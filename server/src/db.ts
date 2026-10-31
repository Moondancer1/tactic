// Durable storage: matches, members, tactical objects, chat and track history.
// Uses Node's built-in SQLite (no native addon to compile in Docker).
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Briefing, ChatMsg, MatchInfo, Marker, Role, Route, Squad, Zone } from '@tactic/shared';
import { config } from './config.js';

export interface MatchRow extends MatchInfo {
  commandPin: string;
  briefing: Briefing;
}

export interface MemberRow {
  id: string;
  matchId: string;
  callsign: string;
  squad: Squad;
  role: Role;
}

fs.mkdirSync(config.dataDir, { recursive: true });
const db = new DatabaseSync(path.join(config.dataDir, 'tactic.sqlite'));

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS matches (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE,
  command_pin TEXT NOT NULL,
  briefing TEXT NOT NULL DEFAULT '{"text":"","by":"","ts":0}',
  created_at INTEGER NOT NULL,
  ended_at INTEGER
);

CREATE TABLE IF NOT EXISTS members (
  id TEXT PRIMARY KEY,
  match_id TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  callsign TEXT NOT NULL,
  squad TEXT NOT NULL,
  role TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (match_id, callsign)
);

CREATE TABLE IF NOT EXISTS objects (
  id TEXT PRIMARY KEY,
  match_id TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('marker','zone','route')),
  data TEXT NOT NULL,
  expires_at INTEGER,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS objects_match ON objects(match_id, type);
CREATE INDEX IF NOT EXISTS objects_expiry ON objects(expires_at) WHERE expires_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS chat (
  id TEXT PRIMARY KEY,
  match_id TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  data TEXT NOT NULL,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS chat_match_ts ON chat(match_id, ts);

CREATE TABLE IF NOT EXISTS tracks (
  match_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  lat REAL NOT NULL,
  lon REAL NOT NULL,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS tracks_match_ts ON tracks(match_id, ts);
`);

type Row = Record<string, unknown>;

function toMatch(r: Row): MatchRow {
  return {
    id: r.id as string,
    name: r.name as string,
    code: r.code as string,
    commandPin: r.command_pin as string,
    briefing: JSON.parse(r.briefing as string),
    createdAt: r.created_at as number,
    endedAt: (r.ended_at as number | null) ?? null,
  };
}

function toMember(r: Row): MemberRow {
  return {
    id: r.id as string,
    matchId: r.match_id as string,
    callsign: r.callsign as string,
    squad: r.squad as Squad,
    role: r.role as Role,
  };
}

const q = {
  insertMatch: db.prepare(
    'INSERT INTO matches (id, name, code, command_pin, created_at) VALUES (?, ?, ?, ?, ?)',
  ),
  matchById: db.prepare('SELECT * FROM matches WHERE id = ?'),
  matchByCode: db.prepare('SELECT * FROM matches WHERE code = ? AND ended_at IS NULL'),
  listMatches: db.prepare('SELECT * FROM matches ORDER BY created_at DESC LIMIT 100'),
  endMatch: db.prepare('UPDATE matches SET ended_at = ? WHERE id = ?'),
  setBriefing: db.prepare('UPDATE matches SET briefing = ? WHERE id = ?'),

  memberByCallsign: db.prepare('SELECT * FROM members WHERE match_id = ? AND callsign = ?'),
  memberById: db.prepare('SELECT * FROM members WHERE id = ?'),
  insertMember: db.prepare(
    'INSERT INTO members (id, match_id, callsign, squad, role, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ),
  updateMember: db.prepare('UPDATE members SET squad = ?, role = ? WHERE id = ?'),
  membersOfMatch: db.prepare('SELECT * FROM members WHERE match_id = ?'),

  upsertObject: db.prepare(`
    INSERT INTO objects (id, match_id, type, data, expires_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET data = excluded.data, expires_at = excluded.expires_at, updated_at = excluded.updated_at
  `),
  objectById: db.prepare('SELECT * FROM objects WHERE id = ? AND match_id = ?'),
  deleteObject: db.prepare('DELETE FROM objects WHERE id = ? AND match_id = ?'),
  objectsOfMatch: db.prepare('SELECT type, data FROM objects WHERE match_id = ?'),
  expiredObjects: db.prepare('SELECT id, match_id FROM objects WHERE expires_at IS NOT NULL AND expires_at <= ?'),

  insertChat: db.prepare('INSERT INTO chat (id, match_id, data, ts) VALUES (?, ?, ?, ?)'),
  recentChat: db.prepare('SELECT data FROM chat WHERE match_id = ? ORDER BY ts DESC LIMIT ?'),

  insertTrack: db.prepare('INSERT INTO tracks (match_id, member_id, lat, lon, ts) VALUES (?, ?, ?, ?, ?)'),
  tracksOfMatch: db.prepare(
    'SELECT member_id, lat, lon, ts FROM tracks WHERE match_id = ? AND ts >= ? ORDER BY ts LIMIT 200000',
  ),
  purgeChat: db.prepare('DELETE FROM chat WHERE ts < ?'),
  purgeTracks: db.prepare('DELETE FROM tracks WHERE ts < ?'),
};

export const store = {
  createMatch(m: { id: string; name: string; code: string; commandPin: string }): MatchRow {
    q.insertMatch.run(m.id, m.name, m.code, m.commandPin, Date.now());
    return this.match(m.id)!;
  },
  match(id: string): MatchRow | null {
    const r = q.matchById.get(id) as Row | undefined;
    return r ? toMatch(r) : null;
  },
  activeMatchByCode(code: string): MatchRow | null {
    const r = q.matchByCode.get(code) as Row | undefined;
    return r ? toMatch(r) : null;
  },
  listMatches(): MatchRow[] {
    return (q.listMatches.all() as Row[]).map(toMatch);
  },
  endMatch(id: string, ts = Date.now()) {
    q.endMatch.run(ts, id);
  },
  setBriefing(id: string, b: Briefing) {
    q.setBriefing.run(JSON.stringify(b), id);
  },

  /** Join or re-join a match by callsign. Re-joining keeps the member id (and its markers). */
  upsertMember(matchId: string, callsign: string, squad: Squad, role: Role, newId: string): MemberRow {
    const existing = q.memberByCallsign.get(matchId, callsign) as Row | undefined;
    if (existing) {
      q.updateMember.run(squad, role, existing.id as string);
      return { ...toMember(existing), squad, role };
    }
    q.insertMember.run(newId, matchId, callsign, squad, role, Date.now());
    return { id: newId, matchId, callsign, squad, role };
  },
  member(id: string): MemberRow | null {
    const r = q.memberById.get(id) as Row | undefined;
    return r ? toMember(r) : null;
  },
  members(matchId: string): MemberRow[] {
    return (q.membersOfMatch.all(matchId) as Row[]).map(toMember);
  },

  putObject(matchId: string, type: 'marker' | 'zone' | 'route', obj: Marker | Zone | Route) {
    const expires = type === 'marker' ? (obj as Marker).expiresAt : null;
    q.upsertObject.run(obj.id, matchId, type, JSON.stringify(obj), expires, Date.now());
  },
  getObject<T>(matchId: string, id: string): { type: string; data: T } | null {
    const r = q.objectById.get(id, matchId) as Row | undefined;
    return r ? { type: r.type as string, data: JSON.parse(r.data as string) as T } : null;
  },
  deleteObject(matchId: string, id: string): boolean {
    return Number(q.deleteObject.run(id, matchId).changes) > 0;
  },
  objects(matchId: string) {
    const markers: Marker[] = [];
    const zones: Zone[] = [];
    const routes: Route[] = [];
    const now = Date.now();
    for (const r of q.objectsOfMatch.all(matchId) as Row[]) {
      const data = JSON.parse(r.data as string);
      if (r.type === 'marker') {
        if (data.expiresAt && data.expiresAt <= now) continue;
        markers.push(data);
      } else if (r.type === 'zone') zones.push(data);
      else routes.push(data);
    }
    return { markers, zones, routes };
  },
  /** Removes expired markers and returns them so the hub can broadcast deletions. */
  takeExpired(now = Date.now()): { id: string; matchId: string }[] {
    const rows = (q.expiredObjects.all(now) as Row[]).map((r) => ({
      id: r.id as string,
      matchId: r.match_id as string,
    }));
    for (const r of rows) q.deleteObject.run(r.id, r.matchId);
    return rows;
  },

  addChat(matchId: string, msg: ChatMsg) {
    q.insertChat.run(msg.id, matchId, JSON.stringify(msg), msg.ts);
  },
  recentChat(matchId: string, limit = config.chatHistory): ChatMsg[] {
    return (q.recentChat.all(matchId, limit) as Row[]).map((r) => JSON.parse(r.data as string)).reverse();
  },

  addTrack(matchId: string, memberId: string, lat: number, lon: number, ts: number) {
    q.insertTrack.run(matchId, memberId, lat, lon, ts);
  },
  tracks(matchId: string, since = 0) {
    return q.tracksOfMatch.all(matchId, since) as { member_id: string; lat: number; lon: number; ts: number }[];
  },

  purge(retentionDays: number) {
    const cutoff = Date.now() - retentionDays * 86_400_000;
    q.purgeChat.run(cutoff);
    q.purgeTracks.run(cutoff);
  },

  close() {
    db.close();
  },
};
