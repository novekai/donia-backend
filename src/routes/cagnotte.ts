// Cagnotte — create (avec publicCode), list mine, get one, contribute, withdraw.
import { Router } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { requireAuth } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { prisma } from '../lib/prisma';
import { generateUniqueCagnotteCode } from '../lib/cagnotte-code';
import { BadRequest, NotFound, Unauthorized } from '../lib/errors';
import { logger } from '../lib/logger';

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
  const publicCode = await generateUniqueCagnotteCode();
  const cagnotte = await prisma.cagnotte.create({
    data: {
      ownerId: req.auth.userId,
      title: body.title,
      description: body.description ?? null,
      goalAmount: new Prisma.Decimal(body.goalAmount),
      deadline: body.deadline ? new Date(body.deadline) : null,
      publicCode,
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
        where: { status: 'CONFIRMED' },
        orderBy: { createdAt: 'desc' },
        include: { contributor: { select: { id: true, name: true } } },
      },
      owner: { select: { id: true, name: true } },
    },
  });
  if (!cagnotte) throw NotFound();
  // Normalise contributor display name : utilise contributorName si pas de user Donia
  const contributions = cagnotte.contributions.map((c) => ({
    ...c,
    contributorDisplayName: c.contributor?.name ?? c.contributorName ?? 'Anonyme',
    isExternal: !c.contributorId,
  }));
  res.json({ cagnotte: { ...cagnotte, contributions } });
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
      data: {
        cagnotteId: cagnotte.id,
        contributorId: req.auth!.userId,
        amount: amt,
        message: message ?? null,
        status: 'CONFIRMED',
      },
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

// ── POST /v1/cagnottes/:id/withdraw ──
// L organisateur retire les fonds collectes vers son wallet Donia, moins la commission.
router.post('/:id/withdraw', async (req, res) => {
  if (!req.auth) throw Unauthorized();
  const cagnotteId = req.params.id as string;

  const result = await prisma.$transaction(async (tx) => {
    const cagnotte = await tx.cagnotte.findUnique({ where: { id: cagnotteId } });
    if (!cagnotte) throw NotFound('Cagnotte introuvable');
    if (cagnotte.ownerId !== req.auth!.userId) throw Unauthorized('Seul lorganisateur peut retirer');
    if (cagnotte.withdrawnAt) throw BadRequest('Fonds deja retires');
    const raised = new Prisma.Decimal(cagnotte.totalRaised);
    if (raised.lessThanOrEqualTo(0)) throw BadRequest('Aucun fonds a retirer');

    const commissionPct = new Prisma.Decimal(cagnotte.commissionPercent);
    const commission = raised.mul(commissionPct).div(100);
    const net = raised.sub(commission);

    // 1. Credite le wallet de l organisateur
    await tx.wallet.update({
      where: { userId: cagnotte.ownerId },
      data: { balancePrincipal: { increment: net } },
    });

    // 2. Marque la cagnotte comme retiree + close
    const updated = await tx.cagnotte.update({
      where: { id: cagnotte.id },
      data: {
        status: 'CLOSED',
        withdrawnAt: new Date(),
        withdrawnAmount: net,
      },
    });

    // 3. Trace les 2 transactions (transfert + commission)
    await tx.transaction.create({
      data: {
        userId: cagnotte.ownerId,
        type: 'CAGNOTTE_IN',
        amount: net,
        status: 'SUCCESS',
        metadata: {
          kind: 'cagnotte_withdraw',
          cagnotteId: cagnotte.id,
          gross: raised.toString(),
          commission: commission.toString(),
          commissionPercent: commissionPct.toString(),
        },
      },
    });
    await tx.transaction.create({
      data: {
        userId: cagnotte.ownerId,
        type: 'COMMISSION',
        amount: commission,
        status: 'SUCCESS',
        metadata: { kind: 'cagnotte_commission', cagnotteId: cagnotte.id },
      },
    });

    return {
      cagnotte: updated,
      gross: raised.toString(),
      commission: commission.toString(),
      net: net.toString(),
      commissionPercent: commissionPct.toString(),
    };
  });

  logger.info({ cagnotteId, net: result.net, commission: result.commission }, '💰 Cagnotte fonds retires');
  res.json(result);
});

export default router;
