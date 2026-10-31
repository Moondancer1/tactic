import { useEffect, useMemo, useRef, useState } from 'react';
import { SQUAD_META, isCommandRole, type ChatChannel, type ChatMsg } from '@tactic/shared';
import { useStore } from '../store';
import { socket } from '../lib/socket';
import { mgrs } from '../lib/geo';

const QUICK = ['COPY', 'MOVING', 'HOLDING', 'IN POSITION', 'NEED AMMO', 'RTB'];

export function ChatPanel() {
  const chat = useStore((s) => s.chat);
  const self = useStore((s) => s.self);
  const players = useStore((s) => s.players);
  const [channel, setChannel] = useState<ChatChannel>('squad');
  const [filter, setFilter] = useState<'all' | ChatChannel>('all');
  const [text, setText] = useState('');
  const list = useRef<HTMLDivElement>(null);
  const canCmd = !!self && (isCommandRole(self.role) || self.squad === 'command');

  const shown = useMemo(() => (filter === 'all' ? chat : chat.filter((m) => m.channel === filter)), [chat, filter]);

  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight });
  }, [shown.length]);

  function send(t = text) {
    const body = t.trim();
    if (!body) return;
    socket.send({ t: 'chat', channel, text: body });
    setText('');
  }

  const squadOf = (m: ChatMsg) => players[m.fromId]?.squad;
  const flyTo = (m: ChatMsg) => {
    if (m.lat == null || m.lon == null) return;
    (window as unknown as { __map?: { flyTo: (ll: [number, number], z: number) => void } }).__map?.flyTo([m.lat, m.lon], 18);
  };

  return (
    <div className="chat">
      <div className="chips">
        {(['all', 'squad', ...(canCmd ? ['command'] : [])] as const).map((f) => (
          <button key={f} className={filter === f ? 'on' : ''} onClick={() => setFilter(f as typeof filter)}>
            {f === 'all' ? 'ALL NETS' : f.toUpperCase()}
          </button>
        ))}
      </div>
      <div className="msgs" ref={list}>
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
            </div>
          );
        })}
        {shown.length === 0 && <div className="empty">No traffic.</div>}
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
          <option value="squad">SQD</option>
          <option value="all">ALL</option>
          {canCmd && <option value="command">CMD</option>}
        </select>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Message…" maxLength={500} enterKeyHint="send" />
        <button className="ok">SEND</button>
      </form>
    </div>
  );
}
