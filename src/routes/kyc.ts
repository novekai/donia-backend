// KYC — upload doc images via multipart + submit
import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { prisma } from '../lib/prisma';
import { BadRequest, Unauthorized } from '../lib/errors';
import { uploadKycDoc } from '../services/r2';

const router = Router();
router.use(requireAuth);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB par image — sharp compresse derrière
});

// POST /v1/kyc/upload — multipart avec champ "photo" + query/body "side" (recto|verso)
// → renvoie l'URL R2 publique de l'image stockée.
router.post('/upload', upload.single('photo'), async (req, res) => {
  if (!req.auth) throw Unauthorized();
  const file = req.file;
  if (!file) throw BadRequest('Missing "photo" file');
  if (!file.mimetype.startsWith('image/')) throw BadRequest('Uploaded file must be an image');

  const side = (req.body?.side ?? req.query?.side) as string | undefined;
  if (side !== 'recto' && side !== 'verso') {
    throw BadRequest('"side" must be "recto" or "verso"');
  }

  const url = await uploadKycDoc(req.auth.userId, side, file.buffer);
  res.json({ url });
});

const submitSchema = z.object({
  docType: z.enum(['CNI', 'PASSPORT', 'PERMIS']),
  docUrlRecto: z.string().url(),
  docUrlVerso: z.string().url().optional(),
});

// POST /v1/kyc — soumission finale : on a uploadé les images, on crée la submission
// + on bascule le user en kycStatus=PENDING.
router.post('/', validate(submitSchema), async (req, res) => {
  if (!req.auth) throw Unauthorized();
  const body = req.body as z.infer<typeof submitSchema>;
  // Pour CNI et PERMIS, le verso est obligatoire — pas pour le passeport.
  if ((body.docType === 'CNI' || body.docType === 'PERMIS') && !body.docUrlVerso) {
    throw BadRequest('Le verso est requis pour ce type de document');
  }
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
