import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { customAlphabet, nanoid } from 'nanoid';
import { z } from 'zod';
import {
  ClientMsgSchema,
  CreateMatchSchema,
  JoinSchema,
  PosSchema,
  isCommandRole,
  type JoinResponse,
  type SelfInfo,
} from '@tactic/shared';
import { bearer, isAdmin, issueToken, verifyToken } from './auth.js';
import { store } from './db.js';
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
    fail(reply, 401, 'unauthorized', 'Invalid or expired session');
    return null;
  }
  return self;
}

function requireAdmin(req: FastifyRequest, reply: FastifyReply): boolean {
  if (isAdmin(req.headers.authorization)) return true;
  fail(reply, 401, 'unauthorized', 'Admin token required');
  return false;
}

export function registerRoutes(app: FastifyInstance, hub: Hub) {
  app.get('/api/health', async () => ({ ok: true, ts: Date.now(), voice: voiceEnabled(), ...hub.stats() }));

  // ---------- admin ----------
  app.post('/api/admin/matches', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const body = CreateMatchSchema.safeParse(req.body);
    if (!body.success) return fail(reply, 400, 'bad_request', body.error.issues[0]?.message ?? 'invalid');
    const code = body.data.code ?? matchCode();
    if (store.activeMatchByCode(code)) return fail(reply, 409, 'conflict', 'Code already used by an active match');
    const m = store.createMatch({ id: nanoid(10), name: body.data.name, code, commandPin: body.data.commandPin });
    return reply.code(201).send({ id: m.id, name: m.name, code: m.code, createdAt: m.createdAt });
  });

  app.get('/api/admin/matches', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    return store.listMatches().map(({ commandPin: _pin, briefing: _b, ...m }) => m);
  });

  app.post<{ Params: { id: string } }>('/api/admin/matches/:id/end', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    if (!store.match(req.params.id)) return fail(reply, 404, 'not_found', 'No such match');
    hub.endMatch(req.params.id);
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
        const m = members[t.member_id];
        const tr = (tracks[t.member_id] ??= { callsign: m?.callsign ?? '?', squad: m?.squad ?? '?', points: [] });
        tr.points.push([t.lat, t.lon, t.ts]);
      }
      return tracks;
    },
  );

  /**
   * Webhook / direct API: inject tactical events (referee bot, scripted objectives, etc).
   * Body is any client message, e.g. {"t":"marker.upsert","marker":{...}} or {"t":"chat","channel":"all","text":"..."}.
   */
  app.post<{ Params: { id: string } }>('/api/admin/matches/:id/events', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    if (!store.match(req.params.id)) return fail(reply, 404, 'not_found', 'No such match');
    const msg = ClientMsgSchema.safeParse(req.body);
    if (!msg.success) return fail(reply, 400, 'bad_request', msg.error.issues[0]?.message ?? 'invalid');
    if (msg.data.t === 'pos' || msg.data.t === 'hello' || msg.data.t === 'ping' || msg.data.t === 'heading' || msg.data.t === 'status') {
      return fail(reply, 400, 'bad_request', `Event ${msg.data.t} not allowed via webhook`);
    }
    await hub.system(req.params.id, msg.data);
    return { ok: true };
  });

  // ---------- players ----------
  app.post('/api/join', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    const body = JoinSchema.safeParse(req.body);
    if (!body.success) return fail(reply, 400, 'bad_request', body.error.issues[0]?.message ?? 'invalid');
    const { code, callsign, squad, role, pin } = body.data;
    const match = store.activeMatchByCode(code);
    if (!match) return fail(reply, 404, 'not_found', 'No active match with this code');
    if ((isCommandRole(role) || squad === 'command') && pin !== match.commandPin) {
      return fail(reply, 403, 'forbidden', 'Command PIN required for leader/commander/HQ');
    }
    const m = store.upsertMember(match.id, callsign, squad, role, nanoid(10));
    const self: SelfInfo = { id: m.id, callsign: m.callsign, squad: m.squad, role: m.role, matchId: match.id };
    const res: JoinResponse = {
      token: await issueToken(self),
      self,
      match: { id: match.id, name: match.name, code: match.code, createdAt: match.createdAt, endedAt: match.endedAt },
    };
    return res;
  });

  /** Position uplink for the Android foreground service (works with the WebView suspended). */
  app.post('/api/telemetry', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req, reply) => {
    const self = await member(req, reply);
    if (!self) return;
    const batch = z.array(PosSchema).max(50).safeParse(Array.isArray(req.body) ? req.body : [req.body]);
    if (!batch.success) return fail(reply, 400, 'bad_request', batch.error.issues[0]?.message ?? 'invalid');
    for (const pos of batch.data.sort((a, b) => a.ts - b.ts)) await hub.position(self, pos);
    return reply.code(204).send();
  });

  app.get('/api/voice', async (req, reply) => {
    const self = await member(req, reply);
    if (!self) return;
    if (!voiceEnabled()) return fail(reply, 503, 'voice_disabled', 'Voice server not configured');
    return voiceGrants(self, livekitUrlFor(req.host, req.protocol));
  });

  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    if (err instanceof Denied) return fail(reply, 403, err.code, err.message);
    const status = err.statusCode ?? 500;
    if (status >= 500) app.log.error(err);
    return fail(reply, status, status === 429 ? 'rate_limited' : 'error', status >= 500 ? 'Internal error' : err.message);
  });
}
