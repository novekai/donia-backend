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
import { getNumericSetting } from '../services/platformSettings';

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
  operator: z.string(),       // e.g. "mtn", "moov", "card" (carte bancaire)
  country: z.string().length(2),
  currency: z.enum(['XOF', 'EUR']).default('XOF'),
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
    // Si EUR, on envoie le montant en EUR (avec parite XOF/EUR fixe 655.957)
    // Si carte bancaire, on bascule en EUR pour ouvrir le formulaire carte FedaPay.
    const isCard = body.operator === 'card';
    const fedaCurrency: 'XOF' | 'EUR' = body.currency === 'EUR' || isCard ? 'EUR' : 'XOF';
    const fedaAmount =
      fedaCurrency === 'EUR'
        ? Math.round((body.amount / 655.957) * 100) / 100    // 2 decimales EUR
        : Math.round(body.amount);                             // XOF entiers
    const fedaTx = await createTransaction({
      amount: fedaAmount,
      currency: { iso: fedaCurrency },
      description: `Recharge Donia · ${body.amount} FCFA${isCard ? ' (carte bancaire)' : ''}`,
      customer: {
        firstname,
        lastname,
        email: user.email ?? undefined,
        phone_number: { number: localNumber, country: user.country.toLowerCase() },
      },
      metadata: { donia_tx_id: localTx.id, operator: body.operator, currency: fedaCurrency },
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

// ── POST /v1/wallet/withdraw — demande de retrait Mobile Money ──
// V1 : la demande est créée en PENDING et le solde immédiatement débité.
// Le payout est traité manuellement côté admin (Paul reçoit la liste des
// demandes PENDING et fait les virements via FedaPay payout ou un autre canal).
// V1.1 : intégration FedaPay payout automatique.
//
// Garde-fous :
// - KYC obligatoire (obligation BCEAO)
// - Montant > 500 FCFA
// - Solde suffisant
// Schema de retrait flexible : on accepte soit Mobile Money (operator + phoneNumber),
// soit carte bancaire (operator='bank_card' + accountNumber libre = IBAN, RIB, ou
// numéro de carte). Le destinataire est validé par Paul cote admin avant payout.
const withdrawSchema = z.object({
  amount: z.number().positive(),                       // toujours en FCFA cote backend (min pilotable depuis le BO)
  operator: z.string().min(2).max(30),                 // mtn, moov, orange, wave, bank_card
  currency: z.enum(['XOF', 'EUR']).default('XOF'),     // devise affichee cote mobile (parite fixe 655.957)
  // Soit phoneNumber (Mobile Money), soit accountNumber (carte bancaire / IBAN)
  phoneNumber: z.string().regex(/^\+\d{8,15}$/).optional(),
  accountNumber: z.string().min(4).max(34).optional(), // IBAN max 34, carte 16-19
}).refine((d) => d.phoneNumber || d.accountNumber, {
  message: "Indique soit un numéro Mobile Money (phoneNumber) soit un IBAN/numéro de carte (accountNumber).",
});

router.post('/withdraw', validate(withdrawSchema), async (req, res) => {
  if (!req.auth) throw Unauthorized();
  const body = req.body as z.infer<typeof withdrawSchema>;

  const user = await prisma.user.findUniqueOrThrow({
    where: { id: req.auth.userId },
    select: { id: true, name: true, kycStatus: true, phone: true },
  });

  if (user.kycStatus !== 'APPROVED') {
    throw BadRequest(
      "Tu dois d'abord valider ta pièce d'identité (KYC) avant de pouvoir retirer ton solde.",
      'KYC_REQUIRED',
    );
  }

  const minWithdrawal = await getNumericSetting('min_withdrawal_amount', 500);
  if (body.amount < minWithdrawal) {
    throw BadRequest(
      `Le montant minimum d'un retrait est de ${minWithdrawal.toLocaleString('fr-FR')} FCFA.`,
      'AMOUNT_TOO_LOW',
    );
  }

  const result = await prisma.$transaction(async (tx) => {
    const wallet = await tx.wallet.findUniqueOrThrow({ where: { userId: req.auth!.userId } });
    if (Number(wallet.balancePrincipal) < body.amount) {
      throw BadRequest('Solde insuffisant.', 'INSUFFICIENT_FUNDS');
    }
    await tx.wallet.update({
      where: { userId: req.auth!.userId },
      data: { balancePrincipal: { decrement: new Prisma.Decimal(body.amount) } },
    });
    const localTx = await tx.transaction.create({
      data: {
        userId: req.auth!.userId,
        type: 'WITHDRAWAL',
        amount: new Prisma.Decimal(body.amount),
        status: 'PENDING',
        metadata: {
          operator: body.operator,
          currency: body.currency,
          phoneNumber: body.phoneNumber ?? null,
          accountNumber: body.accountNumber ?? null,
          requestedAt: new Date().toISOString(),
        },
      },
    });
    return localTx;
  });

  // Message contextuel selon le canal
  const isBankCard = body.operator === 'bank_card';
  const message = isBankCard
    ? "Demande de retrait reçue. Ton compte bancaire sera crédité sous 2-5 jours ouvrés."
    : "Demande de retrait reçue. Ton Mobile Money sera crédité sous 24-48h ouvrées.";

  res.json({ ok: true, txId: result.id, status: 'PENDING', message });
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
