import { useMemo, useState } from 'react';
import {
  PLAYER_STATUSES,
  ROLES,
  ROLE_META,
  SQUADS,
  SQUAD_META,
  isCommandRole,
  type PlayerStatus,
  type Role,
  type Squad,
} from '@tactic/shared';
import { useStore } from '../store';
import { socket } from '../lib/socket';
import { ago, bearing, cardinal, distance, fmtDist } from '../lib/geo';
import { mapRef } from '../lib/mapRef';

const STATUS_LABEL: Record<PlayerStatus, string> = { ok: 'OK', hit: 'HIT', medic: 'MEDIC', out: 'OUT' };
const ACTIVE_SQUADS = SQUADS.filter((s) => s !== 'none');

export function TeamPanel({ onLogout }: { onLogout: () => void }) {
  const players = useStore((s) => s.players);
  const self = useStore((s) => s.self);
  const myPos = useStore((s) => s.myPos);
  const skew = useStore((s) => s.clockSkew);
  const me = self ? players[self.id] : undefined;
  const [pinPrompt, setPinPrompt] = useState<{ squad: Squad; role: Role } | null>(null);
  const [pin, setPin] = useState('');
  const [filter, setFilter] = useState<'all' | 'online'>('all');

  const allPlayers = useMemo(() => Object.values(players), [players]);
  const onlineCount = useMemo(() => allPlayers.filter((p) => p.online).length, [allPlayers]);
  const totalCount = allPlayers.length;

  const bySquad = useMemo(() => {
    const filtered = filter === 'online' ? allPlayers.filter((p) => p.online) : allPlayers;
    const groups = SQUADS.map((sq) => ({ sq, list: filtered.filter((p) => p.squad === sq) }));
    for (const g of groups) g.list.sort((a, b) => Number(b.online) - Number(a.online) || a.callsign.localeCompare(b.callsign));
    return groups.filter((g) => g.list.length);
  }, [allPlayers, filter]);

  const setDrawer = useStore((s) => s.setDrawer);
  const now = Date.now() + skew;
  const fly = (lat: number, lon: number) => {
    mapRef.current?.flyTo(lat, lon, 16);
    if (window.innerWidth < 1024) setDrawer({ open: 'min' });
  };

  function changeSquadOrRole(nextSquad: Squad, nextRole: Role = self?.role ?? 'rifleman') {
    if (!self) return;
    const alreadyPrivileged = isCommandRole(self.role) || self.squad === 'command';
    if ((isCommandRole(nextRole) || nextSquad === 'command') && !alreadyPrivileged) {
      setPinPrompt({ squad: nextSquad, role: nextRole });
      return;
    }
    setPinPrompt(null);
    // If leaving squad while having leader role, reset role to rifleman
    const finalRole = nextSquad === 'none' && isCommandRole(nextRole) ? 'rifleman' : nextRole;
    socket.send({ t: 'squad.set', squad: nextSquad, role: finalRole });
  }

  function confirmPin() {
    if (!pinPrompt) return;
    socket.send({ t: 'squad.set', squad: pinPrompt.squad, role: pinPrompt.role, pin });
    setPin('');
    setPinPrompt(null);
  }

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

      {self && (
        <div className="squad-box">
          <div className="row" style={{ margin: '4px 0' }}>
            <span style={{ fontSize: '.78rem', color: 'var(--dim)' }}>ОТРЯД</span>
            <div className="seg small" style={{ flex: 1 }}>
              {ACTIVE_SQUADS.map((s) => (
                <button
                  key={s}
                  className={self.squad === s ? 'on' : ''}
                  style={{ ['--c' as string]: SQUAD_META[s].color }}
                  onClick={() => changeSquadOrRole(s, self.role)}
                >
                  {SQUAD_META[s].short}
                </button>
              ))}
            </div>
            {self.squad !== 'none' && (
              <button
                className="danger small-btn"
                onClick={() => changeSquadOrRole('none', self.role)}
                title="Выйти из текущего отряда"
              >
                ВЫЙТИ ИЗ ОТРЯДА
              </button>
            )}
          </div>

          <div className="row" style={{ margin: '4px 0' }}>
            <span style={{ fontSize: '.78rem', color: 'var(--dim)' }}>РОЛЬ</span>
            <select
              value={self.role}
              onChange={(e) => changeSquadOrRole(self.squad, e.target.value as Role)}
              style={{ flex: 1, minHeight: '34px', padding: '4px 8px', fontSize: '.82rem' }}
            >
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {ROLE_META[r].label} ({ROLE_META[r].short})
                </option>
              ))}
            </select>
          </div>

          {pinPrompt && (
            <div className="row" style={{ margin: '6px 0' }}>
              <input
                type="password"
                placeholder="PIN командира"
                value={pin}
                onChange={(e) => setPin(e.target.value)}
                style={{ flex: 1, minHeight: '36px', padding: '4px 8px' }}
              />
              <button className="ok small-btn" onClick={confirmPin}>
                ОК
              </button>
              <button className="small-btn" onClick={() => setPinPrompt(null)}>
                ✕
              </button>
            </div>
          )}
        </div>
      )}

      <div className="row" style={{ margin: '8px 0 4px' }}>
        <div className="seg small" style={{ width: '100%' }}>
          <button
            type="button"
            className={filter === 'online' ? 'on' : ''}
            style={{ ['--c' as string]: '#9bd35a' }}
            onClick={() => setFilter('online')}
          >
            В ОНЛАЙНЕ ({onlineCount})
          </button>
          <button
            type="button"
            className={filter === 'all' ? 'on' : ''}
            onClick={() => setFilter('all')}
          >
            ВСЕ ЗАШЕДШИЕ ({totalCount})
          </button>
        </div>
      </div>

      {bySquad.length === 0 && (
        <div className="note" style={{ padding: '8px 0' }}>
          {filter === 'online' ? 'Сейчас никого нет в онлайне.' : 'В этой сети пока нет бойцов.'}
        </div>
      )}

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
              <div
                key={p.id}
                className={`member ${stale ? 'stale' : ''} st-${p.status}`}
                style={{ cursor: p.lat != null ? 'pointer' : 'default' }}
                onClick={() => p.lat != null && fly(p.lat, p.lon!)}
              >
                <span className={`dot ${p.online ? 'ok' : 'bad'}`} />
                <b>{p.callsign}</b>
                <span className="role">{ROLE_META[p.role].short}</span>
                <span
                  className="role"
                  style={{
                    color: p.online ? '#9bd35a' : '#ff5a4e',
                    borderColor: p.online ? 'rgba(155, 211, 90, 0.4)' : 'rgba(255, 90, 78, 0.35)',
                  }}
                >
                  {p.online ? 'ОНЛАЙН' : 'ОФЛАЙН'}
                </span>
                {p.status !== 'ok' && <span className="stat">{STATUS_LABEL[p.status]}</span>}
                <span className="spacer" />
                {p.lat != null ? (
                  <>
                    <span className="rel">{rel}</span>
                    <button
                      type="button"
                      className="small-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        fly(p.lat!, p.lon!);
                      }}
                      title="Показать бойца на карте"
                    >
                      НА КАРТУ
                    </button>
                  </>
                ) : (
                  <span className="age" style={{ color: 'var(--warn)' }}>
                    НЕТ GPS
                  </span>
                )}
                {p.bat != null && <span className={`bat ${p.bat < 20 ? 'low' : ''}`}>{p.bat}%</span>}
                <span className="age">{p.ts ? ago(p.ts, now) : '—'}</span>
              </div>
            );
          })}
        </div>
      ))}

      <div className="row" style={{ marginTop: 16 }}>
        <button className="danger" style={{ width: '100%' }} onClick={onLogout}>
          ВЫЙТИ С СЕРВЕРА (АККАУНТ)
        </button>
      </div>
    </div>
  );
}
