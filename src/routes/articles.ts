// Public blog endpoints (no auth). Used by doniia.com/#blog and future /blog/[slug] pages.
import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { NotFound } from '../lib/errors';

const router = Router();

// GET /v1/articles — published only, most recent first.
// Optional ?limit=3 to feed the SectionBlog grid on the homepage.
router.get('/', async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 24, 1), 100);
  const items = await prisma.article.findMany({
    where: { status: 'PUBLISHED' },
    orderBy: { publishedAt: 'desc' },
    take: limit,
    select: {
      slug: true,
      title: true,
      category: true,
      excerpt: true,
      emoji: true,
      color: true,
      readMinutes: true,
      author: true,
      publishedAt: true,
    },
  });
  res.json({ items });
});

// GET /v1/articles/:slug — full article, only if published
router.get('/:slug', async (req, res) => {
  const slug = req.params.slug as string;
  const article = await prisma.article.findFirst({
    where: { slug, status: 'PUBLISHED' },
    select: {
      slug: true,
      title: true,
      category: true,
      excerpt: true,
      content: true,
      emoji: true,
      color: true,
      readMinutes: true,
      author: true,
      publishedAt: true,
    },
  });
  if (!article) throw NotFound('Article not found');
  res.json(article);
});

export default router;
