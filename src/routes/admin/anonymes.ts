// Admin moderation for AnonymousLink + AnonymousMessage.
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { requireAdmin } from '../../middleware/adminAuth';
import { validate } from '../../middleware/validate';
import { NotFound } from '../../lib/errors';

const router = Router();
router.use(requireAdmin);

// GET /v1/admin/anonymes/links — top owners with message counts
router.get('/links', async (_req, res) => {
  const links = await prisma.anonymousLink.findMany({
    orderBy: { createdAt: 'desc' },
    take: 100,
    include: {
      user: { select: { id: true, name: true, avatarUrl: true } },
      _count: { select: { messages: true } },
    },
  });
  res.json({ items: links });
});

// GET /v1/admin/anonymes/messages?status=REPORTED|HIDDEN|VALID|all
router.get('/messages', async (req, res) => {
  const status = (req.query.status as string) || 'REPORTED';
  const where = status === 'all' ? {} : { status: status as 'PENDING' | 'VALID' | 'HIDDEN' | 'REPORTED' | 'DELETED' };

  const items = await prisma.anonymousMessage.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: 100,
    include: {
      link: {
        select: {
          code: true,
          user: { select: { id: true, name: true, avatarUrl: true } },
        },
      },
    },
  });
  res.json({ items });
});

const actionSchema = z.object({
  action: z.enum(['hide', 'restore', 'delete']),
});

// POST /v1/admin/anonymes/messages/:id
router.post('/messages/:id', validate(actionSchema), async (req, res) => {
  const id = req.params.id as string;
  const { action } = req.body as z.infer<typeof actionSchema>;
  const message = await prisma.anonymousMessage.findUnique({ where: { id } });
  if (!message) throw NotFound('Message not found');

  if (action === 'hide') {
    await prisma.anonymousMessage.update({ where: { id }, data: { status: 'HIDDEN' } });
  } else if (action === 'restore') {
    await prisma.anonymousMessage.update({ where: { id }, data: { status: 'VALID' } });
  } else {
    await prisma.anonymousMessage.update({ where: { id }, data: { status: 'DELETED', deletedAt: new Date() } });
  }

  res.json({ ok: true });
});

export default router;
