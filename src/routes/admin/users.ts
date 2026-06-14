// GET /v1/admin/users — paginated list with KYC + activity aggregates.
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { requireAdmin } from '../../middleware/adminAuth';
import { validate } from '../../middleware/validate';
import { NotFound } from '../../lib/errors';
import { logger } from '../../lib/logger';
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

// GET /v1/admin/users/:id — full profile + wallet + counters + recent activity
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

  // Activity feed for the admin detail view: last transactions + cards + KYC + anonymous links
  const [transactions, sentCards, kycSubmissions, anonymousLinks, referrals] = await Promise.all([
    prisma.transaction.findMany({
      where: { userId: id },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: { id: true, type: true, amount: true, status: true, createdAt: true, cardId: true, metadata: true },
    }),
    prisma.card.findMany({
      where: { senderId: id },
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: {
        id: true, redeemCode: true, recipientName: true, recipientPhone: true,
        amount: true, occasion: true, status: true, deliveryChannel: true, createdAt: true,
      },
    }),
    prisma.kycSubmission.findMany({
      where: { userId: id },
      orderBy: { createdAt: 'desc' },
      take: 5,
      select: { id: true, status: true, docType: true, createdAt: true, reviewedAt: true, rejectionReason: true },
    }),
    prisma.anonymousLink.findMany({
      where: { userId: id },
      orderBy: { createdAt: 'desc' },
      take: 5,
      select: { id: true, code: true, status: true, createdAt: true, _count: { select: { messages: true } } },
    }),
    prisma.referral.findMany({
      where: { parrainId: id },
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: {
        id: true, totalEarned: true, rate: true, createdAt: true,
        filleul: { select: { id: true, name: true, phone: true, createdAt: true } },
      },
    }),
  ]);

  res.json({
    ...user,
    transactions,
    sentCards,
    kycSubmissions,
    anonymousLinks,
    referrals,
  });
});

// DELETE /v1/admin/users/:id — RGPD soft-delete by admin
// Anonymise les PII, révoque les sessions, supprime push tokens / OTPs / KYC,
// archive les liens anonymes. Garde transactions + cards + wallet pour traçabilité BCEAO.
import { Prisma } from '@prisma/client';

router.delete('/:id', async (req, res) => {
  const id = req.params.id as string;
  const user = await prisma.user.findUnique({
    where: { id },
    select: { id: true, name: true, phone: true, deletedAt: true },
  });
  if (!user) throw NotFound('User not found');
  if (user.deletedAt) {
    return res.json({ ok: true, alreadyDeleted: true });
  }

  const tombstone = `deleted-${id}`;
  const tombstoneEmail = `${tombstone}@deleted.donia.invalid`;
  const tombstonePhone = `+0${id.slice(-12).padStart(12, '0')}`;
  const tombstoneCode = `DELETED-${id.slice(-8).toUpperCase()}`;

  await prisma.$transaction([
    prisma.user.update({
      where: { id },
      data: {
        deletedAt: new Date(),
        name: 'Compte supprimé',
        email: tombstoneEmail,
        phone: tombstonePhone,
        whatsapp: null,
        avatarUrl: null,
        sex: null,
        dob: null,
        city: null,
        passwordHash: 'DELETED-ACCOUNT-NO-LOGIN',
        referralCode: tombstoneCode,
        birthdayOptIn: false,
      },
    }),
    prisma.session.updateMany({
      where: { userId: id, revokedAt: null },
      data: { revokedAt: new Date() },
    }),
    prisma.expoPushToken.deleteMany({ where: { userId: id } }),
    prisma.anonymousLink.updateMany({
      where: { userId: id, status: { not: 'ARCHIVED' } },
      data: { status: 'ARCHIVED' },
    }),
    prisma.otp.deleteMany({ where: { userId: id } }),
    prisma.kycSubmission.deleteMany({ where: { userId: id } }),
  ]);

  logger.warn({ adminId: req.admin?.email, deletedUserId: id, deletedUserName: user.name, deletedUserPhone: user.phone }, '🗑️ User soft-deleted by admin');

  res.json({ ok: true, userId: id });
});

// POST /v1/admin/users/:id/wallet/adjust — credit ou debit manuel par l'admin
// Usage : credit demo pour screenshots, correction d'un bug, geste commercial...
// Cree une Transaction TOPUP_CODE (credit) ou WITHDRAWAL (debit) avec metadata.kind = 'admin_adjustment'
// pour tracabilite. La cle reason est obligatoire et stockee dans metadata.
const walletAdjustSchema = z.object({
  amount: z.number().int(),                       // positif = credit, negatif = debit (FCFA)
  reason: z.string().min(3).max(200),             // obligatoire — apparait dans la tx + logs
  pocket: z.enum(['principal', 'referral']).default('principal'),
});

router.post('/:id/wallet/adjust', validate(walletAdjustSchema), async (req, res) => {
  const id = req.params.id as string;
  const { amount, reason, pocket } = req.body as z.infer<typeof walletAdjustSchema>;
  if (amount === 0) {
    return res.status(400).json({ error: { code: 'BAD_AMOUNT', message: 'amount must be non-zero' } });
  }

  const user = await prisma.user.findUnique({
    where: { id },
    include: { wallet: true },
  });
  if (!user) throw NotFound('User not found');

  const field = pocket === 'referral' ? 'balanceReferral' : 'balancePrincipal';
  const current = Number(user.wallet?.[field] ?? 0);
  const next = current + amount;
  if (next < 0) {
    return res.status(400).json({
      error: { code: 'INSUFFICIENT_BALANCE', message: `Solde ${pocket} insuffisant (${current} + ${amount} < 0)` },
    });
  }

  const txType: 'TOPUP_CODE' | 'WITHDRAWAL' = amount > 0 ? 'TOPUP_CODE' : 'WITHDRAWAL';

  const [, tx] = await prisma.$transaction([
    prisma.wallet.upsert({
      where: { userId: id },
      update: { [field]: new Prisma.Decimal(next) },
      create: {
        userId: id,
        balancePrincipal: pocket === 'principal' ? new Prisma.Decimal(next) : new Prisma.Decimal(0),
        balanceReferral: pocket === 'referral' ? new Prisma.Decimal(next) : new Prisma.Decimal(0),
      },
    }),
    prisma.transaction.create({
      data: {
        userId: id,
        type: txType,
        amount: new Prisma.Decimal(Math.abs(amount)),
        status: 'SUCCESS',
        metadata: {
          kind: 'admin_adjustment',
          reason,
          pocket,
          adminEmail: req.admin?.email ?? 'unknown',
          balanceBefore: current,
          balanceAfter: next,
        },
      },
    }),
  ]);

  logger.warn(
    { adminEmail: req.admin?.email, userId: id, userName: user.name, amount, pocket, reason, txId: tx.id },
    `⚙️ Admin wallet adjustment: ${amount > 0 ? '+' : ''}${amount} FCFA (${pocket}) — ${reason}`,
  );

  res.json({
    ok: true,
    userId: id,
    pocket,
    balanceBefore: current,
    balanceAfter: next,
    transactionId: tx.id,
  });
});

export default router;
