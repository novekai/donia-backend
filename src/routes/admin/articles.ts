// Admin CRUD for blog articles. Protected by requireAdmin.
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { validate } from '../../middleware/validate';
import { requireAdmin } from '../../middleware/adminAuth';
import { BadRequest, Conflict, NotFound } from '../../lib/errors';
import type { ArticleStatus } from '@prisma/client';

const router = Router();
router.use(requireAdmin);

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Must be a 6-digit hex color');
const slugRegex = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const statusEnum = z.enum(['DRAFT', 'PUBLISHED', 'ARCHIVED']);

const createSchema = z.object({
  slug: z.string().min(3).max(80).regex(slugRegex, 'Slug must be lowercase-with-dashes'),
  title: z.string().min(3).max(200),
  category: z.string().min(2).max(40),
  excerpt: z.string().min(10).max(400),
  content: z.string().min(10).max(50000),
  emoji: z.string().min(1).max(8),
  color: hexColor,
  readMinutes: z.coerce.number().int().min(1).max(120).default(4),
  author: z.string().min(2).max(80).default('Équipe Donia'),
  status: statusEnum.default('DRAFT'),
  publishedAt: z.string().datetime().optional(),
});

const updateSchema = createSchema.partial();

// GET /v1/admin/articles?status=DRAFT|PUBLISHED|ARCHIVED|all
router.get('/', async (req, res) => {
  const status = (req.query.status as string) || 'all';
  const where = status === 'all' ? {} : { status: status.toUpperCase() as ArticleStatus };
  const items = await prisma.article.findMany({
    where,
    orderBy: [{ status: 'asc' }, { publishedAt: 'desc' }, { updatedAt: 'desc' }],
  });
  res.json({ items, total: items.length });
});

// GET /v1/admin/articles/:slug
router.get('/:slug', async (req, res) => {
  const slug = req.params.slug as string;
  const article = await prisma.article.findUnique({ where: { slug } });
  if (!article) throw NotFound('Article not found');
  res.json(article);
});

// POST /v1/admin/articles
router.post('/', validate(createSchema), async (req, res) => {
  const data = req.body as z.infer<typeof createSchema>;

  const exists = await prisma.article.findUnique({ where: { slug: data.slug }, select: { id: true } });
  if (exists) throw Conflict('Slug already used', 'SLUG_TAKEN');

  const publishedAt =
    data.status === 'PUBLISHED'
      ? data.publishedAt
        ? new Date(data.publishedAt)
        : new Date()
      : null;

  const article = await prisma.article.create({
    data: {
      slug: data.slug,
      title: data.title,
      category: data.category,
      excerpt: data.excerpt,
      content: data.content,
      emoji: data.emoji,
      color: data.color,
      readMinutes: data.readMinutes,
      author: data.author,
      status: data.status,
      publishedAt,
    },
  });
  res.status(201).json(article);
});

// PATCH /v1/admin/articles/:slug
router.patch('/:slug', validate(updateSchema), async (req, res) => {
  const slug = req.params.slug as string;
  const data = req.body as z.infer<typeof updateSchema>;

  const current = await prisma.article.findUnique({ where: { slug } });
  if (!current) throw NotFound('Article not found');

  // Slug rename: ensure no collision
  if (data.slug && data.slug !== slug) {
    const taken = await prisma.article.findUnique({ where: { slug: data.slug }, select: { id: true } });
    if (taken) throw Conflict('Slug already used', 'SLUG_TAKEN');
  }

  // Compute publishedAt transitions
  let publishedAt: Date | null | undefined = undefined;
  if (data.status === 'PUBLISHED' && current.status !== 'PUBLISHED') {
    publishedAt = data.publishedAt ? new Date(data.publishedAt) : new Date();
  } else if (data.status && data.status !== 'PUBLISHED') {
    publishedAt = null;
  } else if (data.publishedAt) {
    publishedAt = new Date(data.publishedAt);
  }

  const updated = await prisma.article.update({
    where: { slug },
    data: {
      ...data,
      ...(publishedAt !== undefined ? { publishedAt } : {}),
    },
  });
  res.json(updated);
});

// DELETE /v1/admin/articles/:slug
router.delete('/:slug', async (req, res) => {
  const slug = req.params.slug as string;
  try {
    const deleted = await prisma.article.delete({ where: { slug } });
    res.json({ deleted: true, slug: deleted.slug });
  } catch {
    throw NotFound('Article not found');
  }
});

export default router;
