import { create } from 'zustand';
import type {
  Briefing,
  ChatMsg,
  MatchInfo,
  Marker,
  PlayerState,
  Route,
  SelfInfo,
  ServerMsg,
  VoiceChannel,
  Zone,
} from '@tactic/shared';
import type { GridStep } from './lib/geo';
import { sfx, speakTts } from './lib/audio';
import { friendlyMessage } from './lib/errors';

export type PowerMode = 'combat' | 'eco';
/** auto = lite on weak hardware or when the map is measured to stutter. */
export type Graphics = 'auto' | 'full' | 'lite';
export type BaseLayer = 'sat' | 'map2d' | 'map3d' | 'topo';
const BASE_LAYERS: BaseLayer[] = ['sat', 'map2d', 'map3d', 'topo'];
export type Tool = 'pan' | 'zone' | 'route' | 'objective' | 'contact' | 'waypoint' | 'trp' | 'measure';
export type DrawerTab = 'chat' | 'spot' | 'brief' | 'team' | 'settings';

export interface Settings {
  mode: PowerMode;
  shareLocation: boolean;
  /** GPS send intervals in ms */
  activeIntervalMs: number;
  ecoIntervalMs: number;
  idleIntervalMs: number;
  /** headset/media key: hold = press-and-hold (wired), toggle = press to start/stop (most BT) */
  pttKeyMode: 'hold' | 'toggle';
  volumeKeyPtt: boolean;
  radioSounds: boolean;
  tts: boolean;
  baseLayer: BaseLayer;
  followMe: boolean;
  /** tactical grid overlay and its cell size */
  grid: boolean;
  gridStep: GridStep;
  /** centre crosshair with coordinates / sector / range from me */
  crosshair: boolean;
  /** ruler starts at my GPS position */
  rulerFromMe: boolean;
  graphics: Graphics;
  /** rotate the map so the direction the phone faces is up (compass); off = north up */
  headingUp: boolean;
}

const DEFAULT_SETTINGS: Settings = {
  mode: 'eco',
  shareLocation: true,
  activeIntervalMs: 2000,
  ecoIntervalMs: 5000,
  idleIntervalMs: 15000,
  pttKeyMode: 'toggle',
  volumeKeyPtt: false,
  radioSounds: false,
  tts: true,
  baseLayer: 'sat',
  followMe: false,
  grid: true,
  gridStep: 100,
  crosshair: true,
  rulerFromMe: true,
  graphics: 'auto',
  headingUp: false,
};

/**
 * Weak device guess: little RAM (Chrome/WebView report deviceMemory, capped at 8) or few CPU cores.
 * 'auto' also switches to lite at runtime when map panning is measured below ~30 fps (MapView).
 */
const WEAK_DEVICE = (() => {
  const nav = navigator as Navigator & { deviceMemory?: number };
  return (nav.deviceMemory ?? 8) <= 3 || (navigator.hardwareConcurrency ?? 8) <= 4;
})();
let measuredSlow = false;
const liteFor = (g: Graphics) => g === 'lite' || (g === 'auto' && (WEAK_DEVICE || measuredSlow));
const applyLiteClass = (lite: boolean) => document.documentElement.classList.toggle('lite', lite);

const SETTINGS_KEY = 'tactic.settings.v2';
function loadSettings(): Settings {
  try {
    const s: Settings = { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') };
    if (!BASE_LAYERS.includes(s.baseLayer)) s.baseLayer = s.baseLayer === ('osm' as BaseLayer) ? 'map2d' : 'sat';
    if (![50, 100, 250].includes(s.gridStep)) s.gridStep = 100;
    if (!['auto', 'full', 'lite'].includes(s.graphics)) s.graphics = 'auto';
    return s;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export interface MyPos {
  lat: number;
  lon: number;
  acc: number;
  heading: number | null;
  speed: number | null;
  ts: number;
  tier: string;
}

export interface VoiceState {
  status: 'off' | 'connecting' | 'ready' | 'error';
  error?: string;
  channels: VoiceChannel[];
  tx: VoiceChannel;
  transmitting: boolean;
  /** who is currently talking per channel */
  rx: Partial<Record<VoiceChannel, string>>;
}

/** Current map camera, published by MapView for the overlays (crosshair readout, north arrow). */
export interface MapViewState {
  lat: number;
  lon: number;
  zoom: number;
  bearing: number;
  pitch: number;
}

export interface Toast {
  id: number;
  text: string;
  kind: 'info' | 'error' | 'alert';
}

interface State {
  self: SelfInfo | null;
  match: MatchInfo | null;
  connected: boolean;
  latencyMs: number | null;
  clockSkew: number;
  players: Record<string, PlayerState>;
  markers: Record<string, Marker>;
  zones: Record<string, Zone>;
  routes: Record<string, Route>;
  chat: ChatMsg[];
  unread: number;
  briefing: Briefing;
  myPos: MyPos | null;
  compass: number | null;
  settings: Settings;
  /** effective lite graphics (from settings.graphics + device detection) */
  lite: boolean;
  tool: Tool;
  drawer: { open: 'min' | 'mid' | 'max'; tab: DrawerTab };
  /** point picked on the map (long-press) for spot reports */
  picked: { lat: number; lon: number } | null;
  /** vertices of the zone/route/measure being drawn */
  draft: [number, number][];
  view: MapViewState | null;
  voice: VoiceState;
  toasts: Toast[];

  apply(msg: ServerMsg): void;
  setSettings(p: Partial<Settings>): void;
  setDrawer(p: Partial<State['drawer']>): void;
  setTool(t: Tool): void;
  setVoice(p: Partial<VoiceState>): void;
  toast(text: string, kind?: Toast['kind']): void;
  /** MapView measured choppy panning: in 'auto' mode switch to lite graphics. */
  reportSlowMap(): void;
  reset(): void;
}

const byId = <T extends { id: string }>(xs: T[]) => Object.fromEntries(xs.map((x) => [x.id, x]));
let toastSeq = 0;

const initialSettings = loadSettings();
applyLiteClass(liteFor(initialSettings.graphics));

export const useStore = create<State>((set, get) => ({
  self: null,
  match: null,
  connected: false,
  latencyMs: null,
  clockSkew: 0,
  players: {},
  markers: {},
  zones: {},
  routes: {},
  chat: [],
  unread: 0,
  briefing: { text: '', by: '', ts: 0 },
  myPos: null,
  compass: null,
  settings: initialSettings,
  lite: liteFor(initialSettings.graphics),
  tool: 'pan',
  drawer: { open: 'min', tab: 'chat' },
  picked: null,
  draft: [],
  view: null,
  voice: { status: 'off', channels: [], tx: 'squad', transmitting: false, rx: {} },
  toasts: [],

  apply(msg) {
    switch (msg.t) {
      case 'snapshot':
        set({
          self: msg.self,
          match: msg.match,
          players: byId(msg.players),
          markers: byId(msg.markers),
          zones: byId(msg.zones),
          routes: byId(msg.routes),
          chat: msg.chat,
          briefing: msg.briefing,
          clockSkew: msg.serverTs - Date.now(),
        });
        return;
      case 'self':
        set({ self: msg.self });
        return;
      case 'players': {
        const players = { ...get().players };
        for (const p of msg.players) players[p.id] = p;
        set({ players });
        return;
      }
      case 'player.leave': {
        const { [msg.id]: _gone, ...players } = get().players;
        set({ players });
        return;
      }
      case 'voice.rx': {
        const s = get();
        if (msg.fromId === s.self?.id) return;
        const rx = { ...s.voice.rx };
        if (msg.callsign) {
          if (!rx[msg.channel]) sfx.rxStart();
          rx[msg.channel] = msg.callsign;
        } else if (rx[msg.channel]) {
          sfx.rxEnd();
          delete rx[msg.channel];
        }
        set({ voice: { ...s.voice, rx } });
        return;
      }
      case 'voice.busy':
        get().toast(`Канал занят: говорит ${msg.callsign}`, 'error');
        return;
      case 'marker':
        set({ markers: { ...get().markers, [msg.marker.id]: msg.marker } });
        return;
      case 'marker.delete': {
        const { [msg.id]: _m, ...markers } = get().markers;
        set({ markers });
        return;
      }
      case 'zone':
        set({ zones: { ...get().zones, [msg.zone.id]: msg.zone } });
        return;
      case 'zone.delete': {
        const { [msg.id]: _z, ...zones } = get().zones;
        set({ zones });
        return;
      }
      case 'route':
        set({ routes: { ...get().routes, [msg.route.id]: msg.route } });
        return;
      case 'route.delete': {
        const { [msg.id]: _r, ...routes } = get().routes;
        set({ routes });
        return;
      }
      case 'chat': {
        const s = get();
        const chatOpen = s.drawer.open !== 'min' && s.drawer.tab === 'chat';
        set({
          chat: [...s.chat.slice(-299), msg.msg],
          unread: chatOpen || msg.msg.fromId === s.self?.id ? s.unread : s.unread + 1,
        });
        if (msg.msg.kind !== 'text' && msg.msg.fromId !== s.self?.id) s.toast(`${msg.msg.callsign}: ${msg.msg.text}`, 'alert');
        if (msg.msg.fromId !== s.self?.id && s.settings.tts) {
          speakTts(`${msg.msg.callsign}: ${msg.msg.text}`, false, msg.msg.id);
        }
        return;
      }
      case 'briefing':
        set({ briefing: msg.briefing });
        get().toast(`Брифинг обновил ${msg.briefing.by}`);
        return;
      case 'match.end':
        get().toast('Штаб завершил матч', 'alert');
        return;
      case 'pong':
        set({ latencyMs: Date.now() - msg.ts, clockSkew: msg.serverTs - Date.now() });
        return;
      case 'error':
        get().toast(friendlyMessage(msg.code, msg.message), 'error');
        return;
    }
  },

  setSettings(p) {
    const settings = { ...get().settings, ...p };
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch {
      /* storage full / unavailable: keep the setting for this session */
    }
    const lite = liteFor(settings.graphics);
    applyLiteClass(lite);
    set({ settings, lite });
  },
  setDrawer(p) {
    const drawer = { ...get().drawer, ...p };
    set({ drawer, unread: drawer.open !== 'min' && drawer.tab === 'chat' ? 0 : get().unread });
  },
  setTool(tool) {
    set({ tool, draft: [] });
  },
  setVoice(p) {
    set({ voice: { ...get().voice, ...p } });
  },
  toast(text, kind = 'info') {
    const id = ++toastSeq;
    set({ toasts: [...get().toasts.slice(-3), { id, text, kind }] });
    setTimeout(() => set({ toasts: get().toasts.filter((t) => t.id !== id) }), kind === 'error' ? 6000 : 4000);
  },
  reportSlowMap() {
    if (measuredSlow || get().settings.graphics !== 'auto' || get().lite) return;
    measuredSlow = true;
    applyLiteClass(true);
    set({ lite: true });
    get().toast('Карта тормозит — включена облегчённая графика (Настройки → ГРАФИКА)');
  },
  reset() {
    set({
      self: null,
      match: null,
      connected: false,
      players: {},
      markers: {},
      zones: {},
      routes: {},
      chat: [],
      unread: 0,
      myPos: null,
      voice: { status: 'off', channels: [], tx: 'squad', transmitting: false, rx: {} },
    });
  },
}));
