// Birthdays — liste des utilisateurs Donia qui fêtent leur anniversaire :
// - aujourd'hui (J)
// - demain (J+1)
// - après-demain (J+2)
// Filtre : uniquement ceux qui ont opté pour l'affichage public (birthdayPublic=true).
// Ne renvoie PAS le user lui-même (il sait qu'il fête).
//
// On match sur (month, day) de la dob, ignore l'année. Pas d'index direct sur ces
// extracts en V1 — c'est une requête lue par tous les users de la home page mais
// le volume reste raisonnable (< 10K users sur V1).
import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { prisma } from '../lib/prisma';
import { Unauthorized } from '../lib/errors';

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

router.get('/', async (req, res) => {
  if (!req.auth) throw Unauthorized();
  const today = new Date();
  const tomorrow = new Date(today); tomorrow.setDate(today.getDate() + 1);
  const after = new Date(today); after.setDate(today.getDate() + 2);

  // On récupère tous les users avec dob non nul et birthdayPublic=true.
  // (Pas d'index sur (month, day), donc on charge tout et on filtre en mémoire.
  //  Acceptable jusqu'à ~50K users — pour aller plus loin il faudra un champ
  //  généré `birthdayMonthDay` indexé.)
  const candidates = await prisma.user.findMany({
    where: {
      dob: { not: null },
      birthdayPublic: true,
      deletedAt: null,
      // On exclut le viewer lui-même (il sait qu'il fête)
      id: { not: req.auth.userId },
    },
    select: { id: true, name: true, avatarUrl: true, dob: true, phone: true },
  });

  type Entry = { id: string; name: string; initial: string; avatarUrl: string | null; phone: string; day: 'today' | 'tomorrow' | 'after'; variant: ColorVariant };
  const out: Entry[] = [];

  for (const u of candidates) {
    if (!u.dob) continue;
    const dob = new Date(u.dob);
    let day: 'today' | 'tomorrow' | 'after' | null = null;
    if (isSameDayMonth(dob, today)) day = 'today';
    else if (isSameDayMonth(dob, tomorrow)) day = 'tomorrow';
    else if (isSameDayMonth(dob, after)) day = 'after';
    if (!day) continue;
    out.push({
      id: u.id,
      name: u.name,
      initial: (u.name[0] ?? '?').toUpperCase(),
      avatarUrl: u.avatarUrl,
      phone: u.phone,
      day,
      variant: colorFor(u.id),
    });
  }

  // Tri : today first, puis tomorrow, puis after. À l'intérieur, tri alphabétique.
  const order = { today: 0, tomorrow: 1, after: 2 };
  out.sort((a, b) => order[a.day] - order[b.day] || a.name.localeCompare(b.name));

  res.json({ people: out });
});

export default router;
