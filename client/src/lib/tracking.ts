// Position uplink with battery-aware throttling, compass heading, and power modes.
//
// Web:    watchPosition while moving and visible; when stationary or hidden it drops to
//         one-shot fixes every idleIntervalMs so the GPS radio can sleep between fixes.
// Native: the Android foreground service owns GPS and posts to /api/telemetry directly
//         (survives a locked screen); the WebView only renders 'location' events.
import type { PluginListenerHandle } from '@capacitor/core';
import { useStore, type Settings } from '../store';
import type { Session } from './api';
import { distance } from './geo';
import { isNative, Tactical } from './native';
import { socket } from './socket';

const STATIONARY_AFTER_MS = 30_000;
const MOVE_THRESHOLD_M = 8;

class Tracker {
  private session: Session | null = null;
  private watchId: number | null = null;
  private pollTimer: number | undefined;
  private lastSent = 0;
  private lastSentPos: [number, number] | null = null;
  private anchor: [number, number] | null = null;
  private lastMoveTs = Date.now();
  private listeners: PluginListenerHandle[] = [];
  private wakeLock: WakeLockSentinel | null = null;
  private lastHeadingSent = 0;
  private lastHeadingVal = -1;
  private battery: number | null = null;

  async start(session: Session) {
    this.session = session;
    window.addEventListener('deviceorientationabsolute', this.onOrientation as EventListener, true);
    window.addEventListener('deviceorientation', this.onOrientation as EventListener, true);
    document.addEventListener('visibilitychange', this.onVisibility);
    this.watchBattery();

    if (isNative()) {
      this.listeners.push(
        await Tactical.addListener('location', (l) => {
          useStore.setState({ myPos: { lat: l.lat, lon: l.lon, acc: l.acc, heading: l.heading, speed: l.speed, ts: l.ts, tier: l.tier } });
        }),
      );
      await this.startNative();
    } else {
      this.reschedule();
    }
    await this.applyPower();
  }

  async stop() {
    this.session = null;
    this.stopWeb();
    window.removeEventListener('deviceorientationabsolute', this.onOrientation as EventListener, true);
    window.removeEventListener('deviceorientation', this.onOrientation as EventListener, true);
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
      useStore.getState().toast('Screen wake lock unavailable', 'error');
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
      useStore.getState().toast(`Background service: ${(e as Error).message}`, 'error');
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
    const opts: PositionOptions = { enableHighAccuracy: true, maximumAge: 1000, timeout: 20_000 };
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
      useStore.getState().toast('Location permission denied', 'error');
      this.stopWeb();
    }
  };

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

  private onOrientation = (e: DeviceOrientationEvent & { webkitCompassHeading?: number }) => {
    let h: number | null = null;
    if (typeof e.webkitCompassHeading === 'number') h = e.webkitCompassHeading;
    else if (e.absolute && e.alpha != null) h = (360 - e.alpha) % 360;
    if (h == null) return;
    // Screen orientation correction
    h = (h + (screen.orientation?.angle ?? 0)) % 360;
    const prev = useStore.getState().compass;
    if (prev == null || Math.abs(((h - prev + 540) % 360) - 180) > 2) useStore.setState({ compass: h });

    // In native mode positions come from the service; push heading separately (only while visible).
    const now = Date.now();
    const diff = Math.abs(((h - this.lastHeadingVal + 540) % 360) - 180);
    if (isNative() && !document.hidden && now - this.lastHeadingSent > 1000 && diff > 10) {
      this.lastHeadingSent = now;
      this.lastHeadingVal = h;
      socket.send({ t: 'heading', heading: Math.round(h) % 360 });
    }
  };

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
