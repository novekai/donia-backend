// Referral — stats (filleuls count, FCFA earned) + code
import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { prisma } from '../lib/prisma';
import { NotFound, Unauthorized } from '../lib/errors';

const router = Router();
router.use(requireAuth);

router.get('/', async (req, res) => {
  if (!req.auth) throw Unauthorized();
  const user = await prisma.user.findUnique({
    where: { id: req.auth.userId },
    select: { referralCode: true, referralsAsParrain: { select: { totalEarned: true, filleulId: true } } },
  });
  if (!user) throw NotFound();

  const filleulsCount = user.referralsAsParrain.length;
  const totalEarned = user.referralsAsParrain.reduce((sum, r) => sum + Number(r.totalEarned), 0);

  res.json({
    code: user.referralCode,
    filleulsCount,
    totalEarned,
    rate: 0.01,
  });
});

export default router;
