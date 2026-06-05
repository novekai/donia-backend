// Admin Circles — vue CRM "contacts associés" / graphe relationnel organique.
// Un "cercle" = un utilisateur Donia + tous les contacts (phone/email) à qui il a déjà envoyé une carte.
// V1.0 : on dérive les cercles depuis prisma.card (senderId → recipientPhone/email).
// Pas de table dédiée pour l'opt-in marketing à ce stade — V1.1 quand on aura le double opt-in.
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { requireAdmin } from '../../middleware/adminAuth';
import { validate } from '../../middleware/validate';
import { BadRequest } from '../../lib/errors';

const router = Router();
router.use(requireAdmin);

type ColorKey = 'coral' | 'indigo' | 'mango' | 'mint' | 'plum' | 'pink';
const COLORS: ColorKey[] = ['coral', 'indigo', 'mango', 'mint', 'plum', 'pink'];

function colorFor(id: string): ColorKey {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return COLORS[Math.abs(h) % COLORS.length]!;
}

function maskEmail(email: string | null): string {
  if (!email) return '—';
  const [local, domain] = email.split('@');
  if (!domain || !local) return email;
  const visible = local.slice(0, Math.max(1, Math.min(4, local.length - 1)));
  return `${visible}***@${domain}`;
}

function maskPhone(phone: string): string {
  // +22990123456 → +229 90 *** *** 56
  if (phone.length < 8) return phone;
  return `${phone.slice(0, 7)} *** *** ${phone.slice(-2)}`;
}

const querySchema = z.object({
  focusUserId: z.string().optional(),
});

// GET /v1/admin/circles
router.get('/', validate(querySchema, 'query'), async (req, res) => {
  const q = req.query as z.infer<typeof querySchema>;

  // Stats globales — basées sur cards.
  const [totalContacts, totalCardsAgg, optInCount, unsubCount] = await Promise.all([
    // Contacts uniques captés = COUNT(DISTINCT recipientPhone) sur toutes les cartes
    prisma.card.groupBy({ by: ['recipientPhone'], _count: true }).then((g) => g.length),
    prisma.card.aggregate({ _count: true }),
    // Opt-in marketing = recipient possède un compte Donia (proxy pour V1)
    prisma.card.count({ where: { recipientId: { not: null } } }),
    // Désinscriptions : pas de table dédiée V1 → on retourne 0
    Promise.resolve(0),
  ]);

  const distinctSenders = await prisma.card.groupBy({ by: ['senderId'], _count: true }).then((g) => g.length);
  const avgPerUser = distinctSenders > 0 ? totalContacts / distinctSenders : 0;
  const optInRate = totalCardsAgg._count > 0 ? optInCount / totalCardsAgg._count : 0;
  const unsubscribeRate = totalCardsAgg._count > 0 ? unsubCount / totalCardsAgg._count : 0;

  // Top cercles : 10 plus gros expéditeurs.
  const top = await prisma.card.groupBy({
    by: ['senderId'],
    _count: { _all: true },
    orderBy: { _count: { senderId: 'desc' } },
    take: 10,
  });
  const senderIds = top.map((t) => t.senderId);
  const senders = await prisma.user.findMany({
    where: { id: { in: senderIds } },
    select: { id: true, name: true },
  });
  const senderById = new Map(senders.map((s) => [s.id, s]));

  // Pour chaque top sender, on calcule le nb de contacts uniques + opt-in (recipientId not null).
  const topCircles = await Promise.all(
    top.map(async (t) => {
      const [contacts, optIn] = await Promise.all([
        prisma.card.groupBy({ by: ['recipientPhone'], where: { senderId: t.senderId }, _count: true }).then((g) => g.length),
        prisma.card.count({ where: { senderId: t.senderId, recipientId: { not: null } } }),
      ]);
      const user = senderById.get(t.senderId);
      const name = user?.name ?? 'Anonyme';
      return {
        userId: t.senderId,
        name,
        initial: (name[0] ?? '?').toUpperCase(),
        color: colorFor(t.senderId),
        contactsCount: contacts,
        optInCount: optIn,
      };
    }),
  );

  // Cercle focalisé : tous les contacts (uniques par phone) du user sélectionné.
  let focused = null;
  const focusId = q.focusUserId ?? topCircles[0]?.userId ?? null;
  if (focusId) {
    const user = senderById.get(focusId) ?? await prisma.user.findUnique({
      where: { id: focusId },
      select: { id: true, name: true },
    });
    if (!user) throw BadRequest('Unknown focus user');

    // Cartes envoyées par focusId, dedupliquées par recipientPhone (la dernière en date).
    const cards = await prisma.card.findMany({
      where: { senderId: focusId },
      orderBy: { createdAt: 'desc' },
      take: 200,
      select: {
        recipientPhone: true,
        recipientEmail: true,
        recipientId: true,
        redeemCode: true,
        status: true,
      },
    });
    const seen = new Set<string>();
    const contacts = [];
    for (const c of cards) {
      if (seen.has(c.recipientPhone)) continue;
      seen.add(c.recipientPhone);
      contacts.push({
        emailMasked: c.recipientEmail ? maskEmail(c.recipientEmail) : maskPhone(c.recipientPhone),
        source: c.redeemCode,
        // V1 : on n'a pas le double opt-in marketing, on infère ACTIF si la carte est REDEEMED
        optIn: c.recipientId !== null ? true : null,
        interactions: cards.filter((x) => x.recipientPhone === c.recipientPhone).length,
        status: c.status === 'CANCELLED' ? 'BOUNCED' as const : 'ACTIVE' as const,
        isDoniaUser: c.recipientId !== null,
      });
    }

    focused = {
      user: { id: user.id, name: user.name },
      contacts,
      totalContacts: contacts.length,
      optInCount: contacts.filter((c) => c.optIn === true).length,
    };
  }

  res.json({
    stats: {
      totalContacts,
      avgPerUser: Number(avgPerUser.toFixed(1)),
      optInRate,
      unsubscribeRate,
    },
    topCircles,
    focused,
  });
});

// GET /v1/admin/circles/export.csv — export RGPD des contacts du cercle sélectionné
// (ou de l'admin connecté si pas de focus). V1 : CSV minimal.
router.get('/export.csv', validate(querySchema, 'query'), async (req, res) => {
  const q = req.query as z.infer<typeof querySchema>;
  if (!q.focusUserId) {
    res.status(400).json({ error: { code: 'NO_FOCUS', message: 'focusUserId requis pour l\'export' } });
    return;
  }
  const cards = await prisma.card.findMany({
    where: { senderId: q.focusUserId },
    orderBy: { createdAt: 'desc' },
    select: { recipientPhone: true, recipientEmail: true, recipientName: true, status: true, createdAt: true },
  });
  const rows = [
    'phone,email,name,status,sent_at',
    ...cards.map((c) =>
      [
        c.recipientPhone,
        c.recipientEmail ?? '',
        (c.recipientName ?? '').replace(/,/g, ' '),
        c.status,
        c.createdAt.toISOString(),
      ].join(','),
    ),
  ];
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="cercle-${q.focusUserId}.csv"`);
  res.send(rows.join('\n'));
});

export default router;
