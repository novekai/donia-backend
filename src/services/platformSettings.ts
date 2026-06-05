// Lecture des paramètres de plateforme depuis la table PlatformSetting.
// Utilise un cache mémoire 60s pour éviter une lecture DB à chaque création de carte.
// Les valeurs sont éditables depuis l'admin (PATCH /v1/admin/settings/:key).
// Si une clé n'a jamais été écrite, on retombe sur le défaut défini ici.
import { prisma } from '../lib/prisma';

export const SETTING_DEFAULTS = {
  commission_rate: 5,           // % prélevé sur conversion (0–100)
  min_card_amount: 500,         // FCFA
  max_amount_no_kyc: 50_000,    // FCFA — au-delà : KYC obligatoire
  referral_lifetime_active: true,
  channel_push: true,
  channel_email: true,
  channel_whatsapp: true,
  // channel_sms volontairement retiré (06/2026) — Donia n'utilise pas le SMS.
} as const;

export type PlatformSettings = typeof SETTING_DEFAULTS;
export type SettingKey = keyof PlatformSettings;

const KEYS = Object.keys(SETTING_DEFAULTS) as SettingKey[];

type CacheEntry = { values: PlatformSettings; expiresAt: number };
const CACHE_TTL_MS = 60_000;
let cache: CacheEntry | null = null;

export async function getPlatformSettings(): Promise<PlatformSettings> {
  const now = Date.now();
  if (cache && cache.expiresAt > now) return cache.values;

  const rows = await prisma.platformSetting.findMany({ where: { key: { in: KEYS } } });
  const stored = new Map(rows.map((r) => [r.key, r.value]));
  const values = { ...SETTING_DEFAULTS } as Record<SettingKey, unknown>;
  for (const k of KEYS) {
    if (stored.has(k)) values[k] = stored.get(k);
  }
  cache = { values: values as PlatformSettings, expiresAt: now + CACHE_TTL_MS };
  return cache.values;
}

// Invalide le cache — à appeler depuis le PATCH admin après écriture.
export function invalidatePlatformSettings(): void {
  cache = null;
}

// Helper typé pour récupérer une seule valeur numérique avec garde-fou.
export async function getNumericSetting(key: SettingKey, fallback: number): Promise<number> {
  const all = await getPlatformSettings();
  const v = all[key];
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  return fallback;
}

export async function getBoolSetting(key: SettingKey, fallback: boolean): Promise<boolean> {
  const all = await getPlatformSettings();
  const v = all[key];
  if (typeof v === 'boolean') return v;
  return fallback;
}
