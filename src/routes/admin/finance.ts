// GET /v1/admin/finance/dashboard — comptabilite Donia.
// Permet a l'admin de comparer en temps reel :
//  - Total du aux users (somme des soldes wallet)
//  - Solde FedaPay merchant (via API FedaPay)
//  - Marge Donia cumulee (somme COMMISSION SUCCESS)
//  - Indicateur sante : vert si solde FedaPay >= du aux users, rouge sinon.
import { Router } from 'express';
import { prisma } from '../../lib/prisma';
import { requireAdmin } from '../../middleware/adminAuth';
import { fetchBalances } from '../../services/fedapay';
import { logger } from '../../lib/logger';

const router = Router();
router.use(requireAdmin);

router.get('/dashboard', async (_req, res) => {
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  const [walletAgg, commissionsAll, commissionsMonth, withdrawalsPending, cagnotteWithdrawn] = await Promise.all([
    prisma.wallet.aggregate({
      _sum: { balancePrincipal: true, balanceReferral: true },
    }),
    prisma.transaction.aggregate({
      where: { type: 'COMMISSION', status: 'SUCCESS' },
      _sum: { amount: true },
    }),
    prisma.transaction.aggregate({
      where: { type: 'COMMISSION', status: 'SUCCESS', createdAt: { gte: startOfMonth } },
      _sum: { amount: true },
    }),
    prisma.transaction.aggregate({
      where: { type: 'WITHDRAWAL', status: 'PENDING' },
      _sum: { amount: true },
    }),
    prisma.cagnotte.findMany({
      where: { withdrawnAt: { not: null } },
      select: { totalRaised: true, withdrawnAmount: true },
    }),
  ]);

  const totalOwedPrincipal = Number(walletAgg._sum.balancePrincipal ?? 0);
  const totalOwedReferral = Number(walletAgg._sum.balanceReferral ?? 0);
  const totalOwedUsers = totalOwedPrincipal + totalOwedReferral;

  const totalMargin = Number(commissionsAll._sum.amount ?? 0);
  const monthMargin = Number(commissionsMonth._sum.amount ?? 0);
  const pendingWithdrawals = Number(withdrawalsPending._sum.amount ?? 0);

  // Commission cagnottes (gross - net) = ce qu'on a garde
  const cagnotteCommission = cagnotteWithdrawn.reduce((acc, c) => {
    const gross = Number(c.totalRaised);
    const net = Number(c.withdrawnAmount ?? 0);
    return acc + Math.max(0, gross - net);
  }, 0);

  // FedaPay merchant balance — best-effort (peut echouer si l'API change ou indispo).
  let fedapayAvailable = 0;
  let fedapayPending = 0;
  let fedapayError: string | null = null;
  try {
    const balances = await fetchBalances();
    const xof = balances.find((b) => b.currency === 'XOF');
    fedapayAvailable = xof?.amount ?? 0;
    fedapayPending = xof?.pendingAmount ?? 0;
  } catch (e) {
    fedapayError = (e as { message?: string }).message ?? 'FedaPay balance fetch failed';
    logger.warn({ err: e }, 'Finance dashboard: FedaPay balance fetch failed');
  }

  // Sante : on doit pouvoir honorer tous les retraits => solde FedaPay disponible >= du aux users.
  const coverage = totalOwedUsers > 0 ? fedapayAvailable / totalOwedUsers : 1;
  const status: 'healthy' | 'warning' | 'critical' =
    coverage >= 1 ? 'healthy' : coverage >= 0.8 ? 'warning' : 'critical';
  const deficit = Math.max(0, totalOwedUsers - fedapayAvailable);

  res.json({
    owedToUsers: {
      total: totalOwedUsers,
      principal: totalOwedPrincipal,
      referral: totalOwedReferral,
    },
    fedapay: {
      available: fedapayAvailable,
      pending: fedapayPending,
      error: fedapayError,
    },
    margin: {
      total: totalMargin,
      thisMonth: monthMargin,
      cagnotteCommissions: cagnotteCommission,
    },
    withdrawals: {
      pending: pendingWithdrawals,
    },
    health: {
      status,
      coverageRatio: Number(coverage.toFixed(2)),
      deficit,
    },
    asOf: now.toISOString(),
  });
});

export default router;
