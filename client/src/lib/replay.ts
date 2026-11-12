// After-action replay: where every member was at time t, plus the trail behind them.
// Pure functions (no map / DOM) so the maths can be checked on its own.
import { SQUAD_META, type MatchTracks, type Squad } from '@tactic/shared';

/** Samples are ~10 s apart; a longer silence means the player was offline: don't interpolate across it. */
const MAX_GAP_MS = 60_000;

export interface ReplayMember {
  id: string;
  callsign: string;
  squad: Squad;
  color: string;
  lat: number[];
  lon: number[];
  ts: number[];
}

export interface Replay {
  members: ReplayMember[];
  t0: number;
  t1: number;
  /** [west, south, east, north] of every sample */
  bounds: [number, number, number, number] | null;
}

export function prepareReplay(tracks: MatchTracks): Replay {
  const members: ReplayMember[] = [];
  let t0 = Infinity;
  let t1 = -Infinity;
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const [id, tr] of Object.entries(tracks)) {
    if (!tr.points.length) continue;
    const pts = [...tr.points].sort((a, b) => a[2] - b[2]);
    const m: ReplayMember = {
      id,
      callsign: tr.callsign,
      squad: tr.squad,
      color: SQUAD_META[tr.squad]?.color ?? '#9aa79c',
      lat: pts.map((p) => p[0]),
      lon: pts.map((p) => p[1]),
      ts: pts.map((p) => p[2]),
    };
    members.push(m);
    t0 = Math.min(t0, m.ts[0]!);
    t1 = Math.max(t1, m.ts[m.ts.length - 1]!);
    for (let i = 0; i < m.ts.length; i++) {
      w = Math.min(w, m.lon[i]!);
      e = Math.max(e, m.lon[i]!);
      s = Math.min(s, m.lat[i]!);
      n = Math.max(n, m.lat[i]!);
    }
  }
  return members.length ? { members, t0, t1, bounds: [w, s, e, n] } : { members, t0: 0, t1: 0, bounds: null };
}

/** Index of the last sample at or before t, or -1. */
function lastIndexAt(ts: number[], t: number): number {
  let lo = 0, hi = ts.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (ts[mid]! <= t) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

export interface FrameHead {
  id: string;
  callsign: string;
  color: string;
  lat: number;
  lon: number;
  /** no fresh sample for a while: player was offline or lost GPS */
  stale: boolean;
}

/** Positions at time t and trails covering the last `tailMs` (Infinity = whole path so far). */
export function frameAt(r: Replay, t: number, tailMs: number) {
  const heads: FrameHead[] = [];
  const trails: { id: string; color: string; coords: [number, number][] }[] = [];
  for (const m of r.members) {
    const i = lastIndexAt(m.ts, t);
    if (i < 0) continue;
    let lat = m.lat[i]!, lon = m.lon[i]!;
    const next = i + 1 < m.ts.length ? i + 1 : -1;
    if (next >= 0 && m.ts[next]! - m.ts[i]! <= MAX_GAP_MS) {
      const k = (t - m.ts[i]!) / (m.ts[next]! - m.ts[i]!);
      lat += (m.lat[next]! - lat) * k;
      lon += (m.lon[next]! - lon) * k;
    }
    heads.push({ id: m.id, callsign: m.callsign, color: m.color, lat, lon, stale: t - m.ts[i]! > MAX_GAP_MS });
    const from = Number.isFinite(tailMs) ? t - tailMs : -Infinity;
    const coords: [number, number][] = [];
    // Start from the sample just before the window so the line reaches the window edge.
    for (let j = Math.max(0, lastIndexAt(m.ts, from)); j <= i; j++) coords.push([m.lon[j]!, m.lat[j]!]);
    if (lon !== m.lon[i] || lat !== m.lat[i]) coords.push([lon, lat]);
    if (coords.length >= 2) trails.push({ id: m.id, color: m.color, coords });
  }
  return { heads, trails };
}
