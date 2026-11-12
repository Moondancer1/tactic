// Right rail: layers sheet, north arrow (declination), grid toggle, follow-me. Centre crosshair readout.
import { useState } from 'react';
import { useStore } from '../store';
import { BASE_LAYERS, BASE_LAYER_IDS } from '../lib/tiles';
import { bearing, declination, distance, fmtAz, fmtDist, fmtSigned, gridConvergence, GRID_STEPS, mgrs } from '../lib/geo';
import { callout } from '../lib/callout';
import { mapRef } from '../lib/mapRef';
import { tracker } from '../lib/tracking';

export function MapControls() {
  const settings = useStore((s) => s.settings);
  const setSettings = useStore((s) => s.setSettings);
  const view = useStore((s) => s.view);
  const myPos = useStore((s) => s.myPos);
  const [sheet, setSheet] = useState(false);
  const brg = view?.bearing ?? 0;
  const decl = view ? declination(view.lat, view.lon) : null;

  return (
    <>
      <nav className="rail rail-right" aria-label="Map">
        <button className={sheet ? 'on' : ''} onClick={() => setSheet(!sheet)} title="Layers & grid">
          <span className="ic">▤</span>
          <small>{BASE_LAYERS[settings.baseLayer].label}</small>
        </button>
        <button className="north" onClick={() => mapRef.current?.resetNorth()} title="North up (tap). Red = true north.">
          <svg viewBox="-20 -20 40 40" style={{ transform: `rotate(${-brg}deg)` }}>
            <path d="M0 -17L6 0H-6Z" fill="#ff5a4e" />
            <path d="M0 17L6 0H-6Z" fill="#cfd8d1" />
            {decl != null && <path d={`M0 0L0 -15`} stroke="#3fa7ff" strokeWidth="2" transform={`rotate(${decl})`} />}
          </svg>
          <small>{decl != null ? `${decl >= 0 ? '+' : '−'}${Math.abs(decl).toFixed(1)}°` : 'N'}</small>
        </button>
        <button className={settings.grid ? 'on' : ''} onClick={() => setSettings({ grid: !settings.grid })} title="Tactical grid">
          <span className="ic">#</span>
          <small>{settings.grid ? `${settings.gridStep}m` : 'GRID'}</small>
        </button>
        <button
          className={settings.followMe ? 'on' : ''}
          onClick={() => {
            const nextFollow = !settings.followMe;
            setSettings({ followMe: nextFollow });
            tracker.forceFix();
            if (myPos) mapRef.current?.flyTo(myPos.lat, myPos.lon, 16);
          }}
          title="Моя позиция (центровать и отправить GPS)"
        >
          <span className="ic">◉</span>
          <small>ME</small>
        </button>
      </nav>
      {sheet && <LayersSheet onClose={() => setSheet(false)} />}
      {settings.crosshair && <Crosshair />}
    </>
  );
}

function LayersSheet({ onClose }: { onClose: () => void }) {
  const settings = useStore((s) => s.settings);
  const setSettings = useStore((s) => s.setSettings);
  const view = useStore((s) => s.view);
  const decl = view ? declination(view.lat, view.lon) : null;
  const conv = view ? gridConvergence(view.lat, view.lon) : null;

  return (
    <div className="sheet" role="dialog" aria-label="Layers">
      <div className="sheet-head">
        <b>MAP</b>
        <span className="spacer" />
        <button onClick={onClose}>✕</button>
      </div>
      <div className="layer-grid">
        {BASE_LAYER_IDS.map((k) => (
          <button key={k} className={`layer l-${k} ${settings.baseLayer === k ? 'on' : ''}`} onClick={() => setSettings({ baseLayer: k })}>
            <b>{BASE_LAYERS[k].label}</b>
            <small>{BASE_LAYERS[k].hint}</small>
          </button>
        ))}
      </div>
      <h4>GRID</h4>
      <div className="seg small">
        <button className={!settings.grid ? 'on' : ''} onClick={() => setSettings({ grid: false })}>
          OFF
        </button>
        {GRID_STEPS.map((st) => (
          <button key={st} className={settings.grid && settings.gridStep === st ? 'on' : ''} onClick={() => setSettings({ grid: true, gridStep: st })}>
            {st} m
          </button>
        ))}
      </div>
      <div className="note">
        Each 1 km square is split into cells: columns A, B, C… (Альфа, Браво, Чарли…) west→east, rows 1, 2, 3… north→south. Everyone on the
        team must use the same cell size.
      </div>
      <label className="check">
        <input type="checkbox" checked={settings.crosshair} onChange={(e) => setSettings({ crosshair: e.target.checked })} /> Centre crosshair with
        coordinates
      </label>
      {decl != null && conv != null && (
        <>
          <h4>NORTH</h4>
          <div className="kv2">
            <span>Magnetic declination</span>
            <b>{fmtSigned(decl)}</b>
            <span>Grid convergence</span>
            <b>{fmtSigned(conv)}</b>
          </div>
          <div className="note">Compass (magnetic) azimuth = true azimuth − declination. The ruler shows both.</div>
        </>
      )}
    </div>
  );
}

/** Fixed crosshair at the map centre: sector, MGRS, nearest TRP, range/azimuth from me. */
function Crosshair() {
  const view = useStore((s) => s.view);
  const myPos = useStore((s) => s.myPos);
  const step = useStore((s) => s.settings.gridStep);
  const markers = useStore((s) => s.markers);
  if (!view) return null;
  const c = callout(view.lat, view.lon, step, markers);
  const fromMe = myPos ? { d: distance([myPos.lat, myPos.lon], [view.lat, view.lon]), az: bearing([myPos.lat, myPos.lon], [view.lat, view.lon]) } : null;

  return (
    <>
      <div className="xhair" aria-hidden>
        <svg viewBox="-20 -20 40 40">
          <path d="M0 -18V-5M0 5V18M-18 0H-5M5 0H18" />
        </svg>
      </div>
      <div className="readout">
        <div>
          <b className="sec">{c.sector.short}</b> <span>{c.sector.name}</span>
          {c.sector.km && <span className="dim"> · кв {c.sector.km}</span>}
        </div>
        <div className="dim">{mgrs(view.lat, view.lon)}</div>
        {(fromMe || c.trp) && (
          <div>
            {fromMe && fromMe.d > 3 && (
              <span>
                ME → {fmtDist(fromMe.d)} {fmtAz(fromMe.az)}
              </span>
            )}
            {c.trp && (
              <span className="trp-ref">
                {' '}
                TRP {c.trp.label} {fmtDist(c.trp.dist)} {fmtAz(c.trp.az)}
              </span>
            )}
          </div>
        )}
      </div>
    </>
  );
}
