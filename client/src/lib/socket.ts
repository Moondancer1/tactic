// Tactical WebSocket: hello/auth, auto-reconnect with backoff, offline outbox.
import { PROTOCOL_VERSION, type ClientMsg, type ServerMsg } from '@tactic/shared';
import { useStore } from '../store';
import { wsUrl } from './api';

type Outgoing = Exclude<ClientMsg, { t: 'hello' }>;

class TacticalSocket {
  private ws: WebSocket | null = null;
  private server = '';
  private token = '';
  private backoff = 500;
  private reconnectTimer: number | undefined;
  private pingTimer: number | undefined;
  private stopped = true;
  /** Messages that must not be lost while offline (chat, markers...). Positions are latest-only. */
  private outbox: Outgoing[] = [];
  private lastPos: Outgoing | null = null;
  onFatal: (code: string) => void = () => {};

  start(server: string, token: string) {
    this.server = server;
    this.token = token;
    this.stopped = false;
    this.open();
    document.addEventListener('visibilitychange', this.onVisible);
    window.addEventListener('online', this.onVisible);
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    clearInterval(this.pingTimer);
    document.removeEventListener('visibilitychange', this.onVisible);
    window.removeEventListener('online', this.onVisible);
    this.ws?.close(1000, 'logout');
    this.ws = null;
    this.outbox = [];
  }

  send(msg: Outgoing) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
      return;
    }
    if (msg.t === 'pos') this.lastPos = msg;
    else if (msg.t !== 'ping' && msg.t !== 'heading') this.outbox.push(msg);
    if (this.outbox.length > 100) this.outbox.shift();
  }

  get isOpen() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  private onVisible = () => {
    // Phones kill sockets in the background; reconnect immediately when back.
    if (document.visibilityState === 'visible' && !this.stopped && !this.isOpen) {
      clearTimeout(this.reconnectTimer);
      this.backoff = 500;
      this.open();
    }
  };

  private open() {
    if (this.stopped) return;
    this.ws?.close();
    const ws = new WebSocket(wsUrl(this.server));
    this.ws = ws;

    ws.onopen = () => {
      ws.send(JSON.stringify({ t: 'hello', token: this.token, v: PROTOCOL_VERSION }));
    };

    ws.onmessage = (ev) => {
      let msg: ServerMsg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.t === 'snapshot') {
        this.backoff = 500;
        useStore.setState({ connected: true });
        this.flushOutbox();
        clearInterval(this.pingTimer);
        this.ping();
        this.pingTimer = window.setInterval(() => this.ping(), 15_000);
      }
      useStore.getState().apply(msg);
    };

    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      useStore.setState({ connected: false });
      clearInterval(this.pingTimer);
      if (ev.code === 4003 || ev.code === 4004) {
        this.stopped = true;
        this.onFatal(ev.code === 4003 ? 'unauthorized' : 'match_ended');
        return;
      }
      this.scheduleReconnect();
    };
    ws.onerror = () => ws.close();
  }

  private scheduleReconnect() {
    if (this.stopped) return;
    clearTimeout(this.reconnectTimer);
    const delay = this.backoff + Math.random() * 300;
    this.backoff = Math.min(this.backoff * 2, 10_000);
    this.reconnectTimer = window.setTimeout(() => this.open(), delay);
  }

  private flushOutbox() {
    const queued = this.outbox;
    this.outbox = [];
    if (this.lastPos) queued.unshift(this.lastPos);
    this.lastPos = null;
    for (const m of queued) this.send(m);
  }

  private ping() {
    this.send({ t: 'ping', ts: Date.now() });
  }
}

export const socket = new TacticalSocket();
