// Bottom sheet on phones (min / mid / max snap points), right-hand split panel on desktop.
import { useRef } from 'react';
import { useStore, type DrawerTab } from '../store';
import { ChatPanel } from './ChatPanel';
import { SpotPanel } from './SpotPanel';
import { BriefPanel } from './BriefPanel';
import { TeamPanel } from './TeamPanel';
import { SettingsPanel } from './SettingsPanel';

const TABS: { id: DrawerTab; label: string }[] = [
  { id: 'chat', label: 'CHAT' },
  { id: 'spot', label: 'SPOT' },
  { id: 'brief', label: 'BRIEF' },
  { id: 'team', label: 'TEAM' },
  { id: 'settings', label: 'SET' },
];

export function Drawer({ onLogout }: { onLogout: () => void }) {
  const drawer = useStore((s) => s.drawer);
  const setDrawer = useStore((s) => s.setDrawer);
  const unread = useStore((s) => s.unread);
  const dragY = useRef<number | null>(null);

  const onHandleDown = (e: React.PointerEvent) => {
    dragY.current = e.clientY;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onHandleUp = (e: React.PointerEvent) => {
    if (dragY.current == null) return;
    const dy = e.clientY - dragY.current;
    dragY.current = null;
    const order = ['min', 'mid', 'max'] as const;
    const i = order.indexOf(drawer.open);
    if (Math.abs(dy) < 8) setDrawer({ open: drawer.open === 'min' ? 'mid' : 'min' });
    else if (dy < 0) setDrawer({ open: order[Math.min(2, i + 1)]! });
    else setDrawer({ open: order[Math.max(0, i - 1)]! });
  };

  return (
    <section className={`drawer d-${drawer.open}`}>
      <div className="handle" onPointerDown={onHandleDown} onPointerUp={onHandleUp}>
        <span />
      </div>
      <nav className="tabs">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={drawer.tab === t.id ? 'on' : ''}
            onClick={() => setDrawer({ tab: t.id, open: drawer.open === 'min' ? 'mid' : drawer.open })}
          >
            {t.label}
            {t.id === 'chat' && unread > 0 && <b className="badge">{unread > 99 ? '99+' : unread}</b>}
          </button>
        ))}
      </nav>
      <div className="panel">
        {drawer.tab === 'chat' && <ChatPanel />}
        {drawer.tab === 'spot' && <SpotPanel />}
        {drawer.tab === 'brief' && <BriefPanel />}
        {drawer.tab === 'team' && <TeamPanel />}
        {drawer.tab === 'settings' && <SettingsPanel onLogout={onLogout} />}
      </div>
    </section>
  );
}
