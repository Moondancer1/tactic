import { useState } from 'react';
import { SQUADS, SQUAD_META, ZONE_KINDS, isCommandRole, type Squad, type ZoneKind } from '@tactic/shared';
import { useStore, type BaseLayer, type Tool } from '../store';
import { BASE_LAYERS } from '../lib/tiles';
import { socket } from '../lib/socket';

const LAYERS: BaseLayer[] = ['sat', 'osm', 'topo'];

export function ToolBar() {
  const tool = useStore((s) => s.tool);
  const setTool = useStore((s) => s.setTool);
  const draft = useStore((s) => s.draft);
  const self = useStore((s) => s.self);
  const settings = useStore((s) => s.settings);
  const setSettings = useStore((s) => s.setSettings);
  const [zoneKind, setZoneKind] = useState<ZoneKind>('hostile');
  const [routeSquad, setRouteSquad] = useState<Squad>(self?.squad === 'command' ? 'alpha' : (self?.squad ?? 'alpha'));
  const [label, setLabel] = useState('');
  const leader = !!self && isCommandRole(self.role);

  const tools: { id: Tool; icon: string; title: string; leader?: boolean }[] = [
    { id: 'contact', icon: '◆', title: 'Contact report (tap map)' },
    { id: 'measure', icon: '⟷', title: 'Measure distance / bearing' },
    { id: 'objective', icon: '◎', title: 'Objective', leader: true },
    { id: 'waypoint', icon: '◇', title: 'Waypoint', leader: true },
    { id: 'route', icon: '➚', title: 'Route arrow', leader: true },
    { id: 'zone', icon: '▧', title: 'Zone polygon', leader: true },
  ];

  function finish() {
    if (tool === 'zone' && draft.length >= 3) {
      socket.send({ t: 'zone.upsert', zone: { kind: zoneKind, name: label.trim(), points: draft } });
    } else if (tool === 'route' && draft.length >= 2) {
      socket.send({ t: 'route.upsert', route: { squad: routeSquad, label: label.trim(), points: draft } });
    }
    setLabel('');
    setTool('pan');
  }

  const drawing = tool === 'zone' || tool === 'route' || tool === 'measure';
  const nextLayer = LAYERS[(LAYERS.indexOf(settings.baseLayer) + 1) % LAYERS.length]!;

  return (
    <>
      <div className="toolbar">
        <button title="Base layer" onClick={() => setSettings({ baseLayer: nextLayer })}>
          {BASE_LAYERS[settings.baseLayer].label}
        </button>
        <button className={settings.followMe ? 'on' : ''} title="Follow my position" onClick={() => setSettings({ followMe: !settings.followMe })}>
          ⌖
        </button>
        <hr />
        {tools
          .filter((t) => !t.leader || leader)
          .map((t) => (
            <button key={t.id} title={t.title} className={tool === t.id ? 'on' : ''} onClick={() => setTool(tool === t.id ? 'pan' : t.id)}>
              {t.icon}
            </button>
          ))}
      </div>

      {tool !== 'pan' && (
        <div className="draftbar">
          <span className="hint">
            {tool === 'contact' && 'Tap the map where the enemy is'}
            {tool === 'objective' && 'Tap to place objective'}
            {tool === 'waypoint' && 'Tap to place waypoint'}
            {drawing && `Tap to add points (${draft.length})`}
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
              {SQUADS.map((s) => (
                <option key={s} value={s}>
                  {SQUAD_META[s].label}
                </option>
              ))}
            </select>
          )}
          {(tool === 'zone' || tool === 'route') && <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Label" maxLength={40} />}
          {drawing && (
            <button disabled={!draft.length} onClick={() => useStore.setState({ draft: draft.slice(0, -1) })}>
              UNDO
            </button>
          )}
          {(tool === 'zone' || tool === 'route') && (
            <button className="ok" disabled={draft.length < (tool === 'zone' ? 3 : 2)} onClick={finish}>
              DONE
            </button>
          )}
          <button onClick={() => setTool('pan')}>{tool === 'measure' ? 'CLOSE' : 'CANCEL'}</button>
        </div>
      )}
    </>
  );
}
