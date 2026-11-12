import type {
  AuthRequest,
  AuthVerifyResponse,
  JoinRequest,
  JoinResponse,
  NetworkItem,
  Role,
  SelfInfo,
  Squad,
  VoiceInfo,
} from '@tactic/shared';
import { isNative } from './native';
import { friendlyMessage } from './errors';

export interface Session extends JoinResponse {
  server: string;
}

export interface AdminUserItem {
  id: string;
  callsign: string;
  squad: Squad;
  role: Role;
  created_at: number;
}

const SESSION_KEY = 'tactic.session';
const SERVER_KEY = 'tactic.server';
export const LAST_KEY = 'tactic.lastJoin';

/**
 * Server baked into the APK at build time (apk/build-apk.ps1 -> VITE_DEFAULT_SERVER = PUBLIC_URL from .env.local).
 * Empty in the open-source build: the APK then asks the player for the server address on first launch.
 */
export const DEFAULT_SERVER_URL = ((import.meta.env.VITE_DEFAULT_SERVER as string | undefined) ?? '').trim().replace(/\/+$/, '');

/** Optional ntfy.sh topic for auto-discovery of rotating quick-tunnel URLs (VITE_DISCOVERY_TOPIC). Disabled when empty. */
const DISCOVERY_TOPIC = ((import.meta.env.VITE_DISCOVERY_TOPIC as string | undefined) ?? '').trim();

/** Web build talks to its own origin; the APK uses the saved server or the one baked in at build time. */
export function defaultServer(): string {
  if (!isNative() && window.location.protocol.startsWith('http')) {
    return window.location.origin;
  }
  const saved = localStorage.getItem(SERVER_KEY);
  if (saved) return saved;
  if (DEFAULT_SERVER_URL) return DEFAULT_SERVER_URL;
  return isNative() ? '' : window.location.origin;
}

/**
 * Optional: discovers the current server URL published to ntfy.sh (only when VITE_DISCOVERY_TOPIC is set,
 * useful with temporary *.trycloudflare.com tunnels). Returns null when disabled.
 */
export async function discoverServerUrl(): Promise<string | null> {
  if (!DISCOVERY_TOPIC) return null;
  try {
    const res = await fetch(`https://ntfy.sh/${encodeURIComponent(DISCOVERY_TOPIC)}/raw?poll=1&since=168h`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const text = await res.text();
    const lines = text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => /^https?:\/\/[^\s]+$/i.test(l));
    if (!lines.length) return null;
    const latest = normalizeServer(lines[lines.length - 1]!);
    if (latest) localStorage.setItem(SERVER_KEY, latest);
    return latest;
  } catch {
    return null;
  }
}

export function loadSavedCredentials(): {
  callsign: string;
  password: string;
  matchId?: string;
  matchPassword?: string;
} | null {
  try {
    const raw = JSON.parse(localStorage.getItem(LAST_KEY) || '{}');
    if (raw.callsign && raw.password) {
      return {
        callsign: String(raw.callsign),
        password: String(raw.password),
        ...(raw.matchId ? { matchId: String(raw.matchId) } : {}),
        ...(raw.matchPassword ? { matchPassword: String(raw.matchPassword) } : {}),
      };
    }
    return null;
  } catch {
    return null;
  }
}

export function saveCredentials(
  callsign: string,
  password: string,
  matchId?: string,
  matchPassword?: string,
) {
  localStorage.setItem(
    LAST_KEY,
    JSON.stringify({
      callsign,
      password,
      ...(matchId ? { matchId } : {}),
      ...(matchPassword ? { matchPassword } : {}),
    }),
  );
}

export function normalizeServer(url: string): string {
  let u = url.trim().replace(/\/+$/, '');
  if (u && !/^https?:\/\//.test(u)) u = `https://${u}`;
  return u;
}

export function loadSession(): Session | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}

export function saveSession(s: Session | null) {
  if (s) {
    localStorage.setItem(SESSION_KEY, JSON.stringify(s));
    localStorage.setItem(SERVER_KEY, s.server);
  } else localStorage.removeItem(SESSION_KEY);
}

export function updateSessionSelf(self: SelfInfo, token?: string) {
  const cur = loadSession();
  if (!cur) return;
  saveSession({ ...cur, self, ...(token ? { token } : {}) });
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

export const api = {
  verify: (server: string, req: { callsign: string; password: string }) =>
    call<AuthVerifyResponse>(server, '/api/auth/verify', { method: 'POST', body: JSON.stringify(req) }),
  networks: (server: string) =>
    call<{ ok: boolean; ts: number; networks: NetworkItem[] }>(server, '/api/networks'),
  login: (server: string, req: AuthRequest) =>
    call<JoinResponse>(server, '/api/auth/login', { method: 'POST', body: JSON.stringify(req) }),
  join: (server: string, req: JoinRequest) =>
    call<JoinResponse>(server, '/api/join', { method: 'POST', body: JSON.stringify(req) }),
  leave: (s: Session) =>
    call<{ ok: boolean }>(s.server, '/api/leave', { method: 'POST', token: s.token }),
  voice: (s: Session) => call<VoiceInfo>(s.server, '/api/voice', { token: s.token }),
  health: (server: string) => call<{ ok: boolean; voice: boolean }>(server, '/api/health'),
  createMatch: (
    server: string,
    adminToken: string,
    body: { name: string; commandPin?: string; password?: string; code?: string },
  ) =>
    call<{ id: string; code: string; name: string }>(server, '/api/admin/matches', {
      method: 'POST',
      token: adminToken,
      body: JSON.stringify(body),
    }),
  adminListUsers: (server: string, adminToken: string) =>
    call<AdminUserItem[]>(server, '/api/admin/users', { token: adminToken }),
  adminSaveUser: (
    server: string,
    adminToken: string,
    body: { callsign: string; password: string; squad: Squad; role: Role },
  ) =>
    call<{ id: string; callsign: string; updated?: boolean; created?: boolean }>(server, '/api/admin/users', {
      method: 'POST',
      token: adminToken,
      body: JSON.stringify(body),
    }),
  adminDeleteUser: (server: string, adminToken: string, callsign: string) =>
    call<{ ok: boolean }>(server, `/api/admin/users/${encodeURIComponent(callsign)}`, {
      method: 'DELETE',
      token: adminToken,
    }),
};

export function wsUrl(server: string): string {
  return server.replace(/^http/, 'ws') + '/ws';
}
