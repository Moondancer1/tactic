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

export type PowerMode = 'combat' | 'eco';
export type BaseLayer = 'osm' | 'sat' | 'topo';
export type Tool = 'pan' | 'zone' | 'route' | 'objective' | 'contact' | 'waypoint' | 'measure';
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
  baseLayer: BaseLayer;
  followMe: boolean;
}

const DEFAULT_SETTINGS: Settings = {
  mode: 'eco',
  shareLocation: true,
  activeIntervalMs: 2000,
  ecoIntervalMs: 5000,
  idleIntervalMs: 15000,
  pttKeyMode: 'toggle',
  volumeKeyPtt: false,
  radioSounds: true,
  baseLayer: 'sat',
  followMe: false,
};

const SETTINGS_KEY = 'tactic.settings';
function loadSettings(): Settings {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') };
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
  tool: Tool;
  drawer: { open: 'min' | 'mid' | 'max'; tab: DrawerTab };
  /** point picked on the map (long-press) for spot reports */
  picked: { lat: number; lon: number } | null;
  /** vertices of the zone/route/measure being drawn */
  draft: [number, number][];
  voice: VoiceState;
  toasts: Toast[];

  apply(msg: ServerMsg): void;
  setSettings(p: Partial<Settings>): void;
  setDrawer(p: Partial<State['drawer']>): void;
  setTool(t: Tool): void;
  setVoice(p: Partial<VoiceState>): void;
  toast(text: string, kind?: Toast['kind']): void;
  reset(): void;
}

const byId = <T extends { id: string }>(xs: T[]) => Object.fromEntries(xs.map((x) => [x.id, x]));
let toastSeq = 0;

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
  settings: loadSettings(),
  tool: 'pan',
  drawer: { open: 'min', tab: 'chat' },
  picked: null,
  draft: [],
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
        return;
      }
      case 'briefing':
        set({ briefing: msg.briefing });
        get().toast(`Briefing updated by ${msg.briefing.by}`);
        return;
      case 'match.end':
        get().toast('Match ended by HQ', 'alert');
        return;
      case 'pong':
        set({ latencyMs: Date.now() - msg.ts, clockSkew: msg.serverTs - Date.now() });
        return;
      case 'error':
        get().toast(msg.message, 'error');
        return;
    }
  },

  setSettings(p) {
    const settings = { ...get().settings, ...p };
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    set({ settings });
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
