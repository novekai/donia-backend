// Wallet routes — balance + top-up (Mobile Money via FedaPay + code reçu)
import { Router } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { requireAuth } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { prisma } from '../lib/prisma';
import { env } from '../config/env';
import { BadRequest, NotFound, Unauthorized } from '../lib/errors';
import { createTransaction, generatePaymentToken } from '../services/fedapay';
import { logger } from '../lib/logger';

const router = Router();
router.use(requireAuth);

// ── GET /v1/wallet — balance + breakdown ──
router.get('/', async (req, res) => {
  if (!req.auth) throw Unauthorized();
  const wallet = await prisma.wallet.findUnique({ where: { userId: req.auth.userId } });
  if (!wallet) throw NotFound();
  res.json({ wallet });
});

// ── POST /v1/wallet/topup/mobile-money — initiate FedaPay payin ──
// MVP: just creates a PENDING transaction; real FedaPay integration to wire later.
const topupMMSchema = z.object({
  amount: z.number().positive(),
  operator: z.string(),       // e.g. "mtn", "moov"
  country: z.string().length(2),
});

router.post('/topup/mobile-money', validate(topupMMSchema), async (req, res) => {
  if (!req.auth) throw Unauthorized();
  const body = req.body as z.infer<typeof topupMMSchema>;

  // Load user for FedaPay customer info
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: req.auth.userId },
    select: { id: true, name: true, phone: true, email: true, country: true },
  });

  // 1. Create local PENDING transaction
  const localTx = await prisma.transaction.create({
    data: {
      userId: req.auth.userId,
      type: 'TOPUP_MOBILE_MONEY',
      amount: new Prisma.Decimal(body.amount),
      status: 'PENDING',
      metadata: { operator: body.operator, country: body.country },
    },
  });

  // 2. Create FedaPay transaction
  try {
    const [firstname, ...rest] = user.name.split(' ');
    const lastname = rest.join(' ') || firstname;
    // E.164 → strip + and country code for FedaPay phone_number (it expects local digits + country code separately)
    const localNumber = user.phone.replace(/^\+\d{1,3}/, '').replace(/\D/g, '');
    const fedaTx = await createTransaction({
      amount: Math.round(body.amount),                                   // XOF integers only
      description: `Recharge Donia · ${body.amount} FCFA`,
      customer: {
        firstname,
        lastname,
        email: user.email ?? undefined,
        phone_number: { number: localNumber, country: user.country.toLowerCase() },
      },
      metadata: { donia_tx_id: localTx.id, operator: body.operator },
    });

    // 3. Generate payment URL
    const token = await generatePaymentToken(fedaTx.id);

    // 4. Link FedaPay tx ID to our local tx
    await prisma.transaction.update({
      where: { id: localTx.id },
      data: {
        ref: String(fedaTx.id),
        metadata: { operator: body.operator, country: body.country, fedapayTxId: fedaTx.id, paymentUrl: token.url },
      },
    });

    res.json({
      ok: true,
      txId: localTx.id,
      status: 'PENDING',
      paymentUrl: token.url,        // Mobile opens this in a WebView
      fedapayTxId: fedaTx.id,
    });
  } catch (e) {
    logger.error({ err: e, localTxId: localTx.id }, 'FedaPay createTransaction failed');
    await prisma.transaction.update({ where: { id: localTx.id }, data: { status: 'FAILED' } });
    throw BadRequest('Impossible de démarrer le paiement Mobile Money', 'PAYMENT_INIT_FAILED');
  }
});

// ── GET /v1/wallet/topup/code/:code/preview — look up a card without redeeming ──
// Used by the mobile app so the user can see what they're about to redeem
// (amount, commission, sender name) BEFORE tapping "Recharger".
router.get('/topup/code/:code/preview', async (req, res) => {
  if (!req.auth) throw Unauthorized();
  const code = (req.params.code as string).toUpperCase().trim();
  const card = await prisma.card.findUnique({
    where: { redeemCode: code },
    include: { sender: { select: { name: true } } },
  });
  if (!card) throw NotFound('Code invalide');
  if (card.status === 'REDEEMED') throw BadRequest('Code déjà utilisé', 'ALREADY_REDEEMED');
  if (card.status === 'CANCELLED' || card.status === 'EXPIRED') {
    throw BadRequest(`Carte ${card.status === 'CANCELLED' ? 'annulée' : 'expirée'}`, 'CARD_INVALID');
  }
  if (card.status !== 'SENT') throw BadRequest('Carte non encore payée', 'CARD_NOT_READY');

  const amount = Number(card.amount);
  const commission = amount * Number(card.commissionRate);
  const net = amount - commission;
  res.json({
    code: card.redeemCode,
    amount,
    commission,
    commissionRate: Number(card.commissionRate),
    net,
    occasion: card.occasion,
    themeKey: card.themeKey,
    palette: card.palette,
    senderName: card.sender?.name ?? 'Un proche',
  });
});

// ── POST /v1/wallet/topup/code — enter a redeem code, credit balance ──
const topupCodeSchema = z.object({ code: z.string() });

router.post('/topup/code', validate(topupCodeSchema), async (req, res) => {
  if (!req.auth) throw Unauthorized();
  const { code } = req.body as z.infer<typeof topupCodeSchema>;

  const result = await prisma.$transaction(async (tx) => {
    const card = await tx.card.findUnique({ where: { redeemCode: code } });
    if (!card) throw NotFound('Code invalide');
    if (card.status !== 'SENT') throw BadRequest(`Code déjà utilisé ou expiré`);

    const amount = new Prisma.Decimal(card.amount);
    const commission = amount.mul(card.commissionRate);
    const net = amount.sub(commission);

    await tx.card.update({
      where: { id: card.id },
      data: { status: 'REDEEMED', redeemedAt: new Date(), recipientId: req.auth!.userId },
    });
    await tx.wallet.update({
      where: { userId: req.auth!.userId },
      data: { balancePrincipal: { increment: net } },
    });
    await tx.transaction.create({
      data: {
        userId: req.auth!.userId,
        type: 'TOPUP_CODE',
        amount: net,
        status: 'SUCCESS',
        cardId: card.id,
        counterpartyId: card.senderId,
        metadata: { gross: amount.toString(), commission: commission.toString() },
      },
    });
    await tx.transaction.create({
      data: {
        userId: card.senderId,
        type: 'COMMISSION',
        amount: commission,
        status: 'SUCCESS',
        cardId: card.id,
      },
    });
    return { credited: net.toString(), gross: amount.toString(), commission: commission.toString() };
  });

  res.json(result);
});

// ── GET /v1/wallet/topup/recent — last 5 topups ──
router.get('/topup/recent', async (req, res) => {
  if (!req.auth) throw Unauthorized();
  const recent = await prisma.transaction.findMany({
    where: {
      userId: req.auth.userId,
      type: { in: ['TOPUP_MOBILE_MONEY', 'TOPUP_CODE'] },
    },
    orderBy: { createdAt: 'desc' },
    take: 5,
  });
  res.json({ recent });
});

export default router;
