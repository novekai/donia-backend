// Pino logger — structured JSON in prod, pretty in dev (with `pino-pretty` if installed)
import pino from 'pino';
import { env } from '../config/env';

export const logger = pino({
  level: env.isDev ? 'debug' : 'info',
  base: { service: 'donia-api', env: env.NODE_ENV },
  redact: ['req.headers.authorization', 'req.headers.cookie', 'password', 'passwordHash', 'codeHash'],
});
