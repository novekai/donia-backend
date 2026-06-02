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

// Manually adjust a user's wallet. Used for commercial gestures (Play Store
// screenshots, marketing gifts, support compensation, etc.).
// Positive amount = credit, negative = debit.
//
// Both endpoints below accept the same body: { amount, reason }.
//   POST /v1/admin/users/:id/credit-wallet            ← lookup by Prisma id
//   POST /v1/admin/users/by-identifier/credit-wallet  ← lookup by phone/email/name (easier)
import { Prisma } from '@prisma/client';

const creditSchema = z.object({
  amount: z.coerce.number().refine((n) => n !== 0, 'amount must be non-zero'),
  reason: z.string().min(2).max(200).default('admin adjustment'),
});

const creditByIdentifierSchema = creditSchema.extend({
  identifier: z.string().min(2),
});

async function adjustWallet(userId: string, amount: number, reason: string, adjustedBy: string) {
  await prisma.$transaction([
    prisma.wallet.update({
      where: { userId },
      data: { balancePrincipal: { increment: new Prisma.Decimal(amount) } },
    }),
    prisma.transaction.create({
      data: {
        userId,
        type: amount > 0 ? 'TOPUP_CODE' : 'WITHDRAWAL',
        amount: new Prisma.Decimal(Math.abs(amount)),
        status: 'SUCCESS',
        metadata: { kind: 'admin_adjustment', reason, adjustedBy },
      },
    }),
  ]);
  const updated = await prisma.wallet.findUnique({ where: { userId } });
  return Number(updated?.balancePrincipal ?? 0);
}

router.post('/:id/credit-wallet', validate(creditSchema), async (req, res) => {
  const id = req.params.id as string;
  const { amount, reason } = req.body as z.infer<typeof creditSchema>;

  const user = await prisma.user.findUnique({ where: { id }, include: { wallet: true } });
  if (!user || !user.wallet) throw NotFound('User or wallet not found');

  const newBalance = await adjustWallet(id, amount, reason, req.admin?.email ?? 'unknown');
  res.json({ ok: true, userId: id, name: user.name, newBalance, adjusted: amount });
});

// TEMP-ADMIN-FIX: cleanup all admin_adjustment transactions for a user
// and revert their balance impact. Used to "remettre comme avant" after
// Play Store screenshots. To remove with the modal once captures are done.
router.post('/:id/admin-transactions/clear', async (req, res) => {
  const id = req.params.id as string;
  const user = await prisma.user.findUnique({ where: { id }, include: { wallet: true } });
  if (!user || !user.wallet) throw NotFound('User or wallet not found');

  const adminTxs = await prisma.transaction.findMany({
    where: {
      userId: id,
      metadata: { path: ['kind'], equals: 'admin_adjustment' },
    },
    select: { id: true, amount: true, type: true },
  });

  // Sum signed amounts: TOPUP_CODE was a credit (+), WITHDRAWAL was a debit (-).
  const netDelta = adminTxs.reduce((sum, tx) => {
    const signed = tx.type === 'WITHDRAWAL' ? -Number(tx.amount) : Number(tx.amount);
    return sum + signed;
  }, 0);

  await prisma.$transaction([
    prisma.wallet.update({
      where: { userId: id },
      data: { balancePrincipal: { decrement: new Prisma.Decimal(netDelta) } },
    }),
    prisma.transaction.deleteMany({
      where: { id: { in: adminTxs.map((t) => t.id) } },
    }),
  ]);

  const updated = await prisma.wallet.findUnique({ where: { userId: id } });
  res.json({
    ok: true,
    userId: id,
    cleared: adminTxs.length,
    netReverted: netDelta,
    newBalance: Number(updated?.balancePrincipal ?? 0),
  });
});

// TEMP-ADMIN-FIX: change a user's referral code (for screenshot polish).
const referralCodeSchema = z.object({
  code: z.string().min(3).max(30).regex(/^[A-Z0-9\-_]+$/i, 'lettres, chiffres, - ou _ uniquement'),
});

router.patch('/:id/referral', validate(referralCodeSchema), async (req, res) => {
  const id = req.params.id as string;
  const { code } = req.body as z.infer<typeof referralCodeSchema>;
  const normalized = code.trim().toUpperCase();

  const taken = await prisma.user.findFirst({
    where: { referralCode: normalized, NOT: { id } },
    select: { id: true },
  });
  if (taken) throw NotFound(`Code "${normalized}" déjà utilisé`);

  const updated = await prisma.user.update({
    where: { id },
    data: { referralCode: normalized },
    select: { id: true, referralCode: true, name: true },
  });
  res.json({ ok: true, ...updated });
});

// TEMP-ADMIN-FIX: create N fake filleuls linked to this user (for screenshot polish).
// Fake users are marked via email pattern `fake-*@donia.test` so they can be deleted.
const fakeReferralsSchema = z.object({
  count: z.coerce.number().int().min(1).max(20),
  totalAmount: z.coerce.number().min(0).max(1_000_000).default(0),
});

const FAKE_NAMES = [
  'Awa Diallo', 'Kofi Mensah', 'Aïcha Touré', 'Yaw Kwame', 'Fatou Ndiaye',
  'Kojo Asante', 'Mariam Coulibaly', 'Sékou Sané', 'Adjoa Boateng', 'Moussa Bamba',
  'Khadija Sow', 'Ibrahim Traoré', 'Lina Cissé', 'Rashid Mensah', 'Bineta Fall',
  'Hassan Diop', 'Aminata Keita', 'Pape Sylla', 'Salimata Bah', 'Ousmane Camara',
];

router.post('/:id/fake-referrals', validate(fakeReferralsSchema), async (req, res) => {
  const id = req.params.id as string;
  const { count, totalAmount } = req.body as z.infer<typeof fakeReferralsSchema>;

  const parrain = await prisma.user.findUnique({ where: { id }, select: { id: true } });
  if (!parrain) throw NotFound('User not found');

  // Reuse a placeholder password hash so the fake accounts can't be logged into.
  const fakeHash = '$2b$10$FAKE.DONIA.SCREENSHOT.USER.HASH.UNUSABLE.PLACEHOLDER.';
  const perReferralEarn = totalAmount > 0 ? totalAmount / count : 0;

  const createdIds: string[] = [];
  for (let i = 0; i < count; i++) {
    const suffix = `${Date.now().toString(36)}${i.toString(36).padStart(2, '0')}`;
    const name = FAKE_NAMES[(i + Date.now()) % FAKE_NAMES.length]!;
    const fake = await prisma.user.create({
      data: {
        phone: `+9999${suffix.slice(-9).padStart(9, '0')}`,
        email: `fake-${suffix}@donia.test`,
        name,
        country: 'BJ',
        passwordHash: fakeHash,
        referralCode: `FAKE-${suffix.toUpperCase()}`,
        referredBy: id,
      },
      select: { id: true },
    });
    await prisma.referral.create({
      data: {
        parrainId: id,
        filleulId: fake.id,
        totalEarned: new Prisma.Decimal(perReferralEarn),
      },
    });
    createdIds.push(fake.id);
  }

  res.json({ ok: true, parrainId: id, created: createdIds.length, totalAmountAllocated: totalAmount });
});

router.delete('/:id/fake-referrals', async (req, res) => {
  const id = req.params.id as string;

  // Fake filleuls are identified by their email pattern AND being referred-by this user.
  const fakes = await prisma.user.findMany({
    where: { email: { startsWith: 'fake-', endsWith: '@donia.test' }, referredBy: id },
    select: { id: true },
  });
  const fakeIds = fakes.map((u) => u.id);

  if (fakeIds.length === 0) {
    res.json({ ok: true, deleted: 0 });
    return;
  }

  await prisma.$transaction([
    prisma.referral.deleteMany({ where: { filleulId: { in: fakeIds } } }),
    prisma.user.deleteMany({ where: { id: { in: fakeIds } } }),
  ]);

  res.json({ ok: true, deleted: fakeIds.length });
});

router.post('/by-identifier/credit-wallet', validate(creditByIdentifierSchema), async (req, res) => {
  const { identifier, amount, reason } = req.body as z.infer<typeof creditByIdentifierSchema>;
  const term = identifier.trim();

  const user = await prisma.user.findFirst({
    where: {
      deletedAt: null,
      OR: [
        { phone: term },
        { email: term.toLowerCase() },
        { name: { contains: term, mode: 'insensitive' } },
        { referralCode: { equals: term.toUpperCase() } },
      ],
    },
    include: { wallet: true },
  });
  if (!user || !user.wallet) throw NotFound(`Aucun utilisateur trouvé pour "${identifier}"`);

  const newBalance = await adjustWallet(user.id, amount, reason, req.admin?.email ?? 'unknown');
  res.json({
    ok: true,
    userId: user.id,
    name: user.name,
    phone: user.phone,
    newBalance,
    adjusted: amount,
  });
});

export default router;
