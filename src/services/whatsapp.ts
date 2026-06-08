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
 * Pour les numéros béninois (+229), la majorité des comptes WhatsApp sont
 * historiquement enregistrés sous l'ancien format à 8 chiffres (sans le préfixe
 * 01 ajouté en 2021). On strip donc systématiquement le 01 pour WAHA, avec un
 * fallback au format avec 01 si le compte est introuvable sous le format strip.
 *
 * preferredBeninFormat : si le numéro est +22901XXXXXXXX, renvoie +229XXXXXXXX.
 * beninRetryVariant : si on a essayé le format A, renvoie le format B.
 */
export function preferredBeninFormat(phoneE164: string): string | null {
  if (!phoneE164.startsWith('+229')) return null;
  const local = phoneE164.slice(4).replace(/\D/g, '');
  if (local.startsWith('01') && local.length === 10) {
    return `+229${local.slice(2)}`;
  }
  return null;
}

export function beninRetryVariant(phoneE164: string): string | null {
  if (!phoneE164.startsWith('+229')) return null;
  const local = phoneE164.slice(4).replace(/\D/g, '');
  if (local.startsWith('01') && local.length === 10) {
    return `+229${local.slice(2)}`;
  }
  if (local.length === 8) {
    return `+22901${local}`;
  }
  return null;
}

/**
 * Vérifie via WAHA si un numéro a un compte WhatsApp actif.
 * WAHA expose GET /api/contacts/check-exists?phone=XXX qui renvoie { numberExists: bool }.
 * En cas d'erreur réseau / WAHA down → renvoie null (le caller doit assumer "peut-être").
 */
export async function checkWhatsAppExists(phoneE164: string): Promise<boolean | null> {
  if (!env.WAHA_URL) return null;
  const cleaned = phoneE164.replace(/[^\d]/g, '');
  if (cleaned.length < 8 || cleaned.length > 15) return false;
  try {
    const res = await axios.get(
      `${env.WAHA_URL.replace(/\/$/, '')}/api/contacts/check-exists`,
      {
        params: { phone: cleaned, session: env.WAHA_SESSION },
        timeout: TIMEOUT_MS,
        headers: env.WAHA_API_KEY ? { 'X-Api-Key': env.WAHA_API_KEY } : undefined,
      },
    );
    // WAHA renvoie soit { numberExists: bool } soit { exists: bool, ... }
    const v = res.data;
    if (typeof v?.numberExists === 'boolean') return v.numberExists;
    if (typeof v?.exists === 'boolean') return v.exists;
    return null;
  } catch (err) {
    const ax = err as AxiosError;
    logger.warn({ phoneE164, status: ax.response?.status, message: ax.message }, 'WAHA check-exists failed');
    return null;
  }
}

/**
 * Résout le bon format WhatsApp pour un numéro :
 * - Tente d'abord avec le numéro tel quel
 * - Si la vérification dit que le compte n'existe pas, tente la variante Bénin (retirer/ajouter 01)
 * - Si la 2e variante existe, on retourne celle-là
 * - Si aucune n'existe : retourne null (le caller doit signaler "pas de WhatsApp")
 * - Si la vérification échoue (WAHA down, …), on retourne le numéro original (let it try anyway)
 */
export async function resolveWhatsAppNumber(phoneE164: string): Promise<string | null> {
  // Priorité Bénin : si le numéro a un préfixe 01, on tente d'abord SANS le 01
  // (ancien format 8 chiffres, majorité des comptes WhatsApp BJ historiques).
  const preferred = preferredBeninFormat(phoneE164) ?? phoneE164;

  const exists = await checkWhatsAppExists(preferred);
  if (exists === true) return preferred;
  if (exists === null) return preferred; // pas pu vérifier → on tente quand même

  // exists === false → tenter la variante alternative
  // Si on a déjà strippé le 01, la variante c'est le format original avec 01
  // Sinon, on calcule la variante via beninRetryVariant
  const variant = preferred !== phoneE164 ? phoneE164 : beninRetryVariant(phoneE164);
  if (!variant) return null;
  const altExists = await checkWhatsAppExists(variant);
  if (altExists === true) return variant;
  // Aucun des 2 n'existe (ou WAHA down sur la 2e) → on signale l'absence
  return altExists === null ? variant : null;
}

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
