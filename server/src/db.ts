// Durable storage: users, matches, members, tactical objects, chat and track history.
// Uses Node's built-in SQLite (no native addon to compile in Docker).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import type { Briefing, ChatMsg, MatchInfo, Marker, Role, Route, Squad, Zone } from '@tactic/shared';
import { config } from './config.js';

export interface MatchRow extends MatchInfo {
  commandPin: string;
  /** scrypt hash ("$s$salt:hex") or '' for an open network */
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
  tokenVersion: number;
  createdAt: number;
}

// ---------- hashing (async: scrypt must not block the event loop that relays positions/voice) ----------
const scrypt = promisify(crypto.scrypt) as (pw: string, salt: string, len: number) => Promise<Buffer>;

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}:${(await scrypt(password, salt, 64)).toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [salt, hex] = stored.split(':');
  if (!salt || !hex) return false;
  const derived = await scrypt(password, salt, 64);
  const target = Buffer.from(hex, 'hex');
  return derived.length === target.length && crypto.timingSafeEqual(derived, target);
}

/** Network passwords are stored as "$s$" + scrypt hash. */
const MATCH_PW = '$s$';
export const hashMatchPassword = async (pw: string) => (pw ? MATCH_PW + (await hashPassword(pw)) : '');
export async function verifyMatchPassword(input: string, stored: string): Promise<boolean> {
  if (!stored) return true;
  return verifyPassword(input, stored.slice(MATCH_PW.length));
}

/** Random numeric command PIN. */
export const randomPin = (digits = 6) => String(crypto.randomInt(0, 10 ** digits)).padStart(digits, '0');

// ---------- schema ----------
fs.mkdirSync(config.dataDir, { recursive: true });
const dbPath = path.join(config.dataDir, 'tactic.sqlite');
const db = new DatabaseSync(dbPath);

// DELETE journal (not WAL): WAL's shared-memory file is unreliable on Docker Desktop bind mounts (Windows).
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
  token_version INTEGER NOT NULL DEFAULT 0,
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

// ---------- migrations (idempotent) ----------
const columns = (table: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string; pk: number }[]);

if (!columns('matches').some((c) => c.name === 'password')) db.exec("ALTER TABLE matches ADD COLUMN password TEXT NOT NULL DEFAULT ''");
if (!columns('users').some((c) => c.name === 'token_version')) db.exec('ALTER TABLE users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0');

// Objects are keyed per match: a global id let one match overwrite another match's objects.
const OBJECTS_DDL = `
CREATE TABLE objects (
  id TEXT NOT NULL,
  match_id TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('marker','zone','route')),
  data TEXT NOT NULL,
  expires_at INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (match_id, id)
)`;
const objCols = columns('objects');
if (objCols.length === 0) {
  db.exec(OBJECTS_DDL);
} else if (objCols.filter((c) => c.pk > 0).length < 2) {
  db.exec(`BEGIN;
ALTER TABLE objects RENAME TO objects_old;
${OBJECTS_DDL};
INSERT OR IGNORE INTO objects SELECT id, match_id, type, data, expires_at, updated_at FROM objects_old;
DROP TABLE objects_old;
COMMIT;`);
}
db.exec(`CREATE INDEX IF NOT EXISTS objects_match ON objects(match_id, type);
CREATE INDEX IF NOT EXISTS objects_expiry ON objects(expires_at) WHERE expires_at IS NOT NULL;`);

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
    tokenVersion: Number(r.token_version ?? 0),
    createdAt: r.created_at as number,
  };
}

const q = {
  userByCallsign: db.prepare('SELECT * FROM users WHERE callsign = ? COLLATE NOCASE'),
  userById: db.prepare('SELECT * FROM users WHERE id = ?'),
  listUsers: db.prepare('SELECT id, callsign, squad, role, created_at FROM users ORDER BY created_at DESC'),
  insertUser: db.prepare(
    'INSERT INTO users (id, callsign, password_hash, squad, role, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ),
  updateUserPrefs: db.prepare('UPDATE users SET squad = ?, role = ? WHERE id = ?'),
  updateUserPassword: db.prepare('UPDATE users SET password_hash = ?, token_version = token_version + 1 WHERE id = ?'),
  bumpTokenVersion: db.prepare('UPDATE users SET token_version = token_version + 1 WHERE id = ?'),
  deleteUser: db.prepare('DELETE FROM users WHERE id = ?'),

  insertMatch: db.prepare(
    'INSERT INTO matches (id, name, code, command_pin, password, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ),
  matchById: db.prepare('SELECT * FROM matches WHERE id = ?'),
  matchByCode: db.prepare('SELECT * FROM matches WHERE code = ? AND ended_at IS NULL'),
  activeMatches: db.prepare('SELECT * FROM matches WHERE ended_at IS NULL ORDER BY created_at ASC'),
  latestActiveMatch: db.prepare('SELECT * FROM matches WHERE ended_at IS NULL ORDER BY created_at DESC LIMIT 1'),
  listMatches: db.prepare('SELECT * FROM matches ORDER BY created_at DESC LIMIT 100'),
  endMatch: db.prepare('UPDATE matches SET ended_at = ? WHERE id = ?'),
  setBriefing: db.prepare('UPDATE matches SET briefing = ? WHERE id = ?'),
  setMatchPin: db.prepare('UPDATE matches SET command_pin = ? WHERE id = ?'),
  setMatchPassword: db.prepare('UPDATE matches SET password = ? WHERE id = ?'),
  purgeMatches: db.prepare('DELETE FROM matches WHERE ended_at IS NOT NULL AND ended_at < ?'),

  memberByCallsign: db.prepare('SELECT * FROM members WHERE match_id = ? AND callsign = ?'),
  memberById: db.prepare('SELECT * FROM members WHERE id = ?'),
  insertMember: db.prepare(
    'INSERT INTO members (id, match_id, callsign, squad, role, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ),
  updateMember: db.prepare('UPDATE members SET squad = ?, role = ? WHERE id = ?'),
  moveMember: db.prepare('UPDATE members SET match_id = ?, squad = ?, role = ? WHERE id = ?'),
  deleteMember: db.prepare('DELETE FROM members WHERE id = ? AND match_id = ?'),
  deleteMembersByCallsign: db.prepare('DELETE FROM members WHERE callsign = ? COLLATE NOCASE'),
  membersOfMatch: db.prepare('SELECT * FROM members WHERE match_id = ?'),

  upsertObject: db.prepare(`
    INSERT INTO objects (id, match_id, type, data, expires_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(match_id, id) DO UPDATE SET data = excluded.data, expires_at = excluded.expires_at, updated_at = excluded.updated_at
    WHERE objects.type = excluded.type
  `),
  objectById: db.prepare('SELECT * FROM objects WHERE id = ? AND match_id = ?'),
  deleteObject: db.prepare('DELETE FROM objects WHERE id = ? AND match_id = ?'),
  objectsOfMatch: db.prepare('SELECT type, data FROM objects WHERE match_id = ?'),
  countMarkersBy: db.prepare("SELECT count(*) AS c FROM objects WHERE match_id = ? AND type = 'marker' AND json_extract(data, '$.createdById') = ?"),
  countObjects: db.prepare('SELECT count(*) AS c FROM objects WHERE match_id = ?'),
  expiredObjects: db.prepare('SELECT id, match_id FROM objects WHERE expires_at IS NOT NULL AND expires_at <= ?'),

  insertChat: db.prepare('INSERT OR IGNORE INTO chat (id, match_id, data, ts) VALUES (?, ?, ?, ?)'),
  recentChat: db.prepare('SELECT data FROM chat WHERE match_id = ? ORDER BY ts DESC LIMIT ?'),

  insertTrack: db.prepare('INSERT INTO tracks (match_id, member_id, lat, lon, ts) VALUES (?, ?, ?, ?, ?)'),
  tracksOfMatch: db.prepare(
    'SELECT member_id, lat, lon, ts FROM tracks WHERE match_id = ? AND ts >= ? ORDER BY ts LIMIT 200000',
  ),
  purgeChat: db.prepare('DELETE FROM chat WHERE ts < ?'),
  purgeTracks: db.prepare('DELETE FROM tracks WHERE ts < ? OR match_id NOT IN (SELECT id FROM matches)'),
};

// ---------- one-time data migrations ----------

/** Earlier builds mirrored every write into JSON files; import anything missing once, then retire them. */
function importLegacyBackups() {
  const usersFile = path.join(config.dataDir, 'users-backup.json');
  const objectsFile = path.join(config.dataDir, 'objects-backup.json');
  try {
    if (fs.existsSync(usersFile)) {
      const rows = JSON.parse(fs.readFileSync(usersFile, 'utf8')) as Row[];
      for (const u of Array.isArray(rows) ? rows : []) {
        if (!u.callsign || !u.password_hash || q.userByCallsign.get(u.callsign as string)) continue;
        q.insertUser.run(u.id as string, u.callsign as string, u.password_hash as string, (u.squad as string) || 'alpha', (u.role as string) || 'rifleman', (u.created_at as number) || Date.now());
      }
      fs.renameSync(usersFile, `${usersFile}.migrated`);
    }
    if (fs.existsSync(objectsFile)) {
      const rows = JSON.parse(fs.readFileSync(objectsFile, 'utf8')) as Row[];
      const now = Date.now();
      for (const r of Array.isArray(rows) ? rows : []) {
        if (!r.match_id || !r.type || !r.data || !q.matchById.get(r.match_id as string)) continue;
        const d = JSON.parse(r.data as string) as { id?: string; expiresAt?: number | null };
        if (!d.id || (d.expiresAt && d.expiresAt <= now)) continue;
        db.prepare('INSERT OR IGNORE INTO objects (id, match_id, type, data, expires_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(
          d.id, r.match_id as string, r.type as string, r.data as string, d.expiresAt ?? null, now,
        );
      }
      fs.renameSync(objectsFile, `${objectsFile}.migrated`);
    }
  } catch (e) {
    console.warn('[db] legacy backup import failed (ignored):', (e as Error).message);
  }
}
importLegacyBackups();

/** Plaintext network passwords → scrypt; publicly known default PIN on active networks → random. */
async function hardenMatches() {
  for (const r of q.activeMatches.all() as Row[]) {
    const m = toMatch(r);
    if (m.password && !m.password.startsWith(MATCH_PW)) q.setMatchPassword.run(await hashMatchPassword(m.password), m.id);
    if (m.commandPin === '4321') {
      const pin = randomPin();
      q.setMatchPin.run(pin, m.id);
      console.warn(`[db] network "${m.name}": default command PIN replaced — see the admin panel for the new PIN`);
    }
  }
  // Ended networks keep history only; no one can join them, so their secrets just get scrubbed.
  db.exec(`UPDATE matches SET password = '' WHERE ended_at IS NOT NULL AND password <> '' AND password NOT LIKE '$s$%'`);
}
await hardenMatches();

// ---------- store ----------
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
  async createUser(u: { id: string; callsign: string; password: string; squad: Squad; role: Role }): Promise<UserRow> {
    q.insertUser.run(u.id, u.callsign, await hashPassword(u.password), u.squad, u.role, Date.now());
    return this.userById(u.id)!;
  },
  updateUserPrefs(userId: string, squad: Squad, role: Role) {
    q.updateUserPrefs.run(squad, role, userId);
  },
  /** Also revokes every token the user holds. */
  async setUserPassword(userId: string, password: string) {
    q.updateUserPassword.run(await hashPassword(password), userId);
  },
  revokeTokens(userId: string) {
    q.bumpTokenVersion.run(userId);
  },
  deleteUser(user: UserRow) {
    q.deleteUser.run(user.id);
    q.deleteMembersByCallsign.run(user.callsign);
  },

  // ---------- matches ----------
  async createMatch(m: { id: string; name: string; code: string; commandPin: string; password: string }): Promise<MatchRow> {
    q.insertMatch.run(m.id, m.name, m.code, m.commandPin, await hashMatchPassword(m.password), Date.now());
    return this.match(m.id)!;
  },
  match(id: string): MatchRow | null {
    const r = q.matchById.get(id) as Row | undefined;
    return r ? toMatch(r) : null;
  },
  /** Active (not ended) match or null. */
  activeMatch(id: string): MatchRow | null {
    const m = this.match(id);
    return m && !m.endedAt ? m : null;
  },
  activeMatchByCode(code: string): MatchRow | null {
    const r = q.matchByCode.get(code) as Row | undefined;
    return r ? toMatch(r) : null;
  },
  activeMatches(): MatchRow[] {
    return (q.activeMatches.all() as Row[]).map(toMatch);
  },
  /** Make sure at least one network exists on a fresh install (an open lobby with a random PIN). */
  ensureLobby() {
    if (q.latestActiveMatch.get()) return;
    if (q.matchById.get('srv-main01')) {
      q.endMatch.run(null, 'srv-main01');
      return;
    }
    q.insertMatch.run('srv-main01', 'Tactic Server', 'SERVER', randomPin(), '', Date.now());
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

  /** Join or re-join a match by callsign. Keeps the member id equal to user.id where possible. */
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
  isMember(matchId: string, memberId: string): boolean {
    const r = q.memberById.get(memberId) as Row | undefined;
    return !!r && r.match_id === matchId;
  },
  updateMember(id: string, squad: Squad, role: Role) {
    q.updateMember.run(squad, role, id);
  },
  removeMember(matchId: string, id: string): boolean {
    return Number(q.deleteMember.run(id, matchId).changes) > 0;
  },
  members(matchId: string): MemberRow[] {
    return (q.membersOfMatch.all(matchId) as Row[]).map(toMember);
  },

  /** Returns false when the id already belongs to an object of a different type. */
  putObject(matchId: string, type: 'marker' | 'zone' | 'route', obj: Marker | Zone | Route): boolean {
    const expires = type === 'marker' ? (obj as Marker).expiresAt : null;
    return Number(q.upsertObject.run(obj.id, matchId, type, JSON.stringify(obj), expires, Date.now()).changes) > 0;
  },
  getObject<T>(matchId: string, id: string): { type: string; data: T } | null {
    const r = q.objectById.get(id, matchId) as Row | undefined;
    return r ? { type: r.type as string, data: JSON.parse(r.data as string) as T } : null;
  },
  deleteObject(matchId: string, id: string): boolean {
    return Number(q.deleteObject.run(id, matchId).changes) > 0;
  },
  countMarkersBy(matchId: string, memberId: string): number {
    return Number((q.countMarkersBy.get(matchId, memberId) as Row).c);
  },
  countObjects(matchId: string): number {
    return Number((q.countObjects.get(matchId) as Row).c);
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

  /** False when a message with this id was already stored (offline outbox replay). */
  addChat(matchId: string, msg: ChatMsg): boolean {
    return Number(q.insertChat.run(msg.id, matchId, JSON.stringify(msg), msg.ts).changes) > 0;
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

  /** Drops chat/tracks older than the retention window and networks that ended before it. */
  purge(retentionDays: number) {
    const cutoff = Date.now() - retentionDays * 86_400_000;
    q.purgeChat.run(cutoff);
    q.purgeMatches.run(cutoff);
    q.purgeTracks.run(cutoff);
  },

  close() {
    db.close();
  },
};
