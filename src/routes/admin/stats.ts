// GET /v1/admin/stats — aggregates for the Dashboard view.
import { Router } from 'express';
import { prisma } from '../../lib/prisma';
import { requireAdmin } from '../../middleware/adminAuth';

const router = Router();
router.use(requireAdmin);

router.get('/', async (_req, res) => {
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const startOfPrevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const endOfPrevMonth = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);
  const sixMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 5, 1);

  const [
    usersTotal,
    usersPrevMonth,
    cardsThisMonth,
    cardsPrevMonth,
    volumeThisMonth,
    volumePrevMonth,
    commissionsThisMonth,
    commissionsPrevMonth,
    topCardsRaw,
    monthlySends,
    monthlyRedeems,
    alerts,
  ] = await Promise.all([
    prisma.user.count({ where: { deletedAt: null } }),
    prisma.user.count({ where: { deletedAt: null, createdAt: { lt: startOfPrevMonth } } }),

    prisma.card.count({ where: { sentAt: { gte: startOfMonth } } }),
    prisma.card.count({ where: { sentAt: { gte: startOfPrevMonth, lte: endOfPrevMonth } } }),

    prisma.card.aggregate({
      where: { sentAt: { gte: startOfMonth } },
      _sum: { amount: true },
    }),
    prisma.card.aggregate({
      where: { sentAt: { gte: startOfPrevMonth, lte: endOfPrevMonth } },
      _sum: { amount: true },
    }),

    prisma.transaction.aggregate({
      where: { type: 'COMMISSION', status: 'SUCCESS', createdAt: { gte: startOfMonth } },
      _sum: { amount: true },
    }),
    prisma.transaction.aggregate({
      where: {
        type: 'COMMISSION',
        status: 'SUCCESS',
        createdAt: { gte: startOfPrevMonth, lte: endOfPrevMonth },
      },
      _sum: { amount: true },
    }),

    prisma.card.groupBy({
      by: ['themeKey'],
      where: { sentAt: { gte: new Date(Date.now() - 30 * 24 * 3600 * 1000) } },
      _count: { themeKey: true },
      orderBy: { _count: { themeKey: 'desc' } },
      take: 5,
    }),

    prisma.card.findMany({
      where: { sentAt: { gte: sixMonthsAgo } },
      select: { sentAt: true },
    }),
    prisma.card.findMany({
      where: { redeemedAt: { gte: sixMonthsAgo } },
      select: { redeemedAt: true },
    }),

    Promise.all([
      prisma.kycSubmission.count({ where: { status: 'PENDING' } }),
      prisma.article.count({ where: { status: 'DRAFT' } }),
      prisma.anonymousMessage.count({ where: { status: 'REPORTED' } }),
    ]),
  ]);

  const [kycPending, articleDrafts, anonymesReported] = alerts;

  // Build a 6-month bar series, oldest → newest.
  const months: string[] = [];
  const monthLabels = ['Jan', 'Fév', 'Mar', 'Avr', 'Mai', 'Juin', 'Juil', 'Août', 'Sep', 'Oct', 'Nov', 'Déc'];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push(monthLabels[d.getMonth()]!);
  }
  const sendsByMonth = new Map<string, number>();
  const redeemsByMonth = new Map<string, number>();
  const bucket = (d: Date | null) => (d ? monthLabels[new Date(d).getMonth()]! : null);
  monthlySends.forEach((c) => {
    const k = bucket(c.sentAt);
    if (k) sendsByMonth.set(k, (sendsByMonth.get(k) ?? 0) + 1);
  });
  monthlyRedeems.forEach((c) => {
    const k = bucket(c.redeemedAt);
    if (k) redeemsByMonth.set(k, (redeemsByMonth.get(k) ?? 0) + 1);
  });
  const bars = months.map((m) => ({
    m,
    sent: sendsByMonth.get(m) ?? 0,
    converted: redeemsByMonth.get(m) ?? 0,
  }));

  function pct(curr: number, prev: number): { delta: number; positive: boolean } {
    if (prev <= 0) return { delta: 100, positive: curr > 0 };
    const d = ((curr - prev) / prev) * 100;
    return { delta: Math.round(d), positive: d >= 0 };
  }

  res.json({
    kpis: {
      users: { value: usersTotal, ...pct(usersTotal, usersPrevMonth) },
      cards: { value: cardsThisMonth, ...pct(cardsThisMonth, cardsPrevMonth) },
      volume: {
        value: Number(volumeThisMonth._sum.amount ?? 0),
        ...pct(Number(volumeThisMonth._sum.amount ?? 0), Number(volumePrevMonth._sum.amount ?? 0)),
      },
      commissions: {
        value: Number(commissionsThisMonth._sum.amount ?? 0),
        ...pct(
          Number(commissionsThisMonth._sum.amount ?? 0),
          Number(commissionsPrevMonth._sum.amount ?? 0),
        ),
      },
    },
    bars,
    topCards: topCardsRaw.map((t) => ({ name: t.themeKey, count: t._count.themeKey })),
    alerts: {
      kycPending,
      articleDrafts,
      anonymesReported,
    },
  });
});

export default router;
