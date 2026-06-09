// Admin Cagnottes — vue tableau + détails + actions (clôturer, annuler).
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { requireAdmin } from '../../middleware/adminAuth';
import { validate } from '../../middleware/validate';
import { BadRequest, NotFound } from '../../lib/errors';

const router = Router();
router.use(requireAdmin);

const listSchema = z.object({
  status: z.enum(['all', 'ACTIVE', 'CLOSED', 'CANCELLED']).default('all'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
  q: z.string().optional(),
});

router.get('/', validate(listSchema, 'query'), async (req, res) => {
  const { status, limit, cursor, q } = req.query as unknown as z.infer<typeof listSchema>;
  const where: Record<string, unknown> = {};
  if (status !== 'all') where.status = status;
  if (q) where.title = { contains: q, mode: 'insensitive' };

  const items = await prisma.cagnotte.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    include: {
      owner: { select: { id: true, name: true } },
      _count: { select: { contributions: true } },
    },
  });
  const hasMore = items.length > limit;
  const slice = hasMore ? items.slice(0, limit) : items;

  const [total, active, closed, cancelled, totalRaisedAll] = await Promise.all([
    prisma.cagnotte.count(),
    prisma.cagnotte.count({ where: { status: 'ACTIVE' } }),
    prisma.cagnotte.count({ where: { status: 'CLOSED' } }),
    prisma.cagnotte.count({ where: { status: 'CANCELLED' } }),
    prisma.cagnotte.aggregate({ _sum: { totalRaised: true } }),
  ]);

  res.json({
    items: slice.map((c) => ({
      id: c.id,
      title: c.title,
      description: c.description,
      goalAmount: Number(c.goalAmount),
      totalRaised: Number(c.totalRaised),
      deadline: c.deadline,
      status: c.status,
      createdAt: c.createdAt,
      owner: c.owner,
      contributionCount: c._count.contributions,
    })),
    nextCursor: hasMore ? slice[slice.length - 1]?.id ?? null : null,
    stats: { total, active, closed, cancelled, totalRaisedAll: Number(totalRaisedAll._sum.totalRaised ?? 0) },
  });
});

router.get('/:id', async (req, res) => {
  const c = await prisma.cagnotte.findUnique({
    where: { id: req.params.id as string },
    include: {
      owner: { select: { id: true, name: true, email: true, phone: true } },
      contributions: {
        orderBy: { createdAt: 'desc' },
        include: { contributor: { select: { id: true, name: true } } },
      },
    },
  });
  if (!c) throw NotFound();
  res.json({ cagnotte: c });
});

// Cloturer / annuler
router.post('/:id/close', async (req, res) => {
  const c = await prisma.cagnotte.findUnique({ where: { id: req.params.id as string } });
  if (!c) throw NotFound();
  if (c.status !== 'ACTIVE') throw BadRequest('Cagnotte non active');
  const updated = await prisma.cagnotte.update({ where: { id: c.id }, data: { status: 'CLOSED' } });
  res.json({ cagnotte: updated });
});

router.post('/:id/cancel', async (req, res) => {
  const c = await prisma.cagnotte.findUnique({ where: { id: req.params.id as string } });
  if (!c) throw NotFound();
  if (c.status !== 'ACTIVE') throw BadRequest('Cagnotte non active');
  const updated = await prisma.cagnotte.update({ where: { id: c.id }, data: { status: 'CANCELLED' } });
  res.json({ cagnotte: updated });
});

export default router;
