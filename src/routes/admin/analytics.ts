// Routes admin : stats analytics du site + liste des abonnes newsletter + export CSV.
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { requireAdmin } from '../../middleware/adminAuth';
import { validate } from '../../middleware/validate';

const router = Router();
router.use(requireAdmin);

// ── GET /v1/admin/newsletter ──
// Liste paginee + stats globales (count + 7j + 30j).
const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
  q: z.string().optional(),                 // recherche par email/source
});

router.get('/newsletter', validate(listQuerySchema, 'query'), async (req, res) => {
  const { limit, cursor, q } = req.query as unknown as z.infer<typeof listQuerySchema>;

  const where: Record<string, unknown> = {};
  if (q) {
    where.OR = [
      { email: { contains: q, mode: 'insensitive' } },
      { source: { contains: q, mode: 'insensitive' } },
      { country: { contains: q, mode: 'insensitive' } },
    ];
  }

  const items = await prisma.newsletterSubscriber.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });
  const hasMore = items.length > limit;
  const slice = hasMore ? items.slice(0, limit) : items;

  const now = new Date();
  const d7 = new Date(now.getTime() - 7 * 24 * 3600_000);
  const d30 = new Date(now.getTime() - 30 * 24 * 3600_000);
  const [total, last7d, last30d, bySource] = await Promise.all([
    prisma.newsletterSubscriber.count({ where: { unsubscribedAt: null } }),
    prisma.newsletterSubscriber.count({ where: { unsubscribedAt: null, createdAt: { gte: d7 } } }),
    prisma.newsletterSubscriber.count({ where: { unsubscribedAt: null, createdAt: { gte: d30 } } }),
    prisma.newsletterSubscriber.groupBy({
      by: ['source'],
      _count: { source: true },
      where: { unsubscribedAt: null },
      orderBy: { _count: { source: 'desc' } },
    }),
  ]);

  res.json({
    items: slice,
    nextCursor: hasMore ? slice[slice.length - 1]?.id ?? null : null,
    stats: {
      total,
      last7d,
      last30d,
      bySource: bySource.map((b) => ({ source: b.source, count: b._count.source })),
    },
  });
});

// ── GET /v1/admin/newsletter/export ──
// CSV (email, source, country, createdAt). Pour relances depuis Mailchimp/Brevo/etc.
router.get('/newsletter/export', async (_req, res) => {
  const subs = await prisma.newsletterSubscriber.findMany({
    where: { unsubscribedAt: null },
    orderBy: { createdAt: 'desc' },
    select: {
      email: true, source: true, country: true, utmSource: true, utmCampaign: true, createdAt: true,
    },
  });
  const lines = ['email,source,country,utm_source,utm_campaign,created_at'];
  for (const s of subs) {
    const row = [
      s.email,
      s.source,
      s.country ?? '',
      s.utmSource ?? '',
      s.utmCampaign ?? '',
      s.createdAt.toISOString(),
    ].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',');
    lines.push(row);
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="newsletter-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(lines.join('\n'));
});

// ── GET /v1/admin/analytics/site ──
// Stats agregees : visites par jour, top pages, top sources, devices, pays.
const rangeSchema = z.object({
  days: z.coerce.number().int().min(1).max(365).default(30),
});

router.get('/analytics/site', validate(rangeSchema, 'query'), async (req, res) => {
  const { days } = req.query as unknown as z.infer<typeof rangeSchema>;
  const since = new Date(Date.now() - days * 24 * 3600_000);

  const [
    totalVisits, uniqueSessions, topPages, byCountry, byDevice, byBrowser, bySource, byUtm,
  ] = await Promise.all([
    prisma.siteVisit.count({ where: { createdAt: { gte: since } } }),
    prisma.siteVisit.groupBy({
      by: ['sessionId'],
      where: { createdAt: { gte: since }, sessionId: { not: null } },
      _count: { sessionId: true },
    }).then((rows) => rows.length),
    prisma.siteVisit.groupBy({
      by: ['path'],
      where: { createdAt: { gte: since } },
      _count: { path: true },
      orderBy: { _count: { path: 'desc' } },
      take: 10,
    }),
    prisma.siteVisit.groupBy({
      by: ['country'],
      where: { createdAt: { gte: since }, country: { not: null } },
      _count: { country: true },
      orderBy: { _count: { country: 'desc' } },
      take: 15,
    }),
    prisma.siteVisit.groupBy({
      by: ['deviceType'],
      where: { createdAt: { gte: since }, deviceType: { not: null } },
      _count: { deviceType: true },
    }),
    prisma.siteVisit.groupBy({
      by: ['browser'],
      where: { createdAt: { gte: since }, browser: { not: null } },
      _count: { browser: true },
      orderBy: { _count: { browser: 'desc' } },
      take: 10,
    }),
    prisma.siteVisit.groupBy({
      by: ['referrer'],
      where: { createdAt: { gte: since }, referrer: { not: null } },
      _count: { referrer: true },
      orderBy: { _count: { referrer: 'desc' } },
      take: 15,
    }),
    prisma.siteVisit.groupBy({
      by: ['utmSource', 'utmCampaign'],
      where: { createdAt: { gte: since }, utmSource: { not: null } },
      _count: { utmSource: true },
      orderBy: { _count: { utmSource: 'desc' } },
      take: 15,
    }),
  ]);

  // Visites par jour pour le sparkline
  const daily = await prisma.$queryRawUnsafe<{ day: Date; count: bigint }[]>(
    `SELECT date_trunc('day', "createdAt") AS day, COUNT(*)::bigint AS count
     FROM "SiteVisit"
     WHERE "createdAt" >= $1
     GROUP BY day
     ORDER BY day ASC`,
    since,
  );

  res.json({
    range: { days, since: since.toISOString() },
    totalVisits,
    uniqueSessions,
    topPages: topPages.map((p) => ({ path: p.path, count: p._count.path })),
    byCountry: byCountry.map((c) => ({ country: c.country, count: c._count.country })),
    byDevice: byDevice.map((d) => ({ device: d.deviceType, count: d._count.deviceType })),
    byBrowser: byBrowser.map((b) => ({ browser: b.browser, count: b._count.browser })),
    bySource: bySource.map((r) => ({ referrer: r.referrer, count: r._count.referrer })),
    byUtm: byUtm.map((u) => ({ utmSource: u.utmSource, utmCampaign: u.utmCampaign, count: u._count.utmSource })),
    daily: daily.map((d) => ({ day: d.day.toISOString().slice(0, 10), count: Number(d.count) })),
  });
});

export default router;
