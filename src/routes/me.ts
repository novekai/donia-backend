// GET /v1/me — profile + wallet + KYC status
// PATCH /v1/me — update profile fields
// POST /v1/me/avatar — upload profile photo (multipart) → R2 → save URL
import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { prisma } from '../lib/prisma';
import { BadRequest, NotFound, Unauthorized } from '../lib/errors';
import { uploadAvatar } from '../services/r2';

const router = Router();
router.use(requireAuth);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 }, // 8 MB raw upload (sharp will compress)
});

const meSelect = {
  id: true, name: true, phone: true, whatsapp: true, email: true,
  sex: true, dob: true, city: true, country: true,
  avatarUrl: true,
  kycStatus: true, emailVerified: true, phoneVerified: true,
  referralCode: true, referredBy: true,
  birthdayOptIn: true,
  createdAt: true,
  wallet: { select: { balancePrincipal: true, balanceReferral: true, currency: true } },
} as const;

router.get('/', async (req, res) => {
  if (!req.auth) throw Unauthorized();
  const user = await prisma.user.findUnique({ where: { id: req.auth.userId }, select: meSelect });
  if (!user || !user.wallet) throw NotFound();
  res.json({ user });
});

const patchSchema = z.object({
  name: z.string().min(2).optional(),
  whatsapp: z.string().regex(/^\+\d{8,15}$/).optional(),
  email: z.string().email().optional(),
  sex: z.enum(['F', 'M', 'OTHER']).optional(),
  dob: z.string().date().optional(),
  city: z.string().optional(),
  country: z.string().length(2).optional(),
  birthdayOptIn: z.boolean().optional(),
}).strict();

router.patch('/', validate(patchSchema), async (req, res) => {
  if (!req.auth) throw Unauthorized();
  const body = req.body as z.infer<typeof patchSchema>;
  const user = await prisma.user.update({
    where: { id: req.auth.userId },
    data: { ...body, dob: body.dob ? new Date(body.dob) : undefined },
    select: meSelect,
  });
  res.json({ user });
});

// POST /v1/me/avatar — multipart/form-data with field "photo"
router.post('/avatar', upload.single('photo'), async (req, res) => {
  if (!req.auth) throw Unauthorized();
  const file = req.file;
  if (!file) throw BadRequest('Missing "photo" file in multipart body');
  if (!file.mimetype.startsWith('image/')) throw BadRequest('Uploaded file is not an image');

  const url = await uploadAvatar(req.auth.userId, file.buffer);
  const user = await prisma.user.update({
    where: { id: req.auth.userId },
    data: { avatarUrl: url },
    select: meSelect,
  });
  res.json({ user });
});

// DELETE /v1/me/avatar — remove current avatar
router.delete('/avatar', async (req, res) => {
  if (!req.auth) throw Unauthorized();
  const user = await prisma.user.update({
    where: { id: req.auth.userId },
    data: { avatarUrl: null },
    select: meSelect,
  });
  res.json({ user });
});

export default router;
