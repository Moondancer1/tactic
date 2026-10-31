// Quick SALUTE-style spot report: what / how many / where -> contact marker + chat line.
import { useState } from 'react';
import { CONTACT_TYPES } from '@tactic/shared';
import { useStore } from '../store';
import { socket } from '../lib/socket';
import { bearing, cardinal, distance, fmtDist, mgrs } from '../lib/geo';

type ContactType = (typeof CONTACT_TYPES)[number];
const TYPE_LABEL: Record<ContactType, string> = {
  infantry: 'INFANTRY',
  sniper: 'SNIPER',
  mg: 'MG NEST',
  vehicle: 'VEHICLE',
  unknown: 'UNKNOWN',
};
const TTLS = [
  { s: 120, l: '2m' },
  { s: 300, l: '5m' },
  { s: 900, l: '15m' },
  { s: 0, l: '∞' },
];

export function SpotPanel() {
  const picked = useStore((s) => s.picked);
  const myPos = useStore((s) => s.myPos);
  const [type, setType] = useState<ContactType>('infantry');
  const [count, setCount] = useState(1);
  const [ttl, setTtl] = useState(300);
  const [moving, setMoving] = useState<'static' | 'moving'>('static');

  const where = picked ?? (myPos ? { lat: myPos.lat, lon: myPos.lon } : null);
  const rel =
    picked && myPos
      ? `${fmtDist(distance([myPos.lat, myPos.lon], [picked.lat, picked.lon]))} ${cardinal(bearing([myPos.lat, myPos.lon], [picked.lat, picked.lon]))} of me`
      : picked
        ? ''
        : 'at my position — long-press the map to mark elsewhere';

  function send() {
    if (!where) return;
    const label = `${count > 1 ? `${count}x ` : ''}${TYPE_LABEL[type]}`;
    socket.send({
      t: 'marker.upsert',
      marker: { kind: 'contact', contactType: type, count, label, lat: where.lat, lon: where.lon, ttlSec: ttl, status: 'active', note: moving.toUpperCase() },
    });
    socket.send({
      t: 'chat',
      channel: 'all',
      text: `CONTACT: ${label} ${moving.toUpperCase()} @ ${mgrs(where.lat, where.lon)}${rel && picked ? ` (${rel})` : ''}`,
      spot: where,
    });
    navigator.vibrate?.(40);
    useStore.setState({ picked: null });
    useStore.getState().setTool('pan');
    useStore.getState().toast('Spot report sent');
  }

  function quick(kind: 'medic' | 'danger', text: string) {
    if (!where) return;
    socket.send({ t: 'marker.upsert', marker: { kind, label: text, lat: where.lat, lon: where.lon, ttlSec: 900, status: 'active' } });
    socket.send({ t: 'chat', channel: 'all', text: `${text} @ ${mgrs(where.lat, where.lon)}`, spot: where });
    useStore.setState({ picked: null });
  }

  return (
    <div className="spot">
      <div className="where">
        {where ? (
          <>
            <b>{mgrs(where.lat, where.lon)}</b> <span>{rel}</span>
          </>
        ) : (
          'No position: long-press the map to pick a point'
        )}
      </div>
      <div className="grid-btns">
        {CONTACT_TYPES.map((t) => (
          <button key={t} className={type === t ? 'on' : ''} onClick={() => setType(t)}>
            {TYPE_LABEL[t]}
          </button>
        ))}
      </div>
      <div className="row">
        <span>COUNT</span>
        <button onClick={() => setCount(Math.max(1, count - 1))}>−</button>
        <b className="count">{count}</b>
        <button onClick={() => setCount(Math.min(99, count + 1))}>+</button>
        <span className="spacer" />
        <div className="seg small">
          {(['static', 'moving'] as const).map((m) => (
            <button key={m} className={moving === m ? 'on' : ''} onClick={() => setMoving(m)}>
              {m.toUpperCase()}
            </button>
          ))}
        </div>
      </div>
      <div className="row">
        <span>EXPIRES</span>
        <div className="seg small">
          {TTLS.map((t) => (
            <button key={t.s} className={ttl === t.s ? 'on' : ''} onClick={() => setTtl(t.s)}>
              {t.l}
            </button>
          ))}
        </div>
      </div>
      <button className="danger big" disabled={!where} onClick={send}>
        SEND CONTACT
      </button>
      <div className="row">
        <button className="wide" disabled={!where} onClick={() => quick('medic', 'MEDIC NEEDED')}>
          ✚ MEDIC
        </button>
        <button className="wide" disabled={!where} onClick={() => quick('danger', 'DANGER AREA')}>
          ⚠ DANGER
        </button>
      </div>
    </div>
  );
}
