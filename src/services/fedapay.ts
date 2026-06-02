// FedaPay service — client + helpers
// Doc: https://docs.fedapay.com
// Auth: Bearer SECRET_KEY
import axios, { type AxiosInstance } from 'axios';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../config/env';
import { logger } from '../lib/logger';

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
