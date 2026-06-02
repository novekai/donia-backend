// KYC — submit a document (assume URL is already uploaded to S3/R2 client-side)
import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { prisma } from '../lib/prisma';
import { Unauthorized } from '../lib/errors';

const router = Router();
router.use(requireAuth);

const submitSchema = z.object({
  docType: z.enum(['CNI', 'PASSPORT', 'PERMIS']),
  docUrlRecto: z.string().url(),
  docUrlVerso: z.string().url().optional(),
});

router.post('/', validate(submitSchema), async (req, res) => {
  if (!req.auth) throw Unauthorized();
  const body = req.body as z.infer<typeof submitSchema>;
  const submission = await prisma.kycSubmission.create({
    data: {
      userId: req.auth.userId,
      docType: body.docType,
      docUrlRecto: body.docUrlRecto,
      docUrlVerso: body.docUrlVerso ?? null,
    },
  });
  await prisma.user.update({ where: { id: req.auth.userId }, data: { kycStatus: 'PENDING' } });
  res.status(201).json({ submission });
});

router.get('/', async (req, res) => {
  if (!req.auth) throw Unauthorized();
  const latest = await prisma.kycSubmission.findFirst({
    where: { userId: req.auth.userId },
    orderBy: { createdAt: 'desc' },
  });
  res.json({ latest });
});

export default router;
