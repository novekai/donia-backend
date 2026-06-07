// Env loader + validation (fail fast at boot if something missing)
import 'dotenv/config';
import { z } from 'zod';

// Trim trailing whitespace from ALL env values before validation.
// Railway/Docker/copy-paste sometimes adds stray \n or spaces that break strict enums.
for (const k of Object.keys(process.env)) {
  const v = process.env[k];
  if (typeof v === 'string') process.env[k] = v.trim();
}

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(3000),

  DATABASE_URL: z.string().url(),

  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 chars'),
  JWT_EXPIRES_IN: z.string().default('30d'),

  // Back-office admin auth — env-based for now (no Admin table).
  // ADMIN_EMAILS is a comma-separated whitelist; ADMIN_PASSWORD_HASH is a single
  // shared bcrypt hash (use `node -e "require('bcryptjs').hash('YOURPW',10).then(console.log)"`).
  ADMIN_EMAILS: z.string().default(''),
  ADMIN_PASSWORD_HASH: z.string().default(''),
  ADMIN_JWT_EXPIRES_IN: z.string().default('7d'),

  OTP_CODE_LENGTH: z.coerce.number().int().min(4).max(8).default(6),
  OTP_TTL_MINUTES: z.coerce.number().int().min(1).max(60).default(10),

  COMMISSION_RATE: z.coerce.number().min(0).max(1).default(0.05),
  REFERRAL_RATE: z.coerce.number().min(0).max(1).default(0.01),
  SUPPORTED_COUNTRIES: z.string().default('BJ,CI,SN,TG,BF,ML,NE,GN,GH,CM'),
  CARD_CODE_PREFIX: z.string().default('DON-2026'),

  FEDAPAY_PUBLIC_KEY: z.string().optional(),
  FEDAPAY_SECRET_KEY: z.string().optional(),
  FEDAPAY_ENV: z.enum(['sandbox', 'live']).default('sandbox'),
  FEDAPAY_WEBHOOK_SECRET: z.string().optional(),

  // KKiaPay (PSP alternatif a FedaPay). Le provider actif est pilote depuis le BO
  // via la setting `active_payment_provider`. Mettre les cles ici en .env mais pas
  // besoin de les changer pour switcher (c'est instantane cote BO).
  KKIAPAY_PUBLIC_KEY: z.string().optional(),
  KKIAPAY_PRIVATE_KEY: z.string().optional(),
  KKIAPAY_SECRET_KEY: z.string().optional(),     // signature webhook
  KKIAPAY_ENV: z.enum(['sandbox', 'live']).default('sandbox'),

  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().default('Donia <hello@doniia.com>'),

  // Cloudflare R2 (S3-compatible) for profile photos + anonymes visuals
  R2_ACCOUNT_ID: z.string().optional(),
  R2_ACCESS_KEY_ID: z.string().optional(),
  R2_SECRET_ACCESS_KEY: z.string().optional(),
  R2_BUCKET: z.string().default('donia-media'),
  R2_PUBLIC_URL: z.string().optional(), // e.g. https://cdn.doniia.com or https://pub-xxx.r2.dev

  // WAHA — self-hosted WhatsApp HTTP API (notre container Railway).
  // WAHA_URL ex: https://waha-production.up.railway.app
  // WAHA_API_KEY: header X-Api-Key envoyé sur chaque requête (optionnel selon config WAHA)
  // WAHA_SESSION: nom de la session (par défaut "default")
  WAHA_URL: z.string().url().optional(),
  WAHA_API_KEY: z.string().optional(),
  WAHA_SESSION: z.string().default('default'),

  // Legacy — Meta WhatsApp Cloud API (non utilisé pour l'instant, on garde au cas où on migre)
  WHATSAPP_TOKEN: z.string().optional(),
  WHATSAPP_PHONE_NUMBER_ID: z.string().optional(),

  // SMS désactivé — Donia n'envoie pas de SMS pour l'instant. Email + WhatsApp uniquement.
  SMS_PROVIDER: z.enum(['twilio', 'mock', 'disabled']).default('disabled'),
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_PHONE_NUMBER: z.string().optional(),

  CORS_ORIGINS: z.string().default('http://localhost:8081,http://localhost:5173'),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('❌ Invalid environment variables:');
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = {
  ...parsed.data,
  isDev: parsed.data.NODE_ENV === 'development',
  isProd: parsed.data.NODE_ENV === 'production',
  supportedCountries: parsed.data.SUPPORTED_COUNTRIES.split(',').map((c) => c.trim()),
  corsOrigins: parsed.data.CORS_ORIGINS.split(',').map((o) => o.trim()),
  adminEmails: parsed.data.ADMIN_EMAILS.split(',').map((e) => e.trim().toLowerCase()).filter(Boolean),
};
