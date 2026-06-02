// Auth routes — signup, login (phone OR email), OTP 3 canaux, password reset, logout
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { env } from '../config/env';
import { hashPassword, verifyPassword } from '../lib/password';
import { newJti, signToken } from '../lib/jwt';
import { generateOtp, buildReferralCode, sha256 } from '../lib/codes';
import { validate } from '../middleware/validate';
import { requireAuth } from '../middleware/auth';
import { BadRequest, Conflict, NotFound, Unauthorized } from '../lib/errors';
import { sendOtp } from '../services/notifier';
import { sendExpoPush } from '../services/push';

const router = Router();

// ── Schemas ──────────────────────────────────────────────────────────

const phoneSchema = z.string().regex(/^\+\d{8,15}$/, 'Phone must be E.164 (e.g. +22990123456)');
const emailSchema = z.string().email();
const passwordSchema = z.string().min(8, 'Password must be at least 8 chars');

const signupSchema = z.object({
  name: z.string().min(2),
  phone: phoneSchema,
  email: emailSchema.optional(),
  whatsapp: phoneSchema.optional(),
  password: passwordSchema,
  sex: z.enum(['F', 'M', 'OTHER']).optional(),
  dob: z.string().date().optional(),
  city: z.string().optional(),
  country: z.string().length(2).default('BJ'),
  referredBy: z.string().optional(),
});

const loginSchema = z.object({
  identifier: z.string(),     // phone OR email
  password: passwordSchema,
});

const otpSendSchema = z.object({
  contact: z.string(),        // phone or email
  channel: z.enum(['SMS', 'WHATSAPP', 'EMAIL']),
});

const otpVerifySchema = z.object({
  contact: z.string(),
  channel: z.enum(['SMS', 'WHATSAPP', 'EMAIL']),
  code: z.string(),
});

const resetSchema = z.object({
  contact: z.string(),
  channel: z.enum(['SMS', 'WHATSAPP', 'EMAIL']),
  code: z.string(),
  newPassword: passwordSchema,
});

// ── Helpers ──────────────────────────────────────────────────────────

async function uniqueReferralCode(name: string): Promise<string> {
  for (let i = 0; i < 5; i++) {
    const suffix = i === 0 ? '' : `-${i}`;
    const code = buildReferralCode(name) + suffix;
    const exists = await prisma.user.findUnique({ where: { referralCode: code }, select: { id: true } });
    if (!exists) return code;
  }
  // fallback: random
  return buildReferralCode(name) + '-' + Math.random().toString(36).slice(2, 6).toUpperCase();
}

async function issueSession(userId: string, req: { ip?: string; headers: Record<string, string | string[] | undefined> }) {
  const jti = newJti();
  const { token, jtiHash, expiresAt } = signToken({ sub: userId, jti });
  await prisma.session.create({
    data: {
      userId,
      jtiHash,
      expiresAt,
      ip: req.ip ?? null,
      userAgent: (req.headers['user-agent'] as string) ?? null,
    },
  });
  return { token, expiresAt };
}

// ── Routes ───────────────────────────────────────────────────────────

router.post('/signup', validate(signupSchema), async (req, res) => {
  const body = req.body as z.infer<typeof signupSchema>;

  const existing = await prisma.user.findFirst({
    where: { OR: [{ phone: body.phone }, ...(body.email ? [{ email: body.email }] : [])] },
    select: { id: true },
  });
  if (existing) throw Conflict('A user with this phone/email already exists');

  const passwordHash = await hashPassword(body.password);
  const referralCode = await uniqueReferralCode(body.name);

  const user = await prisma.user.create({
    data: {
      name: body.name,
      phone: body.phone,
      email: body.email ?? null,
      whatsapp: body.whatsapp ?? body.phone,
      sex: body.sex ?? null,
      dob: body.dob ? new Date(body.dob) : null,
      city: body.city ?? null,
      country: body.country,
      passwordHash,
      referralCode,
      referredBy: body.referredBy ?? null,
      wallet: { create: {} },
    },
    select: { id: true, name: true, phone: true, email: true, referralCode: true, createdAt: true },
  });

  // Create referral link if parrain provided + notify the parrain in-app.
  if (body.referredBy) {
    const parrain = await prisma.user.findUnique({
      where: { referralCode: body.referredBy },
      select: { id: true },
    });
    if (parrain) {
      await prisma.referral.create({
        data: { parrainId: parrain.id, filleulId: user.id, rate: env.REFERRAL_RATE },
      });
      try {
        const firstName = user.name.split(' ')[0];
        await prisma.notification.create({
          data: {
            userId: parrain.id,
            type: 'new_filleul',
            title: 'Nouveau filleul 🎉',
            body: `${firstName} vient de rejoindre Donia grâce à toi.`,
            emoji: '🤝',
            data: { filleulId: user.id },
          },
        });
        await sendExpoPush({
          userId: parrain.id,
          title: 'Nouveau filleul 🎉',
          body: `${firstName} vient de rejoindre Donia grâce à toi.`,
          data: { type: 'new_filleul', filleulId: user.id },
        });
      } catch {
        // best-effort
      }
    }
  }

  const session = await issueSession(user.id, req);
  res.status(201).json({ user, token: session.token, expiresAt: session.expiresAt });
});

router.post('/login', validate(loginSchema), async (req, res) => {
  const { identifier, password } = req.body as z.infer<typeof loginSchema>;
  const where = identifier.includes('@') ? { email: identifier } : { phone: identifier };
  const user = await prisma.user.findUnique({
    where,
    select: { id: true, name: true, phone: true, email: true, referralCode: true, passwordHash: true, deletedAt: true },
  });
  if (!user || user.deletedAt) throw Unauthorized('Invalid credentials');
  const ok = await verifyPassword(password, user.passwordHash);
  if (!ok) throw Unauthorized('Invalid credentials');

  const session = await issueSession(user.id, req);
  const { passwordHash: _omit, ...safe } = user;
  res.json({ user: safe, token: session.token, expiresAt: session.expiresAt });
});

router.post('/otp/send', validate(otpSendSchema), async (req, res) => {
  const { contact, channel } = req.body as z.infer<typeof otpSendSchema>;
  // Light rate-limit: max 3 unconsumed OTPs in last 10 min for this contact/channel
  const recent = await prisma.otp.count({
    where: { contact, channel, consumedAt: null, createdAt: { gte: new Date(Date.now() - 10 * 60_000) } },
  });
  if (recent >= 3) throw BadRequest('Too many OTP requests. Wait a moment.');

  const code = generateOtp(env.OTP_CODE_LENGTH);
  await prisma.otp.create({
    data: {
      contact,
      channel,
      codeHash: sha256(code),
      expiresAt: new Date(Date.now() + env.OTP_TTL_MINUTES * 60_000),
    },
  });
  await sendOtp(contact, channel, code);
  res.json({ ok: true, expiresInSeconds: env.OTP_TTL_MINUTES * 60 });
});

router.post('/otp/verify', validate(otpVerifySchema), async (req, res) => {
  const { contact, channel, code } = req.body as z.infer<typeof otpVerifySchema>;
  const otp = await prisma.otp.findFirst({
    where: { contact, channel, consumedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: 'desc' },
  });
  if (!otp) throw NotFound('No active OTP found');
  if (otp.attempts >= 5) throw BadRequest('Too many attempts on this OTP');
  if (otp.codeHash !== sha256(code)) {
    await prisma.otp.update({ where: { id: otp.id }, data: { attempts: { increment: 1 } } });
    throw Unauthorized('Wrong code');
  }
  await prisma.otp.update({ where: { id: otp.id }, data: { consumedAt: new Date() } });

  // Mark contact verified if it's a phone/email matching a user
  if (channel === 'EMAIL') {
    await prisma.user.updateMany({ where: { email: contact }, data: { emailVerified: true } });
  } else {
    await prisma.user.updateMany({ where: { phone: contact }, data: { phoneVerified: true } });
  }
  res.json({ ok: true });
});

router.post('/forgot-password', validate(otpSendSchema), async (req, res, next) => {
  // Reuse otp/send logic with explicit "for password reset" context
  // (Same endpoint as otp/send; UX-wise the mobile triggers this to start the reset flow.)
  req.url = '/otp/send';
  // forward — but easier to re-implement to skip the early-return
  try {
    const { contact, channel } = req.body as z.infer<typeof otpSendSchema>;
    const exists = await prisma.user.findFirst({
      where: channel === 'EMAIL' ? { email: contact } : { OR: [{ phone: contact }, { whatsapp: contact }] },
      select: { id: true },
    });
    if (!exists) return res.json({ ok: true });   // don't leak existence
    const code = generateOtp(env.OTP_CODE_LENGTH);
    await prisma.otp.create({
      data: {
        userId: exists.id,
        contact,
        channel,
        codeHash: sha256(code),
        expiresAt: new Date(Date.now() + env.OTP_TTL_MINUTES * 60_000),
      },
    });
    await sendOtp(contact, channel, code);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.post('/reset-password', validate(resetSchema), async (req, res) => {
  const { contact, channel, code, newPassword } = req.body as z.infer<typeof resetSchema>;
  const otp = await prisma.otp.findFirst({
    where: { contact, channel, consumedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: 'desc' },
  });
  if (!otp || otp.codeHash !== sha256(code)) throw Unauthorized('Invalid or expired code');
  if (!otp.userId) throw NotFound('User not found');
  const passwordHash = await hashPassword(newPassword);
  await prisma.$transaction([
    prisma.user.update({ where: { id: otp.userId }, data: { passwordHash } }),
    prisma.otp.update({ where: { id: otp.id }, data: { consumedAt: new Date() } }),
    prisma.session.updateMany({ where: { userId: otp.userId, revokedAt: null }, data: { revokedAt: new Date() } }),
  ]);
  res.json({ ok: true });
});

router.post('/logout', requireAuth, async (req, res) => {
  if (!req.auth) throw Unauthorized();
  await prisma.session.updateMany({
    where: { userId: req.auth.userId, jtiHash: sha256(req.auth.jti), revokedAt: null },
    data: { revokedAt: new Date() },
  });
  res.json({ ok: true });
});

export default router;
