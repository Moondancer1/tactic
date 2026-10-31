import { useEffect, useState } from 'react';
import { useStore } from './store';
import { loadSession, saveSession, type Session } from './lib/api';
import { socket } from './lib/socket';
import { tracker } from './lib/tracking';
import { voice, ptt } from './lib/voice';
import { unlockAudio } from './lib/audio';
import { isNative, Tactical } from './lib/native';
import { Login } from './components/Login';
import { MapView } from './components/MapView';
import { TopBar } from './components/TopBar';
import { Drawer } from './components/Drawer';
import { PttButton } from './components/PttButton';
import { ToolBar } from './components/ToolBar';
import { Toasts } from './components/Toasts';

export function App() {
  const [session, setSession] = useState<Session | null>(() => loadSession());

  useEffect(() => {
    if (!session) return;
    socket.onFatal = (code) => {
      useStore.getState().toast(code === 'unauthorized' ? 'Session expired — re-join' : 'Match ended', 'error');
      logout();
    };
    socket.start(session.server, session.token);
    void tracker.start(session);
    void voice.connect(session);

    // Hardware PTT from the Android service (headset hook / media button, volume keys).
    let removeKey: (() => void) | undefined;
    if (isNative()) {
      void Tactical.addListener('pttKey', (e) => {
        const holdCapable = e.source === 'volume' || useStore.getState().settings.pttKeyMode === 'hold';
        if (holdCapable) e.action === 'down' ? ptt.down(e.source) : ptt.up(e.source);
        else if (e.action === 'down') ptt.toggle(e.source);
      }).then((h) => (removeKey = () => void h.remove()));
    }

    const unsub = useStore.subscribe((s, prev) => {
      if (s.settings !== prev.settings) void tracker.onSettings(prev.settings, s.settings);
    });

    return () => {
      unsub();
      removeKey?.();
      socket.stop();
      void tracker.stop();
      void voice.disconnect();
    };
  }, [session]);

  // Desktop: Space = PTT (hold)
  useEffect(() => {
    const isTyping = (e: KeyboardEvent) => (e.target as HTMLElement)?.closest('input,textarea,select');
    const down = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || e.repeat || isTyping(e)) return;
      e.preventDefault();
      ptt.down('keyboard');
    };
    const up = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || isTyping(e)) return;
      e.preventDefault();
      ptt.up('keyboard');
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, []);

  function login(s: Session) {
    unlockAudio();
    saveSession(s);
    setSession(s);
  }

  function logout() {
    saveSession(null);
    useStore.getState().reset();
    setSession(null);
  }

  if (!session) return <Login onJoined={login} />;

  return (
    <div className="app" onPointerDown={unlockAudio}>
      <TopBar />
      <main className="stage">
        <MapView />
        <ToolBar />
        <PttButton />
      </main>
      <Drawer onLogout={logout} />
      <Toasts />
    </div>
  );
}
