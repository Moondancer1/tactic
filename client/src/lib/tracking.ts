// Position uplink with battery-aware throttling, compass heading, and power modes.
//
// Web:    watchPosition while moving and visible; when stationary or hidden it drops to
//         one-shot fixes every idleIntervalMs so the GPS radio can sleep between fixes.
// Native: the Android foreground service owns GPS and posts to /api/telemetry directly
//         (survives a locked screen); the WebView only renders 'location' events.
import type { PluginListenerHandle } from '@capacitor/core';
import { useStore, type Settings } from '../store';
import type { Session } from './api';
import { declination, distance, norm360 } from './geo';
import { isNative, Tactical } from './native';
import { socket } from './socket';

const STATIONARY_AFTER_MS = 30_000;
const MOVE_THRESHOLD_M = 8;

class Tracker {
  private session: Session | null = null;
  private watchId: number | null = null;
  private pollTimer: number | undefined;
  private heartbeatTimer: number | undefined;
  private highAccuracy = true;
  private ipFallbackTried = false;
  private lastSent = 0;
  private lastSentPos: [number, number] | null = null;
  private anchor: [number, number] | null = null;
  private lastMoveTs = Date.now();
  private listeners: PluginListenerHandle[] = [];
  private wakeLock: WakeLockSentinel | null = null;
  private lastHeadingSent = 0;
  private lastHeadingVal = -1;
  private lastCompassStoreTs = 0;
  private hasAbsoluteOrientation = false;
  private battery: number | null = null;

  async start(session: Session) {
    this.session = session;
    this.hasAbsoluteOrientation = false;
    window.addEventListener('deviceorientationabsolute', this.onOrientationAbs as EventListener, { passive: true });
    window.addEventListener('deviceorientation', this.onOrientationRel as EventListener, { passive: true });
    document.addEventListener('visibilitychange', this.onVisibility);
    this.watchBattery();

    if (isNative()) {
      this.listeners.push(
        await Tactical.addListener('location', (l) => {
          const now = l.ts || Date.now();
          const hdg = l.heading ?? useStore.getState().compass;
          useStore.setState({ myPos: { lat: l.lat, lon: l.lon, acc: l.acc, heading: hdg, speed: l.speed, ts: now, tier: l.tier } });
          if (useStore.getState().settings.shareLocation && now - this.lastSent >= 1500) {
            this.lastSent = now;
            this.lastSentPos = [l.lat, l.lon];
            socket.send({
              t: 'pos',
              lat: l.lat,
              lon: l.lon,
              acc: Math.min(l.acc || 50, 99999),
              heading: hdg == null ? null : Math.round(hdg) % 360,
              speed: l.speed == null || Number.isNaN(l.speed) ? null : l.speed,
              bat: this.battery,
              ts: now,
            });
          }
        }),
      );
      await this.startNative();
    }
    this.highAccuracy = true;
    this.ipFallbackTried = false;
    if ('geolocation' in navigator && useStore.getState().settings.shareLocation) {
      navigator.geolocation.getCurrentPosition(
        this.onFix,
        () => void this.tryIpFallback(),
        { enableHighAccuracy: false, maximumAge: 60_000, timeout: 5_000 },
      );
    } else if (!('geolocation' in navigator)) {
      void this.tryIpFallback();
    }
    this.reschedule();
    window.setTimeout(() => {
      if (!useStore.getState().myPos && useStore.getState().settings.shareLocation) {
        void this.tryIpFallback();
      }
    }, 5_500);
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = window.setInterval(() => this.sendHeartbeatPos(), 15_000);
    await this.applyPower();
  }

  /** Force an immediate position acquisition and broadcast to the room (e.g. when pressing ME). */
  forceFix() {
    if (!useStore.getState().settings.shareLocation) {
      useStore.getState().setSettings({ shareLocation: true });
    }
    const existing = useStore.getState().myPos;
    if (existing) {
      const now = Date.now();
      this.lastSent = now;
      socket.send({
        t: 'pos',
        lat: existing.lat,
        lon: existing.lon,
        acc: Math.min(existing.acc, 99999),
        heading: existing.heading == null ? null : Math.round(existing.heading) % 360,
        speed: existing.speed == null || Number.isNaN(existing.speed) ? null : existing.speed,
        bat: this.battery,
        ts: now,
      });
    }
    this.ipFallbackTried = false;
    this.lastSent = 0;
    if (isNative() && this.session) {
      void this.startNative();
    }
    if ('geolocation' in navigator) {
      navigator.geolocation.getCurrentPosition(
        this.onFix,
        () => void this.tryIpFallback(),
        { enableHighAccuracy: this.highAccuracy, maximumAge: 5_000, timeout: 6_000 },
      );
    } else {
      void this.tryIpFallback();
    }
    this.reschedule();
  }

  async stop() {
    this.session = null;
    this.stopWeb();
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
    window.removeEventListener('deviceorientationabsolute', this.onOrientationAbs as EventListener);
    window.removeEventListener('deviceorientation', this.onOrientationRel as EventListener);
    document.removeEventListener('visibilitychange', this.onVisibility);
    for (const l of this.listeners) await l.remove();
    this.listeners = [];
    if (isNative()) await Tactical.stop().catch(() => {});
    await this.releaseWake();
  }

  /** Re-apply after a settings change. */
  async onSettings(prev: Settings, next: Settings) {
    if (!this.session) return;
    if (isNative()) {
      await Tactical.update(this.nativeOpts(next)).catch(() => {});
      if (prev.volumeKeyPtt !== next.volumeKeyPtt) await Tactical.setVolumeKeyPtt({ enabled: next.volumeKeyPtt });
    } else {
      this.reschedule();
    }
    if (prev.mode !== next.mode) await this.applyPower();
  }

  // ---------- power ----------

  private async applyPower() {
    const combat = useStore.getState().settings.mode === 'combat';
    if (isNative()) {
      await Tactical.setKeepScreenOn({ on: combat }).catch(() => {});
      return;
    }
    if (combat) await this.acquireWake();
    else await this.releaseWake();
  }

  private async acquireWake() {
    if (!('wakeLock' in navigator) || this.wakeLock) return;
    try {
      this.wakeLock = await navigator.wakeLock.request('screen');
      this.wakeLock.addEventListener('release', () => (this.wakeLock = null));
    } catch {
      console.debug('[tactic] screen wake lock unavailable');
    }
  }

  private async releaseWake() {
    await this.wakeLock?.release().catch(() => {});
    this.wakeLock = null;
  }

  // ---------- native ----------

  private nativeOpts(s = useStore.getState().settings) {
    return {
      server: this.session!.server,
      token: this.session!.token,
      mode: s.mode,
      activeIntervalMs: s.activeIntervalMs,
      ecoIntervalMs: s.ecoIntervalMs,
      idleIntervalMs: s.idleIntervalMs,
      shareLocation: s.shareLocation,
      title: `${this.session!.self.callsign} · ${this.session!.match.name}`,
    };
  }

  private async startNative() {
    try {
      await Tactical.start(this.nativeOpts());
      await Tactical.setVolumeKeyPtt({ enabled: useStore.getState().settings.volumeKeyPtt });
    } catch (e) {
      useStore.getState().toast('Фоновая работа недоступна: разрешите геолокацию и микрофон в настройках телефона', 'error');
    }
  }

  // ---------- web geolocation ----------

  private get stationary() {
    return Date.now() - this.lastMoveTs > STATIONARY_AFTER_MS;
  }

  private interval(): number {
    const s = useStore.getState().settings;
    if (document.hidden || this.stationary) return s.idleIntervalMs;
    return s.mode === 'combat' ? s.activeIntervalMs : s.ecoIntervalMs;
  }

  private stopWeb() {
    if (this.watchId != null) navigator.geolocation.clearWatch(this.watchId);
    this.watchId = null;
    clearInterval(this.pollTimer);
    this.pollTimer = undefined;
  }

  private onVisibility = () => {
    if (!isNative()) this.reschedule();
    if (document.visibilityState === 'visible' && useStore.getState().settings.mode === 'combat') void this.applyPower();
  };

  /** Choose continuous watch (moving, visible) or sparse polling (stationary/hidden). */
  private reschedule() {
    if (!this.session || !('geolocation' in navigator)) return;
    const s = useStore.getState().settings;
    if (!s.shareLocation) {
      this.stopWeb();
      return;
    }
    const sparse = document.hidden || this.stationary;
    const opts: PositionOptions = { enableHighAccuracy: this.highAccuracy, maximumAge: 3000, timeout: 12_000 };
    if (sparse) {
      if (this.watchId != null) {
        navigator.geolocation.clearWatch(this.watchId);
        this.watchId = null;
      }
      clearInterval(this.pollTimer);
      this.pollTimer = window.setInterval(
        () => navigator.geolocation.getCurrentPosition(this.onFix, this.onGeoError, { ...opts, maximumAge: 5000 }),
        s.idleIntervalMs,
      );
    } else if (this.watchId == null) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
      this.watchId = navigator.geolocation.watchPosition(this.onFix, this.onGeoError, opts);
    }
  }

  private onGeoError = (err: GeolocationPositionError) => {
    if (err.code === err.PERMISSION_DENIED) {
      useStore.getState().toast('Доступ к геолокации запрещён — определение по сети', 'error');
      this.stopWeb();
      void this.tryIpFallback();
      return;
    }
    if (this.highAccuracy) {
      // Fall back to coarse Wi-Fi / cell tower location if satellite GPS times out (e.g. indoors or on PC)
      this.highAccuracy = false;
      this.stopWeb();
      this.reschedule();
      navigator.geolocation.getCurrentPosition(
        this.onFix,
        () => void this.tryIpFallback(),
        { enableHighAccuracy: false, maximumAge: 60_000, timeout: 8_000 },
      );
    } else {
      void this.tryIpFallback();
    }
  };

  private async tryIpFallback() {
    if (this.ipFallbackTried || useStore.getState().myPos || !useStore.getState().settings.shareLocation) return;
    this.ipFallbackTried = true;
    const srv = this.session?.server || '';
    const endpoints: Array<{ url: string; parse: (d: Record<string, unknown>) => [number, number] | null }> = [
      ...(srv
        ? [
            {
              url: `${srv}/api/geo-ip`,
              parse: (d: Record<string, unknown>): [number, number] | null =>
                typeof d.latitude === 'number' && typeof d.longitude === 'number' ? [d.latitude, d.longitude] : null,
            },
          ]
        : []),
      {
        url: 'https://ipwho.is/',
        parse: (d) => (d.success !== false && typeof d.latitude === 'number' && typeof d.longitude === 'number' ? [d.latitude, d.longitude] : null),
      },
      {
        url: 'https://freeipapi.com/api/json',
        parse: (d) => (typeof d.latitude === 'number' && typeof d.longitude === 'number' ? [d.latitude, d.longitude] : null),
      },
      {
        url: 'https://ipapi.co/json/',
        parse: (d) => (typeof d.latitude === 'number' && typeof d.longitude === 'number' ? [d.latitude, d.longitude] : null),
      },
    ];
    for (const ep of endpoints) {
      if (useStore.getState().myPos) return;
      try {
        const res = await fetch(ep.url, { cache: 'no-store', signal: AbortSignal.timeout(3000) });
        if (!res.ok) continue;
        const data = (await res.json()) as Record<string, unknown>;
        const coords = ep.parse(data);
        if (coords && coords[0] !== 0 && coords[1] !== 0) {
          if (useStore.getState().myPos) return;
          const [lat, lon] = coords;
          const now = Date.now();
          useStore.setState({
            myPos: {
              lat,
              lon,
              acc: 1500,
              heading: useStore.getState().compass,
              speed: null,
              ts: now,
              tier: 'ip',
            },
          });
          this.lastSent = now;
          this.lastSentPos = [lat, lon];
          socket.send({
            t: 'pos',
            lat,
            lon,
            acc: 1500,
            heading: null,
            speed: null,
            bat: this.battery,
            ts: now,
          });
          return;
        }
      } catch {
        /* try next endpoint */
      }
    }
  }

  private sendHeartbeatPos() {
    if (!this.session || !useStore.getState().settings.shareLocation) return;
    const pos = useStore.getState().myPos;
    if (!pos) return;
    const now = Date.now();
    if (now - this.lastSent < 12_000) return;
    this.lastSent = now;
    useStore.setState({ myPos: { ...pos, ts: now } });
    socket.send({
      t: 'pos',
      lat: pos.lat,
      lon: pos.lon,
      acc: Math.min(pos.acc, 99999),
      heading: pos.heading == null ? null : Math.round(pos.heading) % 360,
      speed: pos.speed == null || Number.isNaN(pos.speed) ? null : pos.speed,
      bat: this.battery,
      ts: now,
    });
  }

  private onFix = (p: GeolocationPosition) => {
    const { latitude: lat, longitude: lon, accuracy, heading, speed } = p.coords;
    const now = Date.now();
    const here: [number, number] = [lat, lon];

    const wasStationary = this.stationary;
    if (!this.anchor || distance(this.anchor, here) > Math.max(MOVE_THRESHOLD_M, Math.min(accuracy, 30))) {
      this.anchor = here;
      this.lastMoveTs = now;
    }
    if (wasStationary !== this.stationary) this.reschedule();

    const moving = speed != null && speed > 1.2;
    const gpsHeading = moving && heading != null && !Number.isNaN(heading) ? heading : null;
    const hdg = gpsHeading ?? useStore.getState().compass;
    const tier = document.hidden || this.stationary ? 'idle' : useStore.getState().settings.mode === 'combat' ? 'active' : 'eco';
    useStore.setState({ myPos: { lat, lon, acc: accuracy, heading: hdg, speed, ts: now, tier } });

    const jumped = this.lastSentPos ? distance(this.lastSentPos, here) > 25 : true;
    if (now - this.lastSent < this.interval() - 250 && !jumped) return;
    this.lastSent = now;
    this.lastSentPos = here;
    socket.send({
      t: 'pos',
      lat,
      lon,
      acc: Math.min(accuracy, 99999),
      heading: hdg == null ? null : Math.round(hdg) % 360,
      speed: speed == null || Number.isNaN(speed) ? null : speed,
      bat: this.battery,
      ts: now,
    });
  };

  // ---------- compass ----------

  private onOrientationAbs = (e: DeviceOrientationEvent & { webkitCompassHeading?: number }) => {
    this.hasAbsoluteOrientation = true;
    this.handleOrientation(e, true);
  };

  private onOrientationRel = (e: DeviceOrientationEvent & { webkitCompassHeading?: number }) => {
    if (this.hasAbsoluteOrientation) return;
    this.handleOrientation(e, false);
  };

  private handleOrientation(e: DeviceOrientationEvent & { webkitCompassHeading?: number }, isAbsEvent: boolean) {
    const now = Date.now();
    // Throttle high-frequency (60-100Hz) sensor events to at most ~6 updates/sec to keep UI buttery smooth
    if (now - this.lastCompassStoreTs < 160) return;

    let h: number | null = null;
    if (typeof e.webkitCompassHeading === 'number') h = e.webkitCompassHeading;
    else if ((isAbsEvent || e.absolute) && e.alpha != null) h = (360 - e.alpha) % 360;
    if (h == null) return;
    h = (h + (screen.orientation?.angle ?? 0)) % 360;
    const at = useStore.getState().myPos ?? useStore.getState().view;
    if (at) h = norm360(h + declination(at.lat, at.lon));
    h = Math.round(h);
    const prev = useStore.getState().compass;
    if (prev == null || Math.abs(((h - prev + 540) % 360) - 180) >= 4) {
      this.lastCompassStoreTs = now;
      useStore.setState({ compass: h });
    }

    const diff = Math.abs(((h - this.lastHeadingVal + 540) % 360) - 180);
    if (isNative() && !document.hidden && now - this.lastHeadingSent > 1200 && diff > 10) {
      this.lastHeadingSent = now;
      this.lastHeadingVal = h;
      socket.send({ t: 'heading', heading: h % 360 });
    }
  }

  private async watchBattery() {
    const nav = navigator as Navigator & { getBattery?: () => Promise<{ level: number; addEventListener: (e: string, cb: () => void) => void }> };
    if (!nav.getBattery) return;
    try {
      const b = await nav.getBattery();
      const upd = () => (this.battery = Math.round(b.level * 100));
      upd();
      b.addEventListener('levelchange', upd);
    } catch {
      /* unsupported */
    }
  }
}

export const tracker = new Tracker();

/** iOS requires an explicit permission prompt for the compass, from a user gesture. */
export async function requestCompassPermission() {
  const D = DeviceOrientationEvent as unknown as { requestPermission?: () => Promise<string> };
  if (typeof D.requestPermission === 'function') {
    try {
      await D.requestPermission();
    } catch {
      /* denied */
    }
  }
}
