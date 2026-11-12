import crypto from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import type { Role, SelfInfo, Squad } from '@tactic/shared';
import { config } from './config.js';
import { store } from './db.js';

const key = new TextEncoder().encode(config.jwtSecret);
const ISSUER = 'tactic';
/** Session tokens are refreshed on every WebSocket (re)connect, so an active player never expires. */
const SESSION_TTL = '24h';
/** User ticket: lets the client list/join networks without keeping the password on the device. */
const TICKET_TTL = '7d';

export interface UserTicket {
  userId: string;
}

/**
 * Every token carries the user's id and token_version. Kicking, deleting a user or changing
 * their password bumps the version and instantly invalidates all of their tokens.
 */
export async function issueToken(self: SelfInfo, userId: string): Promise<string> {
  const user = store.userById(userId);
  return new SignJWT({ typ: 's', uid: userId, tv: user?.tokenVersion ?? 0, mid: self.matchId, cs: self.callsign, sq: self.squad, rl: self.role })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(self.id)
    .setIssuer(ISSUER)
    .setIssuedAt()
    .setExpirationTime(SESSION_TTL)
    .sign(key);
}

export async function issueTicket(userId: string): Promise<string> {
  const user = store.userById(userId);
  return new SignJWT({ typ: 'u', uid: userId, tv: user?.tokenVersion ?? 0 })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuer(ISSUER)
    .setIssuedAt()
    .setExpirationTime(TICKET_TTL)
    .sign(key);
}

async function verify(token: string, typ: 's' | 'u') {
  try {
    const { payload } = await jwtVerify(token, key, { issuer: ISSUER, algorithms: ['HS256'] });
    if (payload.typ !== typ || typeof payload.uid !== 'string') return null;
    const user = store.userById(payload.uid);
    if (!user || user.tokenVersion !== payload.tv) return null;
    return payload;
  } catch {
    return null;
  }
}

/** Session token → member identity. Null when expired, revoked, or the account no longer exists. */
export async function verifyToken(token: string): Promise<(SelfInfo & { userId: string }) | null> {
  const p = await verify(token, 's');
  if (!p) return null;
  return {
    id: p.sub as string,
    userId: p.uid as string,
    matchId: p.mid as string,
    callsign: p.cs as string,
    squad: p.sq as Squad,
    role: p.rl as Role,
  };
}

export async function verifyTicket(token: string): Promise<UserTicket | null> {
  const p = await verify(token, 'u');
  return p ? { userId: p.uid as string } : null;
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

/** Constant-time string compare that does not leak the length (both sides hashed first). */
export function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/** Admin panel is available only when ADMIN_PASSWORD (or ADMIN_TOKEN) is configured. */
export function adminConfigured(): boolean {
  return Boolean(config.adminPassword || config.adminToken);
}

/** Admin credentials (`ADMIN_USER:ADMIN_PASSWORD`) or ADMIN_TOKEN. */
export function isAdmin(header: string | undefined): boolean {
  const t = bearer(header);
  if (!t) return false;
  if (config.adminPassword && safeEqual(t, `${config.adminUser}:${config.adminPassword}`)) return true;
  if (config.adminToken && safeEqual(t, config.adminToken)) return true;
  return false;
}
