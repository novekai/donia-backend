// Donia API — Express bootstrap
// IMPORTANT: 'express-async-errors' must be imported BEFORE express to patch async error handling.
import 'express-async-errors';
import express, { type Application } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import pinoHttp from 'pino-http';
import rateLimit from 'express-rate-limit';

import { env } from './config/env';
import { logger } from './lib/logger';
import { errorHandler, notFoundHandler } from './middleware/error';

import authRoutes from './routes/auth';
import meRoutes from './routes/me';
import cardsRoutes from './routes/cards';
import walletRoutes from './routes/wallet';
import transactionsRoutes from './routes/transactions';
import notificationsRoutes from './routes/notifications';
import birthdaysRoutes from './routes/birthdays';
import referralRoutes from './routes/referral';
import cagnotteRoutes from './routes/cagnotte';
import kycRoutes from './routes/kyc';
import webhooksRoutes from './routes/webhooks';
import anonymesRoutes from './routes/anonymes';
import anonymesPublicRoutes from './routes/anonymes-public';
import publicAnalyticsRoutes from './routes/public-analytics';
import pushRoutes from './routes/push';
import articlesRoutes from './routes/articles';
import adminAuthRoutes from './routes/admin/auth';
import adminArticlesRoutes from './routes/admin/articles';
import adminStatsRoutes from './routes/admin/stats';
import adminUsersRoutes from './routes/admin/users';
import adminKycRoutes from './routes/admin/kyc';
import adminTransactionsRoutes from './routes/admin/transactions';
import adminAnonymesRoutes from './routes/admin/anonymes';
import adminSettingsRoutes from './routes/admin/settings';
import adminCardTemplatesRoutes from './routes/admin/card-templates';
import adminWhatsappRoutes from './routes/admin/whatsapp';
import adminCirclesRoutes from './routes/admin/circles';
import adminBirthdayCampaignsRoutes from './routes/admin/birthday-campaigns';
import adminAnalyticsRoutes from './routes/admin/analytics';

export function buildApp(): Application {
  const app = express();

  // Trust Railway / Heroku proxy for correct req.ip + secure cookies
  app.set('trust proxy', 1);

  app.use(helmet());
  app.use(cors({ origin: env.corsOrigins, credentials: true }));

  // ⚠️ Webhooks AVANT express.json() pour préserver le raw body (signature verify FedaPay)
  app.use('/webhooks', express.raw({ type: 'application/json', limit: '1mb' }), webhooksRoutes);

  app.use(express.json({ limit: '1mb' }));
  app.use(pinoHttp({ logger }));

  // Liveness / readiness
  app.get('/health', (_req, res) => res.json({ ok: true, service: 'donia-api', env: env.NODE_ENV }));
  app.get('/', (_req, res) => res.json({ name: 'Donia API', version: '0.1.0', docs: '/health' }));

  // Light rate limit on /v1/auth/* (per IP)
  app.use(
    '/v1/auth',
    rateLimit({
      windowMs: 60_000,
      max: 20,
      standardHeaders: true,
      legacyHeaders: false,
    }),
  );

  // Mount routes
  app.use('/v1/auth', authRoutes);
  app.use('/v1/me', meRoutes);
  app.use('/v1/cards', cardsRoutes);
  app.use('/v1/wallet', walletRoutes);
  app.use('/v1/transactions', transactionsRoutes);
  app.use('/v1/notifications', notificationsRoutes);
  app.use('/v1/birthdays', birthdaysRoutes);
  app.use('/v1/referral', referralRoutes);
  app.use('/v1/cagnottes', cagnotteRoutes);
  app.use('/v1/kyc', kycRoutes);
  app.use('/v1/anonymes', anonymesRoutes);
  app.use('/v1/push', pushRoutes);

  // Public Anonymes + analytics + newsletter (no auth — used by doniia.com)
  app.use('/v1/public', anonymesPublicRoutes);
  app.use('/v1/public', publicAnalyticsRoutes);

  // Public blog (no auth — used by doniia.com/#blog and /blog/[slug])
  app.use('/v1/articles', articlesRoutes);

  // Admin back-office API (env-based admin auth). Mounted under /v1/admin.
  app.use(
    '/v1/admin',
    rateLimit({ windowMs: 60_000, max: 60, standardHeaders: true, legacyHeaders: false }),
  );
  app.use('/v1/admin/auth', adminAuthRoutes);
  app.use('/v1/admin/articles', adminArticlesRoutes);
  app.use('/v1/admin/stats', adminStatsRoutes);
  app.use('/v1/admin/users', adminUsersRoutes);
  app.use('/v1/admin/kyc', adminKycRoutes);
  app.use('/v1/admin/transactions', adminTransactionsRoutes);
  app.use('/v1/admin/anonymes', adminAnonymesRoutes);
  app.use('/v1/admin/settings', adminSettingsRoutes);
  app.use('/v1/admin/card-templates', adminCardTemplatesRoutes);
  app.use('/v1/admin/whatsapp', adminWhatsappRoutes);
  app.use('/v1/admin/circles', adminCirclesRoutes);
  app.use('/v1/admin/birthday-campaigns', adminBirthdayCampaignsRoutes);
  app.use('/v1/admin', adminAnalyticsRoutes);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

// Bootstrap unless imported (tests can call buildApp directly)
if (require.main === module) {
  const app = buildApp();
  app.listen(env.PORT, () => {
    logger.info({ port: env.PORT, env: env.NODE_ENV }, '🚀 Donia API listening');
  });
}
