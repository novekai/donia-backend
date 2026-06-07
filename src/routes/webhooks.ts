// Webhooks — endpoint pour les callbacks externes (FedaPay)
// IMPORTANT : monté AVANT express.json() pour avoir accès au raw body (signature verify).
import { Router, type Request, type Response, type NextFunction } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { verifyWebhookSignature, type FedapayTransaction, type FedapayPayout } from '../services/fedapay';
import { kkiapayProvider, type KkiapayWebhookPayload } from '../services/kkiapay';
import { sendCardEmail, sendCardWhatsApp } from '../services/notifier';
import { sendExpoPush } from '../services/push';

const router = Router();

// ── POST /webhooks/fedapay ──
// FedaPay envoie un POST avec :
//   Headers: X-FedaPay-Signature: <hex hmac-sha256>
//   Body (raw JSON): { entity, name (ex: "transaction.approved"), object: { ...transaction... } }
router.post('/fedapay', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const rawBody = req.body as Buffer;
    const signature = (req.header('x-fedapay-signature') ?? req.header('X-FedaPay-Signature')) as string | undefined;

    if (!verifyWebhookSignature(rawBody, signature)) {
      logger.warn({ signature }, 'FedaPay webhook : signature invalide');
      return res.status(401).json({ error: 'invalid signature' });
    }

    // Parse the JSON now (after signature verification).
    // FedaPay payload shape: { name: "transaction.approved", object: "transaction", entity: {...} }
    // Pour les payouts: { name: "payout.approved", object: "payout", entity: {...} }
    const payload = JSON.parse(rawBody.toString('utf8')) as {
      name?: string;
      object?: string;
      entity?: FedapayTransaction | FedapayPayout;
    };

    // ── Branche PAYOUTS (retraits sortants) ──
    if (payload.object === 'payout' && payload.entity) {
      return await handlePayoutEvent(req, res, payload.name ?? '', payload.entity as FedapayPayout);
    }

    if (payload.object !== 'transaction' || !payload.entity) {
      logger.info({ name: payload.name, object: payload.object }, 'FedaPay webhook : event ignoré (non-transaction/non-payout)');
      return res.json({ ok: true, ignored: true });
    }

    const fedaTx = payload.entity as FedapayTransaction;
    const eventName = payload.name ?? '';
    const fedapayTxId = fedaTx.id;

    // Find local tx via ref
    const localTx = await prisma.transaction.findFirst({ where: { ref: String(fedapayTxId) } });
    if (!localTx) {
      logger.warn({ fedapayTxId }, 'FedaPay webhook : transaction locale introuvable');
      return res.json({ ok: true, ignored: true, reason: 'local tx not found' });
    }

    // Idempotency : si déjà SUCCESS/FAILED, on ignore (FedaPay envoie parfois plusieurs fois)
    if (localTx.status === 'SUCCESS' || localTx.status === 'FAILED') {
      logger.info({ localTxId: localTx.id, currentStatus: localTx.status }, 'FedaPay webhook : tx déjà finalisée, ignoré');
      return res.json({ ok: true, idempotent: true });
    }

    const isApproved = eventName === 'transaction.approved' || fedaTx.status === 'approved' || fedaTx.status === 'transferred';
    const isDeclined = eventName === 'transaction.declined' || fedaTx.status === 'declined' || fedaTx.status === 'canceled';

    const meta = (localTx.metadata as { kind?: string; cardId?: string } | null) ?? {};
    const isCardPayment = meta.kind === 'card_payment';

    if (isApproved) {
      if (isCardPayment && meta.cardId) {
        // Card paid directly via Mobile Money → activate card + fire delivery
        const card = await prisma.$transaction(async (tx) => {
          await tx.transaction.update({ where: { id: localTx.id }, data: { status: 'SUCCESS' } });
          return tx.card.update({
            where: { id: meta.cardId! },
            data: { status: 'SENT', sentAt: new Date() },
          });
        });
        logger.info({ cardId: card.id, amount: card.amount.toString() }, '✅ Carte payée via Mobile Money');

        const senderUser = await prisma.user.findUnique({
          where: { id: card.senderId },
          select: { name: true },
        });
        const senderName = senderUser?.name?.split(' ')[0] ?? 'Un proche';
        const deliveryArgs = { code: card.redeemCode, sender: senderName, amount: String(card.amount) };
        try {
          if (card.deliveryChannel === 'EMAIL' && card.recipientEmail) {
            await sendCardEmail(card.recipientEmail, deliveryArgs);
          } else {
            await sendCardWhatsApp(card.recipientPhone, deliveryArgs);
          }
        } catch (deliveryErr) {
          logger.error({ err: deliveryErr, cardId: card.id }, 'Card delivery failed after payment');
        }

        // Best-effort push the recipient if they already have a Donia account.
        try {
          const recipient = await prisma.user.findFirst({
            where: { phone: card.recipientPhone, deletedAt: null },
            select: { id: true },
          });
          if (recipient) {
            await prisma.notification.create({
              data: {
                userId: recipient.id,
                type: 'received_card',
                title: 'Tu as reçu une carte 🎁',
                body: `${senderName} t'a envoyé ${String(card.amount)} FCFA.`,
                emoji: '🎁',
                data: { cardId: card.id, occasion: card.occasion },
              },
            });
            await sendExpoPush({
              userId: recipient.id,
              title: 'Tu as reçu une carte 🎁',
              body: `${senderName} t'a envoyé ${String(card.amount)} FCFA.`,
              data: { type: 'received_card', cardId: card.id },
            });
          }
        } catch (pushErr) {
          logger.warn({ err: pushErr }, 'recipient push failed (non-fatal)');
        }
      } else {
        // Wallet top-up
        await prisma.$transaction([
          prisma.transaction.update({ where: { id: localTx.id }, data: { status: 'SUCCESS' } }),
          prisma.wallet.update({
            where: { userId: localTx.userId },
            data: { balancePrincipal: { increment: new Prisma.Decimal(localTx.amount) } },
          }),
        ]);
        logger.info({ localTxId: localTx.id, amount: localTx.amount.toString() }, '✅ Wallet credité via FedaPay');
      }
    } else if (isDeclined) {
      if (isCardPayment && meta.cardId) {
        await prisma.$transaction([
          prisma.transaction.update({ where: { id: localTx.id }, data: { status: 'FAILED' } }),
          prisma.card.update({ where: { id: meta.cardId }, data: { status: 'CANCELLED' } }),
        ]);
      } else {
        await prisma.transaction.update({ where: { id: localTx.id }, data: { status: 'FAILED' } });
      }
      logger.info({ localTxId: localTx.id }, '❌ Tx FedaPay refusée');
    } else {
      logger.info({ eventName, status: fedaTx.status }, 'FedaPay webhook : statut intermédiaire, pas d\'action');
    }

    res.json({ ok: true });
  } catch (e) {
    logger.error({ err: e }, 'Webhook FedaPay : erreur');
    next(e);
  }
});

// ── POST /webhooks/kkiapay ──
// KKiaPay envoie un body genre :
//   { transactionId, status: 'SUCCESS'|'FAILED'|..., amount, type: 'payment'|'transfer', data }
// Signature: header X-Kkiapay-Signature = hex HMAC-SHA256(rawBody, KKIAPAY_SECRET_KEY)
router.post('/kkiapay', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const rawBody = req.body as Buffer;
    const signature = (req.header('x-kkiapay-signature') ?? req.header('X-Kkiapay-Signature')) as string | undefined;

    if (!kkiapayProvider.verifyWebhookSignature(rawBody, signature)) {
      logger.warn({ signature }, 'KKiaPay webhook : signature invalide');
      return res.status(401).json({ error: 'invalid signature' });
    }

    const payload = JSON.parse(rawBody.toString('utf8')) as KkiapayWebhookPayload;
    const providerTxId = String(payload.transactionId ?? payload.reference ?? '');
    if (!providerTxId) {
      logger.info({ payload }, 'KKiaPay webhook : pas de transactionId, ignore');
      return res.json({ ok: true, ignored: true });
    }

    const localTx = await prisma.transaction.findFirst({ where: { ref: providerTxId } });
    if (!localTx) {
      logger.warn({ providerTxId }, 'KKiaPay webhook : transaction locale introuvable');
      return res.json({ ok: true, ignored: true });
    }
    if (localTx.status === 'SUCCESS' || localTx.status === 'FAILED' || localTx.status === 'REFUNDED') {
      return res.json({ ok: true, idempotent: true });
    }

    const status = String(payload.status ?? '').toUpperCase();
    const isApproved = status === 'SUCCESS' || status === 'COMPLETED' || status === 'APPROVED';
    const isDeclined = status === 'FAILED' || status === 'DECLINED' || status === 'REJECTED' || status === 'CANCELED';
    const isPayout = (payload.type ?? '').toLowerCase() === 'transfer' || localTx.type === 'WITHDRAWAL';

    const meta = (localTx.metadata as { kind?: string; cardId?: string } | null) ?? {};
    const isCardPayment = meta.kind === 'card_payment';

    if (isPayout) {
      // Retrait : approved → SUCCESS + push ; declined → REFUNDED + recredit + push
      if (isApproved) {
        await prisma.transaction.update({
          where: { id: localTx.id },
          data: { status: 'SUCCESS', metadata: { ...meta, payoutApprovedAt: new Date().toISOString() } },
        });
        try {
          await sendExpoPush({
            userId: localTx.userId,
            title: 'Retrait effectué ✅',
            body: `Tu as reçu ${Number(localTx.amount).toLocaleString('fr-FR').replace(/,/g, ' ')} FCFA sur ton Mobile Money.`,
            data: { type: 'withdrawal_success', txId: localTx.id },
          });
        } catch (e) {
          logger.warn({ err: e }, 'kkiapay payout push failed');
        }
      } else if (isDeclined) {
        await prisma.$transaction([
          prisma.wallet.update({
            where: { userId: localTx.userId },
            data: { balancePrincipal: { increment: new Prisma.Decimal(localTx.amount) } },
          }),
          prisma.transaction.update({
            where: { id: localTx.id },
            data: { status: 'REFUNDED', metadata: { ...meta, payoutDeclinedAt: new Date().toISOString() } },
          }),
        ]);
      }
      return res.json({ ok: true });
    }

    // Recharge (payment)
    if (isApproved) {
      if (isCardPayment && meta.cardId) {
        const card = await prisma.$transaction(async (tx) => {
          await tx.transaction.update({ where: { id: localTx.id }, data: { status: 'SUCCESS' } });
          return tx.card.update({ where: { id: meta.cardId! }, data: { status: 'SENT', sentAt: new Date() } });
        });
        const senderUser = await prisma.user.findUnique({ where: { id: card.senderId }, select: { name: true } });
        const senderName = senderUser?.name?.split(' ')[0] ?? 'Un proche';
        const deliveryArgs = { code: card.redeemCode, sender: senderName, amount: String(card.amount) };
        try {
          if (card.deliveryChannel === 'EMAIL' && card.recipientEmail) {
            await sendCardEmail(card.recipientEmail, deliveryArgs);
          } else {
            await sendCardWhatsApp(card.recipientPhone, deliveryArgs);
          }
        } catch (e) {
          logger.error({ err: e, cardId: card.id }, 'kkiapay : Card delivery failed after payment');
        }
      } else {
        await prisma.$transaction([
          prisma.transaction.update({ where: { id: localTx.id }, data: { status: 'SUCCESS' } }),
          prisma.wallet.update({
            where: { userId: localTx.userId },
            data: { balancePrincipal: { increment: new Prisma.Decimal(localTx.amount) } },
          }),
        ]);
      }
    } else if (isDeclined) {
      if (isCardPayment && meta.cardId) {
        await prisma.$transaction([
          prisma.transaction.update({ where: { id: localTx.id }, data: { status: 'FAILED' } }),
          prisma.card.update({ where: { id: meta.cardId }, data: { status: 'CANCELLED' } }),
        ]);
      } else {
        await prisma.transaction.update({ where: { id: localTx.id }, data: { status: 'FAILED' } });
      }
    }
    res.json({ ok: true });
  } catch (e) {
    logger.error({ err: e }, 'Webhook KKiaPay : erreur');
    next(e);
  }
});

// ── Handler PAYOUTS (retraits FedaPay) ──
// Events:
//   - payout.approved : payout effectivement effectue cote operateur MM → SUCCESS
//   - payout.declined / payout.failed : echec → REFUNDED + recredit le solde
// Idempotent (FedaPay peut envoyer plusieurs fois).
async function handlePayoutEvent(_req: Request, res: Response, eventName: string, fedaPayout: FedapayPayout) {
  const localTx = await prisma.transaction.findFirst({
    where: { ref: String(fedaPayout.id), type: 'WITHDRAWAL' },
  });
  if (!localTx) {
    logger.warn({ fedapayPayoutId: fedaPayout.id }, 'FedaPay webhook payout : transaction locale introuvable');
    return res.json({ ok: true, ignored: true, reason: 'local tx not found' });
  }

  // Idempotence
  if (localTx.status === 'SUCCESS' || localTx.status === 'REFUNDED' || localTx.status === 'FAILED') {
    logger.info({ localTxId: localTx.id, currentStatus: localTx.status }, 'FedaPay webhook payout : deja finalise, ignore');
    return res.json({ ok: true, idempotent: true });
  }

  const isApproved =
    eventName === 'payout.approved' ||
    fedaPayout.status === 'approved' ||
    fedaPayout.status === 'sent';
  const isDeclined =
    eventName === 'payout.declined' ||
    eventName === 'payout.failed' ||
    fedaPayout.status === 'declined' ||
    fedaPayout.status === 'failed' ||
    fedaPayout.status === 'canceled';

  const meta = (localTx.metadata as Record<string, unknown> | null) ?? {};

  if (isApproved) {
    await prisma.transaction.update({
      where: { id: localTx.id },
      data: {
        status: 'SUCCESS',
        metadata: { ...meta, payoutApprovedAt: new Date().toISOString(), payoutStatus: fedaPayout.status },
      },
    });
    logger.info({ localTxId: localTx.id, amount: localTx.amount.toString() }, '✅ Payout FedaPay approuve');

    // Push notif user (best-effort)
    try {
      await sendExpoPush({
        userId: localTx.userId,
        title: 'Retrait effectué ✅',
        body: `Tu as reçu ${Number(localTx.amount).toLocaleString('fr-FR').replace(/,/g, ' ')} FCFA sur ton Mobile Money.`,
        data: { type: 'withdrawal_success', txId: localTx.id },
      });
      await prisma.notification.create({
        data: {
          userId: localTx.userId,
          type: 'withdrawal_success',
          title: 'Retrait effectué ✅',
          body: `Tu as reçu ${Number(localTx.amount).toLocaleString('fr-FR').replace(/,/g, ' ')} FCFA sur ton Mobile Money.`,
          emoji: '💸',
          data: { txId: localTx.id },
        },
      });
    } catch (pushErr) {
      logger.warn({ err: pushErr }, 'payout push failed (non-fatal)');
    }
  } else if (isDeclined) {
    // Echec du payout → on recredite immediatement le solde + REFUNDED.
    await prisma.$transaction([
      prisma.wallet.update({
        where: { userId: localTx.userId },
        data: { balancePrincipal: { increment: new Prisma.Decimal(localTx.amount) } },
      }),
      prisma.transaction.update({
        where: { id: localTx.id },
        data: {
          status: 'REFUNDED',
          metadata: {
            ...meta,
            payoutDeclinedAt: new Date().toISOString(),
            payoutStatus: fedaPayout.status,
            payoutEventName: eventName,
          },
        },
      }),
    ]);
    logger.info({ localTxId: localTx.id, amount: localTx.amount.toString() }, '❌ Payout FedaPay refuse, solde recredite');

    // Push notif user
    try {
      await sendExpoPush({
        userId: localTx.userId,
        title: 'Retrait non effectué',
        body: 'Ton retrait a échoué. Ton solde a été recrédité automatiquement.',
        data: { type: 'withdrawal_failed', txId: localTx.id },
      });
      await prisma.notification.create({
        data: {
          userId: localTx.userId,
          type: 'withdrawal_failed',
          title: 'Retrait non effectué',
          body: 'Ton retrait a échoué. Ton solde a été recrédité automatiquement.',
          emoji: '↺',
          data: { txId: localTx.id },
        },
      });
    } catch (pushErr) {
      logger.warn({ err: pushErr }, 'payout-failed push failed (non-fatal)');
    }
  } else {
    logger.info({ eventName, status: fedaPayout.status }, 'FedaPay webhook payout : statut intermediaire, pas action');
  }

  return res.json({ ok: true });
}

export default router;
