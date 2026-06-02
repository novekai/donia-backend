// Cagnotte — create, list mine, get one, contribute
import { Router } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { requireAuth } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { prisma } from '../lib/prisma';
import { BadRequest, NotFound, Unauthorized } from '../lib/errors';

const router = Router();
router.use(requireAuth);

const createSchema = z.object({
  title: z.string().min(2),
  description: z.string().max(500).optional(),
  goalAmount: z.number().positive(),
  deadline: z.string().datetime().optional(),
});

router.post('/', validate(createSchema), async (req, res) => {
  if (!req.auth) throw Unauthorized();
  const body = req.body as z.infer<typeof createSchema>;
  const cagnotte = await prisma.cagnotte.create({
    data: {
      ownerId: req.auth.userId,
      title: body.title,
      description: body.description ?? null,
      goalAmount: new Prisma.Decimal(body.goalAmount),
      deadline: body.deadline ? new Date(body.deadline) : null,
    },
  });
  res.status(201).json({ cagnotte });
});

router.get('/mine', async (req, res) => {
  if (!req.auth) throw Unauthorized();
  const items = await prisma.cagnotte.findMany({
    where: { ownerId: req.auth.userId },
    orderBy: { createdAt: 'desc' },
    include: { _count: { select: { contributions: true } } },
  });
  res.json({ items });
});

router.get('/:id', async (req, res) => {
  if (!req.auth) throw Unauthorized();
  const cagnotte = await prisma.cagnotte.findUnique({
    where: { id: req.params.id },
    include: {
      contributions: {
        orderBy: { createdAt: 'desc' },
        include: { contributor: { select: { id: true, name: true } } },
      },
      owner: { select: { id: true, name: true } },
    },
  });
  if (!cagnotte) throw NotFound();
  res.json({ cagnotte });
});

const contributeSchema = z.object({
  amount: z.number().positive(),
  message: z.string().max(200).optional(),
});

router.post('/:id/contribute', validate(contributeSchema), async (req, res) => {
  if (!req.auth) throw Unauthorized();
  const { amount, message } = req.body as z.infer<typeof contributeSchema>;

  const result = await prisma.$transaction(async (tx) => {
    const cagnotte = await tx.cagnotte.findUnique({ where: { id: req.params.id as string } });
    if (!cagnotte || cagnotte.status !== 'ACTIVE') throw BadRequest('Cagnotte not active');
    if (cagnotte.deadline && cagnotte.deadline < new Date()) throw BadRequest('Cagnotte closed');

    const wallet = await tx.wallet.findUniqueOrThrow({ where: { userId: req.auth!.userId } });
    if (Number(wallet.balancePrincipal) < amount) {
      throw BadRequest('Insufficient balance', 'INSUFFICIENT_FUNDS');
    }
    const amt = new Prisma.Decimal(amount);

    const contrib = await tx.cagnotteContribution.create({
      data: { cagnotteId: cagnotte.id, contributorId: req.auth!.userId, amount: amt, message: message ?? null },
    });
    await tx.wallet.update({ where: { userId: req.auth!.userId }, data: { balancePrincipal: { decrement: amt } } });
    await tx.cagnotte.update({ where: { id: cagnotte.id }, data: { totalRaised: { increment: amt } } });
    await tx.transaction.create({
      data: {
        userId: req.auth!.userId,
        type: 'CAGNOTTE_IN',
        amount: amt,
        status: 'SUCCESS',
        metadata: { cagnotteId: cagnotte.id, message },
      },
    });
    return contrib;
  });

  res.status(201).json({ contribution: result });
});

export default router;
