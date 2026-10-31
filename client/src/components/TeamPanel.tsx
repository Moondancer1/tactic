import { useMemo } from 'react';
import { PLAYER_STATUSES, ROLE_META, SQUADS, SQUAD_META, type PlayerStatus } from '@tactic/shared';
import { useStore } from '../store';
import { socket } from '../lib/socket';
import { ago, bearing, cardinal, distance, fmtDist } from '../lib/geo';

const STATUS_LABEL: Record<PlayerStatus, string> = { ok: 'OK', hit: 'HIT', medic: 'MEDIC', out: 'OUT' };

export function TeamPanel() {
  const players = useStore((s) => s.players);
  const self = useStore((s) => s.self);
  const myPos = useStore((s) => s.myPos);
  const skew = useStore((s) => s.clockSkew);
  const me = self ? players[self.id] : undefined;

  const bySquad = useMemo(() => {
    const groups = SQUADS.map((sq) => ({ sq, list: Object.values(players).filter((p) => p.squad === sq) }));
    for (const g of groups) g.list.sort((a, b) => Number(b.online) - Number(a.online) || a.callsign.localeCompare(b.callsign));
    return groups.filter((g) => g.list.length);
  }, [players]);

  const now = Date.now() + skew;
  const fly = (lat: number, lon: number) =>
    (window as unknown as { __map?: { flyTo: (ll: [number, number], z: number) => void } }).__map?.flyTo([lat, lon], 18);

  return (
    <div className="team">
      <div className="row status-row">
        <span>MY STATUS</span>
        <div className="seg small">
          {PLAYER_STATUSES.map((s) => (
            <button key={s} className={`${me?.status === s ? 'on' : ''} s-${s}`} onClick={() => socket.send({ t: 'status', status: s })}>
              {STATUS_LABEL[s]}
            </button>
          ))}
        </div>
      </div>
      {bySquad.map(({ sq, list }) => (
        <div key={sq} className="squad">
          <h4 style={{ color: SQUAD_META[sq].color }}>
            {SQUAD_META[sq].label.toUpperCase()} <small>{list.filter((p) => p.online).length}/{list.length}</small>
          </h4>
          {list.map((p) => {
            const stale = !p.online || now - p.ts > 45_000;
            const rel =
              myPos && p.lat != null && p.lon != null && p.id !== self?.id
                ? `${fmtDist(distance([myPos.lat, myPos.lon], [p.lat, p.lon]))} ${cardinal(bearing([myPos.lat, myPos.lon], [p.lat, p.lon]))}`
                : '';
            return (
              <div key={p.id} className={`member ${stale ? 'stale' : ''} st-${p.status}`} onClick={() => p.lat != null && fly(p.lat, p.lon!)}>
                <span className={`dot ${p.online ? 'ok' : 'bad'}`} />
                <b>{p.callsign}</b>
                <span className="role">{ROLE_META[p.role].short}</span>
                {p.status !== 'ok' && <span className="stat">{STATUS_LABEL[p.status]}</span>}
                <span className="spacer" />
                <span className="rel">{rel}</span>
                {p.bat != null && <span className={`bat ${p.bat < 20 ? 'low' : ''}`}>{p.bat}%</span>}
                <span className="age">{p.ts ? ago(p.ts, now) : '—'}</span>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
