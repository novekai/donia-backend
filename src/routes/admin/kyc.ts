// Admin KYC moderation queue + actions.
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { requireAdmin } from '../../middleware/adminAuth';
import { validate } from '../../middleware/validate';
import { NotFound } from '../../lib/errors';
import { sendExpoPush } from '../../services/push';
import { logger } from '../../lib/logger';

async function notifyKycDecision(userId: string, decision: 'APPROVED' | 'REJECTED', reason?: string | null) {
  try {
    const isApproved = decision === 'APPROVED';
    const title = isApproved ? 'KYC validé ✅' : 'KYC rejeté';
    const body = isApproved
      ? 'Ton identité est confirmée — tu peux maintenant utiliser tous les services Donia.'
      : reason
        ? `Raison : ${reason}. Tu peux soumettre à nouveau depuis l'app.`
        : 'Documents non conformes — tu peux soumettre à nouveau depuis l\'app.';
    await prisma.notification.create({
      data: {
        userId,
        type: isApproved ? 'kyc_approved' : 'kyc_rejected',
        title,
        body,
        emoji: isApproved ? '✅' : '❌',
      },
    });
    await sendExpoPush({
      userId,
      title,
      body,
      data: { type: isApproved ? 'kyc_approved' : 'kyc_rejected' },
    });
  } catch (e) {
    logger.warn({ err: e, userId, decision }, 'kyc decision push failed (non-fatal)');
  }
}

const router = Router();
router.use(requireAdmin);

// GET /v1/admin/kyc?status=PENDING (default) | APPROVED | REJECTED | all
router.get('/', async (req, res) => {
  const status = (req.query.status as string) || 'PENDING';
  const where = status === 'all' ? {} : { status: status as 'PENDING' | 'APPROVED' | 'REJECTED' };

  const items = await prisma.kycSubmission.findMany({
    where,
    orderBy: { createdAt: 'asc' },
    include: {
      user: {
        select: { id: true, name: true, phone: true, country: true, avatarUrl: true },
      },
    },
    take: 100,
  });

  res.json({ items });
});

// GET /v1/admin/kyc/:id — full submission with doc URLs (signed) + user details
router.get('/:id', async (req, res) => {
  const id = req.params.id as string;
  const submission = await prisma.kycSubmission.findUnique({
    where: { id },
    include: {
      user: true,
    },
  });
  if (!submission) throw NotFound('KYC submission not found');
  res.json(submission);
});

const decisionSchema = z.object({
  note: z.string().max(500).optional(),
  reason: z.string().max(200).optional(),
});

// POST /v1/admin/kyc/:id/approve
router.post('/:id/approve', validate(decisionSchema), async (req, res) => {
  const id = req.params.id as string;
  const { note } = req.body as z.infer<typeof decisionSchema>;

  const submission = await prisma.kycSubmission.findUnique({ where: { id } });
  if (!submission) throw NotFound('KYC submission not found');

  const updated = await prisma.$transaction([
    prisma.kycSubmission.update({
      where: { id },
      data: { status: 'APPROVED', reviewedAt: new Date(), rejectionReason: note ?? null },
    }),
    prisma.user.update({
      where: { id: submission.userId },
      data: { kycStatus: 'APPROVED' },
    }),
  ]);

  await notifyKycDecision(submission.userId, 'APPROVED');

  res.json({ ok: true, submission: updated[0] });
});

// POST /v1/admin/kyc/:id/reject
router.post('/:id/reject', validate(decisionSchema), async (req, res) => {
  const id = req.params.id as string;
  const { reason } = req.body as z.infer<typeof decisionSchema>;

  const submission = await prisma.kycSubmission.findUnique({ where: { id } });
  if (!submission) throw NotFound('KYC submission not found');

  const updated = await prisma.$transaction([
    prisma.kycSubmission.update({
      where: { id },
      data: {
        status: 'REJECTED',
        reviewedAt: new Date(),
        rejectionReason: reason ?? 'Documents non conformes',
      },
    }),
    prisma.user.update({
      where: { id: submission.userId },
      data: { kycStatus: 'REJECTED' },
    }),
  ]);

  await notifyKycDecision(submission.userId, 'REJECTED', reason);

  res.json({ ok: true, submission: updated[0] });
});

export default router;
