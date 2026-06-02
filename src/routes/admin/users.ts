// GET /v1/admin/users — paginated list with KYC + activity aggregates.
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { requireAdmin } from '../../middleware/adminAuth';
import { validate } from '../../middleware/validate';
import { NotFound } from '../../lib/errors';
import type { KycStatus } from '@prisma/client';

const router = Router();
router.use(requireAdmin);

const listQuerySchema = z.object({
  q: z.string().optional(),
  kyc: z.enum(['NONE', 'PENDING', 'APPROVED', 'REJECTED', 'all']).default('all'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
});

router.get('/', validate(listQuerySchema, 'query'), async (req, res) => {
  const { q, kyc, limit, cursor } = req.query as unknown as z.infer<typeof listQuerySchema>;

  const where: Record<string, unknown> = { deletedAt: null };
  if (kyc !== 'all') where.kycStatus = kyc as KycStatus;
  if (q) {
    where.OR = [
      { name: { contains: q, mode: 'insensitive' } },
      { email: { contains: q, mode: 'insensitive' } },
      { phone: { contains: q } },
      { referralCode: { contains: q, mode: 'insensitive' } },
    ];
  }

  const users = await prisma.user.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    select: {
      id: true,
      name: true,
      email: true,
      phone: true,
      country: true,
      kycStatus: true,
      referralCode: true,
      avatarUrl: true,
      createdAt: true,
      _count: { select: { sentCards: true } },
    },
  });

  const hasMore = users.length > limit;
  const items = hasMore ? users.slice(0, limit) : users;
  const nextCursor = hasMore ? items[items.length - 1]?.id ?? null : null;

  // Sum each user's outbound volume from their sent cards.
  const ids = items.map((u) => u.id);
  const volumes = await prisma.card.groupBy({
    by: ['senderId'],
    where: { senderId: { in: ids } },
    _sum: { amount: true },
  });
  const volMap = new Map(volumes.map((v) => [v.senderId, Number(v._sum.amount ?? 0)]));

  res.json({
    items: items.map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      phone: u.phone,
      country: u.country,
      kyc: u.kycStatus,
      referralCode: u.referralCode,
      avatarUrl: u.avatarUrl,
      joinedAt: u.createdAt,
      sentCount: u._count.sentCards,
      volume: volMap.get(u.id) ?? 0,
    })),
    nextCursor,
  });
});

// GET /v1/admin/users/:id — full profile + wallet + counters
router.get('/:id', async (req, res) => {
  const id = req.params.id as string;
  const user = await prisma.user.findUnique({
    where: { id },
    include: {
      wallet: true,
      _count: {
        select: {
          sentCards: true,
          redeemedCards: true,
          anonymousLinks: true,
          referralsAsParrain: true,
        },
      },
    },
  });
  if (!user) throw NotFound('User not found');
  res.json(user);
});

// POST /v1/admin/users/:id/credit-wallet — manually adjust a user's wallet.
// Used for commercial gestures (Play Store screenshots, marketing gifts,
// support compensation, etc.). Positive amount = credit, negative = debit.
import { Prisma } from '@prisma/client';

const creditSchema = z.object({
  amount: z.coerce.number().refine((n) => n !== 0, 'amount must be non-zero'),
  reason: z.string().min(2).max(200).default('admin adjustment'),
});

router.post('/:id/credit-wallet', validate(creditSchema), async (req, res) => {
  const id = req.params.id as string;
  const { amount, reason } = req.body as z.infer<typeof creditSchema>;

  const user = await prisma.user.findUnique({ where: { id }, include: { wallet: true } });
  if (!user || !user.wallet) throw NotFound('User or wallet not found');

  await prisma.$transaction([
    prisma.wallet.update({
      where: { userId: id },
      data: { balancePrincipal: { increment: new Prisma.Decimal(amount) } },
    }),
    prisma.transaction.create({
      data: {
        userId: id,
        type: amount > 0 ? 'TOPUP_CODE' : 'WITHDRAWAL',
        amount: new Prisma.Decimal(Math.abs(amount)),
        status: 'SUCCESS',
        metadata: { kind: 'admin_adjustment', reason, adjustedBy: req.admin?.email ?? 'unknown' },
      },
    }),
  ]);

  const updated = await prisma.wallet.findUnique({ where: { userId: id } });
  res.json({
    ok: true,
    userId: id,
    newBalance: Number(updated?.balancePrincipal ?? 0),
    adjusted: amount,
  });
});

export default router;
