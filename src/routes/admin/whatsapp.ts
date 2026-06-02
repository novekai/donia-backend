// Admin route to check WAHA session health + send a test message.
// Used by the back-office to surface a warning when WhatsApp delivery is down.
import { Router } from 'express';
import { z } from 'zod';
import { requireAdmin } from '../../middleware/adminAuth';
import { validate } from '../../middleware/validate';
import { checkWahaSession, sendWhatsAppText } from '../../services/whatsapp';
import { BadRequest } from '../../lib/errors';

const router = Router();
router.use(requireAdmin);

// GET /v1/admin/whatsapp/status — returns the WAHA session status
router.get('/status', async (_req, res) => {
  const status = await checkWahaSession();
  res.json(status);
});

const sendSchema = z.object({
  phone: z.string().regex(/^\+\d{8,15}$/, 'Phone must be E.164 (e.g. +22990123456)'),
  text: z.string().min(1).max(4096),
});

// POST /v1/admin/whatsapp/send — admin can fire a manual WhatsApp from the back-office
router.post('/send', validate(sendSchema), async (req, res) => {
  const { phone, text } = req.body as z.infer<typeof sendSchema>;
  try {
    const result = await sendWhatsAppText(phone, text);
    res.json({ ok: true, id: result.id });
  } catch (e) {
    throw BadRequest((e as Error).message, 'WHATSAPP_FAILED');
  }
});

export default router;
