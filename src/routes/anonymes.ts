// Anonymes — routes privées (auth requise) pour l'app mobile.
// Création de liens, lecture / gestion des messages reçus.
// Les endpoints publics (réception côté site web) sont dans routes/anonymes-public.ts.
import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { prisma } from '../lib/prisma';
import { BadRequest, Forbidden, NotFound, Unauthorized } from '../lib/errors';
import { generateAnonymousCode } from '../services/anonymes';

const router = Router();
router.use(requireAuth);

// Default themes for the link visual (matches mockup direction-c-v2-anon.jsx)
const THEMES = ['indigo', 'coral', 'mango', 'pink', 'mint'] as const;
type Theme = (typeof THEMES)[number];

const createSchema = z.object({
  prompt: z.string().min(2).max(80).default('Dis-moi un secret 🤫'),
  theme: z.enum(THEMES).default('indigo'),
});

// ── POST /v1/anonymes/links — créer un nouveau lien ──
router.post('/links', validate(createSchema), async (req, res) => {
  if (!req.auth) throw Unauthorized();
  const body = req.body as z.infer<typeof createSchema>;

  // Generate a unique 7-char code, retry up to 5 times in the very unlikely case of collision
  let code = '';
  for (let i = 0; i < 5; i++) {
    code = generateAnonymousCode(7);
    const exists = await prisma.anonymousLink.findUnique({ where: { code } });
    if (!exists) break;
    if (i === 4) throw BadRequest('Impossible de générer un code unique, réessaie');
  }

  // Archive any previously active link for this user — only one active at a time
  await prisma.anonymousLink.updateMany({
    where: { userId: req.auth.userId, status: 'ACTIVE' },
    data: { status: 'ARCHIVED' },
  });

  const link = await prisma.anonymousLink.create({
    data: {
      userId: req.auth.userId,
      code,
      prompt: body.prompt,
      theme: body.theme,
    },
  });

  res.status(201).json({ link });
});

// ── GET /v1/anonymes/links — lister mes liens (actif + historique) ──
router.get('/links', async (req, res) => {
  if (!req.auth) throw Unauthorized();
  const links = await prisma.anonymousLink.findMany({
    where: { userId: req.auth.userId },
    orderBy: { createdAt: 'desc' },
    include: {
      _count: { select: { messages: { where: { status: 'VALID' } } } },
    },
  });
  res.json({ links });
});

// ── GET /v1/anonymes/links/active — récupérer mon lien actif (ou null) ──
router.get('/links/active', async (req, res) => {
  if (!req.auth) throw Unauthorized();
  const link = await prisma.anonymousLink.findFirst({
    where: { userId: req.auth.userId, status: 'ACTIVE' },
    include: {
      _count: { select: { messages: { where: { status: 'VALID' } } } },
    },
  });
  res.json({ link });
});

// ── POST /v1/anonymes/links/:id/regenerate — regénérer un nouveau code (l'ancien est archivé) ──
router.post('/links/:id/regenerate', async (req, res) => {
  if (!req.auth) throw Unauthorized();
  const old = await prisma.anonymousLink.findUnique({ where: { id: req.params.id as string } });
  if (!old) throw NotFound('Lien introuvable');
  if (old.userId !== req.auth.userId) throw Forbidden('Pas ton lien');

  let code = '';
  for (let i = 0; i < 5; i++) {
    code = generateAnonymousCode(7);
    const exists = await prisma.anonymousLink.findUnique({ where: { code } });
    if (!exists) break;
    if (i === 4) throw BadRequest('Impossible de générer un code unique');
  }

  const next = await prisma.$transaction(async (tx) => {
    await tx.anonymousLink.update({
      where: { id: old.id },
      data: { status: 'ARCHIVED' },
    });
    return tx.anonymousLink.create({
      data: {
        userId: req.auth!.userId,
        code,
        prompt: old.prompt,
        theme: old.theme,
        status: 'ACTIVE',
      },
    });
  });
  res.json({ link: next });
});

// ── POST /v1/anonymes/links/:id/suspend — suspendre un lien (les visiteurs voient "désactivé") ──
router.post('/links/:id/suspend', async (req, res) => {
  if (!req.auth) throw Unauthorized();
  const link = await prisma.anonymousLink.findUnique({ where: { id: req.params.id as string } });
  if (!link) throw NotFound();
  if (link.userId !== req.auth.userId) throw Forbidden();
  const updated = await prisma.anonymousLink.update({
    where: { id: link.id },
    data: { status: 'SUSPENDED' },
  });
  res.json({ link: updated });
});

// ── GET /v1/anonymes/messages — lister mes messages reçus (sur tous mes liens) ──
// Si ?linkId=… est fourni, filtre sur ce lien précis (et vérifie qu'il appartient au user).
const listMessagesSchema = z.object({
  linkId: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});

router.get('/messages', validate(listMessagesSchema, 'query'), async (req, res) => {
  if (!req.auth) throw Unauthorized();
  const q = req.query as z.infer<typeof listMessagesSchema>;
  const limit = q.limit ?? 30;

  const myLinks = await prisma.anonymousLink.findMany({
    where: { userId: req.auth.userId },
    select: { id: true },
  });
  const linkIds = myLinks.map((l) => l.id);

  // Si on demande un lien précis, vérifier qu'il fait partie de ceux du user.
  if (q.linkId && !linkIds.includes(q.linkId)) {
    res.json({ items: [], nextCursor: null });
    return;
  }
  const linkFilter = q.linkId ? [q.linkId] : linkIds;

  const items = await prisma.anonymousMessage.findMany({
    where: {
      linkId: { in: linkFilter },
      status: 'VALID',
    },
    orderBy: { createdAt: 'desc' },
    take: limit + 1,
    cursor: q.cursor ? { id: q.cursor } : undefined,
    skip: q.cursor ? 1 : 0,
    select: {
      id: true,
      linkId: true,
      content: true,
      isFavorite: true,
      readAt: true,
      createdAt: true,
    },
  });

  const nextCursor = items.length > limit ? items.pop()?.id ?? null : null;
  res.json({ items, nextCursor });
});

// ── POST /v1/anonymes/messages/:id/favorite — toggle favori ──
router.post('/messages/:id/favorite', async (req, res) => {
  if (!req.auth) throw Unauthorized();
  const msg = await prisma.anonymousMessage.findUnique({
    where: { id: req.params.id as string },
    include: { link: { select: { userId: true } } },
  });
  if (!msg) throw NotFound();
  if (msg.link.userId !== req.auth.userId) throw Forbidden();
  const updated = await prisma.anonymousMessage.update({
    where: { id: msg.id },
    data: { isFavorite: !msg.isFavorite },
    select: { id: true, isFavorite: true },
  });
  res.json({ message: updated });
});

// ── POST /v1/anonymes/messages/:id/read — marquer comme lu ──
router.post('/messages/:id/read', async (req, res) => {
  if (!req.auth) throw Unauthorized();
  const msg = await prisma.anonymousMessage.findUnique({
    where: { id: req.params.id as string },
    include: { link: { select: { userId: true } } },
  });
  if (!msg) throw NotFound();
  if (msg.link.userId !== req.auth.userId) throw Forbidden();
  if (!msg.readAt) {
    await prisma.anonymousMessage.update({
      where: { id: msg.id },
      data: { readAt: new Date() },
    });
  }
  res.json({ ok: true });
});

// ── DELETE /v1/anonymes/messages/:id — supprimer un message ──
router.delete('/messages/:id', async (req, res) => {
  if (!req.auth) throw Unauthorized();
  const msg = await prisma.anonymousMessage.findUnique({
    where: { id: req.params.id as string },
    include: { link: { select: { userId: true } } },
  });
  if (!msg) throw NotFound();
  if (msg.link.userId !== req.auth.userId) throw Forbidden();
  await prisma.anonymousMessage.update({
    where: { id: msg.id },
    data: { status: 'DELETED', deletedAt: new Date() },
  });
  res.json({ ok: true });
});

// ── POST /v1/anonymes/messages/:id/report — signaler un message ──
const reportSchema = z.object({
  reason: z.enum(['HARASSMENT', 'THREAT', 'SPAM', 'SEXUAL', 'HATE', 'OTHER']),
});

router.post('/messages/:id/report', validate(reportSchema), async (req, res) => {
  if (!req.auth) throw Unauthorized();
  const { reason } = req.body as z.infer<typeof reportSchema>;
  const msg = await prisma.anonymousMessage.findUnique({
    where: { id: req.params.id as string },
    include: { link: { select: { userId: true } } },
  });
  if (!msg) throw NotFound();
  if (msg.link.userId !== req.auth.userId) throw Forbidden();
  await prisma.anonymousMessage.update({
    where: { id: msg.id },
    data: {
      status: 'REPORTED',
      reportReason: reason,
      reportedAt: new Date(),
    },
  });
  res.json({ ok: true });
});

// ── GET /v1/anonymes/messages/count-unread — compteur pour badge ──
router.get('/messages/count-unread', async (req, res) => {
  if (!req.auth) throw Unauthorized();
  const myLinks = await prisma.anonymousLink.findMany({
    where: { userId: req.auth.userId },
    select: { id: true },
  });
  const count = await prisma.anonymousMessage.count({
    where: {
      linkId: { in: myLinks.map((l) => l.id) },
      status: 'VALID',
      readAt: null,
    },
  });
  res.json({ count });
});

export default router;
