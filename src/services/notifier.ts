// Notifier — orchestrates OTP and transactional messages across Email + WhatsApp.
// Email goes through Resend; WhatsApp goes through our self-hosted WAHA.
// SMS is currently disabled (see env.SMS_PROVIDER = 'disabled').
import { Resend } from 'resend';
import { logger } from '../lib/logger';
import { env } from '../config/env';
import { otpEmailTemplate, cardReceivedTemplate } from './email-templates';
import { sendWhatsAppText, resolveWhatsAppNumber } from './whatsapp';
import { whatsAppOtp, whatsAppCardDelivery } from './whatsapp-templates';

type Channel = 'SMS' | 'WHATSAPP' | 'EMAIL';

// ─────────────────────────── EMAIL (Resend) ───────────────────────────

const resend = env.RESEND_API_KEY ? new Resend(env.RESEND_API_KEY) : null;

async function sendEmail(to: string, subject: string, html: string, text: string): Promise<void> {
  if (!resend) {
    logger.warn({ to, subject }, '📭 [MOCK] RESEND_API_KEY not set, email not sent');
    return;
  }
  const { data, error } = await resend.emails.send({
    from: env.EMAIL_FROM,
    to: [to],
    subject,
    html,
    text,
  });
  if (error) {
    logger.error({ err: error, to, subject }, '❌ Resend send failed');
    throw new Error(`Email send failed: ${error.message}`);
  }
  logger.info({ to, subject, id: data?.id }, '✉️ Email sent');
}

// ─────────────────────────── OTP DISPATCHER ───────────────────────────

export async function sendOtp(contact: string, channel: Channel, code: string): Promise<void> {
  if (channel === 'EMAIL') {
    const tmpl = otpEmailTemplate({ code, expiresInMinutes: env.OTP_TTL_MINUTES });
    await sendEmail(contact, tmpl.subject, tmpl.html, tmpl.text);
    return;
  }

  if (channel === 'WHATSAPP') {
    const text = whatsAppOtp({ code, expiresInMinutes: env.OTP_TTL_MINUTES });
    // 1. Résoudre le bon format du numéro (Bénin : on bascule entre +229XXXXXXXX
    //    et +22901XXXXXXXX selon ce qui a un compte WhatsApp actif).
    const resolved = await resolveWhatsAppNumber(contact);
    if (!resolved) {
      // Aucun des formats n'a de compte WhatsApp → message clair pour le user.
      throw new Error(
        `Ce numéro (${contact}) n'a pas de compte WhatsApp actif. Vérifie que tu utilises bien le numéro associé à ton WhatsApp, ou utilise le canal Email.`,
      );
    }
    await sendWhatsAppText(resolved, text);
    return;
  }

  // SMS is disabled platform-wide. Log in dev for debugging, reject in prod.
  if (channel === 'SMS') {
    if (env.isDev) {
      logger.info({ contact, code }, '🔑 [MOCK] SMS provider disabled, OTP not sent');
      return;
    }
    throw new Error('SMS channel is disabled — use EMAIL or WHATSAPP for OTP');
  }

  throw new Error(`Unknown OTP channel: ${channel}`);
}

// ─────────────────────────── CARD DELIVERY ───────────────────────────

type CardDeliveryArgs = {
  code: string;
  sender: string;
  amount: string;
  recipientName?: string;
  message?: string;
  redeemUrl?: string;
};

export async function sendCardEmail(toEmail: string, args: CardDeliveryArgs): Promise<void> {
  const tmpl = cardReceivedTemplate({
    recipientName: args.recipientName,
    senderName: args.sender,
    amount: args.amount,
    redeemCode: args.code,
    message: args.message,
  });
  await sendEmail(toEmail, tmpl.subject, tmpl.html, tmpl.text);
}

export async function sendCardWhatsApp(toPhone: string, args: CardDeliveryArgs): Promise<void> {
  const text = whatsAppCardDelivery({
    recipientName: args.recipientName,
    senderName: args.sender,
    amount: args.amount,
    redeemCode: args.code,
    message: args.message,
    redeemUrl: args.redeemUrl,
  });
  // Le destinataire peut avoir un numéro avec ou sans le 01 (Bénin) → on résout.
  const resolved = await resolveWhatsAppNumber(toPhone);
  if (!resolved) {
    throw new Error(
      `Le destinataire (${toPhone}) n'a pas de compte WhatsApp actif. Demande à l'expéditeur de vérifier le numéro WhatsApp ou de choisir la livraison par email.`,
    );
  }
  await sendWhatsAppText(resolved, text);
}
