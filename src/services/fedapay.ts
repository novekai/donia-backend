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

// FedaPay signe les webhooks avec HMAC-SHA256 du raw body, en utilisant FEDAPAY_WEBHOOK_SECRET.
// Le header (souvent `X-FedaPay-Signature` ou `x-fedapay-signature`) contient le hash hex.
export function verifyWebhookSignature(rawBody: Buffer | string, signatureHeader: string | undefined): boolean {
  if (!env.FEDAPAY_WEBHOOK_SECRET) {
    logger.warn('FEDAPAY_WEBHOOK_SECRET not set — accepting webhook without verification (dev only)');
    return env.isDev; // accept in dev, reject in prod
  }
  if (!signatureHeader) return false;
  const expected = createHmac('sha256', env.FEDAPAY_WEBHOOK_SECRET).update(rawBody).digest('hex');
  try {
    const a = Buffer.from(expected, 'hex');
    const b = Buffer.from(signatureHeader, 'hex');
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
