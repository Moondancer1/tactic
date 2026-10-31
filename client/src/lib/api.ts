import type { JoinRequest, JoinResponse, VoiceInfo } from '@tactic/shared';
import { isNative } from './native';

export interface Session extends JoinResponse {
  server: string;
}

const SESSION_KEY = 'tactic.session';
const SERVER_KEY = 'tactic.server';

/** Web build talks to its own origin; the APK needs an explicit server URL. */
export function defaultServer(): string {
  const saved = localStorage.getItem(SERVER_KEY);
  if (saved) return saved;
  const env = import.meta.env.VITE_DEFAULT_SERVER as string | undefined;
  if (env) return env;
  return isNative() ? '' : window.location.origin;
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

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

async function call<T>(server: string, path: string, init: RequestInit & { token?: string } = {}): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (init.token) headers.Authorization = `Bearer ${init.token}`;
  const res = await fetch(`${server}${path}`, { ...init, headers: { ...headers, ...(init.headers as object) } });
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, body.error ?? 'error', body.message ?? res.statusText);
  return body as T;
}

export const api = {
  join: (server: string, req: JoinRequest) =>
    call<JoinResponse>(server, '/api/join', { method: 'POST', body: JSON.stringify(req) }),
  voice: (s: Session) => call<VoiceInfo>(s.server, '/api/voice', { token: s.token }),
  health: (server: string) => call<{ ok: boolean; voice: boolean }>(server, '/api/health'),
  createMatch: (server: string, adminToken: string, body: { name: string; commandPin: string; code?: string }) =>
    call<{ id: string; code: string; name: string }>(server, '/api/admin/matches', {
      method: 'POST',
      token: adminToken,
      body: JSON.stringify(body),
    }),
};

export function wsUrl(server: string): string {
  return server.replace(/^http/, 'ws') + '/ws';
}
