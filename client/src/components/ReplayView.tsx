// Full-screen after-action replay on its own map: every member's movement over time with play / seek /
// speed controls. Used in-game by commanders (BRIEF tab) and by the admin for ended networks.
import { useEffect, useRef, useState } from 'react';
import maplibregl, { type GeoJSONSource } from 'maplibre-gl';
import type { MatchTracks } from '@tactic/shared';
import { useStore } from '../store';
import { BASE_LAYERS, LABEL_FONT, registerCacheProtocol, transformRequest } from '../lib/tiles';
import { frameAt, prepareReplay, type Replay } from '../lib/replay';
import { friendlyError } from '../lib/errors';

const SPEEDS = [10, 30, 60, 120] as const;
const TAILS = [
  { ms: 5 * 60_000, label: '5 мин' },
  { ms: 15 * 60_000, label: '15 мин' },
  { ms: Infinity, label: 'ВЕСЬ' },
] as const;

const fmtTime = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const fc = (features: GeoJSON.Feature[]): GeoJSON.FeatureCollection => ({ type: 'FeatureCollection', features });

export function ReplayView({ title, load, onClose }: { title: string; load: () => Promise<MatchTracks>; onClose: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const replayRef = useRef<Replay | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'empty' | 'error'>('loading');
  const [error, setError] = useState('');
  const [range, setRange] = useState<[number, number]>([0, 0]);
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(60);
  const [tail, setTail] = useState<number>(TAILS[1].ms);
  const tRef = useRef(0);

  // Map + data
  useEffect(() => {
    registerCacheProtocol();
    const st = useStore.getState();
    const map = new maplibregl.Map({
      container: host.current!,
      style: BASE_LAYERS[st.settings.baseLayer].style,
      center: [49.8671, 40.4093],
      zoom: 13,
      maxZoom: 20,
      maxPitch: 0,
      transformRequest,
      attributionControl: { compact: true },
      fadeDuration: 0,
      pixelRatio: Math.min(window.devicePixelRatio || 1, st.lite ? 1 : 2),
    });
    map.touchPitch.disable();
    mapRef.current = map;
    let cancelled = false;

    const install = () => {
      if (map.getSource('trails')) return;
      map.addSource('trails', { type: 'geojson', data: fc([]) });
      map.addSource('heads', { type: 'geojson', data: fc([]) });
      map.addLayer({ id: 'trails-casing', type: 'line', source: 'trails', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#000', 'line-width': 5, 'line-opacity': 0.5 } });
      map.addLayer({ id: 'trails', type: 'line', source: 'trails', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': ['get', 'color'], 'line-width': 2.5 } });
      map.addLayer({
        id: 'heads',
        type: 'circle',
        source: 'heads',
        paint: { 'circle-radius': 7, 'circle-color': ['get', 'color'], 'circle-stroke-color': '#000', 'circle-stroke-width': 2, 'circle-opacity': ['case', ['get', 'stale'], 0.4, 1] },
      });
      map.addLayer({
        id: 'heads-label',
        type: 'symbol',
        source: 'heads',
        layout: { 'text-field': ['get', 'cs'], 'text-font': LABEL_FONT, 'text-size': 11, 'text-anchor': 'top', 'text-offset': [0, 0.9], 'text-allow-overlap': true },
        paint: { 'text-color': '#fff', 'text-halo-color': '#000', 'text-halo-width': 1.6, 'text-opacity': ['case', ['get', 'stale'], 0.5, 1] },
      });
    };

    map.on('load', async () => {
      install();
      try {
        const r = prepareReplay(await load());
        if (cancelled) return;
        replayRef.current = r;
        if (!r.bounds) return setStatus('empty');
        setRange([r.t0, r.t1]);
        tRef.current = r.t0;
        setT(r.t0);
        map.fitBounds([r.bounds[0], r.bounds[1], r.bounds[2], r.bounds[3]], { padding: 60, maxZoom: 17, duration: 0 });
        setStatus('ready');
      } catch (e) {
        if (cancelled) return;
        setError(friendlyError(e, 'Не удалось загрузить треки'));
        setStatus('error');
      }
    });
    return () => {
      cancelled = true;
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // Draw the frame for the current time
  useEffect(() => {
    const map = mapRef.current;
    const r = replayRef.current;
    if (!map || !r || status !== 'ready') return;
    const f = frameAt(r, t, tail);
    (map.getSource('trails') as GeoJSONSource | undefined)?.setData(
      fc(f.trails.map((tr) => ({ type: 'Feature', properties: { color: tr.color }, geometry: { type: 'LineString', coordinates: tr.coords } }))),
    );
    (map.getSource('heads') as GeoJSONSource | undefined)?.setData(
      fc(f.heads.map((h) => ({ type: 'Feature', properties: { color: h.color, cs: h.callsign, stale: h.stale }, geometry: { type: 'Point', coordinates: [h.lon, h.lat] } }))),
    );
  }, [t, tail, status]);

  // Playback clock: real time × speed, redrawn at most ~15 times a second
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    let lastDraw = 0;
    const tick = (now: number) => {
      tRef.current = Math.min(range[1], tRef.current + (now - last) * speed);
      last = now;
      if (now - lastDraw > 66 || tRef.current >= range[1]) {
        lastDraw = now;
        setT(tRef.current);
      }
      if (tRef.current >= range[1]) return setPlaying(false);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, speed, range]);

  const seek = (v: number) => {
    tRef.current = v;
    setT(v);
  };
  const togglePlay = () => {
    if (!playing && tRef.current >= range[1]) seek(range[0]);
    setPlaying(!playing);
  };
  const members = replayRef.current?.members.length ?? 0;

  return (
    <div className="replay" role="dialog" aria-label="Разбор игры">
      <div ref={host} className="replay-map" />
      <div className="replay-top">
        <b>РАЗБОР: {title}</b>
        <span className="spacer" />
        <button className="small-btn" onClick={onClose}>
          ЗАКРЫТЬ
        </button>
      </div>
      <div className="replay-panel">
        {status === 'loading' && <div className="note">Загрузка треков…</div>}
        {status === 'error' && <div className="err">{error}</div>}
        {status === 'empty' && <div className="note">Треков пока нет: позиции пишутся раз в 10 секунд, пока бойцы в сети.</div>}
        {status === 'ready' && (
          <>
            <div className="row" style={{ margin: 0 }}>
              <button className={`small-btn ${playing ? 'on' : 'ok'}`} onClick={togglePlay}>
                {playing ? 'ПАУЗА' : 'СТАРТ'}
              </button>
              <b className="replay-time">{fmtTime(t)}</b>
              <span className="spacer" />
              <span className="note" style={{ margin: 0 }}>
                {members} бойц. · {fmtTime(range[0])}–{fmtTime(range[1])}
              </span>
            </div>
            <input
              type="range"
              className="replay-seek"
              min={range[0]}
              max={range[1]}
              step={1000}
              value={t}
              onChange={(e) => seek(Number(e.target.value))}
              aria-label="Время"
            />
            <div className="row" style={{ margin: 0, gap: 8, flexWrap: 'wrap' }}>
              <div className="seg small">
                {SPEEDS.map((v) => (
                  <button key={v} className={speed === v ? 'on' : ''} onClick={() => setSpeed(v)}>
                    ×{v}
                  </button>
                ))}
              </div>
              <div className="seg small">
                {TAILS.map((o) => (
                  <button key={o.label} className={tail === o.ms ? 'on' : ''} onClick={() => setTail(o.ms)}>
                    {o.label}
                  </button>
                ))}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
