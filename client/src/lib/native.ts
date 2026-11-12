// Bridge to the Android foreground service plugin (client/android/.../TacticalPlugin.java).
// On the web every call is a no-op and isNative() is false.
import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';

export interface NativeLocation {
  lat: number;
  lon: number;
  acc: number;
  heading: number | null;
  speed: number | null;
  bat: number | null;
  ts: number;
  /** Interval the service currently uses: active | eco | idle */
  tier: string;
}

export interface PttKeyEvent {
  action: 'down' | 'up';
  source: 'headset' | 'volume';
  keyCode: number;
}

export interface ServiceOptions {
  server: string;
  token: string;
  mode: 'combat' | 'eco';
  activeIntervalMs: number;
  ecoIntervalMs: number;
  idleIntervalMs: number;
  shareLocation: boolean;
  title?: string;
}

interface TacticalPlugin {
  start(opts: ServiceOptions): Promise<void>;
  update(opts: Partial<ServiceOptions>): Promise<void>;
  stop(): Promise<void>;
  setKeepScreenOn(opts: { on: boolean }): Promise<void>;
  setVolumeKeyPtt(opts: { enabled: boolean }): Promise<void>;
  setTransmitting(opts: { on: boolean }): Promise<void>;
  speak(opts: { text: string; lang?: 'ru-RU' | 'en-US'; flush?: boolean }): Promise<void>;
  isIgnoringBatteryOptimizations(): Promise<{ value: boolean }>;
  requestIgnoreBatteryOptimizations(): Promise<void>;
  addListener(event: 'location', cb: (l: NativeLocation) => void): Promise<PluginListenerHandle>;
  addListener(event: 'pttKey', cb: (e: PttKeyEvent) => void): Promise<PluginListenerHandle>;
  addListener(event: 'serviceStopped', cb: () => void): Promise<PluginListenerHandle>;
}

export const isNative = () => Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';

export const Tactical = registerPlugin<TacticalPlugin>('Tactical');
