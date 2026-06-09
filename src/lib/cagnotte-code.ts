// Générateur de publicCode pour les cagnottes : 8 caracteres ambigus retires (0/O, 1/l/I).
// Collision-tolerant : on retry jusqu'a 5 fois si la DB renvoie un duplicate.
import { prisma } from './prisma';

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // sans 0, O, 1, I, l

export function generateCode(len = 8): string {
  let s = '';
  for (let i = 0; i < len; i++) {
    s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  }
  return s;
}

export async function generateUniqueCagnotteCode(): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateCode(8);
    const exists = await prisma.cagnotte.findUnique({ where: { publicCode: code }, select: { id: true } });
    if (!exists) return code;
  }
  // Tres improbable : on rallonge a 10 chars pour collision finale
  return generateCode(10);
}
