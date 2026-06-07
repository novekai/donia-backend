// Admin transactions list — filters by type, status, date range, and free-text user search.
import { Router } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { requireAdmin } from '../../middleware/adminAuth';
import { validate } from '../../middleware/validate';
import { BadRequest, NotFound } from '../../lib/errors';
import { logger } from '../../lib/logger';

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
      // metadata utile pour les retraits (operator, phoneNumber, accountNumber, currency saisie)
      metadata: t.metadata,
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

// ── POST /v1/admin/transactions/:id/withdraw/mark-paid ──
// Marque un retrait PENDING comme SUCCESS (payout confirmé côté MM ou virement bancaire).
// Le solde a déjà été décrémenté à la création de la demande, donc rien à faire côté wallet.
router.post('/:id/withdraw/mark-paid', async (req, res) => {
  const id = req.params.id as string;
  const tx = await prisma.transaction.findUnique({ where: { id } });
  if (!tx) throw NotFound('Transaction introuvable');
  if (tx.type !== 'WITHDRAWAL') throw BadRequest('Cette transaction n’est pas un retrait.', 'NOT_A_WITHDRAWAL');
  if (tx.status !== 'PENDING') throw BadRequest(`Le retrait est déjà ${tx.status}.`, 'NOT_PENDING');

  const updated = await prisma.transaction.update({
    where: { id },
    data: {
      status: 'SUCCESS',
      metadata: {
        ...((tx.metadata as Record<string, unknown>) ?? {}),
        paidAt: new Date().toISOString(),
        paidByAdmin: req.admin?.email ?? 'unknown',
      },
    },
  });
  logger.info({ txId: id, admin: req.admin?.email }, 'Withdrawal marked as paid');
  res.json({ ok: true, id: updated.id, status: updated.status });
});

// ── POST /v1/admin/transactions/:id/withdraw/refund ──
// Annule un retrait PENDING (ou un retrait SUCCESS qui échoue côté Mobile Money) et
// recrédite le solde du user. Status passe à REFUNDED.
const refundSchema = z.object({ reason: z.string().min(1).max(280).optional() });
router.post('/:id/withdraw/refund', validate(refundSchema), async (req, res) => {
  const id = req.params.id as string;
  const { reason } = req.body as z.infer<typeof refundSchema>;
  const tx = await prisma.transaction.findUnique({ where: { id } });
  if (!tx) throw NotFound('Transaction introuvable');
  if (tx.type !== 'WITHDRAWAL') throw BadRequest('Cette transaction n’est pas un retrait.', 'NOT_A_WITHDRAWAL');
  if (tx.status === 'REFUNDED') throw BadRequest('Retrait déjà remboursé.', 'ALREADY_REFUNDED');

  const result = await prisma.$transaction(async (db) => {
    await db.wallet.update({
      where: { userId: tx.userId },
      data: { balancePrincipal: { increment: new Prisma.Decimal(tx.amount) } },
    });
    const updated = await db.transaction.update({
      where: { id },
      data: {
        status: 'REFUNDED',
        metadata: {
          ...((tx.metadata as Record<string, unknown>) ?? {}),
          refundedAt: new Date().toISOString(),
          refundedByAdmin: req.admin?.email ?? 'unknown',
          refundReason: reason ?? null,
        },
      },
    });
    return updated;
  });

  logger.info({ txId: id, admin: req.admin?.email, amount: Number(tx.amount) }, 'Withdrawal refunded');
  res.json({ ok: true, id: result.id, status: result.status, credited: Number(tx.amount) });
});

export default router;
