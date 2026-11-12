// Durable storage: users, matches, members, tactical objects, chat and track history.
// Uses Node's built-in SQLite (no native addon to compile in Docker).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Briefing, ChatMsg, MatchInfo, Marker, Role, Route, Squad, Zone } from '@tactic/shared';
import { config } from './config.js';

export interface MatchRow extends MatchInfo {
  commandPin: string;
  password: string;
  briefing: Briefing;
}

export interface MemberRow {
  id: string;
  matchId: string;
  callsign: string;
  squad: Squad;
  role: Role;
}

export interface UserRow {
  id: string;
  callsign: string;
  passwordHash: string;
  squad: Squad;
  role: Role;
  createdAt: number;
}

function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hex] = stored.split(':');
  if (!salt || !hex) return false;
  const derived = crypto.scryptSync(password, salt, 64);
  const target = Buffer.from(hex, 'hex');
  if (derived.length !== target.length) return false;
  return crypto.timingSafeEqual(derived, target);
}

fs.mkdirSync(config.dataDir, { recursive: true });
const dbPath = path.join(config.dataDir, 'tactic.sqlite');
const usersBackupPath = path.join(config.dataDir, 'users-backup.json');
const objectsBackupPath = path.join(config.dataDir, 'objects-backup.json');
const db = new DatabaseSync(dbPath);

// Use DELETE journal mode + FULL synchronous so every write goes directly into tactic.sqlite
// without relying on mmap/WAL (-shm/-wal) files on Windows Docker Desktop bind mounts.
try {
  db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
} catch {
  /* ignore */
}
db.exec(`
PRAGMA journal_mode = DELETE;
PRAGMA synchronous = FULL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  callsign TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  squad TEXT NOT NULL DEFAULT 'alpha',
  role TEXT NOT NULL DEFAULT 'rifleman',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS matches (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE,
  command_pin TEXT NOT NULL,
  password TEXT NOT NULL DEFAULT '',
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
try {
  db.exec("ALTER TABLE matches ADD COLUMN password TEXT NOT NULL DEFAULT '';");
} catch {
  /* column already exists */
}

type Row = Record<string, unknown>;

function toMatch(r: Row): MatchRow {
  return {
    id: r.id as string,
    name: r.name as string,
    code: r.code as string,
    commandPin: r.command_pin as string,
    password: (r.password as string) || '',
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

function toUser(r: Row): UserRow {
  return {
    id: r.id as string,
    callsign: r.callsign as string,
    passwordHash: r.password_hash as string,
    squad: (r.squad as Squad) || 'alpha',
    role: (r.role as Role) || 'rifleman',
    createdAt: r.created_at as number,
  };
}

const q = {
  userByCallsign: db.prepare('SELECT * FROM users WHERE callsign = ? COLLATE NOCASE'),
  userById: db.prepare('SELECT * FROM users WHERE id = ?'),
  listUsers: db.prepare('SELECT id, callsign, squad, role, created_at FROM users ORDER BY created_at DESC'),
  allUsersFull: db.prepare('SELECT * FROM users ORDER BY created_at ASC'),
  insertUser: db.prepare(
    'INSERT INTO users (id, callsign, password_hash, squad, role, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ),
  updateUserPrefs: db.prepare('UPDATE users SET squad = ?, role = ? WHERE id = ? OR callsign = ? COLLATE NOCASE'),
  updateUserPassword: db.prepare('UPDATE users SET password_hash = ? WHERE callsign = ? COLLATE NOCASE'),
  deleteUser: db.prepare('DELETE FROM users WHERE callsign = ? COLLATE NOCASE'),

  insertMatch: db.prepare(
    'INSERT INTO matches (id, name, code, command_pin, password, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ),
  matchById: db.prepare('SELECT * FROM matches WHERE id = ?'),
  matchByCode: db.prepare('SELECT * FROM matches WHERE code = ? AND ended_at IS NULL'),
  matchByName: db.prepare('SELECT * FROM matches WHERE name = ? COLLATE NOCASE AND ended_at IS NULL'),
  activeMatches: db.prepare('SELECT * FROM matches WHERE ended_at IS NULL ORDER BY created_at ASC'),
  latestActiveMatch: db.prepare('SELECT * FROM matches WHERE ended_at IS NULL ORDER BY created_at DESC LIMIT 1'),
  listMatches: db.prepare('SELECT * FROM matches ORDER BY created_at DESC LIMIT 100'),
  endMatch: db.prepare('UPDATE matches SET ended_at = ? WHERE id = ?'),
  endAllActiveMatches: db.prepare('UPDATE matches SET ended_at = ? WHERE ended_at IS NULL'),
  setBriefing: db.prepare('UPDATE matches SET briefing = ? WHERE id = ?'),

  memberByCallsign: db.prepare('SELECT * FROM members WHERE match_id = ? AND callsign = ?'),
  memberById: db.prepare('SELECT * FROM members WHERE id = ?'),
  insertMember: db.prepare(
    'INSERT INTO members (id, match_id, callsign, squad, role, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ),
  updateMember: db.prepare('UPDATE members SET squad = ?, role = ? WHERE id = ?'),
  moveMember: db.prepare('UPDATE members SET match_id = ?, squad = ?, role = ? WHERE id = ?'),
  deleteMember: db.prepare('DELETE FROM members WHERE id = ? AND match_id = ?'),
  membersOfMatch: db.prepare('SELECT * FROM members WHERE match_id = ?'),

  upsertObject: db.prepare(`
    INSERT INTO objects (id, match_id, type, data, expires_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET data = excluded.data, expires_at = excluded.expires_at, updated_at = excluded.updated_at
  `),
  objectById: db.prepare('SELECT * FROM objects WHERE id = ? AND match_id = ?'),
  deleteObject: db.prepare('DELETE FROM objects WHERE id = ? AND match_id = ?'),
  objectsOfMatch: db.prepare('SELECT type, data FROM objects WHERE match_id = ?'),
  allObjects: db.prepare('SELECT match_id, type, data FROM objects'),
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

function syncUsersBackup() {
  try {
    const all = q.allUsersFull.all();
    fs.writeFileSync(usersBackupPath, JSON.stringify(all, null, 2), 'utf8');
  } catch {
    /* ignore backup write errors */
  }
}

function restoreUsersFromBackup() {
  try {
    if (!fs.existsSync(usersBackupPath)) {
      syncUsersBackup();
      return;
    }
    const raw = JSON.parse(fs.readFileSync(usersBackupPath, 'utf8')) as Array<{
      id: string;
      callsign: string;
      password_hash: string;
      squad: Squad;
      role: Role;
      created_at: number;
    }>;
    if (!Array.isArray(raw)) return;
    for (const u of raw) {
      if (!u.callsign || !u.password_hash) continue;
      const existing = q.userByCallsign.get(u.callsign) as Row | undefined;
      if (!existing) {
        q.insertUser.run(u.id, u.callsign, u.password_hash, u.squad || 'alpha', u.role || 'rifleman', u.created_at || Date.now());
      }
    }
    syncUsersBackup();
  } catch {
    /* ignore */
  }
}

function syncObjectsBackup(_matchId?: string) {
  try {
    const rows = q.allObjects.all() as Row[];
    fs.writeFileSync(objectsBackupPath, JSON.stringify(rows, null, 2), 'utf8');
  } catch {
    /* ignore */
  }
}

function restoreObjectsFromBackup(matchId: string) {
  try {
    if (!fs.existsSync(objectsBackupPath)) return;
    const rows = JSON.parse(fs.readFileSync(objectsBackupPath, 'utf8')) as Array<{
      match_id?: string;
      type: string;
      data: string;
    }>;
    if (!Array.isArray(rows)) return;
    const now = Date.now();
    for (const r of rows) {
      if (!r.type || !r.data) continue;
      const targetMatch = r.match_id || 'srv-main01';
      if (targetMatch !== matchId) continue;
      const parsed = JSON.parse(r.data) as { id?: string; expiresAt?: number | null };
      if (!parsed.id) continue;
      if (parsed.expiresAt && parsed.expiresAt <= now) continue;
      const existing = q.objectById.get(parsed.id, matchId);
      if (!existing) {
        q.upsertObject.run(parsed.id, matchId, r.type, r.data, parsed.expiresAt ?? null, now);
      }
    }
  } catch {
    /* ignore */
  }
}

restoreUsersFromBackup();

export const store = {
  // ---------- users ----------
  userByCallsign(callsign: string): UserRow | null {
    const r = q.userByCallsign.get(callsign) as Row | undefined;
    return r ? toUser(r) : null;
  },
  userById(id: string): UserRow | null {
    const r = q.userById.get(id) as Row | undefined;
    return r ? toUser(r) : null;
  },
  listUsers() {
    return q.listUsers.all() as { id: string; callsign: string; squad: Squad; role: Role; created_at: number }[];
  },
  createUser(u: { id: string; callsign: string; password: string; squad: Squad; role: Role }): UserRow {
    q.insertUser.run(u.id, u.callsign, hashPassword(u.password), u.squad, u.role, Date.now());
    syncUsersBackup();
    return this.userById(u.id)!;
  },
  updateUserPrefs(idOrCallsign: string, squad: Squad, role: Role) {
    q.updateUserPrefs.run(squad, role, idOrCallsign, idOrCallsign);
    syncUsersBackup();
  },
  setUserPassword(callsign: string, password: string): boolean {
    const ok = Number(q.updateUserPassword.run(hashPassword(password), callsign).changes) > 0;
    syncUsersBackup();
    return ok;
  },
  deleteUser(callsign: string): boolean {
    const ok = Number(q.deleteUser.run(callsign).changes) > 0;
    syncUsersBackup();
    return ok;
  },

  // ---------- matches ----------
  createMatch(m: { id: string; name: string; code: string; commandPin: string; password?: string }): MatchRow {
    q.insertMatch.run(m.id, m.name, m.code, m.commandPin, m.password ?? '', Date.now());
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
  activeMatchByName(name: string): MatchRow | null {
    const r = q.matchByName.get(name) as Row | undefined;
    return r ? toMatch(r) : null;
  },
  activeMatches(): MatchRow[] {
    this.defaultActiveMatch();
    return (q.activeMatches.all() as Row[]).map(toMatch);
  },
  /** Returns the latest active match, or creates/restores a default server room if none exists. */
  defaultActiveMatch(): MatchRow {
    const r = q.latestActiveMatch.get() as Row | undefined;
    if (r) return toMatch(r);
    const anyMain = q.matchById.get('srv-main01') as Row | undefined;
    if (anyMain) {
      q.endMatch.run(null, 'srv-main01');
      return this.match('srv-main01')!;
    }
    return this.createMatch({
      id: 'srv-main01',
      name: 'Tactic Server',
      code: 'SERVER',
      commandPin: '4321',
      password: '',
    });
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

  /** Join or re-join a match by callsign. Keeps the member id equal to user.id so tokens always match. */
  upsertMember(matchId: string, callsign: string, squad: Squad, role: Role, newId: string): MemberRow {
    const existing = q.memberByCallsign.get(matchId, callsign) as Row | undefined;
    if (existing) {
      q.updateMember.run(squad, role, existing.id as string);
      return { ...toMember(existing), squad, role };
    }
    const byId = q.memberById.get(newId) as Row | undefined;
    if (byId) {
      q.moveMember.run(matchId, squad, role, newId);
      return { id: newId, matchId, callsign, squad, role };
    }
    q.insertMember.run(newId, matchId, callsign, squad, role, Date.now());
    return { id: newId, matchId, callsign, squad, role };
  },
  updateMember(id: string, squad: Squad, role: Role) {
    q.updateMember.run(squad, role, id);
  },
  removeMember(matchId: string, id: string): boolean {
    return Number(q.deleteMember.run(id, matchId).changes) > 0;
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
    syncObjectsBackup(matchId);
  },
  getObject<T>(matchId: string, id: string): { type: string; data: T } | null {
    const r = q.objectById.get(id, matchId) as Row | undefined;
    return r ? { type: r.type as string, data: JSON.parse(r.data as string) as T } : null;
  },
  deleteObject(matchId: string, id: string): boolean {
    const ok = Number(q.deleteObject.run(id, matchId).changes) > 0;
    syncObjectsBackup(matchId);
    return ok;
  },
  objects(matchId: string) {
    restoreObjectsFromBackup(matchId);
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
