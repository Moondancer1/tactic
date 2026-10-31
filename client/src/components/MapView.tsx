// Imperative Leaflet map synced from the zustand store (no React re-render per GPS tick).
import { useEffect, useRef } from 'react';
import L from 'leaflet';
import { SQUAD_META, isCommandRole, type Marker, type PlayerState, type Route, type Zone } from '@tactic/shared';
import { useStore, type BaseLayer } from '../store';
import { BASE_LAYERS, CachedTileLayer } from '../lib/tiles';
import { arrowHtml, contactHtml, esc, objectiveHtml, playerHtml, pointHtml } from '../lib/symbols';
import { bearing, distance, fmtDist, mgrs } from '../lib/geo';
import { socket } from '../lib/socket';

const STALE_MS = 45_000;
const DEFAULT_VIEW: [number, number] = [55.751, 37.618];

const ZONE_STYLE: Record<Zone['kind'], { color: string; pattern: string }> = {
  friendly: { color: '#3fa7ff', pattern: 'hatch-blue' },
  hostile: { color: '#ff5a4e', pattern: 'hatch-red' },
  neutral: { color: '#e5e7eb', pattern: 'hatch-white' },
  objective: { color: '#ffb000', pattern: 'hatch-amber' },
  restricted: { color: '#c084fc', pattern: 'cross-violet' },
};

/** Inject SVG <pattern> defs into Leaflet's overlay SVG so polygons can use fill="url(#id)". */
function ensurePatterns(svg: SVGSVGElement) {
  if (svg.querySelector('#hatch-red')) return;
  const ns = 'http://www.w3.org/2000/svg';
  const defs = document.createElementNS(ns, 'defs');
  const mk = (id: string, color: string, cross = false) =>
    `<pattern id="${id}" patternUnits="userSpaceOnUse" width="10" height="10" patternTransform="rotate(45)">
      <rect width="10" height="10" fill="${color}" fill-opacity="0.08"/>
      <line x1="0" y1="0" x2="0" y2="10" stroke="${color}" stroke-width="2.2" stroke-opacity="0.55"/>
      ${cross ? `<line x1="0" y1="5" x2="10" y2="5" stroke="${color}" stroke-width="2" stroke-opacity="0.45"/>` : ''}
    </pattern>`;
  defs.innerHTML =
    mk('hatch-red', '#ff5a4e') + mk('hatch-blue', '#3fa7ff') + mk('hatch-white', '#e5e7eb') + mk('hatch-amber', '#ffb000') + mk('cross-violet', '#c084fc', true);
  svg.prepend(defs);
}

export function MapView() {
  const el = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const store = useStore;
    const renderer = L.svg({ padding: 0.5 });
    const map = L.map(el.current!, {
      zoomControl: false,
      renderer,
      center: DEFAULT_VIEW,
      zoom: 16,
      maxZoom: 21,
      tapHold: true,
      attributionControl: true,
      worldCopyJump: false,
    } as L.MapOptions);
    map.attributionControl.setPrefix(false);
    L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(map);
    renderer.addTo(map);
    // The renderer container is created lazily; patterns go in once it exists.
    const withSvg = () => {
      const svg = map.getPanes().overlayPane.querySelector('svg');
      if (svg) ensurePatterns(svg as SVGSVGElement);
    };

    let base: L.TileLayer | null = null;
    let baseKey: BaseLayer | null = null;
    const setBase = (k: BaseLayer) => {
      if (k === baseKey) return;
      base?.remove();
      const src = BASE_LAYERS[k];
      base = new CachedTileLayer(src.url, {
        maxZoom: src.maxZoom,
        maxNativeZoom: src.maxNativeZoom,
        attribution: src.attribution,
        keepBuffer: 4,
        updateWhenIdle: true,
        crossOrigin: true,
      }).addTo(map);
      base.bringToBack();
      baseKey = k;
    };

    const zonesL = L.layerGroup().addTo(map);
    const routesL = L.layerGroup().addTo(map);
    const markersL = L.layerGroup().addTo(map);
    const playersL = L.layerGroup().addTo(map);
    const draftL = L.layerGroup().addTo(map);

    const zoneObjs = new Map<string, { layer: L.Polygon; v: number }>();
    const routeObjs = new Map<string, { layer: L.LayerGroup; v: number }>();
    const markerObjs = new Map<string, { layer: L.Marker; key: string }>();
    const playerObjs = new Map<string, { layer: L.Marker; key: string }>();
    let selfMarker: L.Marker | null = null;
    let selfKey = '';
    let accCircle: L.Circle | null = null;
    let pickedMarker: L.Marker | null = null;
    let centeredOnce = false;

    // ---------- sync ----------
    const syncZones = (zones: Record<string, Zone>) => {
      for (const [id, o] of zoneObjs) if (!zones[id]) (o.layer.remove(), zoneObjs.delete(id));
      for (const z of Object.values(zones)) {
        const o = zoneObjs.get(z.id);
        if (o?.v === z.updatedAt) continue;
        o?.layer.remove();
        const st = ZONE_STYLE[z.kind];
        const layer = L.polygon(z.points, {
          color: st.color,
          weight: 2.5,
          dashArray: z.kind === 'hostile' ? undefined : z.kind === 'restricted' ? '2 6' : '8 6',
          fillColor: `url(#${st.pattern})`,
          fillOpacity: 1,
          renderer,
        }).addTo(zonesL);
        if (z.name) layer.bindTooltip(esc(z.name.toUpperCase()), { permanent: true, direction: 'center', className: 'zone-label' });
        layer.on('click', (e) => objectPopup(e.latlng, 'zone', z.id, `${z.kind.toUpperCase()} ZONE ${z.name ? `“${esc(z.name)}”` : ''}`));
        zoneObjs.set(z.id, { layer, v: z.updatedAt });
        withSvg();
      }
    };

    const syncRoutes = (routes: Record<string, Route>) => {
      for (const [id, o] of routeObjs) if (!routes[id]) (o.layer.remove(), routeObjs.delete(id));
      for (const r of Object.values(routes)) {
        const o = routeObjs.get(r.id);
        if (o?.v === r.updatedAt) continue;
        o?.layer.remove();
        const color = SQUAD_META[r.squad].color;
        const g = L.layerGroup();
        L.polyline(r.points, { color: '#000', weight: 7, opacity: 0.45, renderer }).addTo(g);
        const line = L.polyline(r.points, { color, weight: 3.5, dashArray: '10 8', renderer }).addTo(g);
        line.on('click', (e) => objectPopup(e.latlng, 'route', r.id, `ROUTE ${esc(r.label || '')} · ${SQUAD_META[r.squad].label}`));
        // Chevron at each segment midpoint and an arrowhead at the end.
        for (let i = 1; i < r.points.length; i++) {
          const a = r.points[i - 1]!;
          const b = r.points[i]!;
          const ang = bearing(a, b);
          const isLast = i === r.points.length - 1;
          const at: [number, number] = isLast ? b : [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
          L.marker(at, {
            icon: L.divIcon({ className: 'route-arrow', html: arrowHtml(color, ang), iconSize: isLast ? [22, 22] : [14, 14] }),
            interactive: false,
            keyboard: false,
          }).addTo(g);
        }
        if (r.label) {
          L.marker(r.points[0]!, {
            icon: L.divIcon({ className: 'route-label', html: `<span style="border-color:${color}">${esc(r.label)}</span>`, iconSize: [0, 0] }),
            interactive: false,
          }).addTo(g);
        }
        g.addTo(routesL);
        routeObjs.set(r.id, { layer: g, v: r.updatedAt });
      }
    };

    const markerIcon = (m: Marker, now: number) => {
      if (m.kind === 'contact') return { html: contactHtml(m, now), size: [44, 44] as [number, number], cls: 'mk-contact' };
      if (m.kind === 'objective') return { html: objectiveHtml(m), size: [40, 40] as [number, number], cls: 'mk-obj' };
      return { html: pointHtml(m), size: [30, 30] as [number, number], cls: 'mk-point' };
    };

    const syncMarkers = (markers: Record<string, Marker>) => {
      const now = Date.now();
      for (const [id, o] of markerObjs) if (!markers[id]) (o.layer.remove(), markerObjs.delete(id));
      for (const m of Object.values(markers)) {
        const ic = markerIcon(m, now);
        const o = markerObjs.get(m.id);
        if (o && o.key === ic.html) {
          o.layer.setLatLng([m.lat, m.lon]);
          continue;
        }
        const icon = L.divIcon({ className: ic.cls, html: ic.html, iconSize: ic.size });
        if (o) {
          o.layer.setIcon(icon).setLatLng([m.lat, m.lon]);
          o.key = ic.html;
          continue;
        }
        const layer = L.marker([m.lat, m.lon], { icon, zIndexOffset: m.kind === 'contact' ? 500 : 100 }).addTo(markersL);
        layer.on('click', () => markerPopup(m.id));
        markerObjs.set(m.id, { layer, key: ic.html });
      }
    };

    const syncPlayers = (players: Record<string, PlayerState>) => {
      const s = store.getState();
      const now = Date.now() + s.clockSkew;
      for (const [id, o] of playerObjs) if (!players[id] || id === s.self?.id) (o.layer.remove(), playerObjs.delete(id));
      for (const p of Object.values(players)) {
        if (p.id === s.self?.id || p.lat == null || p.lon == null) continue;
        const stale = !p.online || now - p.ts > STALE_MS;
        const html = playerHtml(p, { self: false, stale, showCone: !stale });
        const o = playerObjs.get(p.id);
        if (o) {
          o.layer.setLatLng([p.lat, p.lon]);
          if (o.key !== html) (o.layer.setIcon(L.divIcon({ className: 'mk-unit', html, iconSize: [40, 40] })), (o.key = html));
          continue;
        }
        const layer = L.marker([p.lat, p.lon], { icon: L.divIcon({ className: 'mk-unit', html, iconSize: [40, 40] }), zIndexOffset: 1000 }).addTo(playersL);
        layer.on('click', () => playerPopup(p.id));
        playerObjs.set(p.id, { layer, key: html });
      }
    };

    const syncSelf = () => {
      const s = store.getState();
      const pos = s.myPos;
      if (!pos || !s.self) return;
      const me = s.players[s.self.id];
      const fake: PlayerState = {
        ...(me ?? { id: s.self.id, callsign: s.self.callsign, squad: s.self.squad, role: s.self.role, status: 'ok', online: true, bat: null }),
        lat: pos.lat,
        lon: pos.lon,
        acc: pos.acc,
        heading: pos.heading ?? s.compass,
        speed: pos.speed,
        ts: pos.ts,
      } as PlayerState;
      const html = playerHtml(fake, { self: true, stale: false, showCone: true });
      if (!selfMarker) {
        accCircle = L.circle([pos.lat, pos.lon], { radius: pos.acc, color: '#9bd35a', weight: 1, fillOpacity: 0.08, interactive: false, renderer }).addTo(playersL);
        selfMarker = L.marker([pos.lat, pos.lon], { icon: L.divIcon({ className: 'mk-unit', html, iconSize: [40, 40] }), zIndexOffset: 2000 }).addTo(playersL);
        selfKey = html;
      } else {
        selfMarker.setLatLng([pos.lat, pos.lon]);
        accCircle!.setLatLng([pos.lat, pos.lon]).setRadius(pos.acc);
        if (selfKey !== html) (selfMarker.setIcon(L.divIcon({ className: 'mk-unit', html, iconSize: [40, 40] })), (selfKey = html));
      }
      if (!centeredOnce) {
        centeredOnce = true;
        map.setView([pos.lat, pos.lon], Math.max(map.getZoom(), 17));
      } else if (s.settings.followMe) {
        map.panTo([pos.lat, pos.lon], { animate: true, duration: 0.4 });
      }
    };

    const syncDraft = () => {
      draftL.clearLayers();
      const { draft, tool } = store.getState();
      if (!draft.length) return;
      const style = { color: '#9bd35a', weight: 2, dashArray: '4 4', renderer };
      if (tool === 'zone' && draft.length >= 3) L.polygon(draft, { ...style, fillOpacity: 0.1 }).addTo(draftL);
      else L.polyline(draft, style).addTo(draftL);
      for (const p of draft) L.circleMarker(p, { radius: 5, color: '#9bd35a', fillOpacity: 1, renderer }).addTo(draftL);
      if (tool === 'measure' && draft.length >= 2) {
        let total = 0;
        for (let i = 1; i < draft.length; i++) total += distance(draft[i - 1]!, draft[i]!);
        const last = draft[draft.length - 1]!;
        const brg = bearing(draft[draft.length - 2]!, last);
        L.marker(last, {
          icon: L.divIcon({ className: 'measure-label', html: `<span>${fmtDist(total)} · ${Math.round(brg)}°</span>`, iconSize: [0, 0] }),
          interactive: false,
        }).addTo(draftL);
      }
    };

    const syncPicked = () => {
      const p = store.getState().picked;
      if (!p) return void (pickedMarker?.remove(), (pickedMarker = null));
      const icon = L.divIcon({ className: 'picked', html: '<svg viewBox="-20 -20 40 40"><path d="M0 -18V-6M0 6V18M-18 0H-6M6 0H18"/><circle r="4"/></svg>', iconSize: [40, 40] });
      if (!pickedMarker) pickedMarker = L.marker([p.lat, p.lon], { icon, interactive: false, zIndexOffset: 3000 }).addTo(map);
      else pickedMarker.setLatLng([p.lat, p.lon]);
    };

    // ---------- popups ----------
    const popup = L.popup({ className: 'tac-popup', closeButton: true, autoPanPadding: [20, 80] });
    const canEdit = () => {
      const s = store.getState().self;
      return !!s && isCommandRole(s.role);
    };

    function openPopup(at: L.LatLngExpression, html: string, actions: Record<string, () => void>) {
      popup.setLatLng(at).setContent(html).openOn(map);
      const node = popup.getElement();
      node?.querySelectorAll<HTMLButtonElement>('[data-act]').forEach((b) =>
        b.addEventListener('click', () => {
          actions[b.dataset.act!]?.();
          map.closePopup();
        }),
      );
    }

    function markerPopup(id: string) {
      const m = store.getState().markers[id];
      if (!m) return;
      const self = store.getState().self;
      const mine = m.createdById === self?.id;
      const btn = (act: string, label: string) => `<button data-act="${act}">${label}</button>`;
      let btns = '';
      if (m.kind === 'objective' && canEdit()) btns += btn('captured', 'CAPTURED') + btn('lost', 'LOST') + btn('active', 'ACTIVE');
      if (m.kind === 'contact') btns += btn('refresh', 'STILL THERE');
      if (mine || canEdit() || m.kind === 'contact') btns += btn('delete', m.kind === 'contact' ? 'CLEAR' : 'DELETE');
      const upsert = (patch: Partial<Marker>) => {
        const { createdBy: _a, createdById: _b, createdAt: _c, updatedAt: _d, expiresAt: _e, ...input } = { ...m, ...patch };
        socket.send({ t: 'marker.upsert', marker: input });
      };
      openPopup(
        [m.lat, m.lon],
        `<b>${m.kind.toUpperCase()} ${esc(m.label)}</b><div class="pp-sub">${mgrs(m.lat, m.lon)}</div>
         <div class="pp-sub">by ${esc(m.createdBy)} · ${new Date(m.createdAt).toLocaleTimeString()}</div>${m.note ? `<div>${esc(m.note)}</div>` : ''}
         <div class="pp-actions">${btns}</div>`,
        {
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
      const me = store.getState().myPos;
      const rel = me ? `${fmtDist(distance([me.lat, me.lon], [p.lat, p.lon]))} @ ${Math.round(bearing([me.lat, me.lon], [p.lat, p.lon]))}°` : '';
      openPopup(
        [p.lat, p.lon],
        `<b style="color:${SQUAD_META[p.squad].color}">${p.callsign}</b> · ${p.role.toUpperCase()} · ${SQUAD_META[p.squad].label}
         <div class="pp-sub">${mgrs(p.lat, p.lon)} ±${p.acc}m</div>
         <div class="pp-sub">${rel}${p.bat != null ? ` · 🔋${p.bat}%` : ''} · ${p.status.toUpperCase()}</div>
         <div class="pp-sub">fix ${new Date(p.ts).toLocaleTimeString()}</div>`,
        {},
      );
    }

    function objectPopup(at: L.LatLng, type: 'zone' | 'route', id: string, title: string) {
      if (store.getState().tool !== 'pan') return;
      openPopup(at, `<b>${title}</b><div class="pp-actions">${canEdit() ? '<button data-act="delete">DELETE</button>' : ''}</div>`, {
        delete: () => socket.send(type === 'zone' ? { t: 'zone.delete', id } : { t: 'route.delete', id }),
      });
    }

    // ---------- input ----------
    map.on('click', (e: L.LeafletMouseEvent) => {
      const s = store.getState();
      const pt: [number, number] = [e.latlng.lat, e.latlng.lng];
      switch (s.tool) {
        case 'zone':
        case 'route':
        case 'measure':
          store.setState({ draft: [...s.draft, pt] });
          return;
        case 'contact':
          store.setState({ picked: { lat: pt[0], lon: pt[1] } });
          s.setDrawer({ open: 'mid', tab: 'spot' });
          return;
        case 'objective':
        case 'waypoint': {
          const label = window.prompt(s.tool === 'objective' ? 'Objective name (e.g. ALPHA)' : 'Waypoint label', '');
          if (label === null) return;
          socket.send({ t: 'marker.upsert', marker: { kind: s.tool, label: label.toUpperCase().slice(0, 40), lat: pt[0], lon: pt[1], status: 'active' } });
          s.setTool('pan');
          return;
        }
        default:
          if (s.picked) store.setState({ picked: null });
      }
    });
    // Long-press (touch) / right-click: pick a point for a spot report.
    map.on('contextmenu', (e: L.LeafletMouseEvent) => {
      store.setState({ picked: { lat: e.latlng.lat, lon: e.latlng.lng } });
      store.getState().setDrawer({ open: 'mid', tab: 'spot' });
      navigator.vibrate?.(20);
    });
    map.on('dragstart', () => {
      if (store.getState().settings.followMe) store.getState().setSettings({ followMe: false });
    });

    // ---------- subscriptions ----------
    const s0 = store.getState();
    setBase(s0.settings.baseLayer);
    syncZones(s0.zones);
    syncRoutes(s0.routes);
    syncMarkers(s0.markers);
    syncPlayers(s0.players);
    syncSelf();

    const unsub = store.subscribe((s, p) => {
      if (s.settings.baseLayer !== p.settings.baseLayer) setBase(s.settings.baseLayer);
      if (s.zones !== p.zones) syncZones(s.zones);
      if (s.routes !== p.routes) syncRoutes(s.routes);
      if (s.markers !== p.markers) syncMarkers(s.markers);
      if (s.players !== p.players) syncPlayers(s.players);
      if (s.myPos !== p.myPos || s.compass !== p.compass) syncSelf();
      if (s.draft !== p.draft || s.tool !== p.tool) syncDraft();
      if (s.picked !== p.picked) syncPicked();
      if (s.settings.followMe && !p.settings.followMe && s.myPos) map.panTo([s.myPos.lat, s.myPos.lon]);
    });
    // Age labels / TTL fade / stale players.
    const ticker = window.setInterval(() => {
      const s = store.getState();
      syncMarkers(s.markers);
      syncPlayers(s.players);
    }, 15_000);
    (window as unknown as { __map?: L.Map }).__map = map;
    const ro = new ResizeObserver(() => map.invalidateSize());
    ro.observe(el.current!);

    return () => {
      unsub();
      clearInterval(ticker);
      ro.disconnect();
      map.remove();
    };
  }, []);

  return <div ref={el} className="map" />;
}
