// Cards routes — create (send), get, redeem (5% commission), react, resend
import { Router } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { requireAuth } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { prisma } from '../lib/prisma';
import { env } from '../config/env';
import { generateRedeemCode } from '../lib/codes';
import { BadRequest, Forbidden, NotFound, Unauthorized } from '../lib/errors';
import { sendCardEmail, sendCardWhatsApp } from '../services/notifier';
import { sendExpoPush } from '../services/push';
import { createTransaction, generatePaymentToken } from '../services/fedapay';
import { logger } from '../lib/logger';

// If the recipient phone matches an existing Donia user, send them a push notif
// + persist a Notification row so it shows in the in-app inbox.
async function notifyRecipientIfDoniaUser(args: {
  recipientPhone: string;
  senderName: string;
  amount: string;
  cardId: string;
  occasion: string;
}) {
  try {
    const recipient = await prisma.user.findFirst({
      where: { phone: args.recipientPhone, deletedAt: null },
      select: { id: true },
    });
    if (!recipient) return;
    await prisma.notification.create({
      data: {
        userId: recipient.id,
        type: 'received_card',
        title: 'Tu as reçu une carte 🎁',
        body: `${args.senderName} t'a envoyé ${args.amount} FCFA.`,
        emoji: '🎁',
        data: { cardId: args.cardId, occasion: args.occasion },
      },
    });
    await sendExpoPush({
      userId: recipient.id,
      title: 'Tu as reçu une carte 🎁',
      body: `${args.senderName} t'a envoyé ${args.amount} FCFA.`,
      data: { type: 'received_card', cardId: args.cardId },
    });
  } catch (e) {
    logger.warn({ err: e }, 'recipient push notification failed (non-fatal)');
  }
}

async function notifyRedeemed(args: {
  senderId: string;
  recipientName?: string | null;
  amount: string;
  cardId: string;
  parrainBonus?: { parrainId: string; bonus: string } | null;
}) {
  try {
    const who = args.recipientName ?? 'Ton destinataire';
    await prisma.notification.create({
      data: {
        userId: args.senderId,
        type: 'card_redeemed',
        title: 'Ton cadeau a été reçu ✨',
        body: `${who} vient de convertir ta carte de ${args.amount} FCFA.`,
        emoji: '✨',
        data: { cardId: args.cardId },
      },
    });
    await sendExpoPush({
      userId: args.senderId,
      title: 'Ton cadeau a été reçu ✨',
      body: `${who} vient de convertir ta carte.`,
      data: { type: 'card_redeemed', cardId: args.cardId },
    });

    if (args.parrainBonus) {
      await prisma.notification.create({
        data: {
          userId: args.parrainBonus.parrainId,
          type: 'referral_bonus',
          title: 'Bonus parrainage 💸',
          body: `Tu viens de gagner ${args.parrainBonus.bonus} FCFA grâce à ton filleul.`,
          emoji: '💸',
          data: { cardId: args.cardId },
        },
      });
      await sendExpoPush({
        userId: args.parrainBonus.parrainId,
        title: 'Bonus parrainage 💸',
        body: `+${args.parrainBonus.bonus} FCFA crédités sur ton wallet.`,
        data: { type: 'referral_bonus' },
      });
    }
  } catch (e) {
    logger.warn({ err: e }, 'redeem push notification failed (non-fatal)');
  }
}

const router = Router();
router.use(requireAuth);

// ── Create / send a card ──
const createSchema = z.object({
  recipientPhone: z.string().regex(/^\+\d{8,15}$/),
  recipientEmail: z.string().email().optional(),
  recipientName: z.string().optional(),
  recipientCountry: z.string().length(2).default('BJ'),
  occasion: z.string().default('bonjour'),
  themeKey: z.string().default('anniversaire'),
  amount: z.number().positive(),
  message: z.string().max(140).optional(),
  palette: z.enum(['coral', 'indigo', 'pink', 'mango', 'mint', 'plum']).default('coral'),
  deliveryChannel: z.enum(['WHATSAPP', 'EMAIL']).default('WHATSAPP'),
});

router.post('/', validate(createSchema), async (req, res) => {
  if (!req.auth) throw Unauthorized();
  const body = req.body as z.infer<typeof createSchema>;
  if (body.deliveryChannel === 'EMAIL' && !body.recipientEmail) {
    throw BadRequest('recipientEmail required for EMAIL delivery');
  }

  const result = await prisma.$transaction(async (tx) => {
    const wallet = await tx.wallet.findUniqueOrThrow({ where: { userId: req.auth!.userId } });
    if (Number(wallet.balancePrincipal) < body.amount) {
      throw BadRequest('Insufficient balance', 'INSUFFICIENT_FUNDS');
    }
    const card = await tx.card.create({
      data: {
        redeemCode: generateRedeemCode(env.CARD_CODE_PREFIX),
        senderId: req.auth!.userId,
        recipientPhone: body.recipientPhone,
        recipientEmail: body.recipientEmail ?? null,
        recipientName: body.recipientName ?? null,
        recipientCountry: body.recipientCountry,
        occasion: body.occasion,
        themeKey: body.themeKey,
        amount: new Prisma.Decimal(body.amount),
        message: body.message ?? null,
        palette: body.palette,
        deliveryChannel: body.deliveryChannel,
        commissionRate: new Prisma.Decimal(env.COMMISSION_RATE),
        status: 'SENT',
        sentAt: new Date(),
      },
    });
    await tx.wallet.update({
      where: { userId: req.auth!.userId },
      data: { balancePrincipal: { decrement: card.amount } },
    });
    await tx.transaction.create({
      data: {
        userId: req.auth!.userId,
        type: 'SEND',
        amount: card.amount,
        status: 'SUCCESS',
        cardId: card.id,
        metadata: { recipientPhone: card.recipientPhone, occasion: card.occasion },
      },
    });
    return card;
  });

  // Fetch sender's first name to personalize the delivery message + push notif.
  const sender = await prisma.user.findUnique({
    where: { id: req.auth.userId },
    select: { name: true },
  });
  const senderName = sender?.name?.split(' ')[0] ?? 'Un proche';

  // Fire delivery (best-effort; in prod move to a queue)
  const deliveryArgs = { code: result.redeemCode, sender: senderName, amount: String(result.amount) };
  try {
    if (result.deliveryChannel === 'EMAIL' && result.recipientEmail) {
      await sendCardEmail(result.recipientEmail, deliveryArgs);
    } else {
      await sendCardWhatsApp(result.recipientPhone, deliveryArgs);
    }
  } catch {
    // ignore — card still exists, can be resent
  }

  // Best-effort push to the recipient if they already have a Donia account.
  await notifyRecipientIfDoniaUser({
    recipientPhone: result.recipientPhone,
    senderName,
    amount: String(result.amount),
    cardId: result.id,
    occasion: result.occasion,
  });

  res.status(201).json({ card: result });
});

// ── Create card paid directly via Mobile Money (no wallet debit) ──
// The card is created in CREATED status; on FedaPay approval webhook, it transitions to SENT
// and the delivery email/whatsapp is fired.
router.post('/pay-mobile-money', validate(createSchema), async (req, res) => {
  if (!req.auth) throw Unauthorized();
  const body = req.body as z.infer<typeof createSchema>;
  if (body.deliveryChannel === 'EMAIL' && !body.recipientEmail) {
    throw BadRequest('recipientEmail required for EMAIL delivery');
  }

  const user = await prisma.user.findUniqueOrThrow({
    where: { id: req.auth.userId },
    select: { id: true, name: true, phone: true, email: true, country: true },
  });

  const { card, localTx } = await prisma.$transaction(async (tx) => {
    const card = await tx.card.create({
      data: {
        redeemCode: generateRedeemCode(env.CARD_CODE_PREFIX),
        senderId: req.auth!.userId,
        recipientPhone: body.recipientPhone,
        recipientEmail: body.recipientEmail ?? null,
        recipientName: body.recipientName ?? null,
        recipientCountry: body.recipientCountry,
        occasion: body.occasion,
        themeKey: body.themeKey,
        amount: new Prisma.Decimal(body.amount),
        message: body.message ?? null,
        palette: body.palette,
        deliveryChannel: body.deliveryChannel,
        commissionRate: new Prisma.Decimal(env.COMMISSION_RATE),
        status: 'CREATED',
      },
    });
    const localTx = await tx.transaction.create({
      data: {
        userId: req.auth!.userId,
        type: 'SEND',
        amount: card.amount,
        status: 'PENDING',
        cardId: card.id,
        metadata: { kind: 'card_payment', cardId: card.id, recipientPhone: card.recipientPhone, occasion: card.occasion },
      },
    });
    return { card, localTx };
  });

  try {
    const [firstname, ...rest] = user.name.split(' ');
    const lastname = rest.join(' ') || firstname;
    const localNumber = user.phone.replace(/^\+\d{1,3}/, '').replace(/\D/g, '');
    const fedaTx = await createTransaction({
      amount: Math.round(body.amount),
      description: `Cadeau Donia · ${body.amount} FCFA`,
      customer: {
        firstname,
        lastname,
        email: user.email ?? undefined,
        phone_number: { number: localNumber, country: user.country.toLowerCase() },
      },
      metadata: { donia_tx_id: localTx.id, kind: 'card_payment', cardId: card.id },
    });

    const token = await generatePaymentToken(fedaTx.id);

    await prisma.transaction.update({
      where: { id: localTx.id },
      data: {
        ref: String(fedaTx.id),
        metadata: { kind: 'card_payment', cardId: card.id, fedapayTxId: fedaTx.id, paymentUrl: token.url },
      },
    });

    res.status(201).json({
      card,
      paymentUrl: token.url,
      fedapayTxId: fedaTx.id,
    });
  } catch (e) {
    logger.error({ err: e, cardId: card.id }, 'FedaPay createTransaction failed for card payment');
    await prisma.$transaction([
      prisma.transaction.update({ where: { id: localTx.id }, data: { status: 'FAILED' } }),
      prisma.card.update({ where: { id: card.id }, data: { status: 'CANCELLED' } }),
    ]);

    // Surface the real FedaPay error message to the mobile client so the user understands.
    // Without this, axios collapses 400s into "Network Error" or generic messages.
    type AxiosLikeErr = { response?: { data?: { message?: string; error?: string } } };
    const ax = e as AxiosLikeErr;
    const fedapayMsg = ax.response?.data?.message ?? ax.response?.data?.error;
    const userMessage = fedapayMsg
      ? `Paiement refusé par FedaPay : ${fedapayMsg}`
      : 'Impossible de démarrer le paiement Mobile Money. Réessaie dans quelques minutes.';
    throw BadRequest(userMessage, 'PAYMENT_INIT_FAILED');
  }
});

// ── Get one card (sender or recipient access) ──
// Le destinataire voit les infos du sender SELON les préférences de confidentialité
// du sender (showPhonePublic, showEmailPublic, showAvatarPublic). Le sender lui-même
// voit toujours ses propres infos en clair.
router.get('/:id', async (req, res) => {
  if (!req.auth) throw Unauthorized();
  const card = await prisma.card.findUnique({
    where: { id: req.params.id },
    include: {
      reactions: true,
      sender: {
        select: {
          id: true, name: true, avatarUrl: true,
          phone: true, email: true, whatsapp: true,
          showPhonePublic: true, showEmailPublic: true, showAvatarPublic: true,
        },
      },
    },
  });
  if (!card) throw NotFound();
  if (card.senderId !== req.auth.userId && card.recipientId !== req.auth.userId) {
    throw Forbidden('Not your card');
  }
  const viewerIsSender = card.senderId === req.auth.userId;
  const s = card.sender;
  const senderPublic = s
    ? {
        id: s.id,
        name: s.name,
        // Si le viewer est le sender, on lui rend tout. Sinon on filtre selon ses préférences.
        avatarUrl: viewerIsSender || s.showAvatarPublic ? s.avatarUrl : null,
        phone: viewerIsSender || s.showPhonePublic ? s.phone : null,
        whatsapp: viewerIsSender || s.showPhonePublic ? s.whatsapp : null,
        email: viewerIsSender || s.showEmailPublic ? s.email : null,
      }
    : null;
  const { sender: _omit, ...cardOut } = card;
  res.json({ card: { ...cardOut, sender: senderPublic } });
});

// ── Redeem a card (any authenticated user who knows the code) ──
const redeemSchema = z.object({
  destination: z.enum(['MOBILE_MONEY', 'DONIA_BALANCE']),
});

router.post('/:code/redeem', validate(redeemSchema), async (req, res) => {
  if (!req.auth) throw Unauthorized();
  const { destination } = req.body as z.infer<typeof redeemSchema>;

  const result = await prisma.$transaction(async (tx) => {
    const card = await tx.card.findUnique({ where: { redeemCode: req.params.code as string } });
    if (!card) throw NotFound('Card not found');
    if (card.status !== 'SENT') throw BadRequest(`Card is ${card.status}, cannot redeem`);
    if (card.expiresAt && card.expiresAt < new Date()) throw BadRequest('Card expired');

    const amount = new Prisma.Decimal(card.amount);
    const commission = amount.mul(card.commissionRate);
    const net = amount.sub(commission);

    await tx.card.update({
      where: { id: card.id },
      data: { status: 'REDEEMED', redeemedAt: new Date(), recipientId: req.auth!.userId },
    });

    // Credit user wallet (if DONIA_BALANCE) or just record (MOBILE_MONEY = handled by payout webhook later)
    if (destination === 'DONIA_BALANCE') {
      await tx.wallet.update({
        where: { userId: req.auth!.userId },
        data: { balancePrincipal: { increment: net } },
      });
    }

    await tx.transaction.create({
      data: {
        userId: req.auth!.userId,
        type: 'RECEIVE',
        amount: net,
        status: destination === 'DONIA_BALANCE' ? 'SUCCESS' : 'PENDING',
        cardId: card.id,
        counterpartyId: card.senderId,
        metadata: { gross: amount.toString(), commission: commission.toString(), destination },
      },
    });

    // Commission tx (revenue side) — for accounting
    await tx.transaction.create({
      data: {
        userId: card.senderId,
        type: 'COMMISSION',
        amount: commission,
        status: 'SUCCESS',
        cardId: card.id,
        metadata: { recipientId: req.auth!.userId },
      },
    });

    // Referral bonus to parrain (if any) — 1% of commission
    const parrainRelation = await tx.referral.findFirst({ where: { filleulId: req.auth!.userId } });
    if (parrainRelation) {
      const bonus = commission.mul(parrainRelation.rate);
      if (bonus.gt(0)) {
        await tx.wallet.update({
          where: { userId: parrainRelation.parrainId },
          data: { balanceReferral: { increment: bonus } },
        });
        await tx.referral.update({
          where: { id: parrainRelation.id },
          data: { totalEarned: { increment: bonus } },
        });
        await tx.transaction.create({
          data: {
            userId: parrainRelation.parrainId,
            type: 'REFERRAL_BONUS',
            amount: bonus,
            status: 'SUCCESS',
            metadata: { fromFilleulId: req.auth!.userId, cardId: card.id },
          },
        });
      }
    }

    return {
      gross: amount.toString(),
      commission: commission.toString(),
      net: net.toString(),
      destination,
      senderId: card.senderId,
      recipientName: card.recipientName,
      cardId: card.id,
      parrainBonus: parrainRelation
        ? { parrainId: parrainRelation.parrainId, bonus: commission.mul(parrainRelation.rate).toString() }
        : null,
    };
  });

  // Best-effort push notifs to sender (+ parrain if any). Fire after the
  // transaction commit so a push failure can never roll back the redeem.
  await notifyRedeemed({
    senderId: result.senderId,
    recipientName: result.recipientName,
    amount: result.gross,
    cardId: result.cardId,
    parrainBonus: result.parrainBonus,
  });

  res.json(result);
});

// ── Add reaction (recipient or sender) ──
const reactSchema = z.object({ emoji: z.enum(['❤️', '🎉', '🙏', '😍', '✨']) });

router.post('/:id/react', validate(reactSchema), async (req, res) => {
  if (!req.auth) throw Unauthorized();
  const { emoji } = req.body as z.infer<typeof reactSchema>;
  const card = await prisma.card.findUnique({ where: { id: req.params.id as string } });
  if (!card) throw NotFound();
  await prisma.cardReaction.upsert({
    where: { cardId_userId_emoji: { cardId: card.id, userId: req.auth.userId, emoji } },
    update: {},
    create: { cardId: card.id, userId: req.auth.userId, emoji },
  });
  res.json({ ok: true });
});

// ── Resend the delivery (WhatsApp or email) ──
router.post('/:id/resend', async (req, res) => {
  if (!req.auth) throw Unauthorized();
  const card = await prisma.card.findUnique({ where: { id: req.params.id } });
  if (!card) throw NotFound();
  if (card.senderId !== req.auth.userId) throw Forbidden('Only sender can resend');
  const deliveryArgs = { code: card.redeemCode, sender: 'Donia', amount: String(card.amount) };
  if (card.deliveryChannel === 'EMAIL' && card.recipientEmail) {
    await sendCardEmail(card.recipientEmail, deliveryArgs);
  } else {
    await sendCardWhatsApp(card.recipientPhone, deliveryArgs);
  }
  res.json({ ok: true });
});

export default router;
