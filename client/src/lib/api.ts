import type { AuthVerifyResponse, JoinMatchRequest, JoinResponse, MatchTracks, NetworkItem, Role, SelfInfo, Squad } from '@tactic/shared';
import { isNative } from './native';
import { friendlyMessage } from './errors';

export interface Session extends JoinResponse {
  server: string;
}

/** Proof of a verified account (step 1 of login). Replaces storing the password on the device. */
export interface Ticket {
  server: string;
  callsign: string;
  ticket: string;
}

export interface AdminUserItem {
  id: string;
  callsign: string;
  squad: Squad;
  role: Role;
  created_at: number;
}

export interface AdminMatchItem {
  id: string;
  name: string;
  code: string;
  commandPin: string;
  hasPassword: boolean;
  onlineCount: number;
  active: boolean;
  createdAt: number;
  endedAt: number | null;
}

const SESSION_KEY = 'tactic.session';
const SERVER_KEY = 'tactic.server';
const TICKET_KEY = 'tactic.ticket';
// Older builds stored the plaintext password here: wipe it on first run of this version.
try {
  localStorage.removeItem('tactic.lastJoin');
  localStorage.removeItem('tactic.adminToken');
} catch {
  /* storage unavailable */
}

/**
 * Server baked into the APK at build time (apk/build-apk.ps1 -> VITE_DEFAULT_SERVER = PUBLIC_URL from .env.local).
 * Empty in the open-source build: the APK then asks the player for the server address on first launch.
 */
export const DEFAULT_SERVER_URL = ((import.meta.env.VITE_DEFAULT_SERVER as string | undefined) ?? '').trim().replace(/\/+$/, '');

/** Web build talks to its own origin; the APK uses the saved server or the one baked in at build time. */
export function defaultServer(): string {
  if (!isNative() && window.location.protocol.startsWith('http')) return window.location.origin;
  return localStorage.getItem(SERVER_KEY) || DEFAULT_SERVER_URL;
}

/** HTTPS only: credentials and positions must never cross a field Wi-Fi in clear text. */
export function normalizeServer(url: string): string {
  let u = url.trim().replace(/\/+$/, '');
  if (!u) return '';
  u = u.replace(/^http:\/\//i, 'https://');
  if (!/^https:\/\//i.test(u)) u = `https://${u}`;
  return u;
}

function readJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export const loadSession = () => readJson<Session>(SESSION_KEY);

export function saveSession(s: Session | null) {
  if (s) {
    localStorage.setItem(SESSION_KEY, JSON.stringify(s));
    localStorage.setItem(SERVER_KEY, s.server);
  } else localStorage.removeItem(SESSION_KEY);
}

export function updateSessionSelf(self: SelfInfo, token?: string) {
  const cur = loadSession();
  if (cur) saveSession({ ...cur, self, ...(token ? { token } : {}) });
}

export const loadTicket = () => readJson<Ticket>(TICKET_KEY);
export function saveTicket(t: Ticket | null) {
  if (t) localStorage.setItem(TICKET_KEY, JSON.stringify(t));
  else localStorage.removeItem(TICKET_KEY);
}

export class ApiError extends Error {
  /** Safe, user-facing Russian text (never raw technical details). */
  friendly: string;
  constructor(public status: number, public code: string, message: string) {
    super(message);
    this.friendly = friendlyMessage(code, message, status);
  }
}

/**
 * HTTP headers may only carry ISO-8859-1. Admin credentials like "МЕХТИ-1:пароль" contain Cyrillic,
 * so non-Latin tokens are sent as "u8.<base64 of UTF-8>" and decoded by the server.
 */
export function headerSafeToken(token: string): string {
  if (/^[\x20-\x7e]*$/.test(token)) return token;
  const bytes = new TextEncoder().encode(token);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return `u8.${btoa(bin)}`;
}

async function call<T>(server: string, path: string, init: RequestInit & { token?: string } = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';
  if (init.token) headers.Authorization = `Bearer ${headerSafeToken(init.token)}`;
  if (!server) throw new ApiError(0, 'network', 'no server');
  let res: Response;
  try {
    res = await fetch(`${server}${path}`, {
      ...init,
      headers: { ...headers, ...(init.headers as object) },
      signal: init.signal ?? AbortSignal.timeout(15_000),
    });
  } catch (e) {
    const timeout = e instanceof DOMException && (e.name === 'TimeoutError' || e.name === 'AbortError');
    console.warn('[api]', path, e);
    throw new ApiError(0, timeout ? 'timeout' : 'network', String(e));
  }
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, body.error ?? 'error', body.message ?? res.statusText);
  return body as T;
}

const post = (body: unknown, token?: string) => ({ method: 'POST', body: JSON.stringify(body), token });

export const api = {
  verify: (server: string, req: { callsign: string; password: string }) => call<AuthVerifyResponse>(server, '/api/auth/verify', post(req)),
  networks: (t: Ticket) => call<{ ok: boolean; ts: number; networks: NetworkItem[] }>(t.server, '/api/networks', { token: t.ticket }),
  join: (t: Ticket, req: JoinMatchRequest) => call<JoinResponse>(t.server, '/api/auth/join', post(req, t.ticket)),
  leave: (s: Session) => call<{ ok: boolean }>(s.server, '/api/leave', { method: 'POST', token: s.token }),
  /** Commander replay of the own network (uses the freshest stored token: it is refreshed on reconnect). */
  matchTracks: (s: Session) => call<MatchTracks>(s.server, '/api/match/tracks', { token: loadSession()?.token ?? s.token }),

  adminListMatches: (server: string, admin: string) => call<AdminMatchItem[]>(server, '/api/admin/matches', { token: admin }),
  adminCreateMatch: (server: string, admin: string, body: { name: string; password: string; commandPin?: string }) =>
    call<{ id: string; code: string; name: string; commandPin: string }>(server, '/api/admin/matches', post(body, admin)),
  adminEndMatch: (server: string, admin: string, id: string) =>
    call<{ ok: boolean }>(server, `/api/admin/matches/${encodeURIComponent(id)}/end`, { method: 'POST', token: admin }),
  adminTracks: (server: string, admin: string, id: string) => call<MatchTracks>(server, `/api/admin/matches/${encodeURIComponent(id)}/tracks`, { token: admin }),
  adminListUsers: (server: string, admin: string) => call<AdminUserItem[]>(server, '/api/admin/users', { token: admin }),
  adminSaveUser: (server: string, admin: string, body: { callsign: string; password: string; squad: Squad; role: Role }) =>
    call<{ id: string; callsign: string; updated?: boolean; created?: boolean }>(server, '/api/admin/users', post(body, admin)),
  adminKickUser: (server: string, admin: string, callsign: string) =>
    call<{ ok: boolean }>(server, `/api/admin/users/${encodeURIComponent(callsign)}/kick`, { method: 'POST', token: admin }),
  adminDeleteUser: (server: string, admin: string, callsign: string) =>
    call<{ ok: boolean }>(server, `/api/admin/users/${encodeURIComponent(callsign)}`, { method: 'DELETE', token: admin }),
};

export function wsUrl(server: string): string {
  return server.replace(/^http/, 'ws') + '/ws';
}
