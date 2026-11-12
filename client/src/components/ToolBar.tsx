// Left rail: drawing / reporting tools, and the context bar of the active tool (incl. the ruler card).
import { useState } from 'react';
import { SQUADS, SQUAD_META, ZONE_KINDS, isCommandRole, type Squad, type ZoneKind } from '@tactic/shared';
import { useStore, type Tool } from '../store';
import { socket } from '../lib/socket';
import { bearing, declination, distance, fmtAz, fmtDist, fmtMils } from '../lib/geo';
import { callout, calloutText } from '../lib/callout';

const TOOLS: { id: Tool; icon: string; label: string; leader?: boolean }[] = [
  { id: 'measure', icon: '📏', label: 'RULER' },
  { id: 'contact', icon: '◆', label: 'ENEMY' },
  { id: 'trp', icon: '⌖', label: 'TRP', leader: true },
  { id: 'objective', icon: '◎', label: 'OBJ', leader: true },
  { id: 'waypoint', icon: '◇', label: 'WPT', leader: true },
  { id: 'route', icon: '➚', label: 'ROUTE', leader: true },
  { id: 'zone', icon: '▧', label: 'ZONE', leader: true },
];

export function ToolBar() {
  const tool = useStore((s) => s.tool);
  const setTool = useStore((s) => s.setTool);
  const self = useStore((s) => s.self);
  const leader = !!self && isCommandRole(self.role);

  return (
    <>
      <nav className="rail rail-left" aria-label="Tools">
        {TOOLS.filter((t) => !t.leader || leader).map((t) => (
          <button key={t.id} title={t.label} className={tool === t.id ? 'on' : ''} onClick={() => setTool(tool === t.id ? 'pan' : t.id)}>
            <span className="ic">{t.icon}</span>
            <small>{t.label}</small>
          </button>
        ))}
      </nav>
      {tool === 'measure' ? <RulerCard /> : tool !== 'pan' && <DraftBar />}
    </>
  );
}

function DraftBar() {
  const tool = useStore((s) => s.tool);
  const setTool = useStore((s) => s.setTool);
  const draft = useStore((s) => s.draft);
  const self = useStore((s) => s.self);
  const [zoneKind, setZoneKind] = useState<ZoneKind>('hostile');
  const [routeSquad, setRouteSquad] = useState<Squad>(self?.squad === 'command' || self?.squad === 'none' ? 'alpha' : (self?.squad ?? 'alpha'));
  const [label, setLabel] = useState('');
  const drawing = tool === 'zone' || tool === 'route';

  function finish() {
    if (tool === 'zone' && draft.length >= 3) socket.send({ t: 'zone.upsert', zone: { kind: zoneKind, name: label.trim(), points: draft } });
    else if (tool === 'route' && draft.length >= 2) socket.send({ t: 'route.upsert', route: { squad: routeSquad, label: label.trim(), points: draft } });
    setLabel('');
    setTool('pan');
  }

  return (
    <div className="draftbar">
      <span className="hint">
        {tool === 'contact' && 'Tap the map where the enemy is'}
        {tool === 'objective' && 'Tap to place objective'}
        {tool === 'waypoint' && 'Tap to place waypoint'}
        {tool === 'trp' && 'Tap a landmark (lone tree, tower, wreck, crossroads) to name it as a TRP'}
        {drawing && `Tap to add points (${draft.length}) · drag points to adjust`}
      </span>
      {tool === 'zone' && (
        <select value={zoneKind} onChange={(e) => setZoneKind(e.target.value as ZoneKind)}>
          {ZONE_KINDS.map((k) => (
            <option key={k}>{k}</option>
          ))}
        </select>
      )}
      {tool === 'route' && (
        <select value={routeSquad} onChange={(e) => setRouteSquad(e.target.value as Squad)} style={{ color: SQUAD_META[routeSquad].color }}>
          {SQUADS.filter((s) => s !== 'none').map((s) => (
            <option key={s} value={s}>
              {SQUAD_META[s].label}
            </option>
          ))}
        </select>
      )}
      {drawing && <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Label" maxLength={40} />}
      {drawing && (
        <button disabled={!draft.length} onClick={() => useStore.setState({ draft: draft.slice(0, -1) })}>
          UNDO
        </button>
      )}
      {drawing && (
        <button className="ok" disabled={draft.length < (tool === 'zone' ? 3 : 2)} onClick={finish}>
          DONE
        </button>
      )}
      <button onClick={() => setTool('pan')}>{tool === 'trp' ? 'DONE' : 'CANCEL'}</button>
    </div>
  );
}

/** Ruler: tap to add points, drag points to adjust; shows range, true / magnetic azimuth, mils, sector. */
function RulerCard() {
  const draft = useStore((s) => s.draft);
  const setTool = useStore((s) => s.setTool);
  const fromMe = useStore((s) => s.settings.rulerFromMe);
  const gridStep = useStore((s) => s.settings.gridStep);
  const markers = useStore((s) => s.markers);
  const myPos = useStore((s) => s.myPos);
  const setSettings = useStore((s) => s.setSettings);

  const n = draft.length;
  let total = 0;
  for (let i = 1; i < n; i++) total += distance(draft[i - 1]!, draft[i]!);
  const a = draft[n - 2];
  const b = draft[n - 1];
  const seg = a && b ? { d: distance(a, b), az: bearing(a, b), decl: declination(a[0], a[1]) } : null;

  return (
    <div className="ruler">
      {seg ? (
        <>
          <div className="r-main">
            <b className="r-dist">{fmtDist(seg.d)}</b>
            <span className="r-az">
              <b>{fmtAz(seg.az)}</b>
              <small>true</small>
            </span>
            <span className="r-az">
              <b>{fmtAz(seg.az - seg.decl)}</b>
              <small>compass</small>
            </span>
            <span className="r-az">
              <b>{fmtMils(seg.az - seg.decl)}</b>
              <small>mils</small>
            </span>
          </div>
          <div className="r-sub">
            {n > 2 && <span>Σ {fmtDist(total)} · </span>}
            <span>→ {calloutText(callout(b![0], b![1], gridStep, markers))}</span>
          </div>
        </>
      ) : (
        <div className="r-sub">
          {n === 1 ? 'Tap the second point' : fromMe && myPos ? 'Tap a point — range and azimuth from you' : 'Tap the first point'} · drag points to adjust
        </div>
      )}
      <div className="r-actions">
        <button className={fromMe ? 'on' : ''} onClick={() => setSettings({ rulerFromMe: !fromMe })} title="Start the ruler at my GPS position">
          FROM ME
        </button>
        <button disabled={!n} onClick={() => useStore.setState({ draft: draft.slice(0, -1) })}>
          UNDO
        </button>
        <button disabled={!n} onClick={() => useStore.setState({ draft: [] })}>
          CLEAR
        </button>
        <span className="spacer" />
        <button onClick={() => setTool('pan')}>✕</button>
      </div>
    </div>
  );
}
