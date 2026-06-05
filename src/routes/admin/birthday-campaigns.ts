// Admin Birthday Campaigns — séquence automatique J-7 / J-5 / J-1 / Jour J.
// V1.0 : stats dérivées des notifications de type birthday_* + templates statiques.
// Les états activé/désactivé sont stockés dans PlatformSetting (clés "birthday_seq_J7" etc.).
//
// V1.1 (à venir) :
// - Vrai éditeur HTML (templates en base, Markdown ou MJML)
// - "Tester un template" : envoyer une preview à l'admin connecté
// - "Nouvelle occasion" : étendre au-delà de l'anniversaire (mariage, naissance, etc.)
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { requireAdmin } from '../../middleware/adminAuth';
import { validate } from '../../middleware/validate';
import { invalidatePlatformSettings } from '../../services/platformSettings';

const router = Router();
router.use(requireAdmin);

type Stage = 'J7' | 'J5' | 'J1' | 'J0';
const STAGES: Stage[] = ['J7', 'J5', 'J1', 'J0'];

const STAGE_LABELS: Record<Stage, { label: string; hint: string }> = {
  J7: { label: 'J-7 · Teaser', hint: '7 jours avant' },
  J5: { label: 'J-5 · Relance principale', hint: '5 jours avant' },
  J1: { label: 'J-1 · Rappel', hint: '1 jour avant' },
  J0: { label: 'Jour J · Anniversaire', hint: 'le jour même' },
};

const STAGE_DEFAULT_ENABLED: Record<Stage, boolean> = {
  J7: false, // teaser désactivé par défaut (anti-spam)
  J5: true,
  J1: true,
  J0: true,
};

const TEMPLATES: Record<Stage, { subject: string; body: string; ctaLabel: string; variables: string[] }> = {
  J7: {
    subject: '[PRENOM_DESTINATAIRE], anniversaire dans 7 jours 🎂',
    body: 'Plus que 7 jours avant le grand jour de [PRENOM_DESTINATAIRE]. Tu veux le ou la surprendre avec une carte cadeau Donia ?',
    ctaLabel: 'Offrir une carte',
    variables: ['PRENOM_DESTINATAIRE', 'PHOTO_DESTINATAIRE', 'DATE_ANNIVERSAIRE', 'CTA_OFFRIR', 'LIEN_DESABONNEMENT', 'PRENOM_CONTACT'],
  },
  J5: {
    subject: 'L\'anniversaire de [PRENOM] approche',
    body: 'Plus que 5 jours ! Offre-lui une carte cadeau Donia avant le grand jour.',
    ctaLabel: 'Offrir une carte',
    variables: ['PRENOM_DESTINATAIRE', 'PHOTO_DESTINATAIRE', 'DATE_ANNIVERSAIRE', 'CTA_OFFRIR', 'LIEN_DESABONNEMENT', 'PRENOM_CONTACT'],
  },
  J1: {
    subject: 'Demain c\'est l\'anniversaire de [PRENOM] 🎉',
    body: 'C\'est le dernier moment pour offrir une carte cadeau Mobile Money — livraison instantanée par WhatsApp.',
    ctaLabel: 'Offrir maintenant',
    variables: ['PRENOM_DESTINATAIRE', 'DATE_ANNIVERSAIRE', 'CTA_OFFRIR', 'LIEN_DESABONNEMENT', 'PRENOM_CONTACT'],
  },
  J0: {
    subject: '🎂 Bon anniversaire à [PRENOM] !',
    body: 'Aujourd\'hui c\'est son jour. Envoie-lui une carte cadeau Donia — ça la fera sourire en 30 secondes.',
    ctaLabel: 'Lui envoyer une carte',
    variables: ['PRENOM_DESTINATAIRE', 'PHOTO_DESTINATAIRE', 'CTA_OFFRIR', 'LIEN_DESABONNEMENT', 'PRENOM_CONTACT'],
  },
};

function settingKeyFor(stage: Stage): string {
  return `birthday_seq_${stage}`;
}

async function readSequenceFromDb(): Promise<Record<Stage, boolean>> {
  const rows = await prisma.platformSetting.findMany({
    where: { key: { in: STAGES.map(settingKeyFor) } },
  });
  const map = new Map(rows.map((r) => [r.key, r.value]));
  const out: Record<Stage, boolean> = { ...STAGE_DEFAULT_ENABLED };
  for (const s of STAGES) {
    const v = map.get(settingKeyFor(s));
    if (typeof v === 'boolean') out[s] = v;
  }
  return out;
}

// GET /v1/admin/birthday-campaigns
router.get('/', async (_req, res) => {
  const seqMap = await readSequenceFromDb();

  // Stats — basées sur les notifications de type birthday_*  envoyées sur 30 jours.
  const since = new Date(Date.now() - 30 * 86400_000);
  const emailsSent30d = await prisma.notification.count({
    where: { type: { startsWith: 'birthday' }, createdAt: { gte: since } },
  });

  // Pas de tracking open/click détaillé V1 → on retourne des valeurs nulles
  // que le front affiche comme "—". Sera branché à Resend webhooks en V1.1.
  const stats = {
    emailsSent30d,
    openRate: 0,
    conversionRate: 0,
    spamRate: 0,
  };

  const sequence = STAGES.map((stage) => ({
    stage,
    label: STAGE_LABELS[stage].label,
    hint: STAGE_LABELS[stage].hint,
    enabled: seqMap[stage],
    openRate: 0,
    clickRate: 0,
  }));

  const templates = STAGES.map((stage) => ({
    stage,
    ...TEMPLATES[stage],
  }));

  res.json({ stats, sequence, templates });
});

// PATCH /v1/admin/birthday-campaigns/sequence/:stage — activer / désactiver une étape
const toggleSchema = z.object({ enabled: z.boolean() });

router.patch('/sequence/:stage', validate(toggleSchema), async (req, res) => {
  const stage = req.params.stage as Stage;
  if (!STAGES.includes(stage)) {
    res.status(400).json({ error: { code: 'UNKNOWN_STAGE', message: 'Unknown stage' } });
    return;
  }
  const { enabled } = req.body as z.infer<typeof toggleSchema>;
  await prisma.platformSetting.upsert({
    where: { key: settingKeyFor(stage) },
    update: { value: enabled },
    create: { key: settingKeyFor(stage), value: enabled },
  });
  invalidatePlatformSettings();
  res.json({ ok: true, stage, enabled });
});

export default router;
