// Auth middleware — requires a valid JWT Bearer token, attaches user info to req
import type { Request, Response, NextFunction } from 'express';
import { Unauthorized } from '../lib/errors';
import { verifyToken, hashJti } from '../lib/jwt';
import { prisma } from '../lib/prisma';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: { userId: string; jti: string };
    }
  }
}

export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  try {
    const header = req.header('authorization') ?? req.header('Authorization');
    if (!header || !header.startsWith('Bearer ')) throw Unauthorized('Missing token');
    const token = header.slice(7);
    const payload = verifyToken(token);

    // Optional: verify session not revoked
    const session = await prisma.session.findUnique({
      where: { jtiHash: hashJti(payload.jti) },
      select: { revokedAt: true, expiresAt: true, userId: true },
    });
    if (!session) throw Unauthorized('Invalid session');
    if (session.revokedAt) throw Unauthorized('Session revoked');
    if (session.expiresAt < new Date()) throw Unauthorized('Session expired');
    if (session.userId !== payload.sub) throw Unauthorized('Session mismatch');

    req.auth = { userId: payload.sub, jti: payload.jti };
    next();
  } catch (e) {
    next(e instanceof Error ? e : Unauthorized());
  }
}
