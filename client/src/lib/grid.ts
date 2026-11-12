// Tactical grid as GeoJSON: UTM lines every `step` metres (bold every 1 km) plus sector labels.
// Built in the UTM zone of the view centre, so it matches the MGRS readout on every device.
import { fromUtm, sectorCell, toUtm, type GridStep } from './geo';

type LngLat = [number, number];
type FC = GeoJSON.FeatureCollection;

const MAX_LINES = 64;

export interface GridView {
  /** [lat, lon] of the view centre */
  center: [number, number];
  /** [lat, lon] of the visible corners */
  corners: [number, number][];
  /** metres per screen pixel at the centre */
  mpp: number;
}

export function buildGrid(v: GridView, step: GridStep): { lines: FC; labels: FC } {
  const lines: GeoJSON.Feature[] = [];
  const labels: GeoJSON.Feature[] = [];
  const empty = { lines: { type: 'FeatureCollection', features: lines } as FC, labels: { type: 'FeatureCollection', features: labels } as FC };

  const c = toUtm(v.center[0], v.center[1]);
  const pts = v.corners.map((p) => toUtm(p[0], p[1], c.zone, c.south));
  // A tilted view reaches the horizon: keep the grid to a sane radius around the centre.
  const reach = Math.max(1500, v.mpp * 2500);
  const clamp = (x: number, mid: number) => Math.min(mid + reach, Math.max(mid - reach, x));
  let e0 = clamp(Math.min(...pts.map((p) => p.e)), c.e);
  let e1 = clamp(Math.max(...pts.map((p) => p.e)), c.e);
  let n0 = clamp(Math.min(...pts.map((p) => p.n)), c.n);
  let n1 = clamp(Math.max(...pts.map((p) => p.n)), c.n);

  // Fall back to 1 km lines (or nothing) when the minor grid would be a dense mesh.
  const cellPx = step / v.mpp;
  let s: number = step;
  if (cellPx < 22 || Math.max(e1 - e0, n1 - n0) / s > MAX_LINES) s = 1000;
  if (1000 / v.mpp < 14 || Math.max(e1 - e0, n1 - n0) / s > MAX_LINES) return empty;

  e0 = Math.floor(e0 / s) * s;
  n0 = Math.floor(n0 / s) * s;
  e1 = Math.ceil(e1 / s) * s;
  n1 = Math.ceil(n1 / s) * s;

  const ll = (e: number, n: number): LngLat => {
    const [lat, lon] = fromUtm({ zone: c.zone, south: c.south, e, n });
    return [lon, lat];
  };
  // UTM lines are slightly curved in Web Mercator: sample every 500 m.
  const seg = (a: number, b: number) => {
    const out: number[] = [];
    for (let x = a; x < b; x += 500) out.push(x);
    out.push(b);
    return out;
  };
  const ns = seg(n0, n1);
  const es = seg(e0, e1);
  for (let e = e0; e <= e1; e += s)
    lines.push({ type: 'Feature', properties: { major: e % 1000 === 0 }, geometry: { type: 'LineString', coordinates: ns.map((n) => ll(e, n)) } });
  for (let n = n0; n <= n1; n += s)
    lines.push({ type: 'Feature', properties: { major: n % 1000 === 0 }, geometry: { type: 'LineString', coordinates: es.map((e) => ll(e, n)) } });

  // Sector labels ("B3") in each cell centre when cells are big enough to read.
  if (s === step && cellPx >= 34 && ((e1 - e0) / s) * ((n1 - n0) / s) < 900) {
    for (let e = e0; e < e1; e += s)
      for (let n = n0; n < n1; n += s) {
        const cell = sectorCell(e + s / 2, n + s / 2, step);
        labels.push({ type: 'Feature', properties: { text: cell.short, kind: 'cell' }, geometry: { type: 'Point', coordinates: ll(e + s / 2, n + s / 2) } });
      }
  }
  // Kilometre-square numbers (MGRS easting/northing km digits) at each km square's NW corner.
  if (1000 / v.mpp >= 60) {
    for (let e = Math.ceil(e0 / 1000) * 1000; e < e1; e += 1000)
      for (let n = Math.ceil(n0 / 1000) * 1000 + 1000; n <= n1; n += 1000) {
        const txt = `${String(Math.floor(e / 1000) % 100).padStart(2, '0')}-${String(Math.floor((n - 1000) / 1000) % 100).padStart(2, '0')}`;
        labels.push({ type: 'Feature', properties: { text: txt, kind: 'km' }, geometry: { type: 'Point', coordinates: ll(e, n) } });
      }
  }
  return empty;
}
