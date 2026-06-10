// Admin settings — JSON key/value store backing the back-office Settings view.
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { requireAdmin } from '../../middleware/adminAuth';
import { validate } from '../../middleware/validate';
import { env } from '../../config/env';
import { invalidatePlatformSettings } from '../../services/platformSettings';

const router = Router();
router.use(requireAdmin);

// Default values applied when a key has never been set in DB.
// Numbers are stored as numbers, booleans as booleans — typed JSON in Postgres.
// channel_sms volontairement retiré (06/2026) — Donia n'utilise pas le SMS.
export const SETTING_DEFAULTS = {
  commission_rate: 5,             // % taken on conversion
  min_card_amount: 500,           // FCFA
  card_send_fee_fixed: 200,       // FCFA — forfait Donia ajoute au montant envoye
  min_withdrawal_amount: 1000,    // FCFA — pilote depuis le BO
  withdrawal_fee_fixed: 0,        // FCFA — 0 par defaut
  max_auto_payout_amount: 50_000, // FCFA — plafond pour declenchement auto Payout
  max_amount_no_kyc: 50_000,      // FCFA
  active_payment_provider: 'fedapay' as 'fedapay' | 'kkiapay', // PSP actif
  referral_lifetime_active: true,
  channel_push: true,
  channel_email: true,
  channel_whatsapp: true,
} as const;

type SettingKey = keyof typeof SETTING_DEFAULTS;
type SettingValue = (typeof SETTING_DEFAULTS)[SettingKey];

const KEYS = Object.keys(SETTING_DEFAULTS) as SettingKey[];

// GET /v1/admin/settings — returns the merged DB + defaults map.
router.get('/', async (_req, res) => {
  const rows = await prisma.platformSetting.findMany({ where: { key: { in: KEYS } } });
  const stored = new Map(rows.map((r) => [r.key, r.value as SettingValue]));
  const settings: Record<SettingKey, SettingValue> = { ...SETTING_DEFAULTS };
  for (const k of KEYS) {
    if (stored.has(k)) settings[k] = stored.get(k) as SettingValue;
  }
  res.json({
    settings,
    admins: env.adminEmails,
  });
});

const updateSchema = z.object({
  value: z.union([z.number(), z.boolean(), z.string()]),
});

// PATCH /v1/admin/settings/:key
router.patch('/:key', validate(updateSchema), async (req, res) => {
  const key = req.params.key as string;
  if (!KEYS.includes(key as SettingKey)) {
    res.status(400).json({ error: { code: 'UNKNOWN_KEY', message: 'Unknown setting key' } });
    return;
  }
  const { value } = req.body as z.infer<typeof updateSchema>;
  const saved = await prisma.platformSetting.upsert({
    where: { key },
    update: { value },
    create: { key, value },
  });
  // Le mobile + backend lisent les settings via getPlatformSettings() (cache 60s).
  // On invalide immédiatement pour que la nouvelle valeur soit prise en compte sans attendre.
  invalidatePlatformSettings();
  res.json({ key: saved.key, value: saved.value });
});

export default router;
