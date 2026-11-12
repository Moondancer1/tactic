// Imperative MapLibre map synced from the zustand store (no React re-render per GPS tick).
// Base styles: satellite, 2D scheme, 3D scheme (two-finger vertical swipe tilts and shows building heights), topo.
import { useEffect, useRef, useState } from 'react';
import maplibregl, { type GeoJSONSource, type LngLatLike } from 'maplibre-gl';
import { SQUAD_META, isCommandRole, type Marker, type PlayerState, type Route, type Zone } from '@tactic/shared';
import { useStore, type BaseLayer } from '../store';
import { BASE_LAYERS, LABEL_FONT, registerCacheProtocol, transformRequest } from '../lib/tiles';
import { arrowHtml, contactHtml, esc, objectiveHtml, playerHtml, pointHtml, trpHtml, vertexHtml } from '../lib/symbols';
import { bearing, distance, fmtAz, fmtDist, mgrs } from '../lib/geo';
import { buildGrid } from '../lib/grid';
import { callout, calloutText } from '../lib/callout';
import { mapRef } from '../lib/mapRef';
import { socket } from '../lib/socket';

const STALE_MS = 45_000;
// Fallback view before the first GPS fix (the map recentres on it as soon as it arrives)
const DEFAULT_VIEW: [number, number] = [40.4093, 49.8671];
const LONG_PRESS_MS = 550;
const TRP_NAMES = ['ДУБ', 'ВЫШКА', 'КУЗОВ', 'РАЗВИЛКА', 'БЕРЁЗА', 'ТРУБА', 'КРЕСТ', 'ЗАБОР', 'КОЛОДЕЦ', 'АНГАР', 'ОПОРА', 'ПНИ'];

const ZONE_STYLE: Record<Zone['kind'], { color: string; pattern: string; dash: 'solid' | 'dash' | 'dot' }> = {
  friendly: { color: '#3fa7ff', pattern: 'hatch-blue', dash: 'dash' },
  hostile: { color: '#ff5a4e', pattern: 'hatch-red', dash: 'solid' },
  neutral: { color: '#e5e7eb', pattern: 'hatch-white', dash: 'dash' },
  objective: { color: '#ffb000', pattern: 'hatch-amber', dash: 'dash' },
  restricted: { color: '#c084fc', pattern: 'cross-violet', dash: 'dot' },
};

type LL = [number, number]; // [lat, lon]
const lngLat = (p: LL): [number, number] => [p[1], p[0]];
const fc = (features: GeoJSON.Feature[]): GeoJSON.FeatureCollection => ({ type: 'FeatureCollection', features });
const EMPTY = fc([]);

/** Diagonal hatch (optionally cross-hatched) as a fill-pattern image. */
function hatchImage(color: string, cross: boolean) {
  const size = 16;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  g.fillStyle = color;
  g.globalAlpha = 0.1;
  g.fillRect(0, 0, size, size);
  g.globalAlpha = 0.6;
  g.strokeStyle = color;
  g.lineWidth = 2.2;
  g.beginPath();
  for (const o of [-size, 0, size]) (g.moveTo(o, size), g.lineTo(o + size, 0));
  if (cross) for (const o of [-size, 0, size]) (g.moveTo(o, 0), g.lineTo(o + size, size));
  g.stroke();
  return g.getImageData(0, 0, size, size);
}

function circlePolygon(lat: number, lon: number, r: number): GeoJSON.Feature {
  const pts: [number, number][] = [];
  const dLat = r / 111_320;
  const dLon = r / (111_320 * Math.cos((lat * Math.PI) / 180));
  for (let i = 0; i <= 32; i++) {
    const a = (i / 32) * 2 * Math.PI;
    pts.push([lon + dLon * Math.cos(a), lat + dLat * Math.sin(a)]);
  }
  return { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [pts] } };
}

function el(className: string, html: string): HTMLDivElement {
  const d = document.createElement('div');
  d.className = className;
  d.innerHTML = html;
  return d;
}

type LabelPromptState = {
  kind: 'trp' | 'objective' | 'waypoint';
  pt: [number, number];
  value: string;
  title: string;
  placeholder: string;
};

export function MapView() {
  const host = useRef<HTMLDivElement>(null);
  const [labelPrompt, setLabelPrompt] = useState<LabelPromptState | null>(null);

  useEffect(() => {
    const store = useStore;
    registerCacheProtocol();
    const s0 = store.getState();
    const container = host.current!;
    const initCenter: [number, number] = s0.myPos
      ? [s0.myPos.lon, s0.myPos.lat]
      : [DEFAULT_VIEW[1], DEFAULT_VIEW[0]];
    const map = new maplibregl.Map({
      container,
      style: BASE_LAYERS[s0.settings.baseLayer].style,
      center: initCenter,
      zoom: s0.myPos ? 17 : 13,
      maxZoom: 21,
      maxPitch: 70,
      transformRequest,
      attributionControl: { compact: true },
      fadeDuration: 0,
      clickTolerance: 4,
    });
    map.addControl(new maplibregl.ScaleControl({ unit: 'metric', maxWidth: 120 }), 'bottom-left');

    // ---------- base layer ----------
    let baseKey: BaseLayer = s0.settings.baseLayer;
    const applyPitchMode = () => {
      const def = BASE_LAYERS[baseKey];
      if (def.pitch) {
        map.setMaxPitch(70);
        map.touchPitch.enable();
      } else {
        map.setMaxPitch(0);
        map.touchPitch.disable();
      }
    };
    applyPitchMode();
    const setBase = (k: BaseLayer) => {
      if (k === baseKey) return;
      const sameStyle = BASE_LAYERS[k].style === BASE_LAYERS[baseKey].style;
      baseKey = k;
      applyPitchMode();
      if (sameStyle) styleInk();
      else map.setStyle(BASE_LAYERS[k].style, { diff: false });
      if (BASE_LAYERS[k].pitch && map.getPitch() === 0) store.getState().toast('3D: drag up with two fingers to tilt');
    };

    // ---------- overlay data (survives style switches) ----------
    const data: Record<string, GeoJSON.FeatureCollection> = {
      zones: EMPTY,
      routes: EMPTY,
      grid: EMPTY,
      'grid-labels': EMPTY,
      acc: EMPTY,
      draft: EMPTY,
    };
    const setData = (id: string, d: GeoJSON.FeatureCollection) => {
      data[id] = d;
      (map.getSource(id) as GeoJSONSource | undefined)?.setData(d);
    };

    const styleInk = () => {
      if (!map.getLayer('grid-major')) return;
      const ink = BASE_LAYERS[baseKey].ink;
      const halo = baseKey === 'sat' ? '#000' : '#fff';
      map.setPaintProperty('grid-minor', 'line-color', ink);
      map.setPaintProperty('grid-major', 'line-color', ink);
      map.setPaintProperty('grid-cell-labels', 'text-color', ink);
      map.setPaintProperty('grid-cell-labels', 'text-halo-color', halo);
      map.setPaintProperty('grid-km-labels', 'text-color', halo === '#000' ? '#fff' : '#000');
      map.setPaintProperty('grid-km-labels', 'text-halo-color', ink);
    };

    const installOverlays = () => {
      for (const [id, color, cross] of [
        ['hatch-red', '#ff5a4e', false],
        ['hatch-blue', '#3fa7ff', false],
        ['hatch-white', '#e5e7eb', false],
        ['hatch-amber', '#ffb000', false],
        ['cross-violet', '#c084fc', true],
      ] as const)
        if (!map.hasImage(id)) map.addImage(id, hatchImage(color, cross));
      for (const id of Object.keys(data)) if (!map.getSource(id)) map.addSource(id, { type: 'geojson', data: data[id]! });

      const vis = store.getState().settings.grid ? 'visible' : 'none';
      map.addLayer({ id: 'grid-minor', type: 'line', source: 'grid', filter: ['!', ['get', 'major']], layout: { visibility: vis }, paint: { 'line-width': 0.8, 'line-opacity': 0.55 } });
      map.addLayer({ id: 'grid-major', type: 'line', source: 'grid', filter: ['get', 'major'], layout: { visibility: vis }, paint: { 'line-width': 1.8, 'line-opacity': 0.85 } });
      map.addLayer({
        id: 'grid-cell-labels',
        type: 'symbol',
        source: 'grid-labels',
        filter: ['==', ['get', 'kind'], 'cell'],
        layout: { visibility: vis, 'text-field': ['get', 'text'], 'text-font': LABEL_FONT, 'text-size': 12, 'text-allow-overlap': true, 'text-pitch-alignment': 'map', 'text-rotation-alignment': 'map' },
        paint: { 'text-halo-width': 1.4, 'text-opacity': 0.85 },
      });
      map.addLayer({
        id: 'grid-km-labels',
        type: 'symbol',
        source: 'grid-labels',
        filter: ['==', ['get', 'kind'], 'km'],
        layout: { visibility: vis, 'text-field': ['get', 'text'], 'text-font': LABEL_FONT, 'text-size': 12, 'text-anchor': 'top-left', 'text-offset': [0.3, 0.2], 'text-allow-overlap': true },
        paint: { 'text-halo-width': 3 },
      });
      map.addLayer({ id: 'zones-fill', type: 'fill', source: 'zones', paint: { 'fill-pattern': ['get', 'pattern'] } });
      for (const [dash, arr] of [
        ['solid', undefined],
        ['dash', [3, 2]],
        ['dot', [1, 3]],
      ] as const)
        map.addLayer({
          id: `zones-line-${dash}`,
          type: 'line',
          source: 'zones',
          filter: ['==', ['get', 'dash'], dash],
          paint: { 'line-color': ['get', 'color'], 'line-width': 2.5, ...(arr ? { 'line-dasharray': [...arr] } : {}) },
        });
      map.addLayer({ id: 'routes-casing', type: 'line', source: 'routes', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#000', 'line-width': 7, 'line-opacity': 0.45 } });
      map.addLayer({ id: 'routes-line', type: 'line', source: 'routes', paint: { 'line-color': ['get', 'color'], 'line-width': 3.5, 'line-dasharray': [3, 2] } });
      map.addLayer({ id: 'acc-fill', type: 'fill', source: 'acc', paint: { 'fill-color': '#9bd35a', 'fill-opacity': 0.08 } });
      map.addLayer({ id: 'acc-line', type: 'line', source: 'acc', paint: { 'line-color': '#9bd35a', 'line-width': 1 } });
      map.addLayer({ id: 'draft-fill', type: 'fill', source: 'draft', filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'fill-color': '#9bd35a', 'fill-opacity': 0.12 } });
      map.addLayer({ id: 'draft-casing', type: 'line', source: 'draft', layout: { 'line-cap': 'round' }, paint: { 'line-color': '#000', 'line-width': 6, 'line-opacity': 0.5 } });
      map.addLayer({ id: 'draft-line', type: 'line', source: 'draft', layout: { 'line-cap': 'round' }, paint: { 'line-color': '#ffe14d', 'line-width': 3 } });
      styleInk();
    };
    map.on('style.load', () => {
      installOverlays();
      updateGrid();
    });
    // A missing sprite icon or tile must not spam the console / break the style.
    map.on('styleimagemissing', () => {});
    map.on('error', (e) => console.debug('[map]', e.error?.message));

    // ---------- grid ----------
    const updateGrid = () => {
      const st = store.getState().settings;
      if (!st.grid || !map.getSource('grid')) return;
      const { clientWidth: w, clientHeight: h } = container;
      const pad = 0.25;
      const corners = [
        [-w * pad, -h * pad],
        [w * (1 + pad), -h * pad],
        [w * (1 + pad), h * (1 + pad)],
        [-w * pad, h * (1 + pad)],
      ].map(([x, y]) => {
        const p = map.unproject([x!, y!]);
        return [p.lat, p.lng] as LL;
      });
      const c = map.getCenter();
      const mpp = (40075016.686 * Math.cos((c.lat * Math.PI) / 180)) / (512 * 2 ** map.getZoom());
      const g = buildGrid({ center: [c.lat, c.lng], corners, mpp }, st.gridStep);
      setData('grid', g.lines);
      setData('grid-labels', g.labels);
    };
    const setGridVisible = (on: boolean) => {
      for (const id of ['grid-minor', 'grid-major', 'grid-cell-labels', 'grid-km-labels'])
        if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
      if (on) updateGrid();
    };

    // ---------- DOM markers ----------
    type Dom = { m: maplibregl.Marker; key: string };
    const domMarker = (cls: string, html: string, at: LL, opts: maplibregl.MarkerOptions = {}, onClick?: () => void) => {
      const node = el(cls, html);
      if (onClick)
        node.addEventListener('click', (e) => {
          e.stopPropagation();
          onClick();
        });
      return new maplibregl.Marker({ element: node, ...opts }).setLngLat(lngLat(at)).addTo(map);
    };
    const setHtml = (o: Dom, html: string) => {
      if (o.key === html) return;
      o.m.getElement().innerHTML = html;
      o.key = html;
    };

    const zoneLabels = new Map<string, maplibregl.Marker>();
    const routeDecor = new Map<string, maplibregl.Marker[]>();
    const markerObjs = new Map<string, Dom>();
    const playerObjs = new Map<string, Dom>();
    let selfObj: Dom | null = null;
    let pickedMarker: maplibregl.Marker | null = null;
    let centeredOnce = !!s0.myPos;
    if (!centeredOnce && 'geolocation' in navigator) {
      navigator.geolocation.getCurrentPosition(
        (p) => {
          if (!centeredOnce) {
            centeredOnce = true;
            map.jumpTo({ center: [p.coords.longitude, p.coords.latitude], zoom: Math.max(map.getZoom(), 17) });
          }
        },
        () => {},
        { enableHighAccuracy: true, timeout: 10_000, maximumAge: 60_000 },
      );
    }

    // ---------- sync ----------
    const syncZones = (zones: Record<string, Zone>) => {
      setData(
        'zones',
        fc(
          Object.values(zones).map((z) => {
            const st = ZONE_STYLE[z.kind];
            const ring = z.points.map(lngLat);
            ring.push(ring[0]!);
            return { type: 'Feature', properties: { id: z.id, kind: z.kind, color: st.color, pattern: st.pattern, dash: st.dash }, geometry: { type: 'Polygon', coordinates: [ring] } };
          }),
        ),
      );
      for (const [id, m] of zoneLabels) if (!zones[id]?.name) (m.remove(), zoneLabels.delete(id));
      for (const z of Object.values(zones)) {
        if (!z.name) continue;
        const c: LL = [z.points.reduce((a, p) => a + p[0], 0) / z.points.length, z.points.reduce((a, p) => a + p[1], 0) / z.points.length];
        const html = `<span>${esc(z.name.toUpperCase())}</span>`;
        const o = zoneLabels.get(z.id);
        if (o) (o.setLngLat(lngLat(c)), (o.getElement().innerHTML = html));
        else zoneLabels.set(z.id, domMarker('zone-label', html, c));
      }
    };

    const syncRoutes = (routes: Record<string, Route>) => {
      setData(
        'routes',
        fc(Object.values(routes).map((r) => ({ type: 'Feature', properties: { id: r.id, color: SQUAD_META[r.squad].color }, geometry: { type: 'LineString', coordinates: r.points.map(lngLat) } }))),
      );
      for (const ms of routeDecor.values()) ms.forEach((m) => m.remove());
      routeDecor.clear();
      for (const r of Object.values(routes)) {
        const color = SQUAD_META[r.squad].color;
        const ms: maplibregl.Marker[] = [];
        // Chevron at each segment midpoint and an arrowhead at the end, rotated with the map.
        for (let i = 1; i < r.points.length; i++) {
          const a = r.points[i - 1]!;
          const b = r.points[i]!;
          const isLast = i === r.points.length - 1;
          const at: LL = isLast ? b : [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
          const m = domMarker(`route-arrow${isLast ? ' end' : ''}`, arrowHtml(color, 0), at, { rotation: bearing(a, b), rotationAlignment: 'map', pitchAlignment: 'map' });
          ms.push(m);
        }
        if (r.label) ms.push(domMarker('route-label', `<span style="border-color:${color}">${esc(r.label)}</span>`, r.points[0]!));
        routeDecor.set(r.id, ms);
      }
    };

    const markerIcon = (m: Marker, now: number) => {
      if (m.kind === 'contact') return { html: contactHtml(m, now), cls: 'mk-contact' };
      if (m.kind === 'objective') return { html: objectiveHtml(m), cls: 'mk-obj' };
      if (m.kind === 'trp') return { html: trpHtml(m), cls: 'mk-trp' };
      return { html: pointHtml(m), cls: 'mk-point' };
    };

    const syncMarkers = (markers: Record<string, Marker>) => {
      const now = Date.now();
      for (const [id, o] of markerObjs) if (!markers[id]) (o.m.remove(), markerObjs.delete(id));
      for (const m of Object.values(markers)) {
        const ic = markerIcon(m, now);
        const o = markerObjs.get(m.id);
        if (o) {
          o.m.setLngLat([m.lon, m.lat]);
          setHtml(o, ic.html);
          continue;
        }
        const mk = domMarker(ic.cls, ic.html, [m.lat, m.lon], {}, () => markerPopup(m.id));
        mk.getElement().style.zIndex = m.kind === 'contact' ? '5' : '3';
        markerObjs.set(m.id, { m: mk, key: ic.html });
      }
    };

    const syncPlayers = (players: Record<string, PlayerState>) => {
      const s = store.getState();
      const now = Date.now() + s.clockSkew;
      for (const [id, o] of playerObjs) if (!players[id] || id === s.self?.id) (o.m.remove(), playerObjs.delete(id));
      for (const p of Object.values(players)) {
        if (p.id === s.self?.id || p.lat == null || p.lon == null) continue;
        const stale = !p.online || now - p.ts > STALE_MS;
        const html = playerHtml(p, { self: false, stale, showCone: !stale });
        const o = playerObjs.get(p.id);
        if (o) {
          o.m.setLngLat([p.lon, p.lat]);
          setHtml(o, html);
          continue;
        }
        const mk = domMarker('mk-unit', html, [p.lat, p.lon], {}, () => playerPopup(p.id));
        mk.getElement().style.zIndex = '8';
        playerObjs.set(p.id, { m: mk, key: html });
      }
    };

    let lastSelfAccKey = '';
    const syncSelf = () => {
      const s = store.getState();
      const pos = s.myPos;
      if (!pos || !s.self) return;
      const me = s.players[s.self.id];
      const hdg = pos.heading ?? s.compass;
      const fake = {
        ...(me ?? { id: s.self.id, callsign: s.self.callsign, squad: s.self.squad, role: s.self.role, status: 'ok', online: true, bat: null }),
        lat: pos.lat,
        lon: pos.lon,
        acc: pos.acc,
        heading: hdg,
        speed: pos.speed,
        ts: pos.ts,
      } as PlayerState;
      const accKey = `${pos.lat.toFixed(5)},${pos.lon.toFixed(5)},${Math.round(pos.acc)}`;
      if (accKey !== lastSelfAccKey) {
        lastSelfAccKey = accKey;
        setData('acc', fc([circlePolygon(pos.lat, pos.lon, pos.acc)]));
      }
      const html = playerHtml(fake, { self: true, stale: false, showCone: true });
      if (!selfObj) {
        selfObj = { m: domMarker('mk-unit', html, [pos.lat, pos.lon]), key: html };
        selfObj.m.getElement().style.zIndex = '9';
      } else {
        selfObj.m.setLngLat([pos.lon, pos.lat]);
        setHtml(selfObj, html);
      }
      if (!centeredOnce) {
        centeredOnce = true;
        map.jumpTo({ center: [pos.lon, pos.lat], zoom: Math.max(map.getZoom(), 17) });
      } else if (s.settings.followMe) {
        map.easeTo({ center: [pos.lon, pos.lat], duration: 400 });
      }
    };

    // Draft (zone / route / ruler): line + draggable vertices + per-segment range/azimuth labels.
    let vertices: maplibregl.Marker[] = [];
    let segLabels: maplibregl.Marker[] = [];
    const syncDraft = () => {
      const { draft, tool } = store.getState();
      const polygon = tool === 'zone' && draft.length >= 3;
      const coords = draft.map(lngLat);
      setData(
        'draft',
        fc(
          draft.length < 2
            ? []
            : [{ type: 'Feature', properties: {}, geometry: polygon ? { type: 'Polygon', coordinates: [[...coords, coords[0]!]] } : { type: 'LineString', coordinates: coords } }],
        ),
      );
      // Vertices: reuse markers so a vertex being dragged is never recreated.
      while (vertices.length > draft.length) vertices.pop()!.remove();
      draft.forEach((p, i) => {
        let v = vertices[i];
        if (!v) {
          v = new maplibregl.Marker({ element: el('mk-vtx', vertexHtml(i === 0)), draggable: true }).setLngLat(lngLat(p)).addTo(map);
          const idx = i;
          v.on('drag', () => {
            const ll = v!.getLngLat();
            const d = [...store.getState().draft];
            d[idx] = [ll.lat, ll.lng];
            store.setState({ draft: d });
          });
          v.getElement().addEventListener('click', (e) => e.stopPropagation());
          vertices.push(v);
        } else v.setLngLat(lngLat(p));
      });
      segLabels.forEach((m) => m.remove());
      segLabels = [];
      if (tool !== 'measure') return;
      let total = 0;
      for (let i = 1; i < draft.length; i++) {
        const a = draft[i - 1]!;
        const b = draft[i]!;
        const d = distance(a, b);
        total += d;
        const mid: LL = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        segLabels.push(domMarker('seg-label', `<span>${fmtDist(d)} · ${fmtAz(bearing(a, b))}</span>`, mid));
      }
      if (draft.length > 2) segLabels.push(domMarker('seg-label total', `<span>Σ ${fmtDist(total)}</span>`, draft[draft.length - 1]!, { offset: [0, -26] }));
    };

    const syncPicked = () => {
      const p = store.getState().picked;
      if (!p) return void (pickedMarker?.remove(), (pickedMarker = null));
      if (!pickedMarker) {
        pickedMarker = domMarker('picked', '<svg viewBox="-20 -20 40 40"><path d="M0 -18V-6M0 6V18M-18 0H-6M6 0H18"/><circle r="4"/></svg>', [p.lat, p.lon]);
        pickedMarker.getElement().style.zIndex = '10';
      } else pickedMarker.setLngLat([p.lon, p.lat]);
    };

    // ---------- popups ----------
    const popup = new maplibregl.Popup({ className: 'tac-popup', closeButton: true, maxWidth: '300px', offset: 18 });
    const canEdit = () => {
      const s = store.getState().self;
      return !!s && isCommandRole(s.role);
    };
    const where = (lat: number, lon: number) => {
      const s = store.getState();
      const me = s.myPos;
      const rel = me ? ` · ${fmtDist(distance([me.lat, me.lon], [lat, lon]))} ${fmtAz(bearing([me.lat, me.lon], [lat, lon]))}` : '';
      return `<div class="pp-sub">${mgrs(lat, lon)}</div><div class="pp-sub pp-call">${esc(calloutText(callout(lat, lon, s.settings.gridStep, s.markers)))}${rel}</div>`;
    };

    function openPopup(at: LL, html: string, actions: Record<string, () => void>) {
      popup.setLngLat(lngLat(at)).setHTML(html).addTo(map);
      popup
        .getElement()
        ?.querySelectorAll<HTMLButtonElement>('[data-act]')
        .forEach((b) =>
          b.addEventListener('click', () => {
            actions[b.dataset.act!]?.();
            popup.remove();
          }),
        );
    }

    function markerPopup(id: string) {
      const m = store.getState().markers[id];
      if (!m) return;
      const self = store.getState().self;
      const mine = m.createdById === self?.id;
      const btn = (act: string, label: string) => `<button data-act="${act}">${label}</button>`;
      let btns = btn('ruler', 'RULER');
      if (m.kind === 'objective' && canEdit()) btns += btn('captured', 'CAPTURED') + btn('lost', 'LOST') + btn('active', 'ACTIVE');
      if (m.kind === 'contact') btns += btn('refresh', 'STILL THERE');
      // Same rule as the server: only the author or a commander removes a marker.
      if (mine || canEdit()) btns += btn('delete', m.kind === 'contact' ? 'CLEAR' : 'DELETE');
      const upsert = (patch: Partial<Marker>) => {
        // Re-read at click time: the popup may have been open while someone else edited the marker.
        const cur = store.getState().markers[id];
        if (!cur) return;
        const { createdBy: _a, createdById: _b, createdAt: _c, updatedAt: _d, expiresAt: _e, ...input } = { ...cur, ...patch };
        socket.send({ t: 'marker.upsert', marker: input });
      };
      openPopup(
        [m.lat, m.lon],
        `<b>${m.kind === 'trp' ? 'TRP' : m.kind.toUpperCase()} ${esc(m.label)}</b>${where(m.lat, m.lon)}
         <div class="pp-sub">by ${esc(m.createdBy)} · ${new Date(m.createdAt).toLocaleTimeString()}</div>${m.note ? `<div>${esc(m.note)}</div>` : ''}
         <div class="pp-actions">${btns}</div>`,
        {
          ruler: () => startRulerFrom([m.lat, m.lon]),
          captured: () => upsert({ status: 'captured' }),
          lost: () => upsert({ status: 'lost' }),
          active: () => upsert({ status: 'active' }),
          refresh: () => upsert({}),
          delete: () => socket.send({ t: 'marker.delete', id: m.id }),
        },
      );
    }

    function playerPopup(id: string) {
      const p = store.getState().players[id];
      if (!p || p.lat == null || p.lon == null) return;
      openPopup(
        [p.lat, p.lon],
        `<b style="color:${SQUAD_META[p.squad].color}">${esc(p.callsign)}</b> · ${p.role.toUpperCase()} · ${SQUAD_META[p.squad].label}
         ${where(p.lat, p.lon)}
         <div class="pp-sub">±${p.acc}m${p.bat != null ? ` · BAT ${p.bat}%` : ''} · ${p.status.toUpperCase()} · fix ${new Date(p.ts).toLocaleTimeString()}</div>`,
        {},
      );
    }

    function objectPopup(at: LL, type: 'zone' | 'route', id: string) {
      const s = store.getState();
      const title =
        type === 'zone'
          ? `${s.zones[id]?.kind.toUpperCase()} ZONE ${s.zones[id]?.name ? `“${esc(s.zones[id]!.name)}”` : ''}`
          : `ROUTE ${esc(s.routes[id]?.label || '')} · ${s.routes[id] ? SQUAD_META[s.routes[id]!.squad].label : ''}`;
      openPopup(at, `<b>${title}</b><div class="pp-actions">${canEdit() ? '<button data-act="delete">DELETE</button>' : ''}</div>`, {
        delete: () => socket.send(type === 'zone' ? { t: 'zone.delete', id } : { t: 'route.delete', id }),
      });
    }

    function startRulerFrom(p: LL) {
      store.getState().setTool('measure');
      store.setState({ draft: [p] });
    }

    // ---------- input ----------
    let lastPick = 0;
    const pickPoint = (lat: number, lon: number) => {
      if (Date.now() - lastPick < 800 || store.getState().tool !== 'pan') return;
      lastPick = Date.now();
      store.setState({ picked: { lat, lon } });
      store.getState().setDrawer({ open: 'mid', tab: 'spot' });
      navigator.vibrate?.(20);
    };

    map.on('click', (e) => {
      if (Date.now() - lastPick < 800) return; // the click that ends a long-press
      const s = store.getState();
      const pt: LL = [e.lngLat.lat, e.lngLat.lng];
      switch (s.tool) {
        case 'zone':
        case 'route':
          store.setState({ draft: [...s.draft, pt] });
          return;
        case 'measure': {
          const me = s.myPos;
          const start: LL[] = !s.draft.length && s.settings.rulerFromMe && me ? [[me.lat, me.lon]] : [];
          store.setState({ draft: [...s.draft, ...start, pt] });
          return;
        }
        case 'contact':
          store.setState({ picked: { lat: pt[0], lon: pt[1] } });
          s.setDrawer({ open: 'mid', tab: 'spot' });
          return;
        case 'trp': {
          const used = new Set(Object.values(s.markers).filter((m) => m.kind === 'trp').map((m) => m.label.toUpperCase()));
          const suggestion = TRP_NAMES.find((n) => !used.has(n)) ?? `TRP-${used.size + 1}`;
          setLabelPrompt({
            kind: 'trp',
            pt,
            value: suggestion,
            title: 'Кодовое имя ориентира (TRP)',
            placeholder: 'Например: ОРЕЛ',
          });
          return;
        }
        case 'objective':
        case 'waypoint': {
          setLabelPrompt({
            kind: s.tool,
            pt,
            value: '',
            title: s.tool === 'objective' ? 'Название цели (например: АЛЬФА)' : 'Название точки',
            placeholder: s.tool === 'objective' ? 'АЛЬФА' : 'ТОЧКА-1',
          });
          return;
        }
        default: {
          if (s.picked) store.setState({ picked: null });
          const box: [maplibregl.PointLike, maplibregl.PointLike] = [
            [e.point.x - 8, e.point.y - 8],
            [e.point.x + 8, e.point.y + 8],
          ];
          const hit = map.queryRenderedFeatures(box, { layers: ['routes-line', 'zones-fill'].filter((l) => map.getLayer(l)) })[0];
          if (hit) objectPopup(pt, hit.layer.id === 'routes-line' ? 'route' : 'zone', String(hit.properties.id));
        }
      }
    });
    // Right-click (desktop) / long-press (touch): pick a point for a spot report.
    map.on('contextmenu', (e) => pickPoint(e.lngLat.lat, e.lngLat.lng));
    let pressTimer = 0;
    let pressAt: { x: number; y: number } | null = null;
    const cancelPress = () => (clearTimeout(pressTimer), (pressAt = null));
    map.on('touchstart', (e) => {
      cancelPress();
      if (e.points.length !== 1) return;
      pressAt = { x: e.point.x, y: e.point.y };
      const ll = e.lngLat;
      pressTimer = window.setTimeout(() => pickPoint(ll.lat, ll.lng), LONG_PRESS_MS);
    });
    map.on('touchmove', (e) => {
      if (pressAt && (e.points.length !== 1 || Math.hypot(e.point.x - pressAt.x, e.point.y - pressAt.y) > 10)) cancelPress();
    });
    map.on('touchend', cancelPress);
    map.on('touchcancel', cancelPress);
    map.on('dragstart', () => {
      if (store.getState().settings.followMe) store.getState().setSettings({ followMe: false });
    });

    // Camera → store (crosshair readout, north arrow) throttled during pan so React doesn't re-render at 60fps.
    let raf = 0;
    let lastViewTs = 0;
    let lastBrg = -999;
    const publishView = (force = false) => {
      raf = 0;
      const b = map.getBearing();
      if (Math.abs(b - lastBrg) > 0.3) {
        lastBrg = b;
        container.style.setProperty('--map-brg', `${b}deg`);
      }
      const now = performance.now();
      if (!force && now - lastViewTs < 120) return;
      lastViewTs = now;
      const c = map.getCenter();
      store.setState({ view: { lat: c.lat, lon: c.lng, zoom: map.getZoom(), bearing: b, pitch: map.getPitch() } });
    };
    map.on('move', () => (raf ||= requestAnimationFrame(() => publishView(false))));
    map.on('moveend', () => {
      publishView(true);
      updateGrid();
    });
    publishView(true);

    // ---------- subscriptions ----------
    syncZones(s0.zones);
    syncRoutes(s0.routes);
    syncMarkers(s0.markers);
    syncPlayers(s0.players);
    syncSelf();

    const unsub = store.subscribe((s, p) => {
      if (s.settings.baseLayer !== p.settings.baseLayer) setBase(s.settings.baseLayer);
      if (s.settings.grid !== p.settings.grid) setGridVisible(s.settings.grid);
      if (s.settings.gridStep !== p.settings.gridStep) updateGrid();
      if (s.zones !== p.zones) syncZones(s.zones);
      if (s.routes !== p.routes) syncRoutes(s.routes);
      if (s.markers !== p.markers) syncMarkers(s.markers);
      if (s.players !== p.players) syncPlayers(s.players);
      if (s.myPos !== p.myPos || s.compass !== p.compass) syncSelf();
      if (s.draft !== p.draft || s.tool !== p.tool) syncDraft();
      if (s.picked !== p.picked) syncPicked();
      if (s.settings.followMe && !p.settings.followMe && s.myPos) map.easeTo({ center: [s.myPos.lon, s.myPos.lat], duration: 400 });
    });
    // Age labels / TTL fade / stale players.
    const ticker = window.setInterval(() => {
      const s = store.getState();
      syncMarkers(s.markers);
      syncPlayers(s.players);
    }, 15_000);

    mapRef.current = {
      flyTo: (lat, lon, zoom = 18) => map.flyTo({ center: [lon, lat] as LngLatLike, zoom }),
      resetNorth: () => map.easeTo({ bearing: 0, pitch: 0, duration: 400 }),
      bounds: () => {
        const b = map.getBounds();
        return { west: b.getWest(), south: b.getSouth(), east: b.getEast(), north: b.getNorth(), zoom: map.getZoom() };
      },
    };
    const ro = new ResizeObserver(() => map.resize());
    ro.observe(container);

    return () => {
      unsub();
      clearInterval(ticker);
      cancelPress();
      cancelAnimationFrame(raf);
      ro.disconnect();
      mapRef.current = null;
      map.remove();
    };
  }, []);

  function submitLabelPrompt(e: React.FormEvent) {
    e.preventDefault();
    if (!labelPrompt) return;
    const s = useStore.getState();
    const label = labelPrompt.value.trim().toUpperCase().slice(0, 40);
    if (labelPrompt.kind === 'trp') {
      if (!label) return;
      const used = new Set(Object.values(s.markers).filter((m) => m.kind === 'trp').map((m) => m.label.toUpperCase()));
      if (used.has(label)) {
        s.toast(`Ориентир «${label}» уже существует`, 'error');
        return;
      }
      socket.send({ t: 'marker.upsert', marker: { kind: 'trp', label, lat: labelPrompt.pt[0], lon: labelPrompt.pt[1], status: 'active' } });
    } else {
      socket.send({
        t: 'marker.upsert',
        marker: { kind: labelPrompt.kind, label, lat: labelPrompt.pt[0], lon: labelPrompt.pt[1], status: 'active' },
      });
      s.setTool('pan');
    }
    setLabelPrompt(null);
  }

  return (
    <>
      <div ref={host} className="map" />
      {labelPrompt && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 60,
            background: 'rgba(0,0,0,0.65)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 16,
          }}
          onClick={() => setLabelPrompt(null)}
        >
          <form
            onSubmit={submitLabelPrompt}
            onClick={(e) => e.stopPropagation()}
            style={{
              width: '100%',
              maxWidth: 340,
              background: '#131815',
              border: '1px solid #2b362f',
              borderRadius: 10,
              padding: 16,
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
            }}
          >
            <div style={{ fontWeight: 700, fontSize: 14, color: '#e5ebe6' }}>{labelPrompt.title}</div>
            <input
              autoFocus
              value={labelPrompt.value}
              placeholder={labelPrompt.placeholder}
              maxLength={40}
              onChange={(e) => setLabelPrompt({ ...labelPrompt, value: e.target.value })}
            />
            <div className="row">
              <button type="submit" className="ok wide">
                СОЗДАТЬ
              </button>
              <button type="button" className="wide" onClick={() => setLabelPrompt(null)}>
                ОТМЕНА
              </button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}
