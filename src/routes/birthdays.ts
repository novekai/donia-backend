// Birthdays — liste des utilisateurs Donia qui fêtent leur anniversaire :
// - aujourd'hui (J), demain (J+1), après-demain (J+2)
// Filtre selon `birthdayVisibility` du user concerné :
//   - 'public'   : visible par tout le monde
//   - 'contacts' : visible uniquement si une carte a été échangée entre viewer et user
//   - 'private'  : invisible
//
// Enrichissement par person :
//   - age (calculé depuis dob) si birthdayShowAge=true
//   - friendsInCommon (V1 : 0 ; à brancher quand le modèle Cercle sera persisté)
//   - note (birthdayNote du user)

import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { prisma } from '../lib/prisma';
import { NotFound, Unauthorized } from '../lib/errors';

const router = Router();
router.use(requireAuth);

const COLORS = ['coral', 'pink', 'mint', 'mango', 'indigo', 'plum'] as const;
type ColorVariant = (typeof COLORS)[number];

function colorFor(id: string): ColorVariant {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return COLORS[Math.abs(h) % COLORS.length]!;
}

function isSameDayMonth(d: Date, ref: Date): boolean {
  return d.getDate() === ref.getDate() && d.getMonth() === ref.getMonth();
}

function ageFrom(dob: Date, ref: Date): number {
  let age = ref.getFullYear() - dob.getFullYear();
  const m = ref.getMonth() - dob.getMonth();
  if (m < 0 || (m === 0 && ref.getDate() < dob.getDate())) age--;
  return age;
}

// Determine si viewerId et otherId ont déjà eu une interaction par carte (dans un sens ou l'autre).
async function hasInteraction(viewerId: string, otherId: string, viewerPhone: string, otherPhone: string): Promise<boolean> {
  const found = await prisma.card.findFirst({
    where: {
      OR: [
        { senderId: viewerId, OR: [{ recipientPhone: otherPhone }, { recipientId: otherId }] },
        { senderId: otherId, OR: [{ recipientPhone: viewerPhone }, { recipientId: viewerId }] },
      ],
    },
    select: { id: true },
  });
  return Boolean(found);
}

// ── GET /v1/birthdays ──
router.get('/', async (req, res) => {
  if (!req.auth) throw Unauthorized();
  const viewerId = req.auth.userId;
  const viewer = await prisma.user.findUnique({ where: { id: viewerId }, select: { phone: true } });
  if (!viewer) throw Unauthorized();

  const today = new Date();
  const tomorrow = new Date(today); tomorrow.setDate(today.getDate() + 1);
  const after = new Date(today); after.setDate(today.getDate() + 2);

  // 1. Tous les users qui fêtent et qui ne sont pas 'private'.
  const candidates = await prisma.user.findMany({
    where: {
      dob: { not: null },
      deletedAt: null,
      id: { not: viewerId },
      birthdayVisibility: { in: ['public', 'contacts'] },
    },
    select: {
      id: true, name: true, avatarUrl: true, dob: true, phone: true,
      birthdayShowAge: true, birthdayVisibility: true, birthdayNote: true,
    },
  });

  type Entry = {
    id: string; name: string; initial: string; avatarUrl: string | null;
    phone: string;
    day: 'today' | 'tomorrow' | 'after';
    variant: ColorVariant;
    age: number | null;
    friendsInCommon: number;
    note: string | null;
  };
  const out: Entry[] = [];

  for (const u of candidates) {
    if (!u.dob) continue;
    const dob = new Date(u.dob);
    let day: 'today' | 'tomorrow' | 'after' | null = null;
    if (isSameDayMonth(dob, today)) day = 'today';
    else if (isSameDayMonth(dob, tomorrow)) day = 'tomorrow';
    else if (isSameDayMonth(dob, after)) day = 'after';
    if (!day) continue;

    // Filtre visibilité 'contacts' : il faut une interaction prouvée entre viewer et user.
    if (u.birthdayVisibility === 'contacts') {
      const linked = await hasInteraction(viewerId, u.id, viewer.phone, u.phone);
      if (!linked) continue;
    }

    out.push({
      id: u.id,
      name: u.name,
      initial: (u.name[0] ?? '?').toUpperCase(),
      avatarUrl: u.avatarUrl,
      phone: u.phone,
      day,
      variant: colorFor(u.id),
      age: u.birthdayShowAge ? ageFrom(dob, today) : null,
      friendsInCommon: 0, // V1 : pas encore branché — TODO quand modèle Cercle persisté
      note: u.birthdayNote,
    });
  }

  // Tri : today first, puis tomorrow, puis after. Au sein du même jour : alphabétique.
  const order = { today: 0, tomorrow: 1, after: 2 };
  out.sort((a, b) => order[a.day] - order[b.day] || a.name.localeCompare(b.name));

  res.json({ people: out });
});

// ── GET /v1/birthdays/:userId — profil d'une personne qui fête ──
router.get('/:userId', async (req, res) => {
  if (!req.auth) throw Unauthorized();
  const viewerId = req.auth.userId;
  const targetId = req.params.userId as string;

  const [viewer, user] = await Promise.all([
    prisma.user.findUnique({ where: { id: viewerId }, select: { phone: true } }),
    prisma.user.findFirst({
      where: { id: targetId, deletedAt: null },
      select: {
        id: true, name: true, avatarUrl: true, dob: true, phone: true,
        birthdayShowAge: true, birthdayVisibility: true, birthdayNote: true,
        showAvatarPublic: true,
      },
    }),
  ]);
  if (!viewer || !user) throw NotFound('Utilisateur introuvable');
  if (user.birthdayVisibility === 'private') throw NotFound('Profil non accessible');

  if (user.birthdayVisibility === 'contacts') {
    const linked = await hasInteraction(viewerId, user.id, viewer.phone, user.phone);
    if (!linked) throw NotFound('Profil non accessible');
  }

  const today = new Date();
  const dob = user.dob ? new Date(user.dob) : null;
  let day: 'today' | 'tomorrow' | 'after' | null = null;
  if (dob) {
    const tmrw = new Date(today); tmrw.setDate(today.getDate() + 1);
    const aft = new Date(today); aft.setDate(today.getDate() + 2);
    if (isSameDayMonth(dob, today)) day = 'today';
    else if (isSameDayMonth(dob, tmrw)) day = 'tomorrow';
    else if (isSameDayMonth(dob, aft)) day = 'after';
  }

  res.json({
    person: {
      id: user.id,
      name: user.name,
      initial: (user.name[0] ?? '?').toUpperCase(),
      avatarUrl: user.showAvatarPublic ? user.avatarUrl : null,
      phone: user.phone,
      day,
      age: user.birthdayShowAge && dob ? ageFrom(dob, today) : null,
      note: user.birthdayNote,
      friendsInCommon: 0,
      variant: colorFor(user.id),
    },
  });
});

export default router;
