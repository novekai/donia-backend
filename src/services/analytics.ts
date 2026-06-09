// Utilitaires d'extraction de signaux analytiques anonymes depuis une requete HTTP.
// Pas de PII : on hash l'IP, on n'expose pas le UA brut cote BO, on agrege les sources.
import { createHash } from 'node:crypto';
import type { Request } from 'express';
import { env } from '../config/env';

// Salt pour le hash IP : utilise JWT_SECRET pour rester deterministe sans variable supplementaire.
function ipSalt(): string {
  return env.JWT_SECRET.slice(0, 16);
}

export function hashIp(ip: string | undefined): string | null {
  if (!ip) return null;
  return createHash('sha256').update(`${ipSalt()}:${ip}`).digest('hex').slice(0, 32);
}

export type ParsedUserAgent = {
  deviceType: 'mobile' | 'tablet' | 'desktop' | null;
  os: string | null;
  browser: string | null;
};

// Parser User-Agent ultra basique sans dependance externe. Suffisant pour 95% des cas.
// Si on veut plus de precision plus tard : remplacer par `ua-parser-js`.
export function parseUserAgent(ua: string | undefined): ParsedUserAgent {
  if (!ua) return { deviceType: null, os: null, browser: null };
  const s = ua;

  // OS
  let os: string | null = null;
  if (/iPhone|iPad|iPod/.test(s)) os = 'iOS';
  else if (/Android/.test(s)) os = 'Android';
  else if (/Windows NT/.test(s)) os = 'Windows';
  else if (/Mac OS X/.test(s)) os = 'macOS';
  else if (/CrOS/.test(s)) os = 'ChromeOS';
  else if (/Linux/.test(s)) os = 'Linux';

  // Device
  let deviceType: ParsedUserAgent['deviceType'] = 'desktop';
  if (/Mobi|Android.*Mobile|iPhone|iPod/.test(s)) deviceType = 'mobile';
  else if (/iPad|Tablet/.test(s)) deviceType = 'tablet';

  // Browser (ordre important : Edge avant Chrome, Chrome avant Safari)
  let browser: string | null = null;
  if (/Edg\//.test(s)) browser = 'Edge';
  else if (/OPR\/|Opera/.test(s)) browser = 'Opera';
  else if (/SamsungBrowser/.test(s)) browser = 'Samsung Internet';
  else if (/Chrome\//.test(s)) browser = 'Chrome';
  else if (/Firefox\//.test(s)) browser = 'Firefox';
  else if (/Safari\//.test(s)) browser = 'Safari';

  return { deviceType, os, browser };
}

// Extrait le pays approximativement depuis les headers Cloudflare/Vercel/Railway.
// Si rien n'est dispo on renvoie null (le BO affichera 'Inconnu').
export function inferCountry(req: Request): string | null {
  const h = req.headers;
  const candidates = [
    h['cf-ipcountry'],
    h['x-vercel-ip-country'],
    h['x-country-code'],
    h['x-railway-country'],
  ];
  for (const v of candidates) {
    if (typeof v === 'string' && v.length === 2) return v.toUpperCase();
  }
  return null;
}

export function extractRequestSignals(req: Request): {
  ipHash: string | null;
  country: string | null;
  userAgent: string | null;
  parsed: ParsedUserAgent;
  referrer: string | null;
  language: string | null;
} {
  const ua = (req.get('user-agent') ?? null) as string | null;
  return {
    ipHash: hashIp(req.ip || req.socket?.remoteAddress),
    country: inferCountry(req),
    userAgent: ua,
    parsed: parseUserAgent(ua ?? undefined),
    referrer: (req.get('referer') ?? null) as string | null,
    language: (req.get('accept-language')?.split(',')[0] ?? null) as string | null,
  };
}
