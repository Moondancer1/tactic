import { useState } from 'react';
import { ROLES, ROLE_META, SQUADS, SQUAD_META, isCommandRole, type Role, type Squad } from '@tactic/shared';
import { api, defaultServer, normalizeServer, type Session } from '../lib/api';
import { isNative } from '../lib/native';
import { requestCompassPermission } from '../lib/tracking';

const LAST_KEY = 'tactic.lastJoin';

export function Login({ onJoined }: { onJoined: (s: Session) => void }) {
  const last = JSON.parse(localStorage.getItem(LAST_KEY) || '{}');
  const [server, setServer] = useState(defaultServer());
  const [code, setCode] = useState<string>(last.code ?? '');
  const [callsign, setCallsign] = useState<string>(last.callsign ?? '');
  const [squad, setSquad] = useState<Squad>(last.squad ?? 'alpha');
  const [role, setRole] = useState<Role>(last.role ?? 'rifleman');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [hq, setHq] = useState(false);
  const needsPin = isCommandRole(role) || squad === 'command';

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    const srv = normalizeServer(server);
    try {
      await requestCompassPermission();
      const res = await api.join(srv, { code, callsign, squad, role, pin: needsPin ? pin : undefined });
      localStorage.setItem(LAST_KEY, JSON.stringify({ code, callsign, squad, role }));
      onJoined({ ...res, server: srv });
    } catch (err) {
      setError((err as Error).message || 'Join failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <form className="login-card" onSubmit={submit}>
        <h1>
          <span className="brand">TACTIC</span> <small>C2 / RADIO</small>
        </h1>

        {(isNative() || server !== window.location.origin) && (
          <label>
            Server
            <input value={server} onChange={(e) => setServer(e.target.value)} placeholder="https://tactic.example.com" inputMode="url" autoCapitalize="off" required />
          </label>
        )}

        <label>
          Match code
          <input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="ABC123" maxLength={12} autoCapitalize="characters" required />
        </label>

        <label>
          Callsign
          <input value={callsign} onChange={(e) => setCallsign(e.target.value.toUpperCase())} placeholder="VIPER-1" maxLength={16} autoCapitalize="characters" required />
        </label>

        <div className="field">
          <span>Squad</span>
          <div className="seg">
            {SQUADS.map((s) => (
              <button type="button" key={s} className={s === squad ? 'on' : ''} style={{ ['--c' as string]: SQUAD_META[s].color }} onClick={() => setSquad(s)}>
                {SQUAD_META[s].short}
              </button>
            ))}
          </div>
        </div>

        <label>
          Role
          <select value={role} onChange={(e) => setRole(e.target.value as Role)}>
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {ROLE_META[r].label}
              </option>
            ))}
          </select>
        </label>

        {needsPin && (
          <label>
            Command PIN
            <input type="password" value={pin} onChange={(e) => setPin(e.target.value)} inputMode="numeric" required />
          </label>
        )}

        {error && <div className="err">{error}</div>}
        <button className="primary" disabled={busy}>
          {busy ? 'JOINING…' : 'JOIN NET'}
        </button>

        <button type="button" className="link" onClick={() => setHq(!hq)}>
          {hq ? 'Hide HQ setup' : 'HQ: create a match'}
        </button>
        {hq && <CreateMatch server={normalizeServer(server)} onCreated={(c) => setCode(c)} />}
      </form>
    </div>
  );
}

function CreateMatch({ server, onCreated }: { server: string; onCreated: (code: string) => void }) {
  const [admin, setAdmin] = useState('');
  const [name, setName] = useState('');
  const [pin, setPin] = useState('');
  const [msg, setMsg] = useState('');

  async function create() {
    setMsg('');
    try {
      const m = await api.createMatch(server, admin, { name, commandPin: pin });
      setMsg(`Created "${m.name}" — code ${m.code}`);
      onCreated(m.code);
    } catch (e) {
      setMsg((e as Error).message);
    }
  }

  return (
    <div className="hq">
      <input type="password" placeholder="Admin token" value={admin} onChange={(e) => setAdmin(e.target.value)} />
      <input placeholder="Match name (Op. Nightfall — BLUFOR)" value={name} onChange={(e) => setName(e.target.value)} />
      <input placeholder="Command PIN (4+)" value={pin} onChange={(e) => setPin(e.target.value)} />
      <button type="button" onClick={create} disabled={!admin || !name || pin.length < 4}>
        CREATE MATCH
      </button>
      {msg && <div className="note">{msg}</div>}
    </div>
  );
}
