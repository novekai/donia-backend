// Notifications — paginated list + mark as read
import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { prisma } from '../lib/prisma';
import { Unauthorized } from '../lib/errors';

const router = Router();
router.use(requireAuth);

const listSchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  unreadOnly: z.coerce.boolean().optional(),
});

router.get('/', validate(listSchema, 'query'), async (req, res) => {
  if (!req.auth) throw Unauthorized();
  const q = req.query as unknown as z.infer<typeof listSchema>;

  const where = { userId: req.auth.userId, ...(q.unreadOnly ? { readAt: null } : {}) };
  const items = await prisma.notification.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: q.limit + 1,
    ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
  });
  const hasMore = items.length > q.limit;
  const sliced = hasMore ? items.slice(0, q.limit) : items;
  const unread = await prisma.notification.count({ where: { userId: req.auth.userId, readAt: null } });
  res.json({ items: sliced, nextCursor: hasMore ? sliced[sliced.length - 1].id : null, unread });
});

const markSchema = z.object({ ids: z.array(z.string()).optional() });

router.post('/mark-read', validate(markSchema), async (req, res) => {
  if (!req.auth) throw Unauthorized();
  const { ids } = req.body as z.infer<typeof markSchema>;
  await prisma.notification.updateMany({
    where: { userId: req.auth.userId, ...(ids?.length ? { id: { in: ids } } : { readAt: null }) },
    data: { readAt: new Date() },
  });
  res.json({ ok: true });
});

export default router;
