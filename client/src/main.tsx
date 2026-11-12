import React from 'react';
import ReactDOM from 'react-dom/client';
import 'maplibre-gl/dist/maplibre-gl.css';
import './styles.css';
import { App } from './App';

/** Last line of defence: a render crash shows a calm screen with a reload button, never a stack trace. */
class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(err: unknown) {
    console.error('[tactic] UI crash', err);
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="login">
        <div className="login-card" style={{ textAlign: 'center' }}>
          <h1>
            <span className="brand">TACTIC</span>
          </h1>
          <p className="note">Что-то пошло не так. Данные и сессия сохранены — перезапустите экран.</p>
          <button className="primary" onClick={() => window.location.reload()}>
            ПЕРЕЗАГРУЗИТЬ
          </button>
        </div>
      </div>
    );
  }
}

// Unhandled async errors go to the console only; the UI shows its own friendly messages.
window.addEventListener('unhandledrejection', (e) => {
  console.warn('[tactic] unhandled', e.reason);
  e.preventDefault();
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
