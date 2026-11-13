// Match rooms: live player state, permission checks, voice relay, and fan-out to WebSocket clients.
import type { WebSocket } from 'ws';
import { nanoid } from 'nanoid';
import {
  VOICE_CHANNELS,
  canHearVoice,
  canSeeChat,
  isCommandRole,
  voiceChannelsFor,
  type ChatMsg,
  type ClientMsg,
  type Marker,
  type PlayerState,
  type PosInput,
  type Route,
  type SelfInfo,
  type ServerMsg,
  type Squad,
  type VoiceChannel,
  type Zone,
} from '@tactic/shared';
import { issueToken, safeEqual } from './auth.js';
import { Bus, type Envelope } from './bus.js';
import { config } from './config.js';
import { store } from './db.js';

/** Member identity on the server: the public SelfInfo plus the account it belongs to. */
export type Self = SelfInfo & { userId: string };

interface Conn {
  ws: WebSocket;
  self: Self;
  alive: boolean;
}

interface TalkingState {
  channel: VoiceChannel;
  squad: Squad | null;
  callsign: string;
  ts: number;
}

/** Thrown for requests the sender is not allowed to make; reported back as an error frame. */
export class Denied extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

/** Token bucket keyed by an arbitrary string (per user and action). */
class Buckets {
  private b = new Map<string, { tokens: number; last: number }>();
  constructor(private burst: number, private perSec: number) {}
  take(key: string): boolean {
    const now = Date.now();
    const s = this.b.get(key) ?? { tokens: this.burst, last: now };
    s.tokens = Math.min(this.burst, s.tokens + ((now - s.last) / 1000) * this.perSec);
    s.last = now;
    this.b.set(key, s);
    if (s.tokens < 1) return false;
    s.tokens -= 1;
    return true;
  }
  sweep() {
    const old = Date.now() - 600_000;
    for (const [k, s] of this.b) if (s.last < old) this.b.delete(k);
  }
}

const LIMITS = {
  chat: new Buckets(5, 1),
  status: new Buckets(2, 0.5),
  marker: new Buckets(10, 1),
  draw: new Buckets(5, 0.5),
  squad: new Buckets(3, 0.2),
};
const MAX_OWN_MARKERS = 40;
const MAX_OBJECTS_PER_MATCH = 1500;
/** Wrong command PIN attempts before the account is locked out of PIN checks for this match. */
const PIN_MAX_FAILS = 5;
const PIN_LOCK_MS = 15 * 60_000;
/** Faster than this between fixes is a GPS glitch or spoofing, not a running player. */
const MAX_SPEED_MS = 40;
/** A fix this coarse (cell tower / IP) is worse than no fix on a tactical map. */
const MAX_ACC_M = 1000;
/** PTT floor: another talker on the same net within this window = channel busy. */
const FLOOR_HOLD_MS = 1500;
/** Largest accepted voice frame, bytes (normal: 642). */
const MAX_AUDIO_FRAME = 2048;

class MatchRoom {
  conns = new Set<Conn>();
  players = new Map<string, PlayerState>();
  /** Changed player states waiting for the next flush (local origin only). */
  dirty = new Set<string>();
  lastTrack = new Map<string, number>();
  talking = new Map<string, TalkingState>();

  constructor(public id: string) {}
}

const SYSTEM: Self = { id: 'system', userId: 'system', callsign: 'HQ-BOT', squad: 'command', role: 'commander', matchId: '' };

const publicSelf = (s: Self): SelfInfo => ({ id: s.id, callsign: s.callsign, squad: s.squad, role: s.role, matchId: s.matchId });

function distanceM(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const R = 6371000;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLon = ((bLon - aLon) * Math.PI) / 180;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos((aLat * Math.PI) / 180) * Math.cos((bLat * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

export class Hub {
  private rooms = new Map<string, MatchRoom>();
  private timers: NodeJS.Timeout[] = [];
  private pinFails = new Map<string, { n: number; until: number }>();
  private busyNotified = new Map<string, number>();

  constructor(private bus: Bus) {}

  async start(log: (m: string) => void) {
    await this.bus.start((env) => this.deliver(env), log);
    this.timers.push(setInterval(() => this.flush(), config.flushMs));
    this.timers.push(setInterval(() => this.heartbeat(), 20_000));
    this.timers.push(setInterval(() => this.expire(), 1_000));
    this.timers.push(
      setInterval(() => {
        store.purge(config.retentionDays);
        Object.values(LIMITS).forEach((b) => b.sweep());
      }, 3_600_000),
    );
  }

  async stop() {
    this.timers.forEach(clearInterval);
    for (const room of this.rooms.values()) for (const c of room.conns) c.ws.close(1001, 'server shutdown');
    await this.bus.stop();
  }

  onlineCount(matchId: string): number {
    const room = this.rooms.get(matchId);
    if (!room) return 0;
    let count = 0;
    for (const p of room.players.values()) if (p.online) count++;
    return count;
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

  /**
   * Binds an authenticated socket to its match. Returns false when the match has ended or no longer
   * exists — the caller closes the socket. A token is NEVER silently moved into another network.
   */
  async attach(ws: WebSocket, self: Self): Promise<boolean> {
    const match = store.activeMatch(self.matchId);
    if (!match) return false;
    const m = store.upsertMember(match.id, self.callsign, self.squad, self.role, self.id);
    self.id = m.id;

    const room = await this.room(self.matchId);
    // The socket may have closed while the room was loading: do not leave a ghost connection behind.
    if (ws.readyState !== ws.OPEN) return true;
    const conn: Conn = { ws, self, alive: true };
    room.conns.add(conn);

    const prev = room.players.get(self.id) ?? this.blankPlayer(self);
    room.players.set(self.id, { ...prev, callsign: self.callsign, squad: self.squad, role: self.role, online: true });

    const { markers, zones, routes } = store.objects(self.matchId);
    this.sendTo(ws, {
      t: 'snapshot',
      self: publicSelf(self),
      match: { id: match.id, name: match.name, code: match.code, createdAt: match.createdAt, endedAt: match.endedAt },
      players: [...room.players.values()],
      markers,
      zones,
      routes,
      chat: store.recentChat(self.matchId).filter((c) => canSeeChat(c, self.squad, self.role)),
      briefing: match.briefing,
      serverTs: Date.now(),
    });
    // Sliding session: every (re)connect hands out a fresh token.
    this.sendTo(ws, { t: 'self', self: publicSelf(self), token: await issueToken(self, self.userId) });
    this.markDirty(room, self.id);

    ws.on('pong', () => (conn.alive = true));
    ws.on('close', () => this.detach(room, conn));
    return true;
  }

  private detach(room: MatchRoom, conn: Conn) {
    if (!room.conns.delete(conn)) return;
    const id = conn.self.id;
    if ([...room.conns].some((c) => c.self.id === id)) return;
    this.stopTalking(room, id);
    const p = room.players.get(id);
    if (p) {
      p.online = false;
      this.markDirty(room, id);
    }
  }

  private stopTalking(room: MatchRoom, playerId: string) {
    const tk = room.talking.get(playerId);
    if (!tk) return;
    room.talking.delete(playerId);
    this.bus.publish(room.id, { t: 'voice.rx', channel: tk.channel, squad: tk.squad, fromId: playerId, callsign: null });
  }

  // ---------- voice binary relay ----------

  /** Someone else holds this net right now? (half-duplex radio: one talker per net) */
  // ponytail: floor state is per instance; with several instances behind Redis two talkers on different nodes can overlap.
  private floorHolder(room: MatchRoom, selfId: string, channel: VoiceChannel, squad: Squad | null): TalkingState | null {
    const now = Date.now();
    for (const [id, tk] of room.talking) {
      if (id !== selfId && tk.channel === channel && tk.squad === squad && now - tk.ts < FLOOR_HOLD_MS) return tk;
    }
    return null;
  }

  private notifyBusy(self: Self, channel: VoiceChannel, holder: TalkingState) {
    const key = `${self.matchId}:${self.id}`;
    const now = Date.now();
    if (now - (this.busyNotified.get(key) ?? 0) < 1000) return;
    this.busyNotified.set(key, now);
    const room = this.rooms.get(self.matchId);
    for (const c of room?.conns ?? []) if (c.self.id === self.id) this.sendTo(c.ws, { t: 'voice.busy', channel, callsign: holder.callsign });
  }

  onAudio(self: Self, raw: Buffer) {
    // Frame format: [0x56 ('V'), channelIdx (0=squad, 1=platoon, 2=command), ...ulawBytes]
    // A real frame is 2 + 640 bytes (40 ms of µ-law); anything far larger is channel flooding.
    if (raw.length < 4 || raw.length > MAX_AUDIO_FRAME || raw[0] !== 0x56) return;
    const channel = VOICE_CHANNELS[raw[1]!];
    if (!channel) return;
    if (!voiceChannelsFor(self.squad, self.role).includes(channel)) return;

    const room = this.rooms.get(self.matchId);
    if (!room) return;
    const squad = channel === 'squad' ? self.squad : null;
    const holder = this.floorHolder(room, self.id, channel, squad);
    if (holder) return this.notifyBusy(self, channel, holder);

    const prev = room.talking.get(self.id);
    room.talking.set(self.id, { channel, squad, callsign: self.callsign, ts: Date.now() });
    if (!prev || prev.channel !== channel) {
      this.bus.publish(self.matchId, { t: 'voice.rx', channel, squad, fromId: self.id, callsign: self.callsign });
    }
    this.bus.publishAudio({ matchId: self.matchId, channel, squad, fromId: self.id, callsign: self.callsign, data: raw.subarray(2) });
  }

  // ---------- inbound ----------

  /** Apply one client message on behalf of `self`. Shared by WebSocket and the admin webhook. */
  async apply(self: Self, msg: ClientMsg, ws?: WebSocket) {
    const room = await this.room(self.matchId);
    const now = Date.now();
    const cmd = isCommandRole(self.role);
    const limit = (b: Buckets) => {
      if (self.userId !== SYSTEM.userId && !b.take(`${self.matchId}:${self.userId}`)) throw new Denied('rate_limited', 'Слишком часто — подождите пару секунд');
    };

    switch (msg.t) {
      case 'hello':
        return;
      case 'ping':
        if (ws) this.sendTo(ws, { t: 'pong', ts: msg.ts, serverTs: now });
        return;
      case 'pos':
        return this.position(self, msg, now);
      case 'heading': {
        const p = room.players.get(self.id);
        if (!p) return;
        p.heading = Math.round(msg.heading) % 360;
        this.markDirty(room, self.id);
        return;
      }
      case 'status': {
        limit(LIMITS.status);
        const p = room.players.get(self.id);
        if (!p || p.status === msg.status) return;
        p.status = msg.status;
        this.markDirty(room, self.id);
        if (msg.status !== 'ok' && self.squad !== 'none') {
          const text = msg.status === 'medic' ? 'requests MEDIC' : msg.status === 'hit' ? 'is HIT' : 'is OUT';
          this.chat(self, { channel: 'squad', text: `${self.callsign} ${text}`, kind: 'system', spot: p.lat != null ? { lat: p.lat, lon: p.lon! } : undefined });
        }
        return;
      }
      case 'squad.set': {
        limit(LIMITS.squad);
        const nextSquad = msg.squad;
        const nextRole = msg.role ?? self.role;
        const match = store.activeMatch(self.matchId);
        if (!match) throw new Denied('match_ended', 'Сеть завершена');
        const alreadyPrivileged = isCommandRole(self.role) || self.squad === 'command';
        const needsPin = (isCommandRole(nextRole) || nextSquad === 'command') && !alreadyPrivileged;
        if (needsPin) this.checkPin(self, match.commandPin, msg.pin ?? '');
        this.stopTalking(room, self.id);
        self.squad = nextSquad;
        self.role = nextRole;
        for (const c of room.conns) {
          if (c.self.id === self.id) {
            c.self.squad = nextSquad;
            c.self.role = nextRole;
          }
        }
        store.updateMember(self.id, nextSquad, nextRole);
        // Only the squad is remembered on the account: a role unlocked with this network's PIN stays here.
        store.updateUserSquad(self.userId, nextSquad);
        const p = room.players.get(self.id);
        if (p) {
          p.squad = nextSquad;
          p.role = nextRole;
          this.markDirty(room, self.id);
        }
        const token = await issueToken(self, self.userId);
        for (const c of room.conns) if (c.self.id === self.id) this.sendTo(c.ws, { t: 'self', self: publicSelf(self), token });
        return;
      }
      case 'leave':
        await this.leaveMatch(self);
        return;
      case 'voice.tx': {
        if (!voiceChannelsFor(self.squad, self.role).includes(msg.channel)) return;
        const squad = msg.channel === 'squad' ? self.squad : null;
        if (!msg.active) return this.stopTalking(room, self.id);
        const holder = this.floorHolder(room, self.id, msg.channel, squad);
        if (holder) return this.notifyBusy(self, msg.channel, holder);
        room.talking.set(self.id, { channel: msg.channel, squad, callsign: self.callsign, ts: now });
        this.bus.publish(self.matchId, { t: 'voice.rx', channel: msg.channel, squad, fromId: self.id, callsign: self.callsign });
        return;
      }
      case 'chat':
        limit(LIMITS.chat);
        if (msg.channel === 'command' && !cmd && self.squad !== 'command') {
          throw new Denied('forbidden', 'Канал CMD — только для командиров');
        }
        if (msg.channel === 'squad' && self.squad === 'none') {
          throw new Denied('bad_request', 'Вы не в отряде — выберите канал ALL');
        }
        this.chat(self, { id: msg.id, channel: msg.channel, text: msg.text, kind: msg.spot ? 'spot' : 'text', spot: msg.spot });
        return;
      case 'marker.upsert': {
        limit(LIMITS.marker);
        const input = msg.marker;
        const playerKind = input.kind === 'contact' || input.kind === 'medic' || input.kind === 'danger';
        if (!playerKind && !cmd) throw new Denied('forbidden', 'Цели, точки, TRP и точки сбора ставят только командиры');
        const existing = input.id ? store.getObject<Marker>(self.matchId, input.id) : null;
        if (existing && existing.type !== 'marker') throw new Denied('bad_request', 'Объект с таким id уже существует');
        const prev = existing?.data;
        const mine = !prev || prev.createdById === self.id;

        let marker: Marker;
        if (prev && !mine && !cmd) {
          // Anyone may confirm a teammate's contact is still there (refreshes its TTL) — nothing else.
          if (prev.kind !== 'contact' || input.kind !== 'contact') throw new Denied('forbidden', 'Это не ваша метка');
          marker = { ...prev, updatedAt: now, expiresAt: prev.ttlSec ? now + prev.ttlSec * 1000 : null };
        } else {
          if (!prev && !cmd && store.countMarkersBy(self.matchId, self.id) >= MAX_OWN_MARKERS) {
            throw new Denied('rate_limited', `Не больше ${MAX_OWN_MARKERS} своих меток — удалите старые`);
          }
          if (!prev && store.countObjects(self.matchId) >= MAX_OBJECTS_PER_MATCH) throw new Denied('rate_limited', 'На карте слишком много объектов');
          if (input.kind === 'trp') {
            const name = input.label.toUpperCase();
            if (!name) throw new Denied('bad_request', 'Укажите кодовое имя TRP');
            const clash = store.objects(self.matchId).markers.find((m) => m.kind === 'trp' && m.id !== input.id && m.label.toUpperCase() === name);
            if (clash) throw new Denied('bad_request', `TRP «${name}» уже существует`);
            input.label = name;
          }
          const ttl = input.ttlSec ?? (input.kind === 'contact' ? 300 : 0);
          marker = {
            ...input,
            ttlSec: ttl,
            id: input.id ?? nanoid(10),
            createdBy: prev?.createdBy ?? self.callsign,
            createdById: prev?.createdById ?? self.id,
            createdAt: prev?.createdAt ?? now,
            updatedAt: now,
            expiresAt: ttl > 0 ? now + ttl * 1000 : null,
          };
        }
        if (!store.putObject(self.matchId, 'marker', marker)) throw new Denied('bad_request', 'Объект с таким id уже существует');
        this.bus.publish(self.matchId, { t: 'marker', marker });
        return;
      }
      case 'marker.delete': {
        const existing = store.getObject<Marker>(self.matchId, msg.id);
        if (!existing || existing.type !== 'marker') return;
        if (existing.data.createdById !== self.id && !cmd) throw new Denied('forbidden', 'Это не ваша метка');
        store.deleteObject(self.matchId, msg.id);
        this.bus.publish(self.matchId, { t: 'marker.delete', id: msg.id });
        return;
      }
      case 'zone.upsert': {
        if (!cmd) throw new Denied('forbidden', 'Зоны рисуют только командиры');
        limit(LIMITS.draw);
        const zone: Zone = { ...msg.zone, id: msg.zone.id ?? nanoid(10), createdBy: self.callsign, updatedAt: now };
        if (!store.putObject(self.matchId, 'zone', zone)) throw new Denied('bad_request', 'Объект с таким id уже существует');
        this.bus.publish(self.matchId, { t: 'zone', zone });
        return;
      }
      case 'zone.delete':
        if (!cmd) throw new Denied('forbidden', 'Удалять зоны могут только командиры');
        if (store.getObject(self.matchId, msg.id)?.type !== 'zone') return;
        if (store.deleteObject(self.matchId, msg.id)) this.bus.publish(self.matchId, { t: 'zone.delete', id: msg.id });
        return;
      case 'route.upsert': {
        if (!cmd) throw new Denied('forbidden', 'Маршруты рисуют только командиры');
        limit(LIMITS.draw);
        const route: Route = { ...msg.route, id: msg.route.id ?? nanoid(10), createdBy: self.callsign, updatedAt: now };
        if (!store.putObject(self.matchId, 'route', route)) throw new Denied('bad_request', 'Объект с таким id уже существует');
        this.bus.publish(self.matchId, { t: 'route', route });
        return;
      }
      case 'route.delete':
        if (!cmd) throw new Denied('forbidden', 'Удалять маршруты могут только командиры');
        if (store.getObject(self.matchId, msg.id)?.type !== 'route') return;
        if (store.deleteObject(self.matchId, msg.id)) this.bus.publish(self.matchId, { t: 'route.delete', id: msg.id });
        return;
      case 'briefing.set': {
        if (!cmd) throw new Denied('forbidden', 'Брифинг редактируют только командиры');
        limit(LIMITS.draw);
        const briefing = { text: msg.text, by: self.callsign, ts: now };
        store.setBriefing(self.matchId, briefing);
        this.bus.publish(self.matchId, { t: 'briefing', briefing });
        return;
      }
    }
  }

  /** Command PIN with lockout: 5 wrong attempts lock PIN checks for 15 minutes. */
  private checkPin(self: Self, pin: string, input: string) {
    const key = `${self.matchId}:${self.userId}`;
    const now = Date.now();
    const st = this.pinFails.get(key);
    if (st && st.until > now) {
      throw new Denied('rate_limited', `PIN заблокирован после ${PIN_MAX_FAILS} ошибок — попробуйте через ${Math.ceil((st.until - now) / 60000)} мин`);
    }
    if (input && safeEqual(input, pin)) {
      this.pinFails.delete(key);
      return;
    }
    const n = (st && st.until === 0 ? st.n : 0) + 1;
    this.pinFails.set(key, n >= PIN_MAX_FAILS ? { n: 0, until: now + PIN_LOCK_MS } : { n, until: 0 });
    throw new Denied('forbidden', 'Для роли командира / штаба нужен верный PIN командира');
  }

  async leaveMatch(self: Self) {
    const room = await this.room(self.matchId);
    this.stopTalking(room, self.id);
    room.players.delete(self.id);
    room.dirty.delete(self.id);
    store.removeMember(self.matchId, self.id);
    this.bus.removePlayer(self.matchId, self.id);
    this.bus.publish(self.matchId, { t: 'player.leave', id: self.id });
    // The socket that sent 'leave' must not keep feeding positions back into the room.
    for (const c of [...room.conns]) if (c.self.id === self.id) (room.conns.delete(c), c.ws.close(4004, 'left'));
  }

  /** Disconnects every session of a user and removes them from all rooms. Tokens are revoked by the caller. */
  async kickUser(userId: string) {
    for (const room of this.rooms.values()) {
      const ids = new Set<string>([userId]);
      for (const conn of [...room.conns]) {
        if (conn.self.userId !== userId) continue;
        ids.add(conn.self.id);
        room.conns.delete(conn);
        conn.ws.close(4003, 'unauthorized');
      }
      for (const id of ids) {
        if (!room.players.has(id)) continue;
        this.stopTalking(room, id);
        room.players.delete(id);
        room.dirty.delete(id);
        store.removeMember(room.id, id);
        this.bus.removePlayer(room.id, id);
        this.bus.publish(room.id, { t: 'player.leave', id });
      }
    }
  }

  /**
   * Position from WebSocket or the native foreground service (HTTP telemetry).
   * `rxTs` is server time: liveness never depends on the phone's clock.
   */
  async position(self: Self, pos: PosInput, rxTs: number) {
    if (pos.acc > MAX_ACC_M) return;
    if (Math.abs(pos.lat) < 1e-6 && Math.abs(pos.lon) < 1e-6) return; // "null island": no fix
    const room = await this.room(self.matchId);
    // A fix that arrives after the member left (or was removed) must not resurrect them on everyone's map.
    if (!room.players.has(self.id) && !store.isMember(self.matchId, self.id)) return;
    const p = room.players.get(self.id) ?? this.blankPlayer(self);
    if (p.lat != null && p.lon != null && p.ts > 0) {
      const dt = (rxTs - p.ts) / 1000;
      if (dt <= 0) return; // older than what we already show
      const d = distanceM(p.lat, p.lon, pos.lat, pos.lon);
      // Teleport filter. After a minute without accepted fixes the new location is taken as-is.
      if (dt < 60 && d > pos.acc + p.acc && d / Math.max(dt, 1) > MAX_SPEED_MS) return;
    }
    Object.assign(p, {
      lat: pos.lat,
      lon: pos.lon,
      acc: Math.round(pos.acc),
      heading: pos.heading ?? p.heading,
      speed: pos.speed,
      bat: pos.bat ?? p.bat,
      ts: rxTs,
      online: true,
    });
    room.players.set(self.id, p);
    this.markDirty(room, self.id);

    const last = room.lastTrack.get(self.id) ?? 0;
    if (rxTs - last >= config.trackSampleMs) {
      room.lastTrack.set(self.id, rxTs);
      store.addTrack(room.id, self.id, pos.lat, pos.lon, rxTs);
    }
  }

  chat(self: Self, m: { id?: string; channel: ChatMsg['channel']; text: string; kind: ChatMsg['kind']; spot?: { lat: number; lon: number } }) {
    const msg: ChatMsg = {
      // Client ids are namespaced per user so nobody can collide with someone else's message.
      id: m.id ? `c-${self.userId}-${m.id}` : nanoid(12),
      channel: m.channel,
      squad: m.channel === 'squad' ? self.squad : null,
      fromId: self.id,
      callsign: self.callsign,
      kind: m.kind,
      text: m.text,
      ts: Date.now(),
      ...(m.spot ? { lat: m.spot.lat, lon: m.spot.lon } : {}),
    };
    if (!store.addChat(self.matchId, msg)) return; // replayed from an offline outbox
    this.bus.publish(self.matchId, { t: 'chat', msg });
  }

  /** Inject an event from the admin webhook as the HQ bot. */
  async system(matchId: string, msg: ClientMsg) {
    await this.apply({ ...SYSTEM, matchId }, msg);
  }

  endMatch(matchId: string) {
    const endedAt = Date.now();
    if (store.endMatch(matchId, endedAt)) this.bus.publish(matchId, { t: 'match.end', endedAt });
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
  private deliver({ matchId, msg, audio }: Envelope) {
    const room = this.rooms.get(matchId);
    if (!room) return;

    if (audio) {
      const chIdx = VOICE_CHANNELS.indexOf(audio.channel);
      if (chIdx < 0) return;
      const pcm = Buffer.from(audio.b64, 'base64');
      const frame = Buffer.allocUnsafe(2 + pcm.length);
      frame[0] = 0x56; // 'V'
      frame[1] = chIdx;
      pcm.copy(frame, 2);
      for (const c of room.conns) {
        if (c.self.id === audio.fromId) continue;
        if (!canHearVoice(audio.channel, audio.squad, c.self.squad, c.self.role)) continue;
        if (c.ws.readyState === c.ws.OPEN) c.ws.send(frame, { binary: true });
      }
      return;
    }

    if (!msg) return;

    if (msg.t === 'players') {
      for (const p of msg.players) room.players.set(p.id, { ...room.players.get(p.id), ...p });
    } else if (msg.t === 'player.leave') {
      room.players.delete(msg.id);
    }

    const raw = JSON.stringify(msg);
    for (const c of room.conns) {
      if (msg.t === 'chat' && !canSeeChat(msg.msg, c.self.squad, c.self.role)) continue;
      if (msg.t === 'voice.rx' && !canHearVoice(msg.channel, msg.squad, c.self.squad, c.self.role)) continue;
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
    const now = Date.now();
    for (const room of this.rooms.values()) {
      for (const c of [...room.conns]) {
        if (!c.alive || c.ws.readyState !== c.ws.OPEN) {
          c.ws.terminate();
          this.detach(room, c);
          continue;
        }
        c.alive = false;
        c.ws.ping();
      }
      // Members on native telemetry only (no socket) go offline after 90 s of silence (server clock).
      for (const p of room.players.values()) {
        if (p.online && now - p.ts > 90_000 && ![...room.conns].some((c) => c.self.id === p.id)) {
          p.online = false;
          room.dirty.add(p.id);
        }
      }
    }
    for (const [k, t] of this.busyNotified) if (now - t > 60_000) this.busyNotified.delete(k);
  }

  private expire() {
    const now = Date.now();
    for (const { id, matchId } of store.takeExpired(now)) {
      this.bus.publish(matchId, { t: 'marker.delete', id });
    }
    // Watchdog: clear stuck PTT state if audio packets stopped > 2.5 s ago
    for (const room of this.rooms.values()) {
      for (const [id, tk] of room.talking) {
        if (now - tk.ts > 2500) this.stopTalking(room, id);
      }
    }
  }
}
