// Admin auth middleware — requires a valid admin JWT and an allow-listed email.
import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { Unauthorized, Forbidden, HttpError } from '../lib/errors';
import { verifyAdminToken } from '../lib/admin-jwt';
import { env } from '../config/env';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      admin?: { email: string };
    }
  }
}

export function requireAdmin(req: Request, _res: Response, next: NextFunction) {
  try {
    const header = req.header('authorization') ?? req.header('Authorization');
    if (!header || !header.startsWith('Bearer ')) throw Unauthorized('Missing admin token');
    const token = header.slice(7);

    let payload;
    try {
      payload = verifyAdminToken(token);
    } catch (jwtErr) {
      // Convert JWT-library errors to proper 401s so the SPA can clear the
      // session and bounce to /login instead of showing "Internal server error".
      if (jwtErr instanceof jwt.TokenExpiredError) throw Unauthorized('Token expired', 'TOKEN_EXPIRED');
      if (jwtErr instanceof jwt.JsonWebTokenError) throw Unauthorized('Invalid token');
      throw jwtErr;
    }

    const email = payload.sub.toLowerCase();

    // Defense in depth: re-check the email is still in the allow-list at every request,
    // so revoking access only requires changing the env var (no token revocation needed).
    if (!env.adminEmails.includes(email)) throw Forbidden('Not an admin');

    req.admin = { email };
    next();
  } catch (e) {
    next(e instanceof HttpError ? e : Unauthorized());
  }
}
