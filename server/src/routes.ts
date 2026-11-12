import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { customAlphabet, nanoid } from 'nanoid';
import { z } from 'zod';
import {
  AuthRequestSchema,
  CallsignSchema,
  ClientMsgSchema,
  CreateMatchSchema,
  JoinSchema,
  PosSchema,
  ROLES,
  SQUADS,
  type AuthVerifyResponse,
  type JoinResponse,
  type NetworkItem,
  type Role,
  type SelfInfo,
  type Squad,
} from '@tactic/shared';
import { adminConfigured, bearer, isAdmin, issueToken, verifyToken } from './auth.js';
import { store, verifyPassword, type MatchRow } from './db.js';
import { Denied, type Hub } from './hub.js';
import { livekitUrlFor, voiceEnabled, voiceGrants } from './voice.js';

const matchCode = customAlphabet('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 6);

function fail(reply: FastifyReply, status: number, code: string, message: string) {
  return reply.code(status).send({ error: code, message });
}

async function member(req: FastifyRequest, reply: FastifyReply): Promise<SelfInfo | null> {
  const token = bearer(req.headers.authorization);
  const self = token ? await verifyToken(token) : null;
  if (!self) {
    fail(reply, 401, 'unauthorized', 'Сессия истекла — войдите заново');
    return null;
  }
  const m = store.match(self.matchId);
  if (!m || m.endedAt) {
    self.matchId = store.defaultActiveMatch().id;
  }
  return self;
}

function listNetworks(hub: Hub): NetworkItem[] {
  return store.activeMatches().map((m) => ({
    id: m.id,
    name: m.name,
    code: m.code,
    hasPassword: Boolean(m.password && m.password.trim().length > 0),
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
  if (isAdmin(req.headers.authorization)) return true;
  fail(reply, 401, 'admin_unauthorized', 'Неверный логин или пароль администратора');
  return false;
}

function resolveMatch(code?: string): MatchRow | null {
  const trimmed = code?.trim().toUpperCase();
  if (trimmed) return store.activeMatchByCode(trimmed);
  return store.defaultActiveMatch();
}

async function finishJoin(
  match: MatchRow,
  userId: string,
  callsign: string,
  squad: Squad,
  role: Role,
): Promise<JoinResponse> {
  const m = store.upsertMember(match.id, callsign, squad, role, userId);
  const self: SelfInfo = { id: m.id, callsign: m.callsign, squad: m.squad, role: m.role, matchId: match.id };
  return {
    token: await issueToken(self),
    self,
    match: { id: match.id, name: match.name, code: match.code, createdAt: match.createdAt, endedAt: match.endedAt },
  };
}

export function registerRoutes(app: FastifyInstance, hub: Hub) {
  app.get('/api/health', async () => ({ ok: true, ts: Date.now(), voice: true, livekit: voiceEnabled(), ...hub.stats() }));

  app.get('/tactic.apk', async (_req, reply) => {
    const candidates = ['/app/apk/tactic-debug.apk', path.resolve(process.cwd(), '../apk/out/tactic-debug.apk')];
    const apkPath = candidates.find((p) => fs.existsSync(p));
    if (!apkPath) {
      return reply.code(404).send({
        error: 'apk_not_found',
        message: 'APK-файл ещё не собран на сервере',
      });
    }
    const stat = fs.statSync(apkPath);
    return reply
      .header('Content-Type', 'application/vnd.android.package-archive')
      .header('Content-Disposition', 'attachment; filename="tactic.apk"')
      .header('Content-Length', stat.size)
      .header('Cache-Control', 'no-cache')
      .send(fs.createReadStream(apkPath));
  });

  app.get('/api/networks', async () => ({
    ok: true,
    ts: Date.now(),
    networks: listNetworks(hub),
  }));

  app.get('/api/geo-ip', async (req) => {
    const cfLat = Number(req.headers['cf-iplatitude']);
    const cfLon = Number(req.headers['cf-iplongitude']);
    if (!Number.isNaN(cfLat) && !Number.isNaN(cfLon) && cfLat !== 0 && cfLon !== 0) {
      return { ok: true, latitude: cfLat, longitude: cfLon };
    }
    const rawIp =
      (req.headers['cf-connecting-ip'] as string | undefined) ||
      (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() ||
      '';
    const isPublic = rawIp && !/^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1|fc|fd)/.test(rawIp);
    const url = isPublic ? `http://ip-api.com/json/${encodeURIComponent(rawIp)}?fields=status,lat,lon` : 'http://ip-api.com/json/?fields=status,lat,lon';
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2500) });
      if (res.ok) {
        const d = (await res.json()) as { status?: string; lat?: number; lon?: number };
        if (d.status === 'success' && typeof d.lat === 'number' && typeof d.lon === 'number') {
          return { ok: true, latitude: d.lat, longitude: d.lon };
        }
      }
    } catch {
      /* fallback below */
    }
    return { ok: true, latitude: 40.4093, longitude: 49.8671 };
  });

  // ---------- admin ----------
  app.post('/api/admin/matches', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const body = CreateMatchSchema.safeParse(req.body);
    if (!body.success) return fail(reply, 400, 'bad_request', 'Проверьте введённые данные');
    const code = body.data.code ?? matchCode();
    if (store.activeMatchByCode(code)) return fail(reply, 409, 'conflict', 'Этот код уже занят активной сетью');
    const m = store.createMatch({
      id: nanoid(10),
      name: body.data.name,
      code,
      commandPin: body.data.commandPin,
      password: body.data.password ?? '',
    });
    return reply.code(201).send({ id: m.id, name: m.name, code: m.code, createdAt: m.createdAt });
  });

  app.get('/api/admin/matches', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    return store.listMatches().map(({ commandPin: _pin, password: pw, briefing: _b, ...m }) => ({
      ...m,
      hasPassword: Boolean(pw && pw.trim().length > 0),
      onlineCount: hub.onlineCount(m.id),
      active: m.endedAt == null,
    }));
  });

  app.post<{ Params: { id: string } }>('/api/admin/matches/:id/end', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    if (!store.match(req.params.id)) return fail(reply, 404, 'not_found', 'Сеть (матч) не найдена');
    hub.endMatch(req.params.id);
    return { ok: true };
  });

  /** Admin user account management */
  app.get('/api/admin/users', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    return store.listUsers();
  });

  app.post('/api/admin/users', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const schema = z.object({
      callsign: CallsignSchema,
      password: z.string().min(3, 'Пароль минимум 3 символа').max(64),
      squad: z.enum(SQUADS).default('alpha'),
      role: z.enum(ROLES).default('rifleman'),
    });
    const body = schema.safeParse(req.body);
    if (!body.success) return fail(reply, 400, 'bad_request', 'Проверьте введённые данные (позывной до 16 символов, пароль от 3 символов)');
    const existing = store.userByCallsign(body.data.callsign);
    if (existing) {
      store.setUserPassword(body.data.callsign, body.data.password);
      store.updateUserPrefs(existing.id, body.data.squad, body.data.role);
      return { id: existing.id, callsign: existing.callsign, squad: body.data.squad, role: body.data.role, updated: true };
    }
    const u = store.createUser({
      id: nanoid(10),
      callsign: body.data.callsign,
      password: body.data.password,
      squad: body.data.squad,
      role: body.data.role,
    });
    return reply.code(201).send({ id: u.id, callsign: u.callsign, squad: u.squad, role: u.role, created: true });
  });

  app.delete<{ Params: { callsign: string } }>('/api/admin/users/:callsign', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const u = store.userByCallsign(req.params.callsign);
    if (u) {
      await hub.kickUser(u.id);
    }
    store.deleteUser(req.params.callsign);
    return { ok: true };
  });

  /** After-action review: sampled tracks of every member. */
  app.get<{ Params: { id: string }; Querystring: { since?: string } }>(
    '/api/admin/matches/:id/tracks',
    async (req, reply) => {
      if (!requireAdmin(req, reply)) return;
      const members = Object.fromEntries(store.members(req.params.id).map((m) => [m.id, m]));
      const tracks: Record<string, { callsign: string; squad: string; points: [number, number, number][] }> = {};
      for (const t of store.tracks(req.params.id, Number(req.query.since ?? 0))) {
        const m = members[t.member_id] ?? store.userById(t.member_id);
        const tr = (tracks[t.member_id] ??= { callsign: m?.callsign ?? '?', squad: m?.squad ?? '?', points: [] });
        tr.points.push([t.lat, t.lon, t.ts]);
      }
      return tracks;
    },
  );

  /**
   * Webhook / direct API: inject tactical events (referee bot, scripted objectives, etc).
   */
  app.post<{ Params: { id: string } }>('/api/admin/matches/:id/events', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    if (!store.match(req.params.id)) return fail(reply, 404, 'not_found', 'Сеть (матч) не найдена');
    const msg = ClientMsgSchema.safeParse(req.body);
    if (!msg.success) return fail(reply, 400, 'bad_request', 'Некорректное событие');
    if (msg.data.t === 'pos' || msg.data.t === 'hello' || msg.data.t === 'ping' || msg.data.t === 'heading' || msg.data.t === 'status') {
      return fail(reply, 400, 'bad_request', `Event ${msg.data.t} not allowed via webhook`);
    }
    await hub.system(req.params.id, msg.data);
    return { ok: true };
  });

  // ---------- player login (step 1: verify account & list networks; step 2: join network) ----------
  app.post('/api/auth/verify', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const body = AuthRequestSchema.safeParse(req.body);
    if (!body.success) return fail(reply, 400, 'bad_request', 'Проверьте введённые данные (позывной до 16 символов, пароль от 3 символов)');
    const { callsign, password } = body.data;

    const user = store.userByCallsign(callsign);
    if (!user) {
      return fail(reply, 401, 'unauthorized', 'Аккаунт не найден. Создайте бойца в Админ-панели.');
    }
    if (!verifyPassword(password, user.passwordHash)) {
      return fail(reply, 401, 'unauthorized', 'Неверный пароль');
    }

    const res: AuthVerifyResponse = {
      user: {
        id: user.id,
        callsign: user.callsign,
        squad: user.squad,
        role: user.role,
      },
      networks: listNetworks(hub),
    };
    return res;
  });

  app.post('/api/auth/login', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const body = AuthRequestSchema.safeParse(req.body);
    if (!body.success) return fail(reply, 400, 'bad_request', 'Проверьте введённые данные (позывной до 16 символов, пароль от 3 символов)');
    const { callsign, password, code, matchId, matchName, matchPassword } = body.data;

    const user = store.userByCallsign(callsign);
    if (!user) {
      return fail(reply, 401, 'unauthorized', 'Аккаунт не найден. Создайте бойца в Админ-панели.');
    }
    if (!verifyPassword(password, user.passwordHash)) {
      return fail(reply, 401, 'unauthorized', 'Неверный пароль');
    }

    let match: MatchRow | null = null;
    if (matchId) {
      const m = store.match(matchId);
      if (m && !m.endedAt) match = m;
    } else if (matchName && matchName.trim()) {
      const cleanName = matchName.trim();
      match =
        store.activeMatchByName(cleanName) ??
        store.activeMatchByCode(cleanName.toUpperCase());
      if (!match) {
        const pin = matchPassword && matchPassword.trim().length >= 4 ? matchPassword.trim() : '4321';
        match = store.createMatch({
          id: nanoid(10),
          name: cleanName,
          code: matchCode(),
          commandPin: pin,
          password: matchPassword?.trim() ?? '',
        });
      }
    } else {
      match = resolveMatch(code);
    }

    if (!match) return fail(reply, 404, 'not_found', 'Сеть (матч) не найдена');

    if (match.password && match.password.trim().length > 0) {
      if ((matchPassword ?? '').trim() !== match.password.trim()) {
        return fail(reply, 403, 'bad_match_password', 'Неверный пароль сети');
      }
    }

    return finishJoin(match, user.id, user.callsign, user.squad, user.role);
  });

  app.post('/api/join', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const body = JoinSchema.safeParse(req.body);
    if (!body.success) return fail(reply, 400, 'bad_request', 'Проверьте введённые данные');
    const { code, callsign, password } = body.data;

    const user = store.userByCallsign(callsign);
    if (!user) {
      return fail(reply, 401, 'unauthorized', 'Аккаунт не найден. Создайте бойца в Админ-панели.');
    }
    if (!password || !verifyPassword(password, user.passwordHash)) {
      return fail(reply, 401, 'unauthorized', 'Неверный пароль');
    }

    const match = resolveMatch(code);
    if (!match) return fail(reply, 404, 'not_found', 'Нет активной сети с таким кодом');

    return finishJoin(match, user.id, user.callsign, user.squad, user.role);
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
    const batch = z.array(PosSchema).max(50).safeParse(Array.isArray(req.body) ? req.body : [req.body]);
    if (!batch.success) return fail(reply, 400, 'bad_request', 'Некорректные координаты');
    for (const pos of batch.data.sort((a, b) => a.ts - b.ts)) await hub.position(self, pos);
    return reply.code(204).send();
  });

  app.get('/api/voice', async (req, reply) => {
    const self = await member(req, reply);
    if (!self) return;
    if (!voiceEnabled()) return fail(reply, 503, 'voice_disabled', 'Голосовой сервер не настроен');
    return voiceGrants(self, livekitUrlFor(req.host, req.protocol));
  });

  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    if (err instanceof Denied) return fail(reply, 403, err.code, err.message);
    const status = err.statusCode ?? 500;
    if (status >= 500) app.log.error(err);
    return fail(reply, status, status === 429 ? 'rate_limited' : 'error', status >= 500 ? 'Внутренняя ошибка сервера' : 'Некорректный запрос');
  });
}
