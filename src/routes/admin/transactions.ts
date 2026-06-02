// Admin transactions list — filters by type, status, date range, and free-text user search.
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { requireAdmin } from '../../middleware/adminAuth';
import { validate } from '../../middleware/validate';

const router = Router();
router.use(requireAdmin);

const typeEnum = z.enum([
  'SEND',
  'RECEIVE',
  'TOPUP_MOBILE_MONEY',
  'TOPUP_CODE',
  'WITHDRAWAL',
  'COMMISSION',
  'REFERRAL_BONUS',
  'CAGNOTTE_IN',
  'all',
]);
const statusEnum = z.enum(['PENDING', 'SUCCESS', 'FAILED', 'REFUNDED', 'all']);

const querySchema = z.object({
  type: typeEnum.default('all'),
  status: statusEnum.default('all'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
  q: z.string().optional(),
});

router.get('/', validate(querySchema, 'query'), async (req, res) => {
  const { type, status, limit, cursor, q } = req.query as unknown as z.infer<typeof querySchema>;

  const where: Record<string, unknown> = {};
  if (type !== 'all') where.type = type;
  if (status !== 'all') where.status = status;
  if (q) {
    where.OR = [
      { ref: { contains: q } },
      { user: { name: { contains: q, mode: 'insensitive' } } },
      { user: { email: { contains: q, mode: 'insensitive' } } },
    ];
  }

  const items = await prisma.transaction.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    include: {
      user: { select: { id: true, name: true } },
    },
  });

  const hasMore = items.length > limit;
  const slice = hasMore ? items.slice(0, limit) : items;
  const nextCursor = hasMore ? slice[slice.length - 1]?.id ?? null : null;

  // Today aggregate (so the Transactions header shows "Today's revenue", etc.)
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  const [todayCount, todayCommissions, pendingCount, failed24h] = await Promise.all([
    prisma.transaction.count({ where: { createdAt: { gte: dayStart } } }),
    prisma.transaction.aggregate({
      where: { type: 'COMMISSION', status: 'SUCCESS', createdAt: { gte: dayStart } },
      _sum: { amount: true },
    }),
    prisma.transaction.count({ where: { status: 'PENDING' } }),
    prisma.transaction.count({
      where: { status: 'FAILED', createdAt: { gte: new Date(Date.now() - 24 * 3600 * 1000) } },
    }),
  ]);

  res.json({
    items: slice.map((t) => ({
      id: t.id,
      ref: t.ref,
      type: t.type,
      status: t.status,
      amount: Number(t.amount),
      currency: t.currency,
      cardId: t.cardId,
      counterpartyId: t.counterpartyId,
      createdAt: t.createdAt,
      user: t.user,
    })),
    nextCursor,
    stats: {
      todayCount,
      todayCommissions: Number(todayCommissions._sum.amount ?? 0),
      pendingCount,
      failed24h,
    },
  });
});

export default router;
