import { SQUAD_META, VOICE_CHANNEL_META, type VoiceChannel } from '@tactic/shared';
import { useStore } from '../store';
import { cardinal, declination, fmtAz, mgrs } from '../lib/geo';

export function TopBar({
  onLogout,
  onSwitchNetwork,
}: {
  onLogout: () => void;
  onSwitchNetwork?: () => void;
}) {
  const self = useStore((s) => s.self);
  const match = useStore((s) => s.match);
  const connected = useStore((s) => s.connected);
  const latency = useStore((s) => s.latencyMs);
  const myPos = useStore((s) => s.myPos);
  const compass = useStore((s) => s.compass);
  const mode = useStore((s) => s.settings.mode);
  const voice = useStore((s) => s.voice);
  const players = useStore((s) => s.players);
  const setSettings = useStore((s) => s.setSettings);
  const setDrawer = useStore((s) => s.setDrawer);

  const playerList = Object.values(players);
  const onlineCount = playerList.filter((p) => p.online).length;
  const totalCount = playerList.length;

  const rx = Object.entries(voice.rx) as [VoiceChannel, string][];
  const hdg = myPos?.heading ?? compass;

  return (
    <header className="topbar">
      <div className="tb-row">
        <span className={`dot ${connected ? 'ok' : 'bad'}`} title={connected ? `link ${latency ?? '?'} ms` : 'offline'} />
        <button
          type="button"
          className="match"
          style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'inherit', font: 'inherit' }}
          onClick={onSwitchNetwork}
          title="Сменить тактическую сеть (матч)"
        >
          {match?.name ?? '—'} ▾
        </button>
        {self && (
          <span className="me" style={{ color: SQUAD_META[self.squad].color }}>
            {self.callsign}
          </span>
        )}
        <span className="spacer" />
        <button
          type="button"
          className={`mode online ${totalCount === 0 || onlineCount === 0 ? 'none' : onlineCount < totalCount ? 'part' : 'all'}`}
          onClick={() => setDrawer({ open: 'mid', tab: 'team' })}
          title="Кто в сети / список зашедших бойцов"
        >
          ● {onlineCount}/{totalCount} <span className="online-lbl">В СЕТИ</span>
        </button>
        <button
          className={`mode ${mode}`}
          onClick={() => setSettings({ mode: mode === 'combat' ? 'eco' : 'combat' })}
          title="Combat: screen stays on, 2 s GPS. Eco: screen may sleep, 5–15 s GPS."
        >
          {mode === 'combat' ? 'COMBAT' : 'ECO'}
        </button>
        <button
          type="button"
          className="danger exit-btn"
          onClick={onLogout}
          title="Выйти из игры"
        >
          ВЫХОД
        </button>
      </div>
      <div className="tb-row sub">
        <span className="grid">{myPos ? mgrs(myPos.lat, myPos.lon) : 'NO FIX'}</span>
        {myPos && <span className="acc">±{Math.round(myPos.acc)}m</span>}
        {hdg != null && (
          <span className="hdg" title="True heading · magnetic (compass) heading">
            {fmtAz(hdg)} {cardinal(hdg)}
            {myPos && <small> M{fmtAz(hdg - declination(myPos.lat, myPos.lon))}</small>}
          </span>
        )}
        <span className="spacer" />
        {voice.transmitting ? (
          <span className="tx">● TX {VOICE_CHANNEL_META[voice.tx].short}</span>
        ) : rx.length ? (
          rx.map(([ch, who]) => (
            <span key={ch} className="rx">
              RX {who} [{VOICE_CHANNEL_META[ch].short}]
            </span>
          ))
        ) : (
          <span className={`vstat ${voice.status}`}>{voice.status === 'ready' ? 'NET READY' : voice.status === 'error' ? 'NET ERR' : voice.status === 'connecting' ? 'NET…' : 'NO NET'}</span>
        )}
      </div>
    </header>
  );
}
