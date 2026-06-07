// KKiaPay service — implementation du PaymentProvider.
// Doc: https://docs.kkiapay.me
// Auth: header `x-api-key` (private key) + `x-private-key` (private) selon l'endpoint.
// Webhook: signature HMAC-SHA256 du body avec KKIAPAY_SECRET_KEY (header `x-kkiapay-signature`).
import axios, { type AxiosInstance } from 'axios';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../config/env';
import { logger } from '../lib/logger';
import type {
  PaymentProvider,
  PayoutInput,
  PayoutResult,
  TopupInput,
  TopupResult,
} from './paymentProvider';

const BASE_URL =
  env.KKIAPAY_ENV === 'live' ? 'https://api.kkiapay.me' : 'https://api-sandbox.kkiapay.me';

function getClient(): AxiosInstance {
  if (!env.KKIAPAY_PRIVATE_KEY) {
    throw new Error('KKIAPAY_PRIVATE_KEY not configured');
  }
  return axios.create({
    baseURL: BASE_URL,
    timeout: 30000,
    headers: {
      'x-api-key': env.KKIAPAY_PRIVATE_KEY,
      'x-private-key': env.KKIAPAY_PRIVATE_KEY,
      ...(env.KKIAPAY_SECRET_KEY ? { 'x-secret-key': env.KKIAPAY_SECRET_KEY } : {}),
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
  });
}

// FCFA fixe XOF/EUR pour la cohérence quand l'user paie en euro depuis la diaspora.
const FCFA_PER_EUR = 655.957;

function isConfigured(): boolean {
  return Boolean(env.KKIAPAY_PRIVATE_KEY && env.KKIAPAY_PUBLIC_KEY);
}

// ─── TOPUP (encaissement) ────────────────────────────────────────────────
// KKiaPay propose 2 modes :
//  - Widget JS cote front (le plus courant)
//  - API REST `POST /api/v1/payments/init` qui renvoie une URL hostee
// On utilise l'API REST pour rester aligne sur le pattern FedaPay (URL → WebView).
async function createTopup(input: TopupInput): Promise<TopupResult> {
  const client = getClient();
  // KKiaPay accepte XOF ou EUR. Si l'user paie en EUR (carte bancaire diaspora),
  // on envoie EUR avec le montant converti.
  const isEur = input.currency === 'EUR';
  const amount = isEur
    ? Math.round((input.amountFcfa / FCFA_PER_EUR) * 100) / 100
    : Math.round(input.amountFcfa);
  const body = {
    amount,
    currency: isEur ? 'EUR' : 'XOF',
    reason: input.description,
    name: [input.customer.firstname, input.customer.lastname].filter(Boolean).join(' '),
    email: input.customer.email ?? undefined,
    phone: input.customer.phone,
    country: input.country.toUpperCase(),
    data: JSON.stringify(input.metadata ?? {}),
    sandbox: env.KKIAPAY_ENV !== 'live',
  };

  const { data } = await client.post('/api/v1/payments/init', body);
  // Reponse attendue: { transactionId, payment_url } (a confirmer selon doc KKiaPay)
  const providerTxId = (data?.transactionId ?? data?.id ?? data?.reference) as string;
  const paymentUrl = (data?.payment_url ?? data?.url) as string;

  if (!paymentUrl || !providerTxId) {
    throw new Error('KKiaPay : reponse inattendue (pas de payment_url)');
  }
  return { paymentUrl, providerTxId: String(providerTxId) };
}

// ─── PAYOUT (cosh-cosh / virement sortant) ───────────────────────────────
// KKiaPay appelle ca "cosh-cosh" (envoi d'argent vers un MM).
// Endpoint : `POST /api/v1/transfers` (a verifier selon doc).
async function createPayout(input: PayoutInput): Promise<PayoutResult> {
  const client = getClient();
  const body = {
    amount: Math.round(input.amountFcfa),
    currency: 'XOF',
    reason: input.description,
    receiver: {
      fullname: [input.customer.firstname, input.customer.lastname].filter(Boolean).join(' '),
      phone: input.customer.phone,
      country: input.country.toUpperCase(),
    },
    network: mapKkiapayNetwork(input.operator, input.country),
    data: JSON.stringify(input.metadata ?? {}),
    sandbox: env.KKIAPAY_ENV !== 'live',
  };
  const { data } = await client.post('/api/v1/transfers', body);
  const id = (data?.transactionId ?? data?.id ?? data?.reference) as string;
  const status = (data?.status ?? 'pending') as string;
  if (!id) throw new Error('KKiaPay payout : reponse inattendue (pas dID)');

  return {
    providerPayoutId: String(id),
    status: mapKkiapayPayoutStatus(status),
  };
}

// KKiaPay utilise des codes reseau differents (a verifier dans leur doc).
function mapKkiapayNetwork(operator: string, country: string): string {
  const c = country.toUpperCase();
  switch (operator) {
    case 'mtn':
      return c === 'CI' ? 'mtn_ci' : 'mtn';
    case 'moov':
      return c === 'TG' ? 'moov_tg' : 'moov';
    case 'orange':
      if (c === 'CI') return 'orange_ci';
      if (c === 'ML') return 'orange_ml';
      if (c === 'BF') return 'orange_bf';
      return 'orange_sn';
    case 'wave':
      return c === 'CI' ? 'wave_ci' : 'wave_sn';
    default:
      return operator;
  }
}

function mapKkiapayPayoutStatus(s: string): PayoutResult['status'] {
  const v = s.toLowerCase();
  if (v === 'success' || v === 'completed' || v === 'approved' || v === 'sent') return 'approved';
  if (v === 'failed' || v === 'declined' || v === 'rejected') return 'failed';
  if (v === 'canceled' || v === 'cancelled') return 'declined';
  return 'pending';
}

// ─── Webhook signature ───────────────────────────────────────────────────
// KKiaPay : header `x-kkiapay-signature` = hex HMAC-SHA256(rawBody, SECRET_KEY).
function verifyWebhookSignature(rawBody: Buffer | string, signatureHeader: string | undefined): boolean {
  if (!env.KKIAPAY_SECRET_KEY) {
    logger.warn('KKIAPAY_SECRET_KEY not set — webhook accepte en dev uniquement');
    return env.isDev;
  }
  if (!signatureHeader) return false;
  const bodyStr = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
  const expected = createHmac('sha256', env.KKIAPAY_SECRET_KEY).update(bodyStr).digest('hex');
  try {
    const a = Buffer.from(signatureHeader.replace(/^sha256=/, ''), 'hex');
    const b = Buffer.from(expected, 'hex');
    if (a.length === 0 || a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// ─── Export provider ──────────────────────────────────────────────────────
export const kkiapayProvider: PaymentProvider = {
  key: 'kkiapay',
  isConfigured,
  createTopup,
  createPayout,
  verifyWebhookSignature,
};

// ─── Types pour le webhook ────────────────────────────────────────────────
// KKiaPay envoie au format : { transactionId, status, amount, data, ... }
export type KkiapayWebhookPayload = {
  transactionId?: string;
  reference?: string;
  status?: string;          // SUCCESS / FAILED / PENDING / etc.
  amount?: number;
  type?: string;            // 'payment' | 'transfer'
  data?: string;            // JSON stringified metadata
};
