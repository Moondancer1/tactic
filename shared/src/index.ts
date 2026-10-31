// Wire protocol shared by server and client. One match = one side (team).
import { z } from 'zod';

export const PROTOCOL_VERSION = 1;

export const SQUADS = ['alpha', 'bravo', 'charlie', 'overwatch', 'command'] as const;
export type Squad = (typeof SQUADS)[number];

export const ROLES = ['rifleman', 'leader', 'medic', 'marksman', 'mg', 'recon', 'commander'] as const;
export type Role = (typeof ROLES)[number];

/** Roles allowed to edit zones, routes, objectives and the briefing. Require the match command PIN. */
export const COMMAND_ROLES: readonly Role[] = ['leader', 'commander'];
export const isCommandRole = (r: Role) => COMMAND_ROLES.includes(r);

export const SQUAD_META: Record<Squad, { label: string; color: string; short: string }> = {
  alpha: { label: 'Alpha', color: '#3fa7ff', short: 'A' },
  bravo: { label: 'Bravo', color: '#ffb000', short: 'B' },
  charlie: { label: 'Charlie', color: '#c084fc', short: 'C' },
  overwatch: { label: 'Overwatch', color: '#34d399', short: 'OW' },
  command: { label: 'Command', color: '#e5e7eb', short: 'HQ' },
};

export const ROLE_META: Record<Role, { label: string; short: string }> = {
  rifleman: { label: 'Rifleman', short: 'RFL' },
  leader: { label: 'Squad leader', short: 'SL' },
  medic: { label: 'Medic', short: 'MED' },
  marksman: { label: 'Marksman', short: 'DMR' },
  mg: { label: 'Machine gunner', short: 'MG' },
  recon: { label: 'Recon', short: 'RCN' },
  commander: { label: 'Commander', short: 'CO' },
};

export const PLAYER_STATUSES = ['ok', 'hit', 'medic', 'out'] as const;
export type PlayerStatus = (typeof PLAYER_STATUSES)[number];

export const VOICE_CHANNELS = ['squad', 'platoon', 'command'] as const;
export type VoiceChannel = (typeof VOICE_CHANNELS)[number];
export const VOICE_CHANNEL_META: Record<VoiceChannel, { label: string; short: string }> = {
  squad: { label: 'Squad net', short: 'SQD' },
  platoon: { label: 'Platoon all-call', short: 'ALL' },
  command: { label: 'Command net', short: 'CMD' },
};

export const CHAT_CHANNELS = ['all', 'squad', 'command'] as const;
export type ChatChannel = (typeof CHAT_CHANNELS)[number];

// ---------- primitives ----------
const lat = z.number().finite().min(-90).max(90);
const lon = z.number().finite().min(-180).max(180);
const id = z.string().regex(/^[A-Za-z0-9_-]{4,40}$/);
const text = (max: number) => z.string().trim().min(1).max(max);
export const LatLonSchema = z.tuple([lat, lon]);
export type LatLon = z.infer<typeof LatLonSchema>;

// ---------- position ----------
export const PosSchema = z.object({
  lat,
  lon,
  acc: z.number().min(0).max(100000).default(0),
  heading: z.number().min(0).max(360).nullable().default(null),
  speed: z.number().min(0).max(500).nullable().default(null),
  bat: z.number().min(0).max(100).nullable().optional(),
  ts: z.number().int().positive(),
});
export type PosInput = z.infer<typeof PosSchema>;

export interface PlayerState {
  id: string;
  callsign: string;
  squad: Squad;
  role: Role;
  status: PlayerStatus;
  online: boolean;
  lat: number | null;
  lon: number | null;
  acc: number;
  heading: number | null;
  speed: number | null;
  bat: number | null;
  /** ms epoch of last position fix */
  ts: number;
}

// ---------- markers ----------
export const MARKER_KINDS = ['objective', 'contact', 'waypoint', 'rally', 'medic', 'danger'] as const;
export type MarkerKind = (typeof MARKER_KINDS)[number];
export const MARKER_STATUSES = ['active', 'captured', 'lost', 'cleared'] as const;
export const CONTACT_TYPES = ['infantry', 'sniper', 'mg', 'vehicle', 'unknown'] as const;

export const MarkerInputSchema = z.object({
  id: id.optional(),
  kind: z.enum(MARKER_KINDS),
  label: z.string().trim().max(40).default(''),
  lat,
  lon,
  status: z.enum(MARKER_STATUSES).default('active'),
  contactType: z.enum(CONTACT_TYPES).optional(),
  count: z.number().int().min(0).max(99).optional(),
  /** seconds until auto-removal; 0/undefined = permanent */
  ttlSec: z.number().int().min(0).max(86400).optional(),
  note: z.string().trim().max(200).optional(),
});
export type MarkerInput = z.infer<typeof MarkerInputSchema>;
export type Marker = Omit<MarkerInput, 'id'> & {
  id: string;
  createdBy: string;
  createdById: string;
  createdAt: number;
  updatedAt: number;
  expiresAt: number | null;
};

// ---------- zones / routes ----------
export const ZONE_KINDS = ['friendly', 'hostile', 'neutral', 'objective', 'restricted'] as const;
export type ZoneKind = (typeof ZONE_KINDS)[number];
export const ZoneInputSchema = z.object({
  id: id.optional(),
  name: z.string().trim().max(40).default(''),
  kind: z.enum(ZONE_KINDS),
  points: z.array(LatLonSchema).min(3).max(300),
});
export type ZoneInput = z.infer<typeof ZoneInputSchema>;
export type Zone = Omit<ZoneInput, 'id'> & { id: string; createdBy: string; updatedAt: number };

export const RouteInputSchema = z.object({
  id: id.optional(),
  label: z.string().trim().max(40).default(''),
  squad: z.enum(SQUADS),
  points: z.array(LatLonSchema).min(2).max(300),
});
export type RouteInput = z.infer<typeof RouteInputSchema>;
export type Route = Omit<RouteInput, 'id'> & { id: string; createdBy: string; updatedAt: number };

// ---------- chat ----------
export interface ChatMsg {
  id: string;
  channel: ChatChannel;
  /** squad the message belongs to when channel === 'squad' */
  squad: Squad | null;
  fromId: string;
  callsign: string;
  kind: 'text' | 'spot' | 'system';
  text: string;
  lat?: number;
  lon?: number;
  ts: number;
}

export interface Briefing {
  text: string;
  by: string;
  ts: number;
}

export interface MatchInfo {
  id: string;
  name: string;
  code: string;
  createdAt: number;
  endedAt: number | null;
}

export interface SelfInfo {
  id: string;
  callsign: string;
  squad: Squad;
  role: Role;
  matchId: string;
}

// ---------- client -> server ----------
export const ClientMsgSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('hello'), token: z.string().min(10).max(2000), v: z.number().int().optional() }),
  z.object({ t: z.literal('pos') }).merge(PosSchema),
  z.object({ t: z.literal('heading'), heading: z.number().min(0).max(360) }),
  z.object({ t: z.literal('status'), status: z.enum(PLAYER_STATUSES) }),
  z.object({
    t: z.literal('chat'),
    channel: z.enum(CHAT_CHANNELS),
    text: text(500),
    spot: z.object({ lat, lon }).optional(),
  }),
  z.object({ t: z.literal('marker.upsert'), marker: MarkerInputSchema }),
  z.object({ t: z.literal('marker.delete'), id }),
  z.object({ t: z.literal('zone.upsert'), zone: ZoneInputSchema }),
  z.object({ t: z.literal('zone.delete'), id }),
  z.object({ t: z.literal('route.upsert'), route: RouteInputSchema }),
  z.object({ t: z.literal('route.delete'), id }),
  z.object({ t: z.literal('briefing.set'), text: z.string().max(20000) }),
  z.object({ t: z.literal('ping'), ts: z.number() }),
]);
export type ClientMsg = z.infer<typeof ClientMsgSchema>;

// ---------- server -> client ----------
export type ServerMsg =
  | {
      t: 'snapshot';
      self: SelfInfo;
      match: MatchInfo;
      players: PlayerState[];
      markers: Marker[];
      zones: Zone[];
      routes: Route[];
      chat: ChatMsg[];
      briefing: Briefing;
      serverTs: number;
    }
  | { t: 'players'; players: PlayerState[] }
  | { t: 'player.leave'; id: string }
  | { t: 'marker'; marker: Marker }
  | { t: 'marker.delete'; id: string }
  | { t: 'zone'; zone: Zone }
  | { t: 'zone.delete'; id: string }
  | { t: 'route'; route: Route }
  | { t: 'route.delete'; id: string }
  | { t: 'chat'; msg: ChatMsg }
  | { t: 'briefing'; briefing: Briefing }
  | { t: 'match.end'; endedAt: number }
  | { t: 'pong'; ts: number; serverTs: number }
  | { t: 'error'; code: string; message: string };

// ---------- REST payloads ----------
export const JoinSchema = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{4,12}$/),
  callsign: z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9 _-]{1,15}$/),
  squad: z.enum(SQUADS),
  role: z.enum(ROLES),
  pin: z.string().trim().max(32).optional(),
});
export type JoinRequest = z.infer<typeof JoinSchema>;
export interface JoinResponse {
  token: string;
  self: SelfInfo;
  match: MatchInfo;
}

export const CreateMatchSchema = z.object({
  name: z.string().trim().min(1).max(80),
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{4,12}$/).optional(),
  commandPin: z.string().trim().min(4).max(32),
});

export interface VoiceChannelGrant {
  channel: VoiceChannel;
  room: string;
  token: string;
  canPublish: boolean;
}
export interface VoiceInfo {
  url: string;
  channels: VoiceChannelGrant[];
}

/** Which voice channels a member may join. */
export function voiceChannelsFor(squad: Squad, role: Role): VoiceChannel[] {
  const out: VoiceChannel[] = ['platoon'];
  if (squad !== 'command') out.unshift('squad');
  if (isCommandRole(role) || squad === 'command') out.push('command');
  return out;
}

export function voiceRoomName(matchId: string, ch: VoiceChannel, squad: Squad): string {
  if (ch === 'squad') return `m-${matchId}-sq-${squad}`;
  return `m-${matchId}-${ch}`;
}

/** Can the given member read a chat message? */
export function canSeeChat(msg: Pick<ChatMsg, 'channel' | 'squad'>, squad: Squad, role: Role): boolean {
  if (msg.channel === 'all') return true;
  if (msg.channel === 'command') return isCommandRole(role) || squad === 'command';
  return msg.squad === squad || role === 'commander';
}
