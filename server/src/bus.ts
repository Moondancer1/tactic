// Fan-out between server instances. Without REDIS_URL everything stays in-process.
import { Redis } from 'ioredis';
import { nanoid } from 'nanoid';
import type { PlayerState, ServerMsg, Squad, VoiceChannel } from '@tactic/shared';
import { config } from './config.js';

export interface AudioPacket {
  matchId: string;
  channel: VoiceChannel;
  squad: Squad | null;
  fromId: string;
  callsign: string;
  data: Buffer;
}

export interface Envelope {
  origin: string;
  matchId: string;
  msg?: ServerMsg;
  audio?: {
    channel: VoiceChannel;
    squad: Squad | null;
    fromId: string;
    callsign: string;
    b64: string;
  };
}

type Handler = (env: Envelope) => void;

const CHANNEL = 'tactic:events';
const playersKey = (matchId: string) => `tactic:players:${matchId}`;

export class Bus {
  readonly instanceId = nanoid(8);
  private handler: Handler = () => {};
  private pub: Redis | null = null;
  private sub: Redis | null = null;

  async start(handler: Handler, log: (m: string) => void) {
    this.handler = handler;
    if (!config.redisUrl) {
      log('bus: in-process (no REDIS_URL)');
      return;
    }
    this.pub = new Redis(config.redisUrl, { maxRetriesPerRequest: 2, enableAutoPipelining: true });
    this.sub = new Redis(config.redisUrl);
    await this.sub.subscribe(CHANNEL);
    this.sub.on('message', (_ch, raw) => {
      try {
        const env = JSON.parse(raw) as Envelope;
        // Local publishes are delivered synchronously in publish(); skip the echo.
        if (env.origin !== this.instanceId) this.handler(env);
      } catch {
        /* ignore malformed */
      }
    });
    log(`bus: redis ${config.redisUrl.replace(/\/\/.*@/, '//***@')}`);
  }

  publish(matchId: string, msg: ServerMsg) {
    const env: Envelope = { origin: this.instanceId, matchId, msg };
    this.handler(env);
    this.pub?.publish(CHANNEL, JSON.stringify(env)).catch(() => {});
  }

  publishAudio(pkt: AudioPacket) {
    const env: Envelope = {
      origin: this.instanceId,
      matchId: pkt.matchId,
      audio: {
        channel: pkt.channel,
        squad: pkt.squad,
        fromId: pkt.fromId,
        callsign: pkt.callsign,
        b64: pkt.data.toString('base64'),
      },
    };
    this.handler(env);
    this.pub?.publish(CHANNEL, JSON.stringify(env)).catch(() => {});
  }

  /** Persist latest player states so a restarted instance still shows last known positions. */
  savePlayers(matchId: string, players: PlayerState[]) {
    if (!this.pub || players.length === 0) return;
    const flat: string[] = [];
    for (const p of players) flat.push(p.id, JSON.stringify(p));
    const key = playersKey(matchId);
    this.pub.multi().hset(key, ...flat).expire(key, 2 * 86400).exec().catch(() => {});
  }

  removePlayer(matchId: string, playerId: string) {
    if (!this.pub) return;
    this.pub.hdel(playersKey(matchId), playerId).catch(() => {});
  }

  async loadPlayers(matchId: string): Promise<PlayerState[]> {
    if (!this.pub) return [];
    try {
      const all = await this.pub.hgetall(playersKey(matchId));
      return Object.values(all).map((v) => JSON.parse(v) as PlayerState);
    } catch {
      return [];
    }
  }

  async stop() {
    await Promise.allSettled([this.pub?.quit(), this.sub?.quit()]);
  }
}
