// Helpers for generating OTPs, redeem codes, referral codes
import { customAlphabet, nanoid } from 'nanoid';
import { createHash, randomInt } from 'node:crypto';

const ALPHA_NUM = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/I/1 to avoid confusion
const codeGen = customAlphabet(ALPHA_NUM, 5);

/** OTP digits string of length n (cryptographically random) */
export function generateOtp(length = 6): string {
  let s = '';
  for (let i = 0; i < length; i++) s += randomInt(0, 10);
  return s;
}

/** Card redeem code in the format DON-2026-XXXXX */
export function generateRedeemCode(prefix = 'DON-2026'): string {
  return `${prefix}-${codeGen()}`;
}

/** Referral code from a name, e.g. "AWA-2026" — collision is checked at DB unique constraint */
export function buildReferralCode(name: string, year = new Date().getFullYear()): string {
  const base = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z]/g, '')
    .slice(0, 6)
    .toUpperCase() || 'USER';
  return `${base}-${year}`;
}

/** SHA-256 hex digest — used to store OTPs/JTIs without keeping the raw value */
export function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

/** Cryptographically random opaque ID (URL-safe) */
export function newId(size = 16): string {
  return nanoid(size);
}
