import { useEffect, useState } from 'react';
import { ROLES, ROLE_META, SQUADS, SQUAD_META, type NetworkItem, type Role, type Squad } from '@tactic/shared';
import {
  LAST_KEY,
  api,
  defaultServer,
  discoverServerUrl,
  normalizeServer,
  saveCredentials,
  type AdminUserItem,
  type Session,
} from '../lib/api';
import { isNative } from '../lib/native';
import { friendlyError } from '../lib/errors';
import { requestCompassPermission } from '../lib/tracking';

const ADMIN_KEY = 'tactic.adminToken';

export function Login({
  onJoined,
  initialStep = 'auth',
}: {
  onJoined: (s: Session) => void;
  initialStep?: 'auth' | 'networks';
}) {
  const last = JSON.parse(localStorage.getItem(LAST_KEY) || '{}');
  const [server, setServer] = useState(defaultServer());
  const [showServer, setShowServer] = useState(isNative() && !defaultServer());
  const [callsign, setCallsign] = useState<string>(last.callsign ?? '');
  const [password, setPassword] = useState<string>(last.password ?? '');
  const [step, setStep] = useState<'auth' | 'networks'>(
    initialStep === 'networks' && last.callsign && last.password ? 'networks' : 'auth',
  );
  const [networks, setNetworks] = useState<NetworkItem[]>([]);
  const [pingMs, setPingMs] = useState<number | null>(null);
  const [pingOk, setPingOk] = useState<boolean | null>(null);
  const [selectedNetId, setSelectedNetId] = useState<string | null>(null);
  const [netPassInput, setNetPassInput] = useState<string>(last.matchPassword ?? '');
  const [manualOpen, setManualOpen] = useState(false);
  const [manualName, setManualName] = useState('');
  const [manualPass, setManualPass] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [adminOpen, setAdminOpen] = useState(false);

  // Auto-discover active server URL on Android APK (or when current server is empty / unreachable)
  useEffect(() => {
    if (!isNative() && window.location.protocol.startsWith('http')) return;
    let cancelled = false;
    void (async () => {
      const cur = normalizeServer(server);
      if (cur) {
        try {
          await api.health(cur);
          return; // Saved server is alive
        } catch {
          // Saved server URL is stale, discover latest
        }
      }
      const latest = await discoverServerUrl();
      if (!cancelled && latest) {
        setServer(latest);
        setShowServer(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function refreshNetworks(srvUrl = normalizeServer(server)) {
    if (!srvUrl) return;
    const t0 = performance.now();
    try {
      const res = await api.networks(srvUrl);
      const rtt = Math.max(1, Math.round(performance.now() - t0));
      setPingMs(rtt);
      setPingOk(true);
      setNetworks(res.networks);
    } catch {
      setPingOk(false);
      setPingMs(null);
    }
  }

  useEffect(() => {
    if (step !== 'networks') return;
    void refreshNetworks();
    const id = setInterval(() => void refreshNetworks(), 4000);
    return () => clearInterval(id);
  }, [step, server]);

  async function submitAuth(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    let srv = normalizeServer(server);
    try {
      await requestCompassPermission();
      const cs = callsign.trim().toUpperCase();
      if (!srv) {
        const latest = await discoverServerUrl();
        if (latest) {
          srv = latest;
          setServer(latest);
        }
      }
      const t0 = performance.now();
      let res;
      try {
        res = await api.verify(srv, { callsign: cs, password });
      } catch (firstErr) {
        const latest = await discoverServerUrl();
        if (latest && latest !== srv) {
          srv = latest;
          setServer(latest);
          res = await api.verify(srv, { callsign: cs, password });
        } else {
          throw firstErr;
        }
      }
      const rtt = Math.max(1, Math.round(performance.now() - t0));
      setPingMs(rtt);
      setPingOk(true);
      setCallsign(res.user.callsign);
      setNetworks(res.networks);
      saveCredentials(cs, password, last.matchId, last.matchPassword);
      setStep('networks');
    } catch (err) {
      setError(friendlyError(err, 'Ошибка авторизации'));
    } finally {
      setBusy(false);
    }
  }

  async function joinNetwork(opts: { matchId?: string; matchName?: string; matchPassword?: string }) {
    setBusy(true);
    setError('');
    const srv = normalizeServer(server);
    const cs = callsign.trim().toUpperCase();
    try {
      const res = await api.login(srv, {
        callsign: cs,
        password,
        matchId: opts.matchId,
        matchName: opts.matchName,
        matchPassword: opts.matchPassword,
      });
      saveCredentials(cs, password, res.match.id, opts.matchPassword);
      onJoined({ ...res, server: srv });
    } catch (err) {
      setError(friendlyError(err, 'Не удалось подключиться к сети'));
    } finally {
      setBusy(false);
    }
  }

  if (adminOpen) {
    return (
      <div className="login">
        <div className="login-card">
          <div className="row" style={{ margin: 0 }}>
            <h1 style={{ margin: 0 }}>
              <span className="brand">TACTIC</span> <small>АДМИН-ПАНЕЛЬ</small>
            </h1>
            <span className="spacer" />
            <button type="button" className="small-btn" onClick={() => setAdminOpen(false)}>
              ← НАЗАД
            </button>
          </div>
          <AdminPanel server={normalizeServer(server)} />
        </div>
      </div>
    );
  }

  if (step === 'networks') {
    return (
      <div className="login">
        <div className="login-card" style={{ gap: 12 }}>
          <div className="row" style={{ margin: 0 }}>
            <h1 style={{ margin: 0 }}>
              <span className="brand">TACTIC</span> <small>ВЫБОР СЕТИ</small>
            </h1>
            <span className="spacer" />
            <button
              type="button"
              className="small-btn"
              onClick={() => {
                setError('');
                setStep('auth');
              }}
            >
              ← {callsign}
            </button>
          </div>

          <div
            className="row"
            style={{
              margin: 0,
              padding: '8px 10px',
              background: '#0d120f',
              border: '1px solid var(--line)',
              borderRadius: 6,
              fontSize: 12,
            }}
          >
            <span className={`dot ${pingOk ? 'ok' : 'bad'}`} />
            <span>
              {pingOk
                ? `СЕРВЕР НА СВЯЗИ · ${pingMs ?? '—'} ms`
                : pingOk === false
                  ? 'СЕРВЕР НЕ ОТВЕЧАЕТ'
                  : 'ПРОВЕРКА СВЯЗИ…'}
            </span>
            <span className="spacer" />
            <button
              type="button"
              className="small-btn"
              onClick={() => void refreshNetworks()}
              title="Обновить список сетей"
            >
              ↻ ОБНОВИТЬ
            </button>
          </div>

          {error && <div className="err">{error}</div>}

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ fontSize: 11, color: 'var(--muted)', letterSpacing: '0.08em' }}>
              ДОСТУПНЫЕ СЕТИ В ЭФИРЕ ({networks.length})
            </span>

            {networks.length === 0 && (
              <div className="note" style={{ padding: '10px 0' }}>
                {pingOk === false
                  ? 'Нет ответа от сервера. Вы можете добавить сеть вручную ниже.'
                  : 'Активных сетей пока нет. Создайте сеть ниже.'}
              </div>
            )}

            <div style={{ maxHeight: 240, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 6 }}>
              {networks.map((net) => {
                const isSelected = selectedNetId === net.id;
                return (
                  <div
                    key={net.id}
                    style={{
                      border: `1px solid ${isSelected ? 'var(--acc)' : 'var(--line)'}`,
                      borderRadius: 6,
                      padding: '10px 12px',
                      background: isSelected ? 'rgba(155, 211, 90, 0.08)' : '#0f1411',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 8,
                    }}
                  >
                    <div
                      className="row"
                      style={{ margin: 0, cursor: 'pointer' }}
                      onClick={() => {
                        setError('');
                        if (!net.hasPassword) {
                          void joinNetwork({ matchId: net.id });
                        } else {
                          setSelectedNetId(isSelected ? null : net.id);
                          setNetPassInput('');
                        }
                      }}
                    >
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                        <b style={{ fontSize: 15, color: 'var(--fg)' }}>
                          {net.hasPassword ? '🔒 ' : '📡 '}
                          {net.name}
                        </b>
                        <span style={{ fontSize: 11, color: 'var(--muted)' }}>
                          Код: {net.code} · Бойцов: {net.onlineCount} онлайн (всего {net.memberCount})
                        </span>
                      </div>
                      <span className="spacer" />
                      <button
                        type="button"
                        className={net.hasPassword ? 'small-btn' : 'ok small-btn'}
                        disabled={busy}
                        onClick={(e) => {
                          e.stopPropagation();
                          setError('');
                          if (!net.hasPassword) {
                            void joinNetwork({ matchId: net.id });
                          } else {
                            setSelectedNetId(isSelected ? null : net.id);
                            setNetPassInput('');
                          }
                        }}
                      >
                        {net.hasPassword ? (isSelected ? 'СКРЫТЬ' : 'ПАРОЛЬ →') : 'ВОЙТИ →'}
                      </button>
                    </div>

                    {isSelected && net.hasPassword && (
                      <form
                        className="row"
                        style={{ margin: 0, gap: 6 }}
                        onSubmit={(e) => {
                          e.preventDefault();
                          void joinNetwork({ matchId: net.id, matchPassword: netPassInput });
                        }}
                      >
                        <input
                          type="password"
                          placeholder="Пароль сети…"
                          value={netPassInput}
                          onChange={(e) => setNetPassInput(e.target.value)}
                          autoFocus
                          required
                          style={{ flex: 1 }}
                        />
                        <button type="submit" className="ok" disabled={busy || !netPassInput.trim()}>
                          {busy ? '…' : 'ПОДКЛЮЧИТЬСЯ'}
                        </button>
                      </form>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          <div style={{ borderTop: '1px solid var(--line)', paddingTop: 10 }}>
            <button
              type="button"
              className="link"
              style={{ padding: 0, width: '100%', textAlign: 'left' }}
              onClick={() => {
                setManualOpen(!manualOpen);
                setError('');
              }}
            >
              {manualOpen ? '▼ Скрыть ручное подключение' : '+ Подключиться вручную / создать сеть с паролем'}
            </button>

            {manualOpen && (
              <form
                style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 10 }}
                onSubmit={(e) => {
                  e.preventDefault();
                  void joinNetwork({
                    matchName: manualName.trim(),
                    matchPassword: manualPass.trim() || undefined,
                  });
                }}
              >
                <label>
                  Название или код сети
                  <input
                    value={manualName}
                    onChange={(e) => setManualName(e.target.value)}
                    placeholder="Например: Op. Nightfall или SERVER"
                    maxLength={60}
                    required
                  />
                </label>
                <label>
                  Пароль сети (оставьте пустым для открытой)
                  <input
                    type="password"
                    value={manualPass}
                    onChange={(e) => setManualPass(e.target.value)}
                    placeholder="Пароль сети"
                    maxLength={64}
                  />
                </label>
                <button type="submit" className="primary" disabled={busy || !manualName.trim()}>
                  {busy ? 'ПОДКЛЮЧЕНИЕ…' : 'ПОДКЛЮЧИТЬСЯ / СОЗДАТЬ СЕТЬ'}
                </button>
              </form>
            )}
          </div>

          <button type="button" className="link" onClick={() => setAdminOpen(true)}>
            Админ-панель (управление бойцами и сетями)
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="login">
      <form className="login-card" onSubmit={submitAuth}>
        <h1>
          <span className="brand">TACTIC</span> <small>C2 / INTERCOM</small>
        </h1>

        {showServer ? (
          <label>
            Сервер
            <input
              value={server}
              onChange={(e) => setServer(e.target.value)}
              placeholder="https://tactic.example.com"
              inputMode="url"
              autoCapitalize="off"
              required
            />
          </label>
        ) : (
          <button type="button" className="link" style={{ alignSelf: 'flex-start', padding: 0 }} onClick={() => setShowServer(true)}>
            Сервер: {server} (изменить)
          </button>
        )}

        <label>
          Позывной (логин)
          <input
            value={callsign}
            onChange={(e) => setCallsign(e.target.value.toUpperCase())}
            placeholder="РУСЛАН / DEDSE"
            maxLength={16}
            autoCapitalize="characters"
            required
          />
        </label>

        <label>
          Пароль
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Пароль бойца"
            minLength={3}
            maxLength={64}
            required
          />
        </label>

        {error && <div className="err">{error}</div>}
        <button className="primary" disabled={busy}>
          {busy ? 'ПРОВЕРКА…' : 'ДАЛЕЕ → ВЫБОР СЕТИ'}
        </button>

        <button type="button" className="link" onClick={() => setAdminOpen(true)}>
          Админ-панель (управление бойцами)
        </button>
      </form>
    </div>
  );
}

function AdminPanel({ server }: { server: string }) {
  const savedToken = localStorage.getItem(ADMIN_KEY) || '';
  const [adminLogin, setAdminLogin] = useState(() => (savedToken.includes(':') ? savedToken.split(':')[0]! : ''));
  const [adminPass, setAdminPass] = useState(() => (savedToken.includes(':') ? savedToken.slice(savedToken.indexOf(':') + 1) : ''));
  const [authed, setAuthed] = useState(false);
  const [users, setUsers] = useState<AdminUserItem[]>([]);
  const [callsign, setCallsign] = useState('');
  const [password, setPassword] = useState('');
  const [squad, setSquad] = useState<Squad>('alpha');
  const [role, setRole] = useState<Role>('rifleman');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [matchName, setMatchName] = useState('');
  const [matchPin, setMatchPin] = useState('4321');
  const [matchPass, setMatchPass] = useState('');
  const [showMatch, setShowMatch] = useState(false);

  const currentToken = `${adminLogin.trim()}:${adminPass}`;

  async function loadUsers(tok = currentToken) {
    if (!tok || tok === ':') return;
    setErr('');
    try {
      const list = await api.adminListUsers(server, tok);
      setUsers(list);
      setAuthed(true);
      localStorage.setItem(ADMIN_KEY, tok);
    } catch (e) {
      setAuthed(false);
      setErr(friendlyError(e, 'Неверный логин или пароль администратора'));
    }
  }

  useEffect(() => {
    if (savedToken.includes(':')) void loadUsers(savedToken);
  }, []);

  async function saveUser(e: React.FormEvent) {
    e.preventDefault();
    setMsg('');
    setErr('');
    try {
      const cs = callsign.trim().toUpperCase();
      const res = await api.adminSaveUser(server, currentToken, {
        callsign: cs,
        password,
        squad,
        role,
      });
      setMsg(res.updated ? `Обновлён боец ${res.callsign}` : `Создан боец ${res.callsign}`);
      setCallsign('');
      setPassword('');
      await loadUsers();
    } catch (e) {
      setErr(friendlyError(e));
    }
  }

  async function removeUser(cs: string) {
    setMsg('');
    setErr('');
    try {
      await api.adminDeleteUser(server, currentToken, cs);
      setMsg(`Удалён боец ${cs}`);
      await loadUsers();
    } catch (e) {
      setErr(friendlyError(e));
    }
  }

  async function createMatch() {
    setMsg('');
    setErr('');
    try {
      const m = await api.createMatch(server, currentToken, {
        name: matchName,
        commandPin: matchPin,
        password: matchPass.trim() || undefined,
      });
      setMsg(`Создана сеть "${m.name}" (код ${m.code})`);
      setMatchName('');
      setMatchPass('');
    } catch (e) {
      setErr(friendlyError(e));
    }
  }

  if (!authed) {
    return (
      <form
        className="hq"
        onSubmit={(e) => {
          e.preventDefault();
          void loadUsers();
        }}
      >
        <label>
          Логин
          <input
            type="text"
            value={adminLogin}
            onChange={(e) => setAdminLogin(e.target.value)}
            autoCapitalize="off"
            autoComplete="username"
            required
          />
        </label>
        <label>
          Пароль
          <input
            type="password"
            value={adminPass}
            onChange={(e) => setAdminPass(e.target.value)}
            autoComplete="current-password"
            required
          />
        </label>
        {err && <div className="err">{err}</div>}
        <button type="submit" className="ok" disabled={!adminLogin.trim() || !adminPass}>
          ВОЙТИ В АДМИН-ПАНЕЛЬ
        </button>
      </form>
    );
  }

  return (
    <div className="hq">
      <form onSubmit={saveUser} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <h4 style={{ margin: '4px 0 0' }}>ДОБАВИТЬ / ОБНОВИТЬ БОЙЦА</h4>
        <label>
          Позывной (логин)
          <input
            value={callsign}
            onChange={(e) => setCallsign(e.target.value.toUpperCase())}
            placeholder="РУСЛАН / DEDSE / 4321"
            maxLength={16}
            autoCapitalize="characters"
            required
          />
        </label>
        <label>
          Пароль (мин. 3 символа)
          <input
            type="text"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Задайте пароль бойцу"
            minLength={3}
            maxLength={64}
            required
          />
        </label>
        <div className="field">
          <span>Отряд по умолчанию</span>
          <div className="seg small">
            {SQUADS.map((s) => (
              <button
                type="button"
                key={s}
                className={s === squad ? 'on' : ''}
                style={{ ['--c' as string]: SQUAD_META[s].color }}
                onClick={() => setSquad(s)}
              >
                {SQUAD_META[s].short}
              </button>
            ))}
          </div>
        </div>
        <label>
          Роль по умолчанию
          <select value={role} onChange={(e) => setRole(e.target.value as Role)}>
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {ROLE_META[r].label} ({ROLE_META[r].short})
              </option>
            ))}
          </select>
        </label>
        <button className="ok">+ СОХРАНИТЬ БОЙЦА</button>
      </form>

      {msg && <div className="note" style={{ color: 'var(--acc)' }}>{msg}</div>}
      {err && <div className="err">{err}</div>}

      <h4>АККАУНТЫ БОЙЦОВ ({users.length})</h4>
      <div style={{ maxHeight: 220, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 4 }}>
        {users.length === 0 && <div className="note">Аккаунтов пока нет. Добавьте бойцов выше.</div>}
        {users.map((u) => (
          <div key={u.id} className="member" style={{ padding: '6px 4px' }}>
            <b style={{ color: SQUAD_META[u.squad]?.color }}>{u.callsign}</b>
            <span className="role">{SQUAD_META[u.squad]?.short ?? u.squad}</span>
            <span className="role">{ROLE_META[u.role]?.short ?? u.role}</span>
            <span className="spacer" />
            <button
              type="button"
              className="small-btn"
              onClick={() => {
                setCallsign(u.callsign);
                setSquad(u.squad);
                setRole(u.role);
                setMsg(`Введите новый пароль для ${u.callsign} и нажмите Сохранить`);
              }}
              title="Изменить пароль / отряд"
            >
              ИЗМ.
            </button>
            <button type="button" className="danger small-btn" onClick={() => void removeUser(u.callsign)} title="Удалить аккаунт">
              ✕
            </button>
          </div>
        ))}
      </div>

      <div className="row" style={{ marginTop: 8 }}>
        <button type="button" className="link" onClick={() => setShowMatch(!showMatch)}>
          {showMatch ? 'Скрыть настройки матча' : 'Пересоздать / новый матч'}
        </button>
        <span className="spacer" />
        <button
          type="button"
          className="link"
          onClick={() => {
            localStorage.removeItem(ADMIN_KEY);
            setAdminLogin('');
            setAdminPass('');
            setAuthed(false);
          }}
        >
          Выйти из админ-панели
        </button>
      </div>

      {showMatch && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <input placeholder="Название сети / операции" value={matchName} onChange={(e) => setMatchName(e.target.value)} />
          <input
            type="password"
            placeholder="Пароль входа в сеть (необязательно)"
            value={matchPass}
            onChange={(e) => setMatchPass(e.target.value)}
          />
          <input placeholder="PIN командира (4+)" value={matchPin} onChange={(e) => setMatchPin(e.target.value)} />
          <button type="button" onClick={() => void createMatch()} disabled={!matchName || matchPin.length < 4}>
            СОЗДАТЬ НОВУЮ СЕТЬ
          </button>
        </div>
      )}
    </div>
  );
}
