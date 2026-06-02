// Admin JWT helpers — separate token type from user tokens.
// Tokens carry `type: 'admin'` so even if leaked they cannot impersonate a regular user.
import jwt, { type SignOptions } from 'jsonwebtoken';
import { env } from '../config/env';

export type AdminJwtPayload = {
  sub: string;       // admin email
  type: 'admin';
};

export function signAdminToken(email: string): { token: string; expiresAt: Date } {
  const opts: SignOptions = { expiresIn: env.ADMIN_JWT_EXPIRES_IN as SignOptions['expiresIn'] };
  const token = jwt.sign({ sub: email, type: 'admin' } satisfies AdminJwtPayload, env.JWT_SECRET, opts);
  const decoded = jwt.decode(token) as { exp: number };
  return { token, expiresAt: new Date(decoded.exp * 1000) };
}

export function verifyAdminToken(token: string): AdminJwtPayload {
  const payload = jwt.verify(token, env.JWT_SECRET) as AdminJwtPayload;
  if (payload.type !== 'admin') throw new Error('Wrong token type');
  return payload;
}
