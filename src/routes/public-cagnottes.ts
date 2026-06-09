// Routes publiques cagnottes — accessibles sans auth, utilisees par doniia.com/c/[code].
// Permettent a n importe qui de :
//   - GET /v1/public/cagnottes/:code : voir les infos de la cagnotte
//   - POST /v1/public/cagnottes/:code/contribute : contribuer par Mobile Money (FedaPay/KKiaPay)
import { Router } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import rateLimit from 'express-rate-limit';
import { prisma } from '../lib/prisma';
import { validate } from '../middleware/validate';
import { BadRequest, NotFound } from '../lib/errors';
import { getActiveProvider } from '../services/paymentProvider';
import { logger } from '../lib/logger';

const router = Router();

// ── GET /v1/public/cagnottes/:code ──
// Renvoie les infos publiques d'une cagnotte (titre, organizer prenom, progression, contributeurs).
// On masque les details sensibles (email/phone organizer, contributorPhone des autres contributeurs).
router.get('/cagnottes/:code', async (req, res) => {
  const code = req.params.code as string;
  const cagnotte = await prisma.cagnotte.findUnique({
    where: { publicCode: code },
    include: {
      owner: { select: { name: true, avatarUrl: true } },
      contributions: {
        where: { status: 'CONFIRMED' },
        orderBy: { createdAt: 'desc' },
        take: 30,
        include: { contributor: { select: { name: true, avatarUrl: true } } },
      },
    },
  });
  if (!cagnotte) throw NotFound('Cagnotte introuvable');

  // Premier prénom de l organizer pour discrétion
  const ownerFirstName = cagnotte.owner.name.split(' ')[0] ?? 'Un proche';

  res.json({
    cagnotte: {
      publicCode: cagnotte.publicCode,
      title: cagnotte.title,
      description: cagnotte.description,
      goalAmount: Number(cagnotte.goalAmount),
      totalRaised: Number(cagnotte.totalRaised),
      deadline: cagnotte.deadline,
      status: cagnotte.status,
      createdAt: cagnotte.createdAt,
      owner: {
        firstName: ownerFirstName,
        avatarUrl: cagnotte.owner.avatarUrl,
      },
      contributions: cagnotte.contributions.map((c) => ({
        id: c.id,
        name: c.contributor?.name?.split(' ')[0] ?? c.contributorName ?? 'Anonyme',
        amount: Number(c.amount),
        message: c.message,
        createdAt: c.createdAt,
      })),
      contributionCount: cagnotte.contributions.length,
    },
  });
});

// ── POST /v1/public/cagnottes/:code/contribute ──
// Crée une transaction de paiement (FedaPay/KKiaPay) + une contribution PENDING.
// Le webhook PSP confirmera la contribution et incrementera totalRaised quand le paiement passe.
const contributeLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,    // 10 min
  max: 10,                     // 10 contributions/IP/10min
  message: { error: { code: 'TOO_MANY_REQUESTS', message: 'Trop de tentatives, reessaie plus tard.' } },
  standardHeaders: true,
});

const contributeSchema = z.object({
  name: z.string().min(2).max(80),
  phone: z.string().regex(/^\+\d{8,15}$/),         // E.164
  amount: z.number().int().positive().min(100).max(1_000_000),
  message: z.string().max(200).optional(),
  operator: z.string().min(2).max(30),             // 'mtn' | 'moov' | 'orange' | 'wave' | 'card'
  country: z.string().length(2),
});

router.post('/cagnottes/:code/contribute', contributeLimiter, validate(contributeSchema), async (req, res) => {
  const code = req.params.code as string;
  const body = req.body as z.infer<typeof contributeSchema>;

  const cagnotte = await prisma.cagnotte.findUnique({ where: { publicCode: code } });
  if (!cagnotte) throw NotFound('Cagnotte introuvable');
  if (cagnotte.status !== 'ACTIVE') throw BadRequest('Cette cagnotte est cloturee.', 'CAGNOTTE_CLOSED');
  if (cagnotte.deadline && cagnotte.deadline < new Date()) {
    throw BadRequest('Cette cagnotte est expiree.', 'CAGNOTTE_EXPIRED');
  }

  // 1. Crée une transaction interne avec userId = ownerId (pour comptabilite).
  // Le contributeur n'a pas de compte donc on utilise ownerId comme rattachement comptable.
  const localTx = await prisma.transaction.create({
    data: {
      userId: cagnotte.ownerId,
      type: 'CAGNOTTE_IN',
      amount: new Prisma.Decimal(body.amount),
      status: 'PENDING',
      metadata: {
        kind: 'cagnotte_public_contribution',
        cagnotteId: cagnotte.id,
        contributorName: body.name,
        contributorPhone: body.phone,
      },
    },
  });

  // 2. Crée une CagnotteContribution PENDING. Le webhook PSP la passera en CONFIRMED.
  const contribution = await prisma.cagnotteContribution.create({
    data: {
      cagnotteId: cagnotte.id,
      contributorId: null,
      contributorName: body.name,
      contributorPhone: body.phone,
      amount: new Prisma.Decimal(body.amount),
      message: body.message ?? null,
      status: 'PENDING',
      txId: localTx.id,
    },
  });

  // 3. Initie le paiement via le provider actif (FedaPay/KKiaPay)
  try {
    const provider = await getActiveProvider();
    const [firstname, ...rest] = body.name.split(' ');
    const lastname = rest.join(' ') || firstname;
    // URL de retour apres paiement : page de remerciement Donia avec CTA telechargement app
    const callbackUrl = `https://doniia.com/c/${encodeURIComponent(cagnotte.publicCode ?? cagnotte.id)}/merci?contrib=${encodeURIComponent(contribution.id)}`;
    const topup = await provider.createTopup({
      amountFcfa: body.amount,
      operator: body.operator,
      country: body.country,
      description: `Cagnotte ${cagnotte.title}`,
      currency: 'XOF',
      callbackUrl,
      customer: { firstname, lastname, phone: body.phone, email: null },
      metadata: { donia_tx_id: localTx.id, kind: 'cagnotte_public_contribution', cagnotteId: cagnotte.id, contributionId: contribution.id },
    });

    await prisma.transaction.update({
      where: { id: localTx.id },
      data: {
        ref: topup.providerTxId,
        metadata: {
          kind: 'cagnotte_public_contribution',
          cagnotteId: cagnotte.id,
          contributionId: contribution.id,
          contributorName: body.name,
          contributorPhone: body.phone,
          provider: provider.key,
          providerTxId: topup.providerTxId,
        },
      },
    });

    logger.info(
      { provider: provider.key, txId: localTx.id, cagnotteId: cagnotte.id, amount: body.amount },
      '🎁 Cagnotte contribution publique initiee',
    );

    res.status(201).json({
      ok: true,
      contributionId: contribution.id,
      paymentUrl: topup.paymentUrl,
      provider: provider.key,
    });
  } catch (e) {
    logger.error({ err: (e as Error).message, contributionId: contribution.id }, 'cagnotte public contrib failed');
    await prisma.cagnotteContribution.update({
      where: { id: contribution.id },
      data: { status: 'FAILED' },
    });
    await prisma.transaction.update({
      where: { id: localTx.id },
      data: { status: 'FAILED' },
    });
    throw BadRequest('Impossible de demarrer le paiement. Reessaie.', 'PAYMENT_INIT_FAILED');
  }
});

export default router;
