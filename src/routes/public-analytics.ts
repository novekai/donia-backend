// Routes publiques : capture de visites + inscription newsletter depuis le site web.
// Pas d'auth requise. Rate-limit sur les 2 endpoints pour eviter spam.
import { Router } from 'express';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { prisma } from '../lib/prisma';
import { validate } from '../middleware/validate';
import { extractRequestSignals } from '../services/analytics';
import { logger } from '../lib/logger';

const router = Router();

// ── POST /v1/public/newsletter/subscribe ──
// Capture email + tous les signaux analytiques (pays, source, UTM, etc.).
// Dedupe sur l'email (PostgreSQL UNIQUE) : si deja inscrit, on renvoie ok sans erreur.
const subscribeLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1h
  max: 5,                     // 5 inscriptions/h/IP
  message: { error: { code: 'TOO_MANY_REQUESTS', message: 'Trop de demandes, reessaie plus tard.' } },
  standardHeaders: true,
});

const subscribeSchema = z.object({
  email: z.string().email().max(200).optional(),
  phone: z.string().regex(/^\+\d{8,15}$/).optional(),
  source: z.string().max(40).default('popup'),
  utmSource: z.string().max(80).optional(),
  utmMedium: z.string().max(80).optional(),
  utmCampaign: z.string().max(80).optional(),
  referrer: z.string().max(500).optional(),
}).refine((d) => Boolean(d.email || d.phone), {
  message: "Email ou numero WhatsApp requis.",
  path: ['email'],
});

router.post('/newsletter/subscribe', subscribeLimiter, validate(subscribeSchema), async (req, res) => {
  const body = req.body as z.infer<typeof subscribeSchema>;
  const sig = extractRequestSignals(req);

  try {
    await prisma.newsletterSubscriber.create({
      data: {
        email: body.email ? body.email.trim().toLowerCase() : null,
        phone: body.phone ?? null,
        source: body.source,
        ipHash: sig.ipHash,
        country: sig.country,
        referrer: body.referrer ?? sig.referrer,
        utmSource: body.utmSource ?? null,
        utmMedium: body.utmMedium ?? null,
        utmCampaign: body.utmCampaign ?? null,
        userAgent: sig.userAgent,
      },
    });
    logger.info({ email: body.email, phone: body.phone, source: body.source }, '📧 Newsletter subscriber added');
    res.status(201).json({ ok: true });
  } catch (e) {
    // Dedupe : si email deja inscrit, on renvoie ok silencieusement (pas d'info-leak).
    const code = (e as { code?: string }).code;
    if (code === 'P2002') {
      return res.json({ ok: true, alreadySubscribed: true });
    }
    logger.error({ err: (e as Error).message }, 'Newsletter subscribe failed');
    res.status(500).json({ error: { code: 'INTERNAL', message: 'Erreur, reessaie plus tard.' } });
  }
});

// ── POST /v1/public/track-visit ──
// Tracking analytique anonyme : 1 ligne par page-view.
// Rate-limit doux (60 hits/min/IP) pour empêcher abus tout en laissant les utilisateurs naviguer.
const trackLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  // Pas de message d'erreur — on absorbe silencieusement (le client n'a pas besoin de savoir).
});

const trackSchema = z.object({
  path: z.string().min(1).max(200),
  sessionId: z.string().max(50).optional(),
  utmSource: z.string().max(80).optional(),
  utmMedium: z.string().max(80).optional(),
  utmCampaign: z.string().max(80).optional(),
  referrer: z.string().max(500).optional(),
});

router.post('/track-visit', trackLimiter, validate(trackSchema), async (req, res) => {
  const body = req.body as z.infer<typeof trackSchema>;
  const sig = extractRequestSignals(req);

  try {
    await prisma.siteVisit.create({
      data: {
        path: body.path,
        sessionId: body.sessionId ?? null,
        ipHash: sig.ipHash,
        country: sig.country,
        referrer: body.referrer ?? sig.referrer,
        utmSource: body.utmSource ?? null,
        utmMedium: body.utmMedium ?? null,
        utmCampaign: body.utmCampaign ?? null,
        deviceType: sig.parsed.deviceType,
        os: sig.parsed.os,
        browser: sig.parsed.browser,
        language: sig.language,
      },
    });
    res.status(204).end();
  } catch (e) {
    // Tracking est best-effort. Si ça plante on log et on absorbe (UX > telemetry).
    logger.warn({ err: (e as Error).message }, 'track-visit failed (non-fatal)');
    res.status(204).end();
  }
});

export default router;
