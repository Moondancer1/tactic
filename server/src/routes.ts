import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { customAlphabet, nanoid } from 'nanoid';
import { z } from 'zod';
import {
  AuthVerifySchema,
  CallsignSchema,
  ClientMsgSchema,
  CreateMatchSchema,
  JoinMatchSchema,
  PosSchema,
  isCommandRole,
  type MemberTrack as TrackOut,
  ROLES,
  SQUADS,
  UserPasswordSchema,
  type AuthVerifyResponse,
  type JoinResponse,
  type NetworkItem,
} from '@tactic/shared';
import { adminConfigured, bearer, isAdmin, issueTicket, issueToken, verifyTicket, verifyToken } from './auth.js';
import { randomPin, store, verifyMatchPassword, verifyPassword, type MatchRow, type UserRow } from './db.js';
import { Denied, type Hub, type Self } from './hub.js';
import { clientIp } from './net.js';

const matchCode = customAlphabet('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 6);

function fail(reply: FastifyReply, status: number, code: string, message: string) {
  return reply.code(status).send({ error: code, message });
}

/**
 * Failed-attempt lockout keyed by account (callsign / user id), independent of IP: behind a tunnel every
 * player shares one address, and an attacker can rotate addresses anyway.
 */
class Lockout {
  private m = new Map<string, { n: number; first: number; until: number }>();
  constructor(private max: number, private windowMs: number, private lockMs: number) {}
  locked(key: string): number {
    const s = this.m.get(key);
    return s && s.until > Date.now() ? Math.ceil((s.until - Date.now()) / 60000) : 0;
  }
  fail(key: string) {
    const now = Date.now();
    const s = this.m.get(key);
    const cur = s && now - s.first < this.windowMs ? s : { n: 0, first: now, until: 0 };
    cur.n += 1;
    if (cur.n >= this.max) Object.assign(cur, { n: 0, first: now, until: now + this.lockMs });
    this.m.set(key, cur);
    if (this.m.size > 10_000) for (const [k, v] of this.m) if (v.until < now && now - v.first > this.windowMs) this.m.delete(k);
  }
  ok(key: string) {
    this.m.delete(key);
  }
}
/**
 * Keyed by callsign + client address: someone else's wrong guesses lock only *their* address out of
 * that account, never the real fighter (who logs in from another address) on game day.
 */
const loginLock = new Lockout(10, 15 * 60_000, 15 * 60_000);
/** Admin credentials: 10 failures lock the guessing address for 15 minutes. */
const adminLock = new Lockout(10, 15 * 60_000, 15 * 60_000);
const netPassLock = new Lockout(8, 15 * 60_000, 15 * 60_000);

const BAD_LOGIN = 'Неверный позывной или пароль';

/** Session token of a member of an *active* match. Never re-routes a stale token into another network. */
async function member(req: FastifyRequest, reply: FastifyReply): Promise<Self | null> {
  const token = bearer(req.headers.authorization);
  const self = token ? await verifyToken(token) : null;
  if (!self) {
    fail(reply, 401, 'unauthorized', 'Сессия истекла — войдите заново');
    return null;
  }
  if (!store.activeMatch(self.matchId)) {
    fail(reply, 410, 'match_ended', 'Сеть завершена — выберите другую');
    return null;
  }
  return self;
}

async function ticketUser(req: FastifyRequest, reply: FastifyReply): Promise<UserRow | null> {
  const token = bearer(req.headers.authorization);
  const t = token ? await verifyTicket(token) : null;
  const user = t ? store.userById(t.userId) : null;
  if (!user) {
    fail(reply, 401, 'unauthorized', 'Сессия истекла — войдите заново');
    return null;
  }
  return user;
}

function listNetworks(hub: Hub): NetworkItem[] {
  return store.activeMatches().map((m) => ({
    id: m.id,
    name: m.name,
    hasPassword: Boolean(m.password),
    onlineCount: hub.onlineCount(m.id),
    memberCount: store.members(m.id).length,
    createdAt: m.createdAt,
  }));
}

function requireAdmin(req: FastifyRequest, reply: FastifyReply): boolean {
  if (!adminConfigured()) {
    fail(reply, 503, 'admin_disabled', 'Админ-панель отключена: на сервере не задан ADMIN_PASSWORD');
    return false;
  }
  const key = clientIp(req);
  const wait = adminLock.locked(key);
  if (wait) {
    fail(reply, 429, 'rate_limited', `Слишком много неверных входов в админ-панель — подождите ${wait} мин`);
    return false;
  }
  if (isAdmin(req.headers.authorization)) {
    adminLock.ok(key);
    return true;
  }
  adminLock.fail(key);
  fail(reply, 401, 'admin_unauthorized', 'Неверный логин или пароль администратора');
  return false;
}

async function finishJoin(match: MatchRow, user: UserRow): Promise<JoinResponse> {
  const m = store.upsertMember(match.id, user.callsign, user.squad, user.role, user.id);
  const self = { id: m.id, callsign: m.callsign, squad: m.squad, role: m.role, matchId: match.id };
  return {
    token: await issueToken(self, user.id),
    self,
    match: { id: match.id, name: match.name, code: match.code, createdAt: match.createdAt, endedAt: match.endedAt },
  };
}

/** `{memberId: {callsign, squad, points: [[lat, lon, ts], ...]}}`, points in time order. */
function tracksOf(matchId: string, since: number): Record<string, TrackOut> {
  const members = Object.fromEntries(store.members(matchId).map((m) => [m.id, m]));
  const tracks: Record<string, TrackOut> = {};
  for (const t of store.tracks(matchId, since)) {
    const m = members[t.member_id] ?? store.userById(t.member_id);
    const tr = (tracks[t.member_id] ??= { callsign: m?.callsign ?? '?', squad: m?.squad ?? 'none', points: [] });
    tr.points.push([t.lat, t.lon, t.ts]);
  }
  return tracks;
}

/** APK served to players. Only a release build is ever published (debug builds are debuggable). */
const APK_CANDIDATES = ['/app/apk/tactic.apk', path.resolve(process.cwd(), '../apk/out/tactic.apk')];

export function registerRoutes(app: FastifyInstance, hub: Hub) {
  const strict = { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } };

  app.get('/api/health', async () => ({ ok: true, ts: Date.now() }));

  app.get('/tactic.apk', async (_req, reply) => {
    const apkPath = APK_CANDIDATES.find((p) => fs.existsSync(p));
    if (!apkPath) return fail(reply, 404, 'apk_not_found', 'APK-файл ещё не собран на сервере');
    const stat = fs.statSync(apkPath);
    return reply
      .header('Content-Type', 'application/vnd.android.package-archive')
      .header('Content-Disposition', 'attachment; filename="tactic.apk"')
      .header('Content-Length', stat.size)
      .header('Cache-Control', 'no-cache')
      .send(fs.createReadStream(apkPath));
  });

  // ---------- admin ----------
  app.get('/api/admin/matches', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    return store.listMatches().map(({ password, briefing: _b, ...m }) => ({
      ...m,
      hasPassword: Boolean(password),
      onlineCount: hub.onlineCount(m.id),
      active: m.endedAt == null,
    }));
  });

  app.post('/api/admin/matches', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const body = CreateMatchSchema.safeParse(req.body);
    if (!body.success) return fail(reply, 400, 'bad_request', body.error.issues[0]?.message ?? 'Проверьте введённые данные');
    const code = body.data.code ?? matchCode();
    if (store.activeMatchByCode(code)) return fail(reply, 409, 'conflict', 'Этот код уже занят активной сетью');
    const m = await store.createMatch({
      id: nanoid(10),
      name: body.data.name,
      code,
      commandPin: body.data.commandPin ?? randomPin(),
      password: body.data.password,
    });
    return reply.code(201).send({ id: m.id, name: m.name, code: m.code, commandPin: m.commandPin, createdAt: m.createdAt });
  });

  app.post<{ Params: { id: string } }>('/api/admin/matches/:id/end', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    if (!store.match(req.params.id)) return fail(reply, 404, 'not_found', 'Сеть (матч) не найдена');
    hub.endMatch(req.params.id);
    return { ok: true };
  });

  app.get('/api/admin/users', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    return store.listUsers();
  });

  app.post('/api/admin/users', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const schema = z.object({
      callsign: CallsignSchema,
      password: UserPasswordSchema,
      squad: z.enum(SQUADS).default('alpha'),
      role: z.enum(ROLES).default('rifleman'),
    });
    const body = schema.safeParse(req.body);
    if (!body.success) return fail(reply, 400, 'bad_request', body.error.issues[0]?.message ?? 'Проверьте введённые данные');
    const existing = store.userByCallsign(body.data.callsign);
    if (existing) {
      // New password revokes every session of this fighter.
      await store.setUserPassword(existing.id, body.data.password);
      store.updateUserPrefs(existing.id, body.data.squad, body.data.role);
      await hub.kickUser(existing.id);
      return { id: existing.id, callsign: existing.callsign, squad: body.data.squad, role: body.data.role, updated: true };
    }
    const u = await store.createUser({ id: nanoid(10), ...body.data });
    return reply.code(201).send({ id: u.id, callsign: u.callsign, squad: u.squad, role: u.role, created: true });
  });

  app.delete<{ Params: { callsign: string } }>('/api/admin/users/:callsign', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const u = store.userByCallsign(req.params.callsign);
    if (!u) return fail(reply, 404, 'not_found', 'Боец не найден');
    store.deleteUser(u);
    await hub.kickUser(u.id);
    return { ok: true };
  });

  /** Kick without deleting: revokes all tokens, the fighter has to log in again. */
  app.post<{ Params: { callsign: string } }>('/api/admin/users/:callsign/kick', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const u = store.userByCallsign(req.params.callsign);
    if (!u) return fail(reply, 404, 'not_found', 'Боец не найден');
    store.revokeTokens(u.id);
    await hub.kickUser(u.id);
    return { ok: true };
  });

  /** After-action review: sampled tracks of every member (any network, including ended ones). */
  app.get<{ Params: { id: string }; Querystring: { since?: string } }>('/api/admin/matches/:id/tracks', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    return tracksOf(req.params.id, Number(req.query.since ?? 0) || 0);
  });

  /** Webhook / direct API: inject tactical events (referee bot, scripted objectives, etc). */
  const WEBHOOK_EVENTS = new Set(['chat', 'marker.upsert', 'marker.delete', 'zone.upsert', 'zone.delete', 'route.upsert', 'route.delete', 'briefing.set']);
  app.post<{ Params: { id: string } }>('/api/admin/matches/:id/events', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    if (!store.activeMatch(req.params.id)) return fail(reply, 404, 'not_found', 'Активная сеть не найдена');
    const msg = ClientMsgSchema.safeParse(req.body);
    if (!msg.success) return fail(reply, 400, 'bad_request', 'Некорректное событие');
    if (!WEBHOOK_EVENTS.has(msg.data.t)) return fail(reply, 400, 'bad_request', `Event ${msg.data.t} not allowed via webhook`);
    await hub.system(req.params.id, msg.data);
    return { ok: true };
  });

  // ---------- player login: step 1 account → ticket; step 2 ticket + network password → session ----------
  app.post('/api/auth/verify', strict, async (req, reply) => {
    const body = AuthVerifySchema.safeParse(req.body);
    if (!body.success) return fail(reply, 401, 'unauthorized', BAD_LOGIN);
    const { callsign, password } = body.data;
    const key = `${callsign.toUpperCase()}|${clientIp(req)}`;
    const wait = loginLock.locked(key);
    if (wait) return fail(reply, 429, 'rate_limited', `Слишком много неудачных попыток — подождите ${wait} мин`);

    const user = store.userByCallsign(callsign);
    // Same answer and similar timing whether the account exists or not.
    const ok = await verifyPassword(password, user?.passwordHash ?? 'x:00');
    if (!user || !ok) {
      loginLock.fail(key);
      return fail(reply, 401, 'unauthorized', BAD_LOGIN);
    }
    loginLock.ok(key);
    const res: AuthVerifyResponse = {
      user: { id: user.id, callsign: user.callsign, squad: user.squad, role: user.role },
      networks: listNetworks(hub),
      ticket: await issueTicket(user.id),
    };
    return res;
  });

  app.get('/api/networks', async (req, reply) => {
    const user = await ticketUser(req, reply);
    if (!user) return;
    return { ok: true, ts: Date.now(), networks: listNetworks(hub) };
  });

  app.post('/api/auth/join', strict, async (req, reply) => {
    const user = await ticketUser(req, reply);
    if (!user) return;
    const body = JoinMatchSchema.safeParse(req.body);
    if (!body.success) return fail(reply, 400, 'bad_request', 'Проверьте введённые данные');
    const match = store.activeMatch(body.data.matchId);
    if (!match) return fail(reply, 404, 'not_found', 'Сеть не найдена или уже завершена');

    if (match.password) {
      const key = `${user.id}:${match.id}`;
      const wait = netPassLock.locked(key);
      if (wait) return fail(reply, 429, 'rate_limited', `Слишком много неверных паролей — подождите ${wait} мин`);
      if (!(await verifyMatchPassword(body.data.matchPassword ?? '', match.password))) {
        netPassLock.fail(key);
        return fail(reply, 403, 'bad_match_password', 'Неверный пароль сети');
      }
      netPassLock.ok(key);
    }
    return finishJoin(match, user);
  });

  /** Movement tracks of the caller's own network, for commanders (in-game replay). */
  app.get<{ Querystring: { since?: string } }>('/api/match/tracks', async (req, reply) => {
    const self = await member(req, reply);
    if (!self) return;
    if (!isCommandRole(self.role) && self.squad !== 'command') return fail(reply, 403, 'forbidden', 'Разбор доступен командирам');
    return tracksOf(self.matchId, Number(req.query.since ?? 0) || 0);
  });

  app.post('/api/leave', async (req, reply) => {
    const self = await member(req, reply);
    if (!self) return;
    await hub.leaveMatch(self);
    return { ok: true };
  });

  /** Position uplink for the Android foreground service (works with the WebView suspended). */
  app.post('/api/telemetry', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req, reply) => {
    const self = await member(req, reply);
    if (!self) return;
    // Left the network (or was removed): 410 makes the phone's background service stop uploading.
    if (!store.isMember(self.matchId, self.id)) return fail(reply, 410, 'match_ended', 'Вы вышли из этой сети');
    const batch = z.array(PosSchema).max(50).safeParse(Array.isArray(req.body) ? req.body : [req.body]);
    if (!batch.success || batch.data.length === 0) return fail(reply, 400, 'bad_request', 'Некорректные координаты');
    // Device clocks are not trusted: fixes are placed on the server clock, keeping only their spacing.
    const fixes = batch.data.sort((a, b) => a.ts - b.ts);
    const now = Date.now();
    const newest = fixes[fixes.length - 1]!.ts;
    for (const pos of fixes) await hub.position(self, pos, now - Math.min(newest - pos.ts, 600_000));
    return reply.code(204).send();
  });

  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    if (err instanceof Denied) return fail(reply, 403, err.code, err.message);
    const status = err.statusCode ?? 500;
    if (status >= 500) app.log.error(err);
    return fail(reply, status, status === 429 ? 'rate_limited' : 'error', status >= 500 ? 'Внутренняя ошибка сервера' : 'Некорректный запрос');
  });
}
