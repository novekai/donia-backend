// FedaPay service — client + helpers
// Doc: https://docs.fedapay.com
// Auth: Bearer SECRET_KEY
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
  env.FEDAPAY_ENV === 'live'
    ? 'https://api.fedapay.com'
    : 'https://sandbox-api.fedapay.com';

function getClient(): AxiosInstance {
  if (!env.FEDAPAY_SECRET_KEY) {
    throw new Error('FEDAPAY_SECRET_KEY not configured');
  }
  return axios.create({
    baseURL: BASE_URL,
    timeout: 30000,
    headers: {
      Authorization: `Bearer ${env.FEDAPAY_SECRET_KEY}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
  });
}

// ─────────────────────────── TYPES ───────────────────────────

export type FedapayTxStatus = 'pending' | 'approved' | 'declined' | 'canceled' | 'refunded' | 'transferred';

export type CreateTransactionInput = {
  amount: number;                  // in XOF (integer, no decimals for XOF)
  description: string;
  currency?: { iso: 'XOF' | 'XAF' | 'EUR' | 'USD' };
  callback_url?: string;           // webhook URL (we'll mostly rely on global webhook config)
  customer: {
    firstname?: string;
    lastname?: string;
    email?: string;
    phone_number?: { number: string; country: string }; // e.g. { number: "90123456", country: "bj" }
  };
  metadata?: Record<string, string | number | boolean>;
};

export type FedapayTransaction = {
  id: number;
  reference: string;
  status: FedapayTxStatus;
  amount: number;
  description: string;
  customer_id?: number;
  created_at: string;
  metadata?: Record<string, unknown>;
};

// ─────────────────────────── CREATE TRANSACTION ───────────────────────────

export async function createTransaction(input: CreateTransactionInput): Promise<FedapayTransaction> {
  const client = getClient();
  const body = {
    ...input,
    currency: input.currency ?? { iso: 'XOF' },
  };
  const { data } = await client.post('/v1/transactions', body);
  // FedaPay wraps the resource: { "v1/transaction": { ... } }
  const tx: FedapayTransaction = (data?.['v1/transaction'] ?? data) as FedapayTransaction;
  return tx;
}

// ─────────────────────────── GENERATE PAYMENT URL ───────────────────────────

export type FedapayPaymentToken = {
  token: string;
  url: string;
};

export async function generatePaymentToken(transactionId: number): Promise<FedapayPaymentToken> {
  const client = getClient();
  const { data } = await client.post(`/v1/transactions/${transactionId}/token`, {});
  return {
    token: data?.token,
    url: data?.url,
  };
}

// ─────────────────────────── GET TRANSACTION ───────────────────────────

export async function getTransaction(transactionId: number): Promise<FedapayTransaction> {
  const client = getClient();
  const { data } = await client.get(`/v1/transactions/${transactionId}`);
  return (data?.['v1/transaction'] ?? data) as FedapayTransaction;
}

// ─────────────────────────── PAYOUTS (virements sortants) ───────────────────────────
// Doc: https://docs.fedapay.com/payouts
// IMPORTANT : l'API Payouts doit etre activee dans le dashboard FedaPay merchant
// (demande commerciale a faire chez FedaPay). Sans activation, createPayout throw.
// Le code gere ce cas en fallback PENDING manuel cote wallet/withdraw.

export type FedapayPayoutStatus =
  | 'pending'
  | 'started'
  | 'sent'
  | 'approved'
  | 'declined'
  | 'canceled'
  | 'failed';

// Mode = canal Mobile Money. Mapping donne par FedaPay (a verifier dans leur dashboard).
// Les codes "_open" sont generiques par operateur ; les codes pays-specifiques aussi.
export type FedapayPayoutMode =
  | 'mtn_open'      // MTN (BJ / CI selon activation)
  | 'mtn_ci'        // MTN CI
  | 'moov_open'     // Moov (BJ / TG)
  | 'moov_tg'       // Moov Togo
  | 'moov_ci'       // Moov CI
  | 'orange_sn'     // Orange Senegal
  | 'orange_ci'     // Orange CI
  | 'orange_ml'     // Orange Mali
  | 'orange_bf'     // Orange Burkina
  | 'wave_sn'       // Wave Senegal
  | 'wave_ci'       // Wave CI
  | 'free_sn';      // Free Senegal

export type CreatePayoutInput = {
  amount: number;                  // XOF integer
  currency?: { iso: 'XOF' | 'XAF' };
  mode: FedapayPayoutMode;
  customer: {
    firstname?: string;
    lastname?: string;
    email?: string;
    phone_number: { number: string; country: string };
  };
  description?: string;
  metadata?: Record<string, string | number | boolean>;
};

export type FedapayPayout = {
  id: number;
  status: FedapayPayoutStatus;
  amount: number;
  reference?: string;
  mode?: string;
  created_at?: string;
  metadata?: Record<string, unknown>;
};

// 1. Cree le payout en "pending" (pas encore parti).
export async function createPayout(input: CreatePayoutInput): Promise<FedapayPayout> {
  const client = getClient();
  const body = { ...input, currency: input.currency ?? { iso: 'XOF' } };
  const { data } = await client.post('/v1/payouts', body);
  return (data?.['v1/payout'] ?? data) as FedapayPayout;
}

// 2. Declenche l'envoi effectif. FedaPay enverra ensuite le webhook payout.approved / payout.declined.
export async function startPayout(payoutId: number): Promise<FedapayPayout> {
  const client = getClient();
  const { data } = await client.put(`/v1/payouts/${payoutId}/start`, {});
  return (data?.['v1/payout'] ?? data) as FedapayPayout;
}

// Mappe operateur Donia + pays user vers le mode FedaPay.
// Retourne null si la combinaison n'est pas supportee (fallback manuel BO).
export function resolvePayoutMode(operator: string, country: string): FedapayPayoutMode | null {
  const c = country.toUpperCase();
  switch (operator) {
    case 'mtn':
      if (c === 'BJ') return 'mtn_open';
      if (c === 'CI') return 'mtn_ci';
      return null;
    case 'moov':
      if (c === 'BJ') return 'moov_open';
      if (c === 'TG') return 'moov_tg';
      if (c === 'CI') return 'moov_ci';
      return null;
    case 'orange':
      if (c === 'SN') return 'orange_sn';
      if (c === 'CI') return 'orange_ci';
      if (c === 'ML') return 'orange_ml';
      if (c === 'BF') return 'orange_bf';
      return null;
    case 'wave':
      if (c === 'SN') return 'wave_sn';
      if (c === 'CI') return 'wave_ci';
      return null;
    default:
      return null;
  }
}

// ─────────────────────────── WEBHOOK SIGNATURE VERIFY ───────────────────────────

// FedaPay envoie une signature au format Stripe-style :
//   X-FedaPay-Signature: t=<unix_seconds>,s=<hex_hmac_sha256>
// La signature est calculée sur `<timestamp>.<raw_body>` avec FEDAPAY_WEBHOOK_SECRET.
// Si le format simple (sans préfixe t=) arrive on accepte aussi en fallback.
const MAX_AGE_SECONDS = 5 * 60; // reject anything older than 5 minutes (anti-replay)

export function verifyWebhookSignature(rawBody: Buffer | string, signatureHeader: string | undefined): boolean {
  if (!env.FEDAPAY_WEBHOOK_SECRET) {
    logger.warn('FEDAPAY_WEBHOOK_SECRET not set — accepting webhook without verification (dev only)');
    return env.isDev;
  }
  if (!signatureHeader) return false;

  const bodyStr = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
  const secret = env.FEDAPAY_WEBHOOK_SECRET;

  // Parse t=…,s=… (comma-separated key=value). Fall back to raw signature if no t/s pair found.
  const parts: Record<string, string> = {};
  for (const seg of signatureHeader.split(',')) {
    const [k, v] = seg.split('=');
    if (k && v) parts[k.trim()] = v.trim();
  }
  const timestamp = parts.t;
  const signature = parts.s;

  // Candidate 1: Stripe-style "t.body"
  if (timestamp && signature) {
    const ageSec = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
    if (Number.isFinite(ageSec) && ageSec > MAX_AGE_SECONDS) {
      logger.warn({ ageSec }, 'FedaPay webhook : timestamp too old, rejecting');
      return false;
    }
    if (constantTimeHexEqual(signature, hmacHex(secret, `${timestamp}.${bodyStr}`))) return true;
    // Some integrations sign the body only, even with a t= prefix.
    if (constantTimeHexEqual(signature, hmacHex(secret, bodyStr))) return true;
    return false;
  }

  // Candidate 2: raw hex signature (legacy)
  return constantTimeHexEqual(signatureHeader, hmacHex(secret, bodyStr));
}

function hmacHex(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

function constantTimeHexEqual(a: string, b: string): boolean {
  try {
    const ba = Buffer.from(a, 'hex');
    const bb = Buffer.from(b, 'hex');
    if (ba.length === 0 || ba.length !== bb.length) return false;
    return timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

// ─────────────────────────── PROVIDER WRAPPER ───────────────────────────
// Wrapper qui expose FedaPay via l'interface PaymentProvider unifiee.
// Le code existant (webhook etc.) peut continuer a appeler createTransaction/
// generatePaymentToken/createPayout directement.

function fedapayIsConfigured(): boolean {
  return Boolean(env.FEDAPAY_SECRET_KEY);
}

async function fedapayCreateTopup(input: TopupInput): Promise<TopupResult> {
  // Pour les cartes bancaires, FedaPay demande currency=EUR pour ouvrir le formulaire carte.
  const isCard = input.operator === 'card';
  const fedaCurrency: 'XOF' | 'EUR' = input.currency === 'EUR' || isCard ? 'EUR' : 'XOF';
  const FCFA_PER_EUR = 655.957;
  const fedaAmount =
    fedaCurrency === 'EUR'
      ? Math.round((input.amountFcfa / FCFA_PER_EUR) * 100) / 100
      : Math.round(input.amountFcfa);

  // E.164 → strip + et indicatif pour FedaPay
  const localNumber = input.customer.phone.replace(/^\+\d{1,3}/, '').replace(/\D/g, '');

  const fedaTx = await createTransaction({
    amount: fedaAmount,
    currency: { iso: fedaCurrency },
    description: input.description,
    callback_url: input.callbackUrl,
    customer: {
      firstname: input.customer.firstname,
      lastname: input.customer.lastname,
      email: input.customer.email ?? undefined,
      phone_number: { number: localNumber, country: input.country.toLowerCase() },
    },
    metadata: { ...(input.metadata ?? {}), currency: fedaCurrency },
  });
  const token = await generatePaymentToken(fedaTx.id);
  return { paymentUrl: token.url, providerTxId: String(fedaTx.id) };
}

async function fedapayCreatePayout(input: PayoutInput): Promise<PayoutResult> {
  const mode = resolvePayoutMode(input.operator, input.country);
  if (!mode) {
    throw new Error(`FedaPay : operateur/pays non supporte (${input.operator}/${input.country})`);
  }
  const localNumber = input.customer.phone.replace(/^\+\d{1,3}/, '').replace(/\D/g, '');
  const payout = await createPayout({
    amount: Math.round(input.amountFcfa),
    mode,
    description: input.description,
    customer: {
      firstname: input.customer.firstname,
      lastname: input.customer.lastname,
      phone_number: { number: localNumber, country: input.country.toLowerCase() },
    },
    metadata: input.metadata,
  });
  const started = await startPayout(payout.id);
  return {
    providerPayoutId: String(payout.id),
    status: mapFedaPayoutStatus(started.status),
  };
}

function mapFedaPayoutStatus(s: FedapayPayoutStatus): PayoutResult['status'] {
  if (s === 'approved' || s === 'sent') return 'approved';
  if (s === 'declined' || s === 'canceled') return 'declined';
  if (s === 'failed') return 'failed';
  return 'pending';
}

export const fedapayProvider: PaymentProvider = {
  key: 'fedapay',
  isConfigured: fedapayIsConfigured,
  createTopup: fedapayCreateTopup,
  createPayout: fedapayCreatePayout,
  verifyWebhookSignature,
};
