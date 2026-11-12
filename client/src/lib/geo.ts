import { forward as toMgrs } from 'mgrs';
import geomagnetism from 'geomagnetism';

const R = 6371008.8;
const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;
export const norm360 = (d: number) => ((d % 360) + 360) % 360;

export function distance(a: [number, number], b: [number, number]): number {
  const dLat = rad(b[0] - a[0]);
  const dLon = rad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** True (geographic) bearing a → b, degrees 0..360. */
export function bearing(a: [number, number], b: [number, number]): number {
  const y = Math.sin(rad(b[1] - a[1])) * Math.cos(rad(b[0]));
  const x =
    Math.cos(rad(a[0])) * Math.sin(rad(b[0])) - Math.sin(rad(a[0])) * Math.cos(rad(b[0])) * Math.cos(rad(b[1] - a[1]));
  return norm360(deg(Math.atan2(y, x)));
}

export function fmtDist(m: number): string {
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(2)} km`;
}

export const fmtAz = (d: number) => `${String(Math.round(norm360(d)) % 360).padStart(3, '0')}°`;

/** Angle in artillery mils (6000 per circle), formatted "12-50". */
export function fmtMils(d: number): string {
  const m = Math.round((norm360(d) / 360) * 6000) % 6000;
  return `${Math.floor(m / 100)}-${String(m % 100).padStart(2, '0')}`;
}

/** MGRS 10-digit (1 m) grid, e.g. "37U DB 12345 67890" */
export function mgrs(lat: number, lon: number): string {
  try {
    const s = toMgrs([lon, lat], 5);
    return `${s.slice(0, 3)} ${s.slice(3, 5)} ${s.slice(5, 10)} ${s.slice(10)}`;
  } catch {
    return `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
  }
}

export function fmtLatLon(lat: number, lon: number): string {
  return `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
}

export function cardinal(b: number): string {
  return ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(b / 45) % 8]!;
}

export function ago(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
}

// ---------------------------------------------------------------------------
// UTM (WGS84, Krüger series). Grid lines and sectors are built in UTM metres,
// so every device draws the same squares, aligned with the MGRS readout.
// ---------------------------------------------------------------------------
const A_ = 6378137;
const F_ = 1 / 298.257223563;
const N_ = F_ / (2 - F_);
const AA = (A_ / (1 + N_)) * (1 + N_ ** 2 / 4 + N_ ** 4 / 64);
const K0 = 0.9996;
const ALPHA = [N_ / 2 - (2 * N_ ** 2) / 3 + (5 * N_ ** 3) / 16, (13 * N_ ** 2) / 48 - (3 * N_ ** 3) / 5, (61 * N_ ** 3) / 240];
const BETA = [N_ / 2 - (2 * N_ ** 2) / 3 + (37 * N_ ** 3) / 96, N_ ** 2 / 48 + N_ ** 3 / 15, (17 * N_ ** 3) / 480];
const DELTA = [2 * N_ - (2 * N_ ** 2) / 3 - 2 * N_ ** 3, (7 * N_ ** 2) / 3 - (8 * N_ ** 3) / 5, (56 * N_ ** 3) / 15];
const C2N = (2 * Math.sqrt(N_)) / (1 + N_);

export interface Utm {
  zone: number;
  south: boolean;
  e: number;
  n: number;
}

export function utmZone(lat: number, lon: number): number {
  let z = Math.floor((lon + 180) / 6) + 1;
  if (lat >= 56 && lat < 64 && lon >= 3 && lon < 12) z = 32;
  if (lat >= 72 && lat < 84) {
    if (lon >= 0 && lon < 9) z = 31;
    else if (lon >= 9 && lon < 21) z = 33;
    else if (lon >= 21 && lon < 33) z = 35;
    else if (lon >= 33 && lon < 42) z = 37;
  }
  return Math.min(60, Math.max(1, z));
}

export function toUtm(lat: number, lon: number, zone = utmZone(lat, lon), south = lat < 0): Utm {
  const phi = rad(lat);
  const dl = rad(lon - (zone * 6 - 183));
  const t = Math.sinh(Math.atanh(Math.sin(phi)) - C2N * Math.atanh(C2N * Math.sin(phi)));
  const xi = Math.atan2(t, Math.cos(dl));
  const eta = Math.atanh(Math.sin(dl) / Math.sqrt(1 + t * t));
  let e = eta;
  let n = xi;
  for (let j = 1; j <= 3; j++) {
    e += ALPHA[j - 1]! * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta);
    n += ALPHA[j - 1]! * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta);
  }
  return { zone, south, e: 500000 + K0 * AA * e, n: (south ? 10000000 : 0) + K0 * AA * n };
}

export function fromUtm(u: Utm): [number, number] {
  const xi = (u.n - (u.south ? 10000000 : 0)) / (K0 * AA);
  const eta = (u.e - 500000) / (K0 * AA);
  let xp = xi;
  let ep = eta;
  for (let j = 1; j <= 3; j++) {
    xp -= BETA[j - 1]! * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta);
    ep -= BETA[j - 1]! * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta);
  }
  const chi = Math.asin(Math.sin(xp) / Math.cosh(ep));
  let phi = chi;
  for (let j = 1; j <= 3; j++) phi += DELTA[j - 1]! * Math.sin(2 * j * chi);
  const lon = u.zone * 6 - 183 + deg(Math.atan2(Math.sinh(ep), Math.cos(xp)));
  return [deg(phi), lon];
}

/** Grid convergence γ: angle from true north to grid north (east positive). */
export function gridConvergence(lat: number, lon: number): number {
  const dl = rad(lon - (utmZone(lat, lon) * 6 - 183));
  return deg(Math.atan(Math.tan(dl) * Math.sin(rad(lat))));
}

// ---------------------------------------------------------------------------
// Magnetic declination (WMM). magnetic azimuth = true azimuth − declination.
// ---------------------------------------------------------------------------
let wmm: ReturnType<typeof geomagnetism.model> | null = null;
const declCache = new Map<string, number>();
/** Declination in degrees, east positive. Cached per ~1 km cell. */
export function declination(lat: number, lon: number): number {
  const key = `${lat.toFixed(2)},${lon.toFixed(2)}`;
  let d = declCache.get(key);
  if (d == null) {
    wmm ??= geomagnetism.model(new Date(), { allowOutOfBoundsModel: true });
    d = wmm.point([lat, lon]).decl;
    if (declCache.size > 200) declCache.clear();
    declCache.set(key, d);
  }
  return d;
}

export const fmtSigned = (d: number, pos = 'E', neg = 'W') => `${Math.abs(d).toFixed(1)}° ${d >= 0 ? pos : neg}`;

// ---------------------------------------------------------------------------
// Sectors ("условные квадраты"): each 1 km MGRS square is split into
// step-metre cells. Columns west→east are NATO letters, rows north→south numbers:
// "Браво-3" = column B, row 3. The km square ("DB 12-67") disambiguates.
// ---------------------------------------------------------------------------
export const GRID_STEPS = [50, 100, 250] as const;
export type GridStep = (typeof GRID_STEPS)[number];

export const PHONETIC = [
  'Альфа', 'Браво', 'Чарли', 'Дельта', 'Эхо', 'Фокстрот', 'Гольф', 'Хотел', 'Индия', 'Джульетта',
  'Кило', 'Лима', 'Майк', 'Ноябрь', 'Оскар', 'Папа', 'Квебек', 'Ромео', 'Сьерра', 'Танго',
];
export const LETTERS = 'ABCDEFGHIJKLMNOPQRST';

export interface Sector {
  /** MGRS 100 km letters + km digits, e.g. "DB 12-67" */
  km: string;
  col: number;
  row: number;
  short: string;
  name: string;
}

export function sectorCell(e: number, n: number, step: GridStep) {
  const per = 1000 / step;
  const col = Math.floor((((e % 1000) + 1000) % 1000) / step);
  const row = per - Math.floor((((n % 1000) + 1000) % 1000) / step);
  return { col, row, short: `${LETTERS[col]}${row}`, name: `${PHONETIC[col]}-${row}` };
}

export function sectorAt(lat: number, lon: number, step: GridStep): Sector {
  const u = toUtm(lat, lon);
  const c = sectorCell(u.e, u.n, step);
  let km = '';
  try {
    const s = toMgrs([lon, lat], 2); // "37UDB1267"
    km = `${s.slice(-6, -4)} ${s.slice(-4, -2)}-${s.slice(-2)}`;
  } catch {
    /* polar: no MGRS */
  }
  return { km, ...c };
}
