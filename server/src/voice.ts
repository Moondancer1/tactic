// LiveKit access tokens: one room per voice channel, grants derived from squad/role.
import { AccessToken, TrackSource } from 'livekit-server-sdk';
import { voiceChannelsFor, voiceRoomName, type SelfInfo, type VoiceInfo } from '@tactic/shared';
import { config } from './config.js';

export const voiceEnabled = () =>
  Boolean(config.livekit.url && config.livekit.apiKey && config.livekit.apiSecret);

/**
 * LIVEKIT_URL=auto derives the signalling URL from the request host, so the same
 * build works behind a tunnel or LAN address that is not known in advance.
 */
export function livekitUrlFor(host: string | undefined, protocol: string): string {
  if (config.livekit.url !== 'auto') return config.livekit.url;
  return `${protocol === 'https' ? 'wss' : 'ws'}://${host ?? 'localhost'}`;
}

export async function voiceGrants(self: SelfInfo, url = config.livekit.url): Promise<VoiceInfo> {
  const channels = await Promise.all(
    voiceChannelsFor(self.squad, self.role).map(async (channel) => {
      const room = voiceRoomName(self.matchId, channel, self.squad);
      const at = new AccessToken(config.livekit.apiKey, config.livekit.apiSecret, {
        identity: self.id,
        name: self.callsign,
        ttl: '12h',
        metadata: JSON.stringify({ squad: self.squad, role: self.role }),
      });
      at.addGrant({
        room,
        roomJoin: true,
        canPublish: true,
        canPublishData: false,
        canSubscribe: true,
        canPublishSources: [TrackSource.MICROPHONE],
      });
      return { channel, room, token: await at.toJwt(), canPublish: true };
    }),
  );
  return { url, channels };
}
