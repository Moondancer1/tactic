// Tactical WebSocket: hello/auth, binary PTT audio transport, auto-reconnect with backoff, offline outbox.
import { PROTOCOL_VERSION, type ClientMsg, type ServerMsg } from '@tactic/shared';
import { useStore } from '../store';
import { updateSessionSelf, wsUrl } from './api';

/** Client-side id (fits the server's [A-Za-z0-9_-]{4,40}): makes outbox replays idempotent. */
function newId(): string {
  const b = crypto.getRandomValues(new Uint8Array(10));
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

/** Give every create-type message an id before it can be queued, so a resend never duplicates it. */
function withId(msg: Outgoing): Outgoing {
  switch (msg.t) {
    case 'chat':
      return msg.id ? msg : { ...msg, id: newId() };
    case 'marker.upsert':
      return msg.marker.id ? msg : { ...msg, marker: { ...msg.marker, id: newId() } };
    case 'zone.upsert':
      return msg.zone.id ? msg : { ...msg, zone: { ...msg.zone, id: newId() } };
    case 'route.upsert':
      return msg.route.id ? msg : { ...msg, route: { ...msg.route, id: newId() } };
    default:
      return msg;
  }
}

type Outgoing = Exclude<ClientMsg, { t: 'hello' }>;

class TacticalSocket {
  private ws: WebSocket | null = null;
  private authed = false;
  private server = '';
  private token = '';
  private backoff = 500;
  private reconnectTimer: number | undefined;
  private pingTimer: number | undefined;
  private lastRxTs = 0;
  private stopped = true;
  /** Messages that must not be lost while offline (chat, markers...). Positions are latest-only. */
  private outbox: Outgoing[] = [];
  private lastPos: Outgoing | null = null;
  onFatal: (code: 'unauthorized' | 'match_ended') => void = () => {};
  /** Fresh session token from the server (sliding expiry, squad/role change). */
  onToken: (token: string) => void = () => {};
  onBinary: (data: Uint8Array) => void = () => {};

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
    this.authed = false;
    this.outbox = [];
  }

  send(m: Outgoing) {
    const msg = withId(m);
    if (this.ws?.readyState === WebSocket.OPEN && this.authed) {
      this.ws.send(JSON.stringify(msg));
      return;
    }
    if (msg.t === 'pos') this.lastPos = msg;
    else if (msg.t !== 'ping' && msg.t !== 'heading' && msg.t !== 'voice.tx') this.outbox.push(msg);
    if (this.outbox.length > 100) this.outbox.shift();
  }

  sendBinary(data: Uint8Array) {
    if (this.ws?.readyState === WebSocket.OPEN && this.authed && this.ws.bufferedAmount < 65536) {
      this.ws.send(data);
    }
  }

  get isOpen() {
    return this.ws?.readyState === WebSocket.OPEN && this.authed;
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
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    this.authed = false;

    ws.onopen = () => {
      this.lastRxTs = Date.now();
      ws.send(JSON.stringify({ t: 'hello', token: this.token, v: PROTOCOL_VERSION }));
    };

    ws.onmessage = (ev) => {
      this.lastRxTs = Date.now();
      if (ev.data instanceof ArrayBuffer) {
        this.onBinary(new Uint8Array(ev.data));
        return;
      }
      let msg: ServerMsg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.t === 'snapshot') {
        this.authed = true;
        this.backoff = 500;
        useStore.setState({ connected: true });
        const curPos = useStore.getState().myPos;
        if (curPos && !this.lastPos) {
          this.lastPos = {
            t: 'pos',
            lat: curPos.lat,
            lon: curPos.lon,
            acc: Math.min(curPos.acc, 99999),
            heading: curPos.heading == null ? null : Math.round(curPos.heading) % 360,
            speed: curPos.speed == null || Number.isNaN(curPos.speed) ? null : curPos.speed,
            ts: Date.now(),
          };
        }
        this.flushOutbox();
        clearInterval(this.pingTimer);
        this.ping();
        this.pingTimer = window.setInterval(() => this.ping(), 10_000);
      } else if (msg.t === 'self') {
        if (msg.token) {
          this.token = msg.token;
          this.onToken(msg.token);
        }
        updateSessionSelf(msg.self, msg.token);
      }
      useStore.getState().apply(msg);
    };

    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.authed = false;
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
    this.backoff = Math.min(this.backoff * 2, 8_000);
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
    if (Date.now() - this.lastRxTs > 25_000) {
      // Dead half-open TCP socket on mobile network: force reconnect immediately
      this.ws?.close();
      this.scheduleReconnect();
      return;
    }
    this.send({ t: 'ping', ts: Date.now() });
  }
}

export const socket = new TacticalSocket();
