import { useEffect, useState } from 'react';
import { useStore } from './store';
import { api, loadSession, saveSession, saveTicket, type Session } from './lib/api';
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
import { MapControls } from './components/MapControls';
import { Toasts } from './components/Toasts';

export function App() {
  const [session, setSession] = useState<Session | null>(() => loadSession());
  const [loginStep, setLoginStep] = useState<'auth' | 'networks'>('auth');

  useEffect(() => {
    if (!session) return;
    // Revoked / expired session → back to login. Ended network → pick another one (the ticket stays valid).
    socket.onFatal = (code) => {
      if (code === 'match_ended') {
        logout(false, 'networks');
        useStore.getState().toast('Сеть завершена — выберите другую сеть', 'error');
        return;
      }
      saveTicket(null);
      logout(false, 'auth');
      useStore.getState().toast('Сессия завершена — войдите заново', 'error');
    };
    socket.onToken = (token) => tracker.setToken(token);
    socket.start(session.server, session.token);
    void tracker.start(session);
    void voice.connect(session);

    // Hardware PTT from the Android service (headset hook / media button, volume keys).
    let removeKey: (() => void) | undefined;
    let removeAuth: (() => void) | undefined;
    if (isNative()) {
      void Tactical.addListener('authExpired', (e) => socket.onFatal(e.status === 410 ? 'match_ended' : 'unauthorized')).then(
        (h) => (removeAuth = () => void h.remove()),
      );
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
      removeAuth?.();
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
    setLoginStep('auth');
    setSession(s);
  }

  function logout(notifyServer = true, toStep: 'auth' | 'networks' = 'auth') {
    if (notifyServer && session) {
      socket.send({ t: 'leave' });
      void api.leave(session).catch(() => {});
    }
    saveSession(null);
    useStore.getState().reset();
    setLoginStep(toStep);
    setSession(null);
  }

  if (!session) return <Login onJoined={login} initialStep={loginStep} />;

  return (
    <div className="app" onPointerDown={unlockAudio}>
      <TopBar onLogout={() => logout(true, 'auth')} onSwitchNetwork={() => logout(true, 'networks')} />
      <main className="stage">
        <MapView />
        <ToolBar />
        <MapControls />
        <PttButton />
      </main>
      <Drawer onLogout={() => logout(true)} />
      <Toasts />
    </div>
  );
}
