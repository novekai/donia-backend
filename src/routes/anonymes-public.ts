// Anonymes — routes publiques (pas d'auth) pour le site web doniia.com/a/[CODE].
// - GET /public/anonymes/:code → infos publiques du destinataire (prénom, avatar, prompt)
// - POST /public/anonymes/:code/message → envoi d'un message anonyme + capture optionnelle email
//
// Anti-abuse :
// - Rate limiting par IP (5/min, 30/h, 100/jour/destinataire)
// - Modération auto (mots-clés + spam)
// - Captcha à vérifier côté front (Cloudflare Turnstile) — vérification serveur stub
import { Router } from 'express';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { prisma } from '../lib/prisma';
import { validate } from '../middleware/validate';
import { BadRequest, NotFound } from '../lib/errors';
import { autoModerate, hashSenderIp } from '../services/anonymes';
import { sendExpoPush } from '../services/push';
import { logger } from '../lib/logger';
import { getPlatformSettings } from '../services/platformSettings';

const router = Router();

// GET /v1/public/settings — valeurs de plateforme nécessaires aux clients (mobile + web).
// Pas d'auth — ces valeurs ne sont pas sensibles (montants min/max, commission affichée, etc).
// Les booléens de canal notification ne sont PAS exposés ici (info interne).
router.get('/settings', async (_req, res) => {
  const s = await getPlatformSettings();
  res.json({
    minCardAmount: s.min_card_amount,
    cardSendFeeFixed: s.card_send_fee_fixed,
    minWithdrawalAmount: s.min_withdrawal_amount,
    withdrawalFeeFixed: s.withdrawal_fee_fixed,
    maxAmountNoKyc: s.max_amount_no_kyc,
    commissionRate: s.commission_rate, // en pourcentage (0–100)
    cardPaymentEnabled: s.card_payment_enabled,
    referralLifetimeActive: s.referral_lifetime_active,
  });
});

// Hard limits
const messageLimiterPerIp = rateLimit({
  windowMs: 60 * 1000,       // 1 min
  max: 5,                     // 5 messages/min/IP
  message: { error: { code: 'TOO_MANY_REQUESTS', message: 'Trop de messages envoyés, réessaie dans une minute.' } },
  standardHeaders: true,
  legacyHeaders: false,
});

const hourlyLimiterPerIp = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30,
  message: { error: { code: 'TOO_MANY_REQUESTS', message: 'Limite horaire atteinte, réessaie plus tard.' } },
});

// ── GET /public/anonymes/:code — récupère les infos publiques du destinataire ──
router.get('/anonymes/:code', async (req, res) => {
  const code = req.params.code as string;
  const link = await prisma.anonymousLink.findUnique({
    where: { code },
    include: {
      user: {
        select: { name: true, avatarUrl: true },
      },
    },
  });

  if (!link) {
    throw NotFound('Ce lien n\'existe pas ou a été supprimé.');
  }
  if (link.status !== 'ACTIVE') {
    throw NotFound('Ce lien n\'est plus actif.');
  }

  // Show only first name, not full name (privacy)
  const firstName = link.user.name.split(' ')[0] ?? 'cette personne';

  res.json({
    link: {
      code: link.code,
      prompt: link.prompt,
      theme: link.theme,
      recipient: {
        firstName,
        avatarUrl: link.user.avatarUrl,
      },
    },
  });
});

// ── POST /public/anonymes/:code/message — envoyer un message anonyme ──
const sendSchema = z.object({
  content: z.string().min(1).max(500),
  senderEmail: z.string().email().optional(),                 // optionnel : Cercle CRM (Phase 5)
  senderPhone: z.string().regex(/^\+\d{8,15}$/).optional(),   // optionnel : E.164 WhatsApp
  marketingOptIn: z.boolean().default(false),
  captchaToken: z.string().optional(),                        // Turnstile token (verified server-side)
});

router.post(
  '/anonymes/:code/message',
  messageLimiterPerIp,
  hourlyLimiterPerIp,
  validate(sendSchema),
  async (req, res) => {
    const code = req.params.code as string;
    const body = req.body as z.infer<typeof sendSchema>;

    const link = await prisma.anonymousLink.findUnique({
      where: { code },
      include: {
        user: { select: { id: true, name: true } },
      },
    });
    if (!link) throw NotFound('Lien introuvable.');
    if (link.status !== 'ACTIVE') throw BadRequest('Ce lien n\'est plus actif.', 'LINK_INACTIVE');

    // Per-link daily cap : 100 messages/jour/IP
    const ipHash = hashSenderIp(req.ip || req.socket?.remoteAddress);
    if (ipHash) {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const recentCount = await prisma.anonymousMessage.count({
        where: { linkId: link.id, senderIpHash: ipHash, createdAt: { gte: since } },
      });
      if (recentCount >= 100) {
        throw BadRequest('Trop de messages envoyés à ce destinataire aujourd\'hui.', 'DAILY_RECIPIENT_CAP');
      }
    }

    // TODO Phase 4 : verify Turnstile token here (env.TURNSTILE_SECRET_KEY)
    // if (env.TURNSTILE_SECRET_KEY) { ... }

    // Auto-moderation
    const mod = autoModerate(body.content);
    const status = mod.flagged ? 'HIDDEN' : 'VALID';

    const message = await prisma.anonymousMessage.create({
      data: {
        linkId: link.id,
        content: body.content,
        senderIpHash: ipHash,
        senderUserAgent: req.get('user-agent') ?? null,
        senderEmail: body.senderEmail ?? null,
        senderPhone: body.senderPhone ?? null,
        status,
        moderationScore: mod.score,
      },
    });

    // Push notif to recipient (best-effort)
    if (status === 'VALID') {
      try {
        await sendExpoPush({
          userId: link.user.id,
          title: 'Nouveau message anonyme ✨',
          body: 'Tu as reçu un message anonyme. Ouvre Donia pour le lire.',
          data: { type: 'anonymous_message', messageId: message.id },
        });

        // Also persist in notifications table
        await prisma.notification.create({
          data: {
            userId: link.user.id,
            type: 'anonymous_message',
            title: 'Nouveau message anonyme ✨',
            body: 'Quelqu\'un t\'a écrit en anonyme.',
            emoji: '💌',
            data: { messageId: message.id, linkId: link.id },
          },
        });
      } catch (e) {
        logger.warn({ err: e, recipientId: link.user.id }, 'Push notification failed (non-fatal)');
      }
    }

    res.status(201).json({
      ok: true,
      delivered: status === 'VALID',
      moderated: mod.flagged,
    });
  },
);

export default router;
