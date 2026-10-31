// Match rooms: live player state, permission checks, and fan-out to WebSocket clients.
import type { WebSocket } from 'ws';
import { nanoid } from 'nanoid';
import {
  canSeeChat,
  isCommandRole,
  type ChatMsg,
  type ClientMsg,
  type Marker,
  type PlayerState,
  type PosInput,
  type Route,
  type SelfInfo,
  type ServerMsg,
  type Zone,
} from '@tactic/shared';
import { Bus, type Envelope } from './bus.js';
import { config } from './config.js';
import { store } from './db.js';

interface Conn {
  ws: WebSocket;
  self: SelfInfo;
  alive: boolean;
}

/** Thrown for requests the sender is not allowed to make; reported back as an error frame. */
export class Denied extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

class MatchRoom {
  conns = new Set<Conn>();
  players = new Map<string, PlayerState>();
  /** Changed player states waiting for the next flush (local origin only). */
  dirty = new Set<string>();
  lastTrack = new Map<string, number>();

  constructor(public id: string) {}
}

const SYSTEM: SelfInfo = { id: 'system', callsign: 'HQ-BOT', squad: 'command', role: 'commander', matchId: '' };

export class Hub {
  private rooms = new Map<string, MatchRoom>();
  private timers: NodeJS.Timeout[] = [];

  constructor(private bus: Bus) {}

  async start(log: (m: string) => void) {
    await this.bus.start((env) => this.deliver(env), log);
    this.timers.push(setInterval(() => this.flush(), config.flushMs));
    this.timers.push(setInterval(() => this.heartbeat(), 20_000));
    this.timers.push(setInterval(() => this.expire(), 5_000));
    this.timers.push(setInterval(() => store.purge(config.retentionDays), 3_600_000));
  }

  async stop() {
    this.timers.forEach(clearInterval);
    for (const room of this.rooms.values()) for (const c of room.conns) c.ws.close(1001, 'server shutdown');
    await this.bus.stop();
  }

  stats() {
    let conns = 0;
    for (const r of this.rooms.values()) conns += r.conns.size;
    return { rooms: this.rooms.size, conns, instance: this.bus.instanceId };
  }

  // ---------- connections ----------

  private async room(matchId: string): Promise<MatchRoom> {
    let room = this.rooms.get(matchId);
    if (room) return room;
    room = new MatchRoom(matchId);
    this.rooms.set(matchId, room);
    for (const m of store.members(matchId)) room.players.set(m.id, this.blankPlayer(m));
    for (const p of await this.bus.loadPlayers(matchId)) {
      const base = room.players.get(p.id);
      if (base) room.players.set(p.id, { ...p, callsign: base.callsign, squad: base.squad, role: base.role, online: false });
    }
    return room;
  }

  private blankPlayer(m: { id: string; callsign: string; squad: PlayerState['squad']; role: PlayerState['role'] }): PlayerState {
    return {
      id: m.id,
      callsign: m.callsign,
      squad: m.squad,
      role: m.role,
      status: 'ok',
      online: false,
      lat: null,
      lon: null,
      acc: 0,
      heading: null,
      speed: null,
      bat: null,
      ts: 0,
    };
  }

  async attach(ws: WebSocket, self: SelfInfo) {
    const match = store.match(self.matchId);
    if (!match || match.endedAt) {
      this.sendTo(ws, { t: 'error', code: 'match_ended', message: 'Match is not active' });
      ws.close(4004, 'match not active');
      return;
    }
    const room = await this.room(self.matchId);
    const conn: Conn = { ws, self, alive: true };
    room.conns.add(conn);

    const prev = room.players.get(self.id) ?? this.blankPlayer(self);
    const player: PlayerState = { ...prev, callsign: self.callsign, squad: self.squad, role: self.role, online: true };
    room.players.set(self.id, player);

    const { markers, zones, routes } = store.objects(self.matchId);
    this.sendTo(ws, {
      t: 'snapshot',
      self,
      match: { id: match.id, name: match.name, code: match.code, createdAt: match.createdAt, endedAt: match.endedAt },
      players: [...room.players.values()],
      markers,
      zones,
      routes,
      chat: store.recentChat(self.matchId).filter((m) => canSeeChat(m, self.squad, self.role)),
      briefing: match.briefing,
      serverTs: Date.now(),
    });
    this.markDirty(room, self.id);

    ws.on('pong', () => (conn.alive = true));
    ws.on('close', () => {
      room.conns.delete(conn);
      const stillHere = [...room.conns].some((c) => c.self.id === self.id);
      const p = room.players.get(self.id);
      if (p && !stillHere) {
        p.online = false;
        this.markDirty(room, self.id);
      }
    });
  }

  // ---------- inbound ----------

  /** Apply one client message on behalf of `self`. Shared by WebSocket, telemetry and webhook paths. */
  async apply(self: SelfInfo, msg: ClientMsg, ws?: WebSocket) {
    const room = await this.room(self.matchId);
    const now = Date.now();
    const cmd = isCommandRole(self.role);

    switch (msg.t) {
      case 'hello':
        return;
      case 'ping':
        if (ws) this.sendTo(ws, { t: 'pong', ts: msg.ts, serverTs: now });
        return;
      case 'pos':
        return this.position(self, msg);
      case 'heading': {
        const p = room.players.get(self.id);
        if (!p) return;
        p.heading = Math.round(msg.heading);
        this.markDirty(room, self.id);
        return;
      }
      case 'status': {
        const p = room.players.get(self.id);
        if (!p) return;
        p.status = msg.status;
        this.markDirty(room, self.id);
        if (msg.status !== 'ok') {
          const text = msg.status === 'medic' ? 'requests MEDIC' : msg.status === 'hit' ? 'is HIT' : 'is OUT';
          this.chat(self, { channel: 'squad', text: `${self.callsign} ${text}`, kind: 'system', spot: p.lat != null ? { lat: p.lat, lon: p.lon! } : undefined });
        }
        return;
      }
      case 'chat':
        if (msg.channel === 'command' && !cmd && self.squad !== 'command') {
          throw new Denied('forbidden', 'Command net is for leaders only');
        }
        this.chat(self, { channel: msg.channel, text: msg.text, kind: msg.spot ? 'spot' : 'text', spot: msg.spot });
        return;
      case 'marker.upsert': {
        const input = msg.marker;
        if (input.kind !== 'contact' && input.kind !== 'medic' && input.kind !== 'danger' && !cmd) {
          throw new Denied('forbidden', 'Only leaders can place objectives, waypoints and rally points');
        }
        const existing = input.id ? store.getObject<Marker>(self.matchId, input.id) : null;
        if (existing && existing.type !== 'marker') throw new Denied('bad_request', 'id belongs to another object');
        if (existing && existing.data.createdById !== self.id && !cmd && input.kind !== 'contact') {
          throw new Denied('forbidden', 'Not your marker');
        }
        const ttl = input.ttlSec ?? (input.kind === 'contact' ? 300 : 0);
        const marker: Marker = {
          ...input,
          ttlSec: ttl,
          id: input.id ?? nanoid(10),
          createdBy: existing?.data.createdBy ?? self.callsign,
          createdById: existing?.data.createdById ?? self.id,
          createdAt: existing?.data.createdAt ?? now,
          updatedAt: now,
          expiresAt: ttl > 0 ? now + ttl * 1000 : null,
        };
        store.putObject(self.matchId, 'marker', marker);
        this.bus.publish(self.matchId, { t: 'marker', marker });
        return;
      }
      case 'marker.delete': {
        const existing = store.getObject<Marker>(self.matchId, msg.id);
        if (!existing || existing.type !== 'marker') return;
        if (existing.data.createdById !== self.id && !cmd) throw new Denied('forbidden', 'Not your marker');
        store.deleteObject(self.matchId, msg.id);
        this.bus.publish(self.matchId, { t: 'marker.delete', id: msg.id });
        return;
      }
      case 'zone.upsert': {
        if (!cmd) throw new Denied('forbidden', 'Only leaders can draw zones');
        const zone: Zone = { ...msg.zone, id: msg.zone.id ?? nanoid(10), createdBy: self.callsign, updatedAt: now };
        store.putObject(self.matchId, 'zone', zone);
        this.bus.publish(self.matchId, { t: 'zone', zone });
        return;
      }
      case 'zone.delete':
        if (!cmd) throw new Denied('forbidden', 'Only leaders can delete zones');
        if (store.deleteObject(self.matchId, msg.id)) this.bus.publish(self.matchId, { t: 'zone.delete', id: msg.id });
        return;
      case 'route.upsert': {
        if (!cmd) throw new Denied('forbidden', 'Only leaders can draw routes');
        const route: Route = { ...msg.route, id: msg.route.id ?? nanoid(10), createdBy: self.callsign, updatedAt: now };
        store.putObject(self.matchId, 'route', route);
        this.bus.publish(self.matchId, { t: 'route', route });
        return;
      }
      case 'route.delete':
        if (!cmd) throw new Denied('forbidden', 'Only leaders can delete routes');
        if (store.deleteObject(self.matchId, msg.id)) this.bus.publish(self.matchId, { t: 'route.delete', id: msg.id });
        return;
      case 'briefing.set': {
        if (!cmd) throw new Denied('forbidden', 'Only leaders can edit the briefing');
        const briefing = { text: msg.text, by: self.callsign, ts: now };
        store.setBriefing(self.matchId, briefing);
        this.bus.publish(self.matchId, { t: 'briefing', briefing });
        return;
      }
    }
  }

  /** Position from WebSocket or the native foreground service (HTTP telemetry). */
  async position(self: SelfInfo, pos: PosInput) {
    const room = await this.room(self.matchId);
    const p = room.players.get(self.id) ?? this.blankPlayer(self);
    // Drop out-of-order fixes (telemetry and WS can race).
    if (pos.ts < p.ts) return;
    Object.assign(p, {
      lat: pos.lat,
      lon: pos.lon,
      acc: Math.round(pos.acc),
      heading: pos.heading ?? p.heading,
      speed: pos.speed,
      bat: pos.bat ?? p.bat,
      ts: Math.min(pos.ts, Date.now()),
      online: true,
    });
    room.players.set(self.id, p);
    this.markDirty(room, self.id);

    const last = room.lastTrack.get(self.id) ?? 0;
    if (p.ts - last >= config.trackSampleMs) {
      room.lastTrack.set(self.id, p.ts);
      store.addTrack(self.matchId, self.id, pos.lat, pos.lon, p.ts);
    }
  }

  chat(self: SelfInfo, m: { channel: ChatMsg['channel']; text: string; kind: ChatMsg['kind']; spot?: { lat: number; lon: number } }) {
    const msg: ChatMsg = {
      id: nanoid(12),
      channel: m.channel,
      squad: m.channel === 'squad' ? self.squad : null,
      fromId: self.id,
      callsign: self.callsign,
      kind: m.kind,
      text: m.text,
      ts: Date.now(),
      ...(m.spot ? { lat: m.spot.lat, lon: m.spot.lon } : {}),
    };
    store.addChat(self.matchId, msg);
    this.bus.publish(self.matchId, { t: 'chat', msg });
  }

  /** Inject an event from the admin webhook as the HQ bot. */
  async system(matchId: string, msg: ClientMsg) {
    await this.apply({ ...SYSTEM, matchId }, msg);
  }

  endMatch(matchId: string) {
    const endedAt = Date.now();
    store.endMatch(matchId, endedAt);
    this.bus.publish(matchId, { t: 'match.end', endedAt });
  }

  // ---------- outbound ----------

  private markDirty(room: MatchRoom, playerId: string) {
    room.dirty.add(playerId);
  }

  /** Batch dirty player states into a single frame per match every flushMs. */
  private flush() {
    for (const room of this.rooms.values()) {
      if (room.dirty.size === 0) continue;
      const players: PlayerState[] = [];
      for (const id of room.dirty) {
        const p = room.players.get(id);
        if (p) players.push(p);
      }
      room.dirty.clear();
      this.bus.publish(room.id, { t: 'players', players });
      this.bus.savePlayers(room.id, players);
    }
  }

  /** Delivers an envelope from any instance to local sockets, applying visibility rules. */
  private deliver({ matchId, msg }: Envelope) {
    const room = this.rooms.get(matchId);
    if (!room) return;

    if (msg.t === 'players') {
      // Keep remote instances' player maps in sync for snapshots.
      for (const p of msg.players) room.players.set(p.id, { ...room.players.get(p.id), ...p });
    }

    const raw = JSON.stringify(msg);
    for (const c of room.conns) {
      if (msg.t === 'chat' && !canSeeChat(msg.msg, c.self.squad, c.self.role)) continue;
      if (c.ws.readyState === c.ws.OPEN) c.ws.send(raw);
    }
    if (msg.t === 'match.end') {
      for (const c of room.conns) c.ws.close(4004, 'match ended');
      this.rooms.delete(matchId);
    }
  }

  sendTo(ws: WebSocket, msg: ServerMsg) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  }

  private heartbeat() {
    for (const room of this.rooms.values()) {
      for (const c of room.conns) {
        if (!c.alive) {
          c.ws.terminate();
          continue;
        }
        c.alive = false;
        c.ws.ping();
      }
      // Members on native telemetry only (no socket) go offline after 90 s of silence.
      const now = Date.now();
      for (const p of room.players.values()) {
        if (p.online && now - p.ts > 90_000 && ![...room.conns].some((c) => c.self.id === p.id)) {
          p.online = false;
          room.dirty.add(p.id);
        }
      }
    }
  }

  private expire() {
    for (const { id, matchId } of store.takeExpired()) {
      this.bus.publish(matchId, { t: 'marker.delete', id });
    }
  }
}
