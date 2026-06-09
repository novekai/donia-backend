// GET /v1/me — profile + wallet + KYC status
// PATCH /v1/me — update profile fields
// POST /v1/me/avatar — upload profile photo (multipart) → R2 → save URL
// POST /v1/me/password — change password (knowing the current one)
import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { prisma } from '../lib/prisma';
import { BadRequest, NotFound, Unauthorized } from '../lib/errors';
import { uploadAvatar } from '../services/r2';
import { hashPassword, verifyPassword } from '../lib/password';

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
  birthdayPublic: true,
  birthdayNote: true,
  birthdayShowAge: true,
  birthdayAutoCard: true,
  birthdayAutoCardAmount: true,
  birthdayVisibility: true,
  showEmailPublic: true, showPhonePublic: true, showAvatarPublic: true,
  preferredLanguage: true,
  notifPushEnabled: true, notifEmailEnabled: true, notifWhatsAppEnabled: true,
  createdAt: true,
  wallet: { select: { balancePrincipal: true, balanceReferral: true, currency: true } },
} as const;

router.get('/', async (req, res) => {
  if (!req.auth) throw Unauthorized();
  const user = await prisma.user.findUnique({ where: { id: req.auth.userId }, select: meSelect });
  if (!user || !user.wallet) throw NotFound();
  res.json({ user });
});

// Note : dob VOLONTAIREMENT exclue du patch. La date de naissance est verrouillée
// après l'inscription pour éviter les triches (compter sur son anniv pour recevoir
// des cartes spontanées, jouer avec les filtres KYC, etc.).
const patchSchema = z.object({
  name: z.string().min(2).optional(),
  whatsapp: z.string().regex(/^\+\d{8,15}$/).optional(),
  email: z.string().email().optional(),
  sex: z.enum(['F', 'M', 'OTHER']).optional(),
  city: z.string().optional(),
  country: z.string().length(2).optional(),
  birthdayOptIn: z.boolean().optional(),
  birthdayPublic: z.boolean().optional(),
  birthdayNote: z.string().max(280).nullable().optional(),
  birthdayShowAge: z.boolean().optional(),
  birthdayAutoCard: z.boolean().optional(),
  birthdayAutoCardAmount: z.number().int().min(100).max(50_000).optional(),
  birthdayVisibility: z.enum(['public', 'contacts', 'private']).optional(),
  // Confidentialité
  showEmailPublic: z.boolean().optional(),
  showPhonePublic: z.boolean().optional(),
  showAvatarPublic: z.boolean().optional(),
  // Langue préférée (BCP 47)
  preferredLanguage: z.enum(['fr-FR', 'en-US']).optional(),
  // Préférences notifications
  notifPushEnabled: z.boolean().optional(),
  notifEmailEnabled: z.boolean().optional(),
  notifWhatsAppEnabled: z.boolean().optional(),
}).strict();

router.patch('/', validate(patchSchema), async (req, res) => {
  if (!req.auth) throw Unauthorized();
  const body = req.body as z.infer<typeof patchSchema>;
  const user = await prisma.user.update({
    where: { id: req.auth.userId },
    data: body,
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

// POST /v1/me/password — change password en connaissant le mot de passe actuel.
// Si on veut RESET (a oublié le mot de passe), c'est l'endpoint POST /auth/reset-password
// avec un OTP par WhatsApp/Email (cf. routes/auth.ts).
const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8),
});

router.post('/password', validate(changePasswordSchema), async (req, res) => {
  if (!req.auth) throw Unauthorized();
  const { currentPassword, newPassword } = req.body as z.infer<typeof changePasswordSchema>;

  const user = await prisma.user.findUnique({
    where: { id: req.auth.userId },
    select: { passwordHash: true },
  });
  if (!user) throw NotFound('User not found');

  const ok = await verifyPassword(currentPassword, user.passwordHash);
  if (!ok) throw Unauthorized('Mot de passe actuel incorrect');

  if (currentPassword === newPassword) {
    throw BadRequest('Le nouveau mot de passe doit être différent de l\'ancien');
  }

  const passwordHash = await hashPassword(newPassword);
  await prisma.user.update({ where: { id: req.auth.userId }, data: { passwordHash } });

  res.json({ ok: true });
});

// GET /v1/me/sessions — liste des sessions actives (non révoquées + non expirées)
// Sert l'écran "Sessions récentes" + "Appareils connectés" côté mobile.
router.get('/sessions', async (req, res) => {
  if (!req.auth) throw Unauthorized();
  const sessions = await prisma.session.findMany({
    where: { userId: req.auth.userId, revokedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: 'desc' },
    select: { id: true, ip: true, userAgent: true, deviceName: true, createdAt: true, expiresAt: true, jtiHash: true },
    take: 50,
  });
  // Marque la session courante (pour que le mobile la mette en évidence et empêche sa révocation).
  const currentJtiHash = req.auth.jti ? Buffer.from(req.auth.jti).toString('base64') : null;
  res.json({
    sessions: sessions.map((s) => ({
      id: s.id,
      ip: s.ip,
      userAgent: s.userAgent,
      deviceName: s.deviceName,
      createdAt: s.createdAt,
      expiresAt: s.expiresAt,
      isCurrent: currentJtiHash !== null && s.jtiHash.includes(currentJtiHash.slice(0, 12)),
    })),
  });
});

// POST /v1/me/sessions/:id/revoke — révoque une session spécifique (déconnexion à distance).
router.post('/sessions/:id/revoke', async (req, res) => {
  if (!req.auth) throw Unauthorized();
  const id = req.params.id;
  const session = await prisma.session.findUnique({ where: { id }, select: { userId: true, revokedAt: true } });
  if (!session) throw NotFound('Session not found');
  if (session.userId !== req.auth.userId) throw Unauthorized('Not your session');
  if (session.revokedAt) return res.json({ ok: true, alreadyRevoked: true });
  await prisma.session.update({ where: { id }, data: { revokedAt: new Date() } });
  res.json({ ok: true });
});

// POST /v1/me/sessions/revoke-all — révoque toutes les sessions SAUF la courante.
// Utile si l'utilisateur veut se déconnecter de tous ses autres appareils.
router.post('/sessions/revoke-all', async (req, res) => {
  if (!req.auth) throw Unauthorized();
  const all = await prisma.session.findMany({
    where: { userId: req.auth.userId, revokedAt: null },
    select: { id: true, jtiHash: true },
  });
  const currentJtiHash = req.auth.jti ? Buffer.from(req.auth.jti).toString('base64') : null;
  const toRevoke = all.filter((s) =>
    !(currentJtiHash !== null && s.jtiHash.includes(currentJtiHash.slice(0, 12))),
  );
  await prisma.session.updateMany({
    where: { id: { in: toRevoke.map((s) => s.id) } },
    data: { revokedAt: new Date() },
  });
  res.json({ ok: true, revoked: toRevoke.length });
});

// DELETE /v1/me — RGPD account deletion.
// Soft delete + anonymisation des PII (nom, email, téléphone, photo, sexe, ville, dob, whatsapp).
// On garde les transactions financières et les cartes (obligation BCEAO de conservation 10 ans
// pour les ESM). Les sessions sont révoquées, les push tokens supprimés, les liens anonymes
// désactivés (les messages déjà reçus restent en base mais ne sont plus liés à l'utilisateur).
const deleteMeSchema = z.object({
  // Anti-erreur : on demande à l'utilisateur de retaper "SUPPRIMER" en clair pour confirmer.
  confirmation: z.literal('SUPPRIMER'),
});

router.delete('/', validate(deleteMeSchema), async (req, res) => {
  if (!req.auth) throw Unauthorized();
  const userId = req.auth.userId;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, deletedAt: true },
  });
  if (!user) throw NotFound('User not found');
  if (user.deletedAt) {
    return res.json({ ok: true, alreadyDeleted: true });
  }

  // Anonymise PII : on garde une trace technique (id, deletedAt) mais on rend le compte
  // ininstallable et invisible côté produit. Les valeurs uniques sont préfixées avec l'id
  // pour ne pas violer les contraintes UNIQUE sur phone/email/referralCode.
  const tombstone = `deleted-${userId}`;
  const tombstoneEmail = `${tombstone}@deleted.donia.invalid`;
  const tombstonePhone = `+0${userId.slice(-12).padStart(12, '0')}`;
  const tombstoneCode = `DELETED-${userId.slice(-8).toUpperCase()}`;

  await prisma.$transaction([
    // 1. Anonymise les champs PII du user
    prisma.user.update({
      where: { id: userId },
      data: {
        deletedAt: new Date(),
        name: 'Compte supprimé',
        email: tombstoneEmail,
        phone: tombstonePhone,
        whatsapp: null,
        avatarUrl: null,
        sex: null,
        dob: null,
        city: null,
        passwordHash: 'DELETED-ACCOUNT-NO-LOGIN',
        referralCode: tombstoneCode,
        birthdayOptIn: false,
      },
    }),
    // 2. Révoque toutes les sessions actives (force le logout côté mobile)
    prisma.session.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    }),
    // 3. Supprime les push tokens (l'app ne recevra plus de notifs)
    prisma.expoPushToken.deleteMany({ where: { userId } }),
    // 4. Archive tous les liens anonymes (les nouveaux messages ne peuvent plus être envoyés)
    prisma.anonymousLink.updateMany({
      where: { userId, status: { not: 'ARCHIVED' } },
      data: { status: 'ARCHIVED' },
    }),
    // 5. Supprime les OTP en cours
    prisma.otp.deleteMany({ where: { userId } }),
    // 6. Supprime les soumissions KYC (docs identité — RGPD : effacement)
    prisma.kycSubmission.deleteMany({ where: { userId } }),
  ]);

  // Note : on garde volontairement intacts :
  // - prisma.transaction (obligation BCEAO : 10 ans de rétention pour les paiements)
  // - prisma.card (les cartes envoyées/reçues — le destinataire n'est pas un compte Donia souvent)
  // - prisma.wallet (lié à la traçabilité financière, le solde n'est plus accessible)
  // - prisma.referral (anonymisé via le tombstone du parrain, mais relation conservée)

  res.json({ ok: true });
});

export default router;
