import { useEffect, useState } from 'react';
import { isCommandRole } from '@tactic/shared';
import { useStore } from '../store';
import { socket } from '../lib/socket';
import { api, loadSession } from '../lib/api';
import { ReplayView } from './ReplayView';

/** Plain-text briefing (SMEAC). Leaders edit; everyone reads. */
export function BriefPanel() {
  const briefing = useStore((s) => s.briefing);
  const self = useStore((s) => s.self);
  const markers = useStore((s) => s.markers);
  const [edit, setEdit] = useState(false);
  const [draft, setDraft] = useState(briefing.text);
  const leader = !!self && isCommandRole(self.role);
  const canReplay = leader || self?.squad === 'command';
  const match = useStore((s) => s.match);
  const [replay, setReplay] = useState(false);

  useEffect(() => {
    if (!edit) setDraft(briefing.text);
  }, [briefing.text, edit]);

  const objectives = Object.values(markers).filter((m) => m.kind === 'objective');

  return (
    <div className="brief">
      {objectives.length > 0 && (
        <div className="objs">
          {objectives.map((o) => (
            <span key={o.id} className={`obj st-${o.status}`}>
              ЦЕЛЬ {o.label} · {o.status.toUpperCase()}
            </span>
          ))}
        </div>
      )}
      {edit ? (
        <>
          <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={14} placeholder={'ОБСТАНОВКА\nЗАДАЧА\nПОРЯДОК ВЫПОЛНЕНИЯ\nТЫЛ И ОБЕСПЕЧЕНИЕ\nУПРАВЛЕНИЕ И СВЯЗЬ'} />
          <div className="row">
            <button
              className="ok"
              onClick={() => {
                socket.send({ t: 'briefing.set', text: draft });
                setEdit(false);
              }}
            >
              ОПУБЛИКОВАТЬ
            </button>
            <button onClick={() => setEdit(false)}>ОТМЕНА</button>
          </div>
        </>
      ) : (
        <>
          <pre className="brief-text">{briefing.text || 'Брифинг ещё не заполнен.'}</pre>
          {briefing.ts > 0 && (
            <div className="meta">
              автор: {briefing.by} · {new Date(briefing.ts).toLocaleString()}
            </div>
          )}
          {leader && <button onClick={() => setEdit(true)}>РЕДАКТИРОВАТЬ БРИФИНГ</button>}
        </>
      )}
      {canReplay && (
        <button onClick={() => setReplay(true)} title="Треки движения всех бойцов сети с перемоткой">
          РАЗБОР ИГРЫ (ТРЕКИ)
        </button>
      )}
      {replay && (
        <ReplayView
          title={match?.name ?? ''}
          load={() => {
            const s = loadSession();
            if (!s) return Promise.reject(new Error('Сессия истекла — войдите заново'));
            return api.matchTracks(s);
          }}
          onClose={() => setReplay(false)}
        />
      )}
    </div>
  );
}
