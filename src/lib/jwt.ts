// JWT helpers — sign + verify with the shared secret
import jwt, { type SignOptions } from 'jsonwebtoken';
import { createHash, randomBytes } from 'node:crypto';
import { env } from '../config/env';

export type JwtPayload = {
  sub: string;       // user id
  jti: string;       // session id
};

export function signToken(payload: JwtPayload): { token: string; jtiHash: string; expiresAt: Date } {
  const jti = payload.jti;
  const opts: SignOptions = { expiresIn: env.JWT_EXPIRES_IN as SignOptions['expiresIn'] };
  const token = jwt.sign(payload, env.JWT_SECRET, opts);
  const decoded = jwt.decode(token) as { exp: number };
  return {
    token,
    jtiHash: hashJti(jti),
    expiresAt: new Date(decoded.exp * 1000),
  };
}

export function verifyToken(token: string): JwtPayload {
  return jwt.verify(token, env.JWT_SECRET) as JwtPayload;
}

export function newJti(): string {
  return randomBytes(16).toString('hex');
}

export function hashJti(jti: string): string {
  return createHash('sha256').update(jti).digest('hex');
}
