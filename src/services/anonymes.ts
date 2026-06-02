// Anonymes — helpers : génération de code, hash IP, modération auto.
import { createHash } from 'node:crypto';
import { env } from '../config/env';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';

export function generateAnonymousCode(length = 7): string {
  let s = '';
  for (let i = 0; i < length; i++) {
    s += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return s;
}

// Hash IP for moderation (90-day retention).
// Salt with JWT_SECRET so the hash can't be reversed from an IP list alone.
export function hashSenderIp(ip: string | null | undefined): string | null {
  if (!ip) return null;
  return createHash('sha256').update(`${ip}|${env.JWT_SECRET}`).digest('hex');
}

// Naive auto-moderation: keyword blacklist for French + English + most-common abuses.
// Returns a score 0..1 where higher = more likely problematic.
const RED_FLAGS = [
  // Threats / hate / harassment (FR)
  'tuer', 'mourir', 'crève', 'creve', 'sale pute', 'connard', 'salope',
  'nique', 'fdp', 'fils de pute', 'pédé', 'pede', 'enfoiré', 'enfoire',
  // Threats / hate / harassment (EN)
  'kill yourself', 'kys', 'die', 'rape', 'faggot', 'nigger',
  // Sexual content (FR)
  'baise', 'sexe', 'cul', 'bite', 'chatte',
  // Sexual content (EN)
  'fuck', 'pussy', 'dick',
];

const SPAM_HINTS = [
  'http://', 'https://', 'www.', '.com', '.fr', 'bit.ly', 'tinyurl',
  'whatsapp.com', 't.me/', 'discord.gg/',
];

export function autoModerate(content: string): { score: number; flagged: boolean; reason?: string } {
  const lower = content.toLowerCase();

  for (const word of RED_FLAGS) {
    if (lower.includes(word)) {
      return { score: 0.95, flagged: true, reason: 'hate-or-threat' };
    }
  }

  let spamHits = 0;
  for (const hint of SPAM_HINTS) {
    if (lower.includes(hint)) spamHits++;
  }
  if (spamHits >= 2) {
    return { score: 0.8, flagged: true, reason: 'spam' };
  }
  if (spamHits === 1) {
    return { score: 0.5, flagged: false, reason: 'spam-suspect' };
  }

  // Excessive caps
  const letters = content.replace(/[^A-Za-zÀ-ÿ]/g, '');
  if (letters.length > 12) {
    const caps = letters.replace(/[a-zà-ÿ]/g, '').length;
    if (caps / letters.length > 0.7) {
      return { score: 0.4, flagged: false, reason: 'caps' };
    }
  }

  return { score: 0.05, flagged: false };
}
