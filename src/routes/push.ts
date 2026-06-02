// Push token registration — l'app mobile push son Expo token ici au login pour recevoir les notifs.
import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { Unauthorized } from '../lib/errors';
import { registerPushToken, unregisterPushToken } from '../services/push';

const router = Router();
router.use(requireAuth);

const registerSchema = z.object({
  token: z.string().min(20),                                  // ExponentPushToken[xxx]
  platform: z.enum(['ios', 'android']),
  deviceName: z.string().max(120).optional(),
});

router.post('/register', validate(registerSchema), async (req, res) => {
  if (!req.auth) throw Unauthorized();
  const { token, platform, deviceName } = req.body as z.infer<typeof registerSchema>;
  await registerPushToken(req.auth.userId, token, platform, deviceName);
  res.json({ ok: true });
});

const unregisterSchema = z.object({ token: z.string().min(20) });

router.post('/unregister', validate(unregisterSchema), async (req, res) => {
  if (!req.auth) throw Unauthorized();
  const { token } = req.body as z.infer<typeof unregisterSchema>;
  await unregisterPushToken(token);
  res.json({ ok: true });
});

export default router;
