// Transactions — paginated history with filters
import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { prisma } from '../lib/prisma';
import { Unauthorized } from '../lib/errors';

const router = Router();
router.use(requireAuth);

const querySchema = z.object({
  type: z.enum(['SEND', 'RECEIVE', 'TOPUP_MOBILE_MONEY', 'TOPUP_CODE', 'WITHDRAWAL', 'COMMISSION', 'REFERRAL_BONUS', 'CAGNOTTE_IN']).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

router.get('/', validate(querySchema, 'query'), async (req, res) => {
  if (!req.auth) throw Unauthorized();
  const q = req.query as unknown as z.infer<typeof querySchema>;

  const txs = await prisma.transaction.findMany({
    where: {
      userId: req.auth.userId,
      ...(q.type ? { type: q.type } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: q.limit + 1,
    ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
  });

  const hasMore = txs.length > q.limit;
  const items = hasMore ? txs.slice(0, q.limit) : txs;
  res.json({ items, nextCursor: hasMore ? items[items.length - 1].id : null });
});

export default router;
