// WhatsApp service — wraps our self-hosted WAHA (https://waha.devlike.pro/) container.
// WAHA exposes a REST API that proxies a real WhatsApp Web session.
// We use the /api/sendText endpoint to push plain-text messages.
import axios, { AxiosError } from 'axios';
import { env } from '../config/env';
import { logger } from '../lib/logger';

const TIMEOUT_MS = 15_000;

/**
 * Convert an E.164 phone number (e.g. "+22990123456") to the WhatsApp chatId
 * format expected by WAHA ("22990123456@c.us"). Returns null if the phone is
 * not in a recognizable format — caller should fallback to email.
 */
export function phoneToChatId(phoneE164: string): string | null {
  const cleaned = phoneE164.replace(/[^\d]/g, '');
  if (cleaned.length < 8 || cleaned.length > 15) return null;
  return `${cleaned}@c.us`;
}

type SendTextOk = { id: string };

/**
 * Send a plain-text WhatsApp message via WAHA.
 * Returns the WAHA message id on success. Throws on failure (caller handles fallback).
 */
export async function sendWhatsAppText(toPhone: string, text: string): Promise<SendTextOk> {
  if (!env.WAHA_URL) {
    if (env.isDev) {
      logger.info({ toPhone, preview: text.slice(0, 60) }, '💬 [MOCK] WAHA_URL not set, WhatsApp not sent');
      return { id: 'mock' };
    }
    throw new Error('WAHA_URL not configured');
  }

  const chatId = phoneToChatId(toPhone);
  if (!chatId) {
    throw new Error(`Invalid phone for WhatsApp: ${toPhone}`);
  }

  const url = `${env.WAHA_URL.replace(/\/$/, '')}/api/sendText`;
  try {
    const res = await axios.post(
      url,
      {
        chatId,
        text,
        session: env.WAHA_SESSION,
      },
      {
        timeout: TIMEOUT_MS,
        headers: env.WAHA_API_KEY ? { 'X-Api-Key': env.WAHA_API_KEY } : undefined,
      },
    );

    const id = (res.data?.id?._serialized as string | undefined) ?? res.data?.id ?? 'unknown';
    logger.info({ toPhone, chatId, id }, '✅ WhatsApp message sent via WAHA');
    return { id };
  } catch (err) {
    const ax = err as AxiosError;
    const data = ax.response?.data as { error?: string; message?: string } | undefined;
    logger.error(
      {
        toPhone,
        chatId,
        status: ax.response?.status,
        body: data,
        message: ax.message,
      },
      '❌ WAHA send failed',
    );
    throw new Error(
      `WhatsApp send failed (${ax.response?.status ?? 'no response'}): ${
        data?.message ?? data?.error ?? ax.message
      }`,
    );
  }
}

/**
 * Health check — returns true if the WAHA session is currently WORKING (connected to a WhatsApp account).
 * Used by /v1/admin/health to surface a sidebar warning if WhatsApp is offline.
 */
export async function checkWahaSession(): Promise<{ status: string; ok: boolean }> {
  if (!env.WAHA_URL) return { status: 'NOT_CONFIGURED', ok: false };
  try {
    const res = await axios.get(`${env.WAHA_URL.replace(/\/$/, '')}/api/sessions/${env.WAHA_SESSION}`, {
      timeout: TIMEOUT_MS,
      headers: env.WAHA_API_KEY ? { 'X-Api-Key': env.WAHA_API_KEY } : undefined,
    });
    const status = (res.data?.status as string) ?? 'UNKNOWN';
    return { status, ok: status === 'WORKING' };
  } catch (err) {
    const ax = err as AxiosError;
    logger.warn({ err: ax.message }, 'WAHA health check failed');
    return { status: 'UNREACHABLE', ok: false };
  }
}
