import { useEffect, useMemo, useRef, useState } from 'react';
import { SQUAD_META, isCommandRole, type ChatChannel, type ChatMsg } from '@tactic/shared';
import { useStore } from '../store';
import { socket } from '../lib/socket';
import { mgrs } from '../lib/geo';
import { mapRef } from '../lib/mapRef';
import { speakTts } from '../lib/audio';

const QUICK = ['COPY', 'MOVING', 'HOLDING', 'IN POSITION', 'NEED AMMO', 'RTB'];

export function ChatPanel() {
  const chat = useStore((s) => s.chat);
  const self = useStore((s) => s.self);
  const players = useStore((s) => s.players);
  const tts = useStore((s) => s.settings.tts);
  const setSettings = useStore((s) => s.setSettings);
  const hasSquad = !!self && self.squad !== 'none';
  const [channel, setChannel] = useState<ChatChannel>(hasSquad ? 'squad' : 'all');
  const [filter, setFilter] = useState<'all' | ChatChannel>('all');
  const [text, setText] = useState('');
  const [coolingIds, setCoolingIds] = useState<Record<string, boolean>>({});
  const list = useRef<HTMLDivElement>(null);
  const canCmd = !!self && (isCommandRole(self.role) || self.squad === 'command');

  useEffect(() => {
    if (!hasSquad && channel === 'squad') setChannel('all');
  }, [hasSquad, channel]);

  const shown = useMemo(() => (filter === 'all' ? chat : chat.filter((m) => m.channel === filter)), [chat, filter]);
  const stickBottom = useRef(true);

  useEffect(() => {
    const el = list.current;
    if (!el) return;
    if (stickBottom.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [shown.length, filter]);

  function onScrollMsgs() {
    const el = list.current;
    if (!el) return;
    stickBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  }

  function send(t = text) {
    const body = t.trim();
    if (!body) return;
    stickBottom.current = true;
    socket.send({ t: 'chat', channel: !hasSquad && channel === 'squad' ? 'all' : channel, text: body });
    setText('');
  }

  const squadOf = (m: ChatMsg) => players[m.fromId]?.squad;
  const flyTo = (m: ChatMsg) => {
    if (m.lat == null || m.lon == null) return;
    mapRef.current?.flyTo(m.lat, m.lon);
  };

  return (
    <div className="chat">
      <div className="chips">
        {(['all', ...(hasSquad ? ['squad'] : []), ...(canCmd ? ['command'] : [])] as const).map((f) => (
          <button key={f} className={filter === f ? 'on' : ''} onClick={() => setFilter(f as typeof filter)}>
            {f === 'all' ? 'ALL NETS' : f.toUpperCase()}
          </button>
        ))}
        <span className="spacer" />
        <button
          type="button"
          className={tts ? 'on' : ''}
          onClick={() => setSettings({ tts: !tts })}
          title="Авто-озвучка сообщений (Text-to-Speech RU/EN)"
        >
          {tts ? '🔊 TTS ВКЛ' : '🔇 TTS ВЫКЛ'}
        </button>
      </div>
      <div className="msgs" ref={list} onScroll={onScrollMsgs}>
        {shown.map((m) => {
          const sq = squadOf(m);
          return (
            <div key={m.id} className={`msg k-${m.kind} ch-${m.channel} ${m.fromId === self?.id ? 'mine' : ''}`} onClick={() => flyTo(m)}>
              <span className="time">{new Date(m.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
              <span className="net">{m.channel === 'all' ? 'ALL' : m.channel === 'squad' ? (m.squad ? SQUAD_META[m.squad].short : 'SQ') : 'CMD'}</span>
              <span className="from" style={{ color: sq ? SQUAD_META[sq].color : undefined }}>
                {m.callsign}
              </span>
              <span className="text">
                {m.text}
                {m.lat != null && m.lon != null && <span className="grid"> ⌖ {mgrs(m.lat, m.lon)}</span>}
              </span>
              <button
                type="button"
                className={`small-btn ${coolingIds[m.id] ? 'on' : ''}`}
                style={{ padding: '2px 6px', minHeight: 22 }}
                disabled={!!coolingIds[m.id]}
                onClick={(e) => {
                  e.stopPropagation();
                  const full = `${m.callsign}: ${m.text}`;
                  if (speakTts(full, true, m.id)) {
                    const cooldownMs = Math.max(3500, Math.min(10_000, full.length * 75));
                    setCoolingIds((prev) => ({ ...prev, [m.id]: true }));
                    window.setTimeout(() => {
                      setCoolingIds((prev) => {
                        const next = { ...prev };
                        delete next[m.id];
                        return next;
                      });
                    }, cooldownMs);
                  }
                }}
                title={coolingIds[m.id] ? 'Уже озвучивается (защита от повторного нажатия)' : 'Озвучить сообщение (TTS)'}
              >
                {coolingIds[m.id] ? '⏳' : '🔊'}
              </button>
            </div>
          );
        })}
        {shown.length === 0 && <div className="empty">Сообщений пока нет.</div>}
      </div>
      <div className="quick">
        {QUICK.map((q) => (
          <button key={q} onClick={() => send(q)}>
            {q}
          </button>
        ))}
      </div>
      <form
        className="compose"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <select value={channel} onChange={(e) => setChannel(e.target.value as ChatChannel)}>
          {hasSquad && <option value="squad">SQD</option>}
          <option value="all">ALL</option>
          {canCmd && <option value="command">CMD</option>}
        </select>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Message…" maxLength={500} enterKeyHint="send" />
        <button className="ok">SEND</button>
      </form>
    </div>
  );
}
