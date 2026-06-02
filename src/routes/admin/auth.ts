// POST /v1/admin/login — email + shared password, returns admin JWT.
import { Router } from 'express';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { env } from '../../config/env';
import { validate } from '../../middleware/validate';
import { BadRequest, Unauthorized, Forbidden } from '../../lib/errors';
import { signAdminToken } from '../../lib/admin-jwt';
import { requireAdmin } from '../../middleware/adminAuth';

const router = Router();

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

router.post('/login', validate(loginSchema), async (req, res) => {
  const { email, password } = req.body as z.infer<typeof loginSchema>;
  const emailLower = email.toLowerCase();

  if (!env.adminEmails.length) throw BadRequest('Admin not configured', 'ADMIN_NOT_CONFIGURED');
  if (!env.adminEmails.includes(emailLower)) throw Forbidden('Not an admin');
  if (!env.ADMIN_PASSWORD_HASH) throw BadRequest('Admin password not configured', 'ADMIN_NOT_CONFIGURED');

  const ok = await bcrypt.compare(password, env.ADMIN_PASSWORD_HASH);
  if (!ok) throw Unauthorized('Invalid credentials');

  const { token, expiresAt } = signAdminToken(emailLower);
  res.json({ token, expiresAt, email: emailLower });
});

// GET /v1/admin/me — returns who we are (useful for the admin SPA on hard reloads)
router.get('/me', requireAdmin, (req, res) => {
  res.json({ email: req.admin!.email });
});

export default router;
