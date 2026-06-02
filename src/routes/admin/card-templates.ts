// Admin CRUD for card templates (used by the Cards Gallery + Designer views).
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { requireAdmin } from '../../middleware/adminAuth';
import { validate } from '../../middleware/validate';
import { Conflict, NotFound } from '../../lib/errors';

const router = Router();
router.use(requireAdmin);

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Must be a 6-digit hex color');
const themeKeyRegex = /^[a-z0-9-]{2,40}$/;

const createSchema = z.object({
  themeKey: z.string().regex(themeKeyRegex, 'Lowercase letters, digits and dashes only'),
  name: z.string().min(2).max(60),
  emoji: z.string().min(1).max(8),
  color: hexColor,
  ink: hexColor.default('#FDF7F6'),
  category: z.string().min(2).max(60).default('Famille · Fêtes'),
  isLive: z.boolean().default(true),
  sortOrder: z.coerce.number().int().min(0).max(9999).default(0),
});

const updateSchema = createSchema.partial();

// GET /v1/admin/card-templates — all templates + how many times each was sent.
router.get('/', async (_req, res) => {
  const templates = await prisma.cardTemplate.findMany({
    orderBy: [{ isLive: 'desc' }, { sortOrder: 'asc' }, { name: 'asc' }],
  });
  const counts = await prisma.card.groupBy({
    by: ['themeKey'],
    _count: { themeKey: true },
  });
  const countMap = new Map(counts.map((c) => [c.themeKey, c._count.themeKey]));
  res.json({
    items: templates.map((t) => ({
      ...t,
      sentCount: countMap.get(t.themeKey) ?? 0,
    })),
  });
});

// GET /v1/admin/card-templates/:themeKey
router.get('/:themeKey', async (req, res) => {
  const themeKey = req.params.themeKey as string;
  const template = await prisma.cardTemplate.findUnique({ where: { themeKey } });
  if (!template) throw NotFound('Template not found');
  const sentCount = await prisma.card.count({ where: { themeKey } });
  res.json({ ...template, sentCount });
});

// POST /v1/admin/card-templates
router.post('/', validate(createSchema), async (req, res) => {
  const data = req.body as z.infer<typeof createSchema>;
  const exists = await prisma.cardTemplate.findUnique({ where: { themeKey: data.themeKey } });
  if (exists) throw Conflict('Theme key already used', 'THEME_KEY_TAKEN');
  const created = await prisma.cardTemplate.create({ data });
  res.status(201).json(created);
});

// PATCH /v1/admin/card-templates/:themeKey
router.patch('/:themeKey', validate(updateSchema), async (req, res) => {
  const themeKey = req.params.themeKey as string;
  const current = await prisma.cardTemplate.findUnique({ where: { themeKey } });
  if (!current) throw NotFound('Template not found');
  const data = req.body as z.infer<typeof updateSchema>;
  if (data.themeKey && data.themeKey !== themeKey) {
    const taken = await prisma.cardTemplate.findUnique({ where: { themeKey: data.themeKey } });
    if (taken) throw Conflict('Theme key already used', 'THEME_KEY_TAKEN');
  }
  const updated = await prisma.cardTemplate.update({ where: { themeKey }, data });
  res.json(updated);
});

// DELETE /v1/admin/card-templates/:themeKey
router.delete('/:themeKey', async (req, res) => {
  const themeKey = req.params.themeKey as string;
  try {
    const deleted = await prisma.cardTemplate.delete({ where: { themeKey } });
    res.json({ deleted: true, themeKey: deleted.themeKey });
  } catch {
    throw NotFound('Template not found');
  }
});

export default router;
