// Offline-capable tile layer backed by the Cache Storage API.
// Works in browsers and inside the Capacitor WebView (no Service Worker needed).
import L from 'leaflet';
import type { BaseLayer } from '../store';

const CACHE = 'tactic-tiles-v1';

export const BASE_LAYERS: Record<BaseLayer, { url: string; maxZoom: number; maxNativeZoom: number; attribution: string; label: string }> = {
  sat: {
    label: 'SAT',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    maxZoom: 21,
    maxNativeZoom: 19,
    attribution: 'Imagery © Esri, Maxar, Earthstar Geographics',
  },
  osm: {
    label: 'OSM',
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    maxZoom: 21,
    maxNativeZoom: 19,
    attribution: '© OpenStreetMap contributors',
  },
  topo: {
    label: 'TOPO',
    url: 'https://a.tile.opentopomap.org/{z}/{x}/{y}.png',
    maxZoom: 19,
    maxNativeZoom: 17,
    attribution: '© OpenStreetMap contributors, SRTM | © OpenTopoMap (CC-BY-SA)',
  },
};

let cachePromise: Promise<Cache | null> | null = null;
function tileCache(): Promise<Cache | null> {
  cachePromise ??= ('caches' in window ? caches.open(CACHE) : Promise.resolve(null)).catch(() => null);
  return cachePromise;
}

async function cachedBlobUrl(url: string, signal: AbortSignal): Promise<string> {
  const cache = await tileCache();
  if (cache) {
    const hit = await cache.match(url);
    if (hit) return URL.createObjectURL(await hit.blob());
  }
  const res = await fetch(url, { mode: 'cors', signal });
  if (!res.ok) throw new Error(`tile ${res.status}`);
  if (cache) cache.put(url, res.clone()).catch(() => {});
  return URL.createObjectURL(await res.blob());
}

export const CachedTileLayer = L.TileLayer.extend({
  createTile(this: L.TileLayer, coords: L.Coords, done: L.DoneCallback) {
    const img = document.createElement('img');
    img.alt = '';
    img.setAttribute('role', 'presentation');
    const url = this.getTileUrl(coords);
    const ctrl = new AbortController();
    (img as HTMLImageElement & { _abort?: AbortController })._abort = ctrl;

    img.onload = () => {
      if (img.src.startsWith('blob:')) URL.revokeObjectURL(img.src);
      done(undefined, img);
    };
    img.onerror = () => done(new Error('tile load failed'), img);

    cachedBlobUrl(url, ctrl.signal)
      .then((blobUrl) => (img.src = blobUrl))
      .catch(() => {
        // CORS-less servers or network failure: let the browser try directly.
        if (!ctrl.signal.aborted) img.src = url;
      });
    return img;
  },
  _abortLoading(this: L.TileLayer & { _tiles: Record<string, { coords: L.Coords; el: HTMLImageElement & { _abort?: AbortController } }> }) {
    for (const key in this._tiles) {
      const tile = this._tiles[key]!;
      if (tile.coords.z !== Math.round((this as unknown as { _tileZoom: number })._tileZoom)) tile.el._abort?.abort();
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (L.TileLayer.prototype as any)._abortLoading?.call(this);
  },
}) as unknown as new (url: string, opts?: L.TileLayerOptions) => L.TileLayer;

function lon2tile(lon: number, z: number) {
  return Math.floor(((lon + 180) / 360) * 2 ** z);
}
function lat2tile(lat: number, z: number) {
  const r = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
}

export function tileList(layer: BaseLayer, bounds: L.LatLngBounds, zMin: number, zMax: number): string[] {
  const src = BASE_LAYERS[layer];
  const urls: string[] = [];
  for (let z = zMin; z <= Math.min(zMax, src.maxNativeZoom); z++) {
    const x0 = lon2tile(bounds.getWest(), z);
    const x1 = lon2tile(bounds.getEast(), z);
    const y0 = lat2tile(bounds.getNorth(), z);
    const y1 = lat2tile(bounds.getSouth(), z);
    for (let x = x0; x <= x1; x++)
      for (let y = y0; y <= y1; y++) urls.push(src.url.replace('{z}', `${z}`).replace('{x}', `${x}`).replace('{y}', `${y}`));
  }
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
