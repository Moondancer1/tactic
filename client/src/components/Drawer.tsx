// Bottom sheet on phones (min / mid / max snap points with live finger-follow drag), right-hand split panel on desktop / landscape.
import { useRef, useState } from 'react';
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
  const players = useStore((s) => s.players);
  const onlineCount = Object.values(players).filter((p) => p.online).length;
  const secRef = useRef<HTMLElement>(null);
  const dragState = useRef<{ startY: number; startH: number; moved: boolean } | null>(null);
  const [dragH, setDragH] = useState<number | null>(null);

  const isSidePanel = () =>
    window.innerWidth >= 1024 || (window.innerWidth > window.innerHeight && window.innerHeight <= 540);

  const onHeaderDown = (e: React.PointerEvent) => {
    e.stopPropagation();
    if (isSidePanel()) return;
    const h = secRef.current?.getBoundingClientRect().height ?? 64;
    dragState.current = { startY: e.clientY, startH: h, moved: false };
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  };

  const onHeaderMove = (e: React.PointerEvent) => {
    const st = dragState.current;
    if (!st) return;
    e.stopPropagation();
    const dy = e.clientY - st.startY;
    if (Math.abs(dy) > 6) st.moved = true;
    if (!st.moved) return;
    const maxH = window.innerHeight - 60;
    const nextH = Math.max(58, Math.min(maxH, st.startH - dy));
    setDragH(nextH);
    // Automatically collapse while holding & dragging near the bottom so user doesn't even have to wait
    if (nextH <= 90 && drawer.open !== 'min') {
      setDrawer({ open: 'min' });
    }
  };

  const finishDrag = (e: React.PointerEvent) => {
    const st = dragState.current;
    if (!st) return;
    e.stopPropagation();
    dragState.current = null;
    setDragH(null);

    const dy = e.clientY - st.startY;
    const vh = window.innerHeight;
    const endH = st.startH - dy;

    if (!st.moved) {
      // Simple tap on the handle bar toggles min <-> mid
      const target = e.target as HTMLElement;
      if (target.closest('.handle')) {
        setDrawer({ open: drawer.open === 'min' ? 'mid' : 'min' });
      }
      return;
    }

    // Snap by either swipe delta or dragged height
    if (dy > 55 || endH < vh * 0.25) {
      if (drawer.open === 'max' && endH > vh * 0.35 && dy < 160) setDrawer({ open: 'mid' });
      else setDrawer({ open: 'min' });
    } else if (dy < -55) {
      if (drawer.open === 'min' && endH < vh * 0.65 && dy > -180) setDrawer({ open: 'mid' });
      else setDrawer({ open: 'max' });
    } else {
      if (endH < vh * 0.26) setDrawer({ open: 'min' });
      else if (endH < vh * 0.65) setDrawer({ open: 'mid' });
      else setDrawer({ open: 'max' });
    }
  };

  const onTabClick = (tabId: DrawerTab) => {
    // If user just finished dragging the header, don't trigger tab click
    if (dragState.current?.moved) return;
    if (drawer.open !== 'min' && drawer.tab === tabId) {
      setDrawer({ open: 'min' });
    } else {
      setDrawer({ tab: tabId, open: drawer.open === 'min' ? 'mid' : drawer.open });
    }
  };

  return (
    <section
      ref={secRef}
      className={`drawer d-${drawer.open}`}
      style={dragH != null ? { height: `${dragH}px`, transition: 'none' } : undefined}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div
        className="drawer-head"
        onPointerDown={onHeaderDown}
        onPointerMove={onHeaderMove}
        onPointerUp={finishDrag}
        onPointerCancel={finishDrag}
      >
        <div className="handle">
          <span />
        </div>
        <nav className="tabs">
          {TABS.map((t) => (
            <button
              key={t.id}
              className={drawer.tab === t.id && drawer.open !== 'min' ? 'on' : drawer.tab === t.id ? 'active-min' : ''}
              onClick={() => onTabClick(t.id)}
            >
              {t.label}
              {t.id === 'chat' && unread > 0 && <b className="badge">{unread > 99 ? '99+' : unread}</b>}
              {t.id === 'team' && onlineCount > 0 && (
                <b className="badge" style={{ background: 'var(--acc)', color: '#0b0e0c' }}>
                  {onlineCount}
                </b>
              )}
            </button>
          ))}
          {drawer.open !== 'min' && (
            <button
              className="collapse-btn"
              onClick={(e) => {
                e.stopPropagation();
                setDrawer({ open: 'min' });
              }}
              title="Свернуть панель"
              aria-label="Collapse drawer"
            >
              ▼
            </button>
          )}
        </nav>
      </div>
      <div className="panel">
        {drawer.tab === 'chat' && <ChatPanel />}
        {drawer.tab === 'spot' && <SpotPanel />}
        {drawer.tab === 'brief' && <BriefPanel />}
        {drawer.tab === 'team' && <TeamPanel onLogout={onLogout} />}
        {drawer.tab === 'settings' && <SettingsPanel onLogout={onLogout} />}
      </div>
    </section>
  );
}
