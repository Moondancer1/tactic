// Voice-friendly target indication: grid sector + offset from the nearest TRP.
import type { Marker } from '@tactic/shared';
import { bearing, distance, fmtAz, fmtDist, sectorAt, type GridStep, type Sector } from './geo';

export interface TrpRef {
  label: string;
  dist: number;
  az: number;
}

export function nearestTrp(lat: number, lon: number, markers: Record<string, Marker>, maxDist = 1500): TrpRef | null {
  let best: TrpRef | null = null;
  for (const m of Object.values(markers)) {
    if (m.kind !== 'trp') continue;
    const d = distance([m.lat, m.lon], [lat, lon]);
    if (d <= maxDist && (!best || d < best.dist)) best = { label: m.label, dist: d, az: bearing([m.lat, m.lon], [lat, lon]) };
  }
  return best;
}

export interface Callout {
  sector: Sector;
  trp: TrpRef | null;
}

export function callout(lat: number, lon: number, step: GridStep, markers: Record<string, Marker>): Callout {
  return { sector: sectorAt(lat, lon, step), trp: nearestTrp(lat, lon, markers) };
}

/** "Браво-3 (кв DB 12-67) · TRP ДУБ 120 m 045°" */
export function calloutText(c: Callout): string {
  const sec = `${c.sector.name}${c.sector.km ? ` (кв ${c.sector.km})` : ''}`;
  if (!c.trp) return sec;
  return `${sec} · TRP ${c.trp.label} ${c.trp.dist < 15 ? '0 m' : `${fmtDist(c.trp.dist)} ${fmtAz(c.trp.az)}`}`;
}
