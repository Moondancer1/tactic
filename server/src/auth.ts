import { SignJWT, jwtVerify } from 'jose';
import type { Role, SelfInfo, Squad } from '@tactic/shared';
import { config } from './config.js';

const key = new TextEncoder().encode(config.jwtSecret);
const ISSUER = 'tactic';
/** Tokens outlive a long game day; re-join issues a fresh one. */
const TTL = '36h';

export async function issueToken(self: SelfInfo): Promise<string> {
  return new SignJWT({ mid: self.matchId, cs: self.callsign, sq: self.squad, rl: self.role })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(self.id)
    .setIssuer(ISSUER)
    .setIssuedAt()
    .setExpirationTime(TTL)
    .sign(key);
}

export async function verifyToken(token: string): Promise<SelfInfo | null> {
  try {
    const { payload } = await jwtVerify(token, key, { issuer: ISSUER, algorithms: ['HS256'] });
    return {
      id: payload.sub as string,
      matchId: payload.mid as string,
      callsign: payload.cs as string,
      squad: payload.sq as Squad,
      role: payload.rl as Role,
    };
  } catch {
    return null;
  }
}

export function bearer(header: string | undefined): string | null {
  if (!header?.startsWith('Bearer ')) return null;
  let t = header.slice(7).trim();
  // Non-Latin credentials (e.g. Cyrillic logins) arrive as "u8.<base64 of UTF-8>" — HTTP headers are ISO-8859-1 only.
  if (t.startsWith('u8.')) {
    try {
      t = Buffer.from(t.slice(3), 'base64').toString('utf8');
    } catch {
      return null;
    }
  }
  return t || null;
}

function safeEqual(aStr: string, bStr: string): boolean {
  const a = Buffer.from(aStr);
  const b = Buffer.from(bStr);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/** Admin panel is available only when ADMIN_PASSWORD (or ADMIN_TOKEN) is configured. */
export function adminConfigured(): boolean {
  return Boolean(config.adminPassword || config.adminToken);
}

/** Constant-time compare for admin credentials (`ADMIN_USER:ADMIN_PASSWORD`) or ADMIN_TOKEN. */
export function isAdmin(header: string | undefined): boolean {
  const t = bearer(header);
  if (!t) return false;
  if (config.adminPassword && safeEqual(t, `${config.adminUser}:${config.adminPassword}`)) return true;
  if (config.adminToken && safeEqual(t, config.adminToken)) return true;
  return false;
}
