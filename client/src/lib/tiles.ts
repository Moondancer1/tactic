// Base map styles + offline cache for every map resource (tiles, styles, glyphs, sprites).
// MapLibre requests go through the `cache://` protocol, backed by the Cache Storage API.
// Works in browsers and inside the Capacitor WebView (no Service Worker needed).
import maplibregl, { type RequestTransformFunction, type StyleSpecification } from 'maplibre-gl';
import type { BaseLayer } from '../store';

const CACHE = 'tactic-tiles-v1';
const OFM = 'https://tiles.openfreemap.org';
export const GLYPHS = `${OFM}/fonts/{fontstack}/{range}.pbf`;
export const LABEL_FONT = ['Noto Sans Bold'];
const VECTOR_STYLE = `${OFM}/styles/liberty`;

const rasterStyle = (url: string, maxzoom: number, attribution: string): StyleSpecification => ({
  version: 8,
  glyphs: GLYPHS,
  sources: { base: { type: 'raster', tiles: [url], tileSize: 256, maxzoom, attribution } },
  layers: [{ id: 'base', type: 'raster', source: 'base' }],
});

export interface BaseLayerDef {
  label: string;
  hint: string;
  style: string | StyleSpecification;
  /** tilting allowed (two-finger vertical swipe) */
  pitch: boolean;
  /** grid / ruler colour that reads well on this background */
  ink: string;
  raster?: { url: string; maxzoom: number };
}

const SAT_URL = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
const TOPO_URL = 'https://a.tile.opentopomap.org/{z}/{x}/{y}.png';

export const BASE_LAYERS: Record<BaseLayer, BaseLayerDef> = {
  sat: {
    label: 'SAT',
    hint: 'Спутник',
    style: rasterStyle(SAT_URL, 19, 'Imagery © Esri, Maxar, Earthstar Geographics'),
    pitch: false,
    ink: '#ffd400',
    raster: { url: SAT_URL, maxzoom: 19 },
  },
  map2d: { label: '2D', hint: 'Схема', style: VECTOR_STYLE, pitch: false, ink: '#1d4ed8' },
  map3d: { label: '3D', hint: 'Схема, наклон двумя пальцами', style: VECTOR_STYLE, pitch: true, ink: '#1d4ed8' },
  topo: {
    label: 'TOPO',
    hint: 'Топо',
    style: rasterStyle(TOPO_URL, 17, '© OpenStreetMap contributors, SRTM | © OpenTopoMap (CC-BY-SA)'),
    pitch: false,
    ink: '#c2185b',
    raster: { url: TOPO_URL, maxzoom: 17 },
  },
};
export const BASE_LAYER_IDS = Object.keys(BASE_LAYERS) as BaseLayer[];

// ---------- cache ----------
let cachePromise: Promise<Cache | null> | null = null;
function tileCache(): Promise<Cache | null> {
  cachePromise ??= ('caches' in window ? caches.open(CACHE) : Promise.resolve(null)).catch(() => null);
  return cachePromise;
}

/** Tiles/glyphs/sprites never change for a URL: cache first. Style/TileJSON may: network first. */
async function cachedFetch(url: string, signal: AbortSignal, networkFirst: boolean): Promise<Response> {
  const cache = await tileCache();
  if (cache && !networkFirst) {
    const hit = await cache.match(url);
    if (hit) return hit;
  }
  try {
    const res = await fetch(url, { mode: 'cors', signal });
    if (!res.ok) throw new Error(`${res.status} ${url}`);
    if (cache) void cache.put(url, res.clone()).catch(() => {});
    return res;
  } catch (e) {
    const hit = networkFirst && cache ? await cache.match(url) : undefined;
    if (hit) return hit;
    throw e;
  }
}

let registered = false;
export function registerCacheProtocol() {
  if (registered) return;
  registered = true;
  maplibregl.addProtocol('cache', async (params, ctrl) => {
    const url = params.url.slice('cache://'.length);
    const isJson = params.type === 'json';
    const res = await cachedFetch(url, ctrl.signal, isJson);
    if (isJson) return { data: await res.json() };
    if (params.type === 'string') return { data: await res.text() };
    return { data: await res.arrayBuffer() };
  });
}

/** Route every remote map resource through the offline cache. */
export const transformRequest: RequestTransformFunction = (url) =>
  url.startsWith('http') ? { url: `cache://${url}` } : { url };

// ---------- prefetch ----------
function lon2tile(lon: number, z: number) {
  return Math.floor(((lon + 180) / 360) * 2 ** z);
}
function lat2tile(lat: number, z: number) {
  const r = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
}

export interface Bounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

function expand(tpl: string, b: Bounds, zMin: number, zMax: number, out: string[]) {
  for (let z = zMin; z <= zMax; z++) {
    const x0 = lon2tile(b.west, z), x1 = lon2tile(b.east, z);
    const y0 = lat2tile(b.north, z), y1 = lat2tile(b.south, z);
    for (let x = x0; x <= x1; x++)
      for (let y = y0; y <= y1; y++) out.push(tpl.replace('{z}', `${z}`).replace('{x}', `${x}`).replace('{y}', `${y}`));
  }
}

/** Every URL needed to show `layer` offline over `b`, zoom zMin..zMax (+ glyphs for grid labels). */
export async function tileList(layer: BaseLayer, b: Bounds, zMin: number, zMax: number): Promise<string[]> {
  const def = BASE_LAYERS[layer];
  const urls: string[] = [];
  for (const range of ['0-255', '1024-1279']) urls.push(GLYPHS.replace('{fontstack}', LABEL_FONT[0]!).replace('{range}', range));
  if (def.raster) {
    expand(def.raster.url, b, zMin, Math.min(zMax, def.raster.maxzoom), urls);
    return urls;
  }
  // Vector: style -> TileJSON -> tile template, plus sprites and the style's fonts.
  const ctrl = new AbortController();
  const style = (await (await cachedFetch(def.style as string, ctrl.signal, true)).json()) as StyleSpecification & { sprite?: string };
  urls.push(def.style as string);
  for (const src of Object.values(style.sources)) {
    if (src.type !== 'vector' || !src.url) continue;
    const tj = (await (await cachedFetch(src.url, ctrl.signal, true)).json()) as { tiles: string[]; maxzoom?: number };
    urls.push(src.url);
    expand(tj.tiles[0]!, b, zMin, Math.min(zMax, tj.maxzoom ?? 14), urls);
  }
  if (typeof style.sprite === 'string') for (const sfx of ['', '@2x']) urls.push(`${style.sprite}${sfx}.json`, `${style.sprite}${sfx}.png`);
  for (const font of ['Noto Sans Regular', 'Noto Sans Italic'])
    for (const range of ['0-255', '1024-1279']) urls.push(GLYPHS.replace('{fontstack}', font).replace('{range}', range));
  return urls;
}

/** Download the game area for offline use. Keep it to the playing field: tile servers have fair-use limits. */
export async function prefetchTiles(urls: string[], onProgress: (done: number, total: number) => void, signal: AbortSignal) {
  const cache = await tileCache();
  if (!cache) throw new Error('Cache Storage unavailable');
  let done = 0;
  const queue = [...urls];
  const worker = async () => {
    while (queue.length && !signal.aborted) {
      const url = queue.shift()!;
      try {
        if (!(await cache.match(url))) {
          const res = await fetch(url, { mode: 'cors', signal });
          if (res.ok) await cache.put(url, res);
        }
      } catch {
        /* skip failed tile */
      }
      onProgress(++done, urls.length);
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
}

export async function clearTileCache() {
  cachePromise = null;
  await caches.delete(CACHE);
}

export async function tileCacheCount(): Promise<number> {
  const cache = await tileCache();
  return cache ? (await cache.keys()).length : 0;
}
