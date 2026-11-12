import { useEffect, useState } from 'react';
import { ROLES, ROLE_META, SQUADS, SQUAD_META, type NetworkItem, type Role, type Squad } from '@tactic/shared';
import {
  ApiError,
  api,
  defaultServer,
  loadTicket,
  normalizeServer,
  saveTicket,
  type AdminMatchItem,
  type AdminUserItem,
  type Session,
  type Ticket,
} from '../lib/api';
import { isNative } from '../lib/native';
import { friendlyError } from '../lib/errors';
import { requestCompassPermission } from '../lib/tracking';

/** Admin credentials live only for this browser tab (sessionStorage), never on disk. */
const ADMIN_KEY = 'tactic.admin';

export function Login({
  onJoined,
  initialStep = 'auth',
}: {
  onJoined: (s: Session) => void;
  initialStep?: 'auth' | 'networks';
}) {
  const saved = loadTicket();
  const [server, setServer] = useState(saved?.server || defaultServer());
  const [showServer, setShowServer] = useState(isNative() && !(saved?.server || defaultServer()));
  const [callsign, setCallsign] = useState<string>(saved?.callsign ?? '');
  const [password, setPassword] = useState('');
  const [ticket, setTicket] = useState<Ticket | null>(saved);
  const [step, setStep] = useState<'auth' | 'networks'>(initialStep === 'networks' && saved ? 'networks' : 'auth');
  const [networks, setNetworks] = useState<NetworkItem[]>([]);
  const [pingMs, setPingMs] = useState<number | null>(null);
  const [pingOk, setPingOk] = useState<boolean | null>(null);
  const [selectedNetId, setSelectedNetId] = useState<string | null>(null);
  const [netPassInput, setNetPassInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [adminOpen, setAdminOpen] = useState(false);

  /** Ticket rejected (revoked, expired, account deleted): back to the password step. */
  function dropTicket(err: unknown) {
    if (err instanceof ApiError && err.status === 401) {
      saveTicket(null);
      setTicket(null);
      setStep('auth');
      setError('Сессия истекла — войдите заново');
      return true;
    }
    return false;
  }

  async function refreshNetworks(t = ticket) {
    if (!t) return;
    const t0 = performance.now();
    try {
      const res = await api.networks(t);
      setPingMs(Math.max(1, Math.round(performance.now() - t0)));
      setPingOk(true);
      setNetworks(res.networks);
    } catch (err) {
      if (dropTicket(err)) return;
      setPingOk(false);
      setPingMs(null);
    }
  }

  useEffect(() => {
    if (step !== 'networks') return;
    void refreshNetworks();
    const id = setInterval(() => void refreshNetworks(), 5000);
    return () => clearInterval(id);
  }, [step, ticket]);

  async function submitAuth(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    const srv = normalizeServer(server);
    try {
      await requestCompassPermission();
      const t0 = performance.now();
      const res = await api.verify(srv, { callsign: callsign.trim().toUpperCase(), password });
      setPingMs(Math.max(1, Math.round(performance.now() - t0)));
      setPingOk(true);
      const t: Ticket = { server: srv, callsign: res.user.callsign, ticket: res.ticket };
      saveTicket(t);
      setTicket(t);
      setServer(srv);
      setCallsign(res.user.callsign);
      setPassword('');
      setNetworks(res.networks);
      setStep('networks');
    } catch (err) {
      setError(friendlyError(err, 'Ошибка авторизации'));
    } finally {
      setBusy(false);
    }
  }

  async function joinNetwork(matchId: string, matchPassword?: string) {
    if (!ticket) return;
    setBusy(true);
    setError('');
    try {
      const res = await api.join(ticket, { matchId, matchPassword });
      onJoined({ ...res, server: ticket.server });
    } catch (err) {
      if (!dropTicket(err)) setError(friendlyError(err, 'Не удалось подключиться к сети'));
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
                saveTicket(null);
                setTicket(null);
                setStep('auth');
              }}
              title="Выйти из аккаунта"
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
                  ? 'Нет ответа от сервера.'
                  : 'Активных сетей нет. Сеть создаёт администратор в админ-панели.'}
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
                          void joinNetwork(net.id);
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
                          Бойцов: {net.onlineCount} онлайн (всего {net.memberCount})
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
                            void joinNetwork(net.id);
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
                          void joinNetwork(net.id, netPassInput);
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
            placeholder="ПОЗЫВНОЙ"
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
            autoComplete="current-password"
            maxLength={64}
            required
          />
        </label>

        {error && <div className="err">{error}</div>}
        <button className="primary" disabled={busy}>
          {busy ? 'ПРОВЕРКА…' : 'ДАЛЕЕ → ВЫБОР СЕТИ'}
        </button>

        <button type="button" className="link" onClick={() => setAdminOpen(true)}>
          Админ-панель (бойцы и сети)
        </button>
      </form>
    </div>
  );
}

function AdminPanel({ server }: { server: string }) {
  const savedToken = sessionStorage.getItem(ADMIN_KEY) || '';
  const [adminLogin, setAdminLogin] = useState(() => (savedToken.includes(':') ? savedToken.split(':')[0]! : ''));
  const [adminPass, setAdminPass] = useState('');
  const [token, setToken] = useState(savedToken);
  const [authed, setAuthed] = useState(false);
  const [users, setUsers] = useState<AdminUserItem[]>([]);
  const [matches, setMatches] = useState<AdminMatchItem[]>([]);
  const [callsign, setCallsign] = useState('');
  const [password, setPassword] = useState('');
  const [squad, setSquad] = useState<Squad>('alpha');
  const [role, setRole] = useState<Role>('rifleman');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [matchName, setMatchName] = useState('');
  const [matchPin, setMatchPin] = useState('');
  const [matchPass, setMatchPass] = useState('');

  async function load(tok = token) {
    if (!tok || tok === ':') return;
    setErr('');
    try {
      const [u, m] = await Promise.all([api.adminListUsers(server, tok), api.adminListMatches(server, tok)]);
      setUsers(u);
      setMatches(m.filter((x) => x.active));
      setAuthed(true);
      setToken(tok);
      sessionStorage.setItem(ADMIN_KEY, tok);
    } catch (e) {
      setAuthed(false);
      sessionStorage.removeItem(ADMIN_KEY);
      setErr(friendlyError(e, 'Неверный логин или пароль администратора'));
    }
  }

  useEffect(() => {
    if (savedToken.includes(':')) void load(savedToken);
  }, []);

  async function run(action: () => Promise<string>) {
    setMsg('');
    setErr('');
    try {
      setMsg(await action());
      await load();
    } catch (e) {
      setErr(friendlyError(e));
    }
  }

  const saveUser = (e: React.FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const res = await api.adminSaveUser(server, token, { callsign: callsign.trim().toUpperCase(), password, squad, role });
      setCallsign('');
      setPassword('');
      return res.updated ? `Обновлён боец ${res.callsign} (его старые сессии сброшены)` : `Создан боец ${res.callsign}`;
    });
  };

  const createMatch = (e: React.FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const m = await api.adminCreateMatch(server, token, {
        name: matchName.trim(),
        password: matchPass.trim(),
        commandPin: matchPin.trim() || undefined,
      });
      setMatchName('');
      setMatchPass('');
      setMatchPin('');
      return `Создана сеть «${m.name}». PIN командира: ${m.commandPin}`;
    });
  };

  const kick = (cs: string) =>
    void run(async () => {
      await api.adminKickUser(server, token, cs);
      return `${cs} отключён, сессии сброшены`;
    });

  const remove = (cs: string) => {
    if (!window.confirm(`Удалить аккаунт ${cs}?`)) return;
    void run(async () => {
      await api.adminDeleteUser(server, token, cs);
      return `Удалён боец ${cs}`;
    });
  };

  const endMatch = (m: AdminMatchItem) => {
    if (!window.confirm(`Завершить сеть «${m.name}»? Все бойцы будут отключены.`)) return;
    void run(async () => {
      await api.adminEndMatch(server, token, m.id);
      return `Сеть «${m.name}» завершена`;
    });
  };

  if (!authed) {
    return (
      <form
        className="hq"
        onSubmit={(e) => {
          e.preventDefault();
          void load(`${adminLogin.trim()}:${adminPass}`);
        }}
      >
        <label>
          Логин
          <input type="text" value={adminLogin} onChange={(e) => setAdminLogin(e.target.value)} autoCapitalize="off" autoComplete="username" required />
        </label>
        <label>
          Пароль
          <input type="password" value={adminPass} onChange={(e) => setAdminPass(e.target.value)} autoComplete="current-password" required />
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
      {msg && <div className="note" style={{ color: 'var(--acc)' }}>{msg}</div>}
      {err && <div className="err">{err}</div>}

      <h4 style={{ margin: '4px 0 0' }}>АКТИВНЫЕ СЕТИ ({matches.length})</h4>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {matches.map((m) => (
          <div key={m.id} className="member" style={{ padding: '6px 4px' }}>
            <b>
              {m.hasPassword ? '🔒' : '📡'} {m.name}
            </b>
            <span className="role" title="PIN командира">
              PIN {m.commandPin}
            </span>
            <span className="role">{m.onlineCount} онлайн</span>
            <span className="spacer" />
            <button type="button" className="danger small-btn" title="Завершить сеть: все бойцы будут отключены" onClick={() => endMatch(m)}>
              ЗАВЕРШИТЬ
            </button>
          </div>
        ))}
      </div>

      <form onSubmit={createMatch} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <h4 style={{ margin: '8px 0 0' }}>НОВАЯ СЕТЬ (ОДНА СЕТЬ = ОДНА КОМАНДА)</h4>
        <input placeholder="Название сети / операции" value={matchName} onChange={(e) => setMatchName(e.target.value)} maxLength={80} required />
        <input
          type="text"
          placeholder="Пароль сети (мин. 4) — только для своей команды"
          value={matchPass}
          onChange={(e) => setMatchPass(e.target.value)}
          minLength={4}
          maxLength={64}
          autoComplete="off"
          required
        />
        <input
          placeholder="PIN командира (пусто = случайный, 6 цифр)"
          value={matchPin}
          onChange={(e) => setMatchPin(e.target.value.replace(/\D/g, ''))}
          inputMode="numeric"
          maxLength={12}
        />
        <button className="ok" disabled={!matchName.trim() || matchPass.trim().length < 4 || (matchPin.length > 0 && matchPin.length < 6)}>
          + СОЗДАТЬ СЕТЬ
        </button>
      </form>

      <form onSubmit={saveUser} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <h4 style={{ margin: '8px 0 0' }}>ДОБАВИТЬ / ОБНОВИТЬ БОЙЦА</h4>
        <label>
          Позывной (логин)
          <input value={callsign} onChange={(e) => setCallsign(e.target.value.toUpperCase())} placeholder="ПОЗЫВНОЙ" maxLength={16} autoCapitalize="characters" required />
        </label>
        <label>
          Пароль (мин. 6 символов)
          <input
            type="text"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Задайте пароль бойцу"
            minLength={6}
            maxLength={64}
            autoComplete="new-password"
            required
          />
        </label>
        <div className="field">
          <span>Отряд по умолчанию</span>
          <div className="seg small">
            {SQUADS.map((s) => (
              <button type="button" key={s} className={s === squad ? 'on' : ''} style={{ ['--c' as string]: SQUAD_META[s].color }} onClick={() => setSquad(s)}>
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

      <h4>АККАУНТЫ БОЙЦОВ ({users.length})</h4>
      <div style={{ maxHeight: 240, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 4 }}>
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
                setMsg(`Введите новый пароль для ${u.callsign} и нажмите «Сохранить»`);
              }}
              title="Изменить пароль / отряд"
            >
              ИЗМ.
            </button>
            <button type="button" className="small-btn" title="Выкинуть из всех сетей и сбросить сессии" onClick={() => kick(u.callsign)}>
              КИК
            </button>
            <button type="button" className="danger small-btn" title="Удалить аккаунт" onClick={() => remove(u.callsign)}>
              ✕
            </button>
          </div>
        ))}
      </div>

      <button
        type="button"
        className="link"
        onClick={() => {
          sessionStorage.removeItem(ADMIN_KEY);
          setToken('');
          setAdminPass('');
          setAuthed(false);
        }}
      >
        Выйти из админ-панели
      </button>
    </div>
  );
}
