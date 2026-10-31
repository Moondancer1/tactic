// PTT voice over LiveKit SFU. One LiveKit room per channel (squad / platoon / command).
// The member listens to every channel it is granted and transmits on one selected channel.
// The mic track is published once, muted; PTT just unmutes it (≈ no key-up latency).
import {
  AudioPresets,
  createLocalAudioTrack,
  Room,
  RoomEvent,
  Track,
  type LocalAudioTrack,
  type Participant,
  type RemoteTrack,
  type TrackPublication,
} from 'livekit-client';
import { VOICE_CHANNEL_META, type VoiceChannel, type VoiceInfo } from '@tactic/shared';
import { useStore } from '../store';
import { api, type Session } from './api';
import { setMediaSession, sfx } from './audio';
import { isNative, Tactical } from './native';

class VoiceManager {
  private rooms = new Map<VoiceChannel, Room>();
  private mic: LocalAudioTrack | null = null;
  private txRoom: Room | null = null;
  private keyedAt = 0;
  private audioEls = new Set<HTMLMediaElement>();
  private session: Session | null = null;
  private retryTimer: number | undefined;

  async connect(session: Session) {
    this.session = session;
    const set = useStore.getState().setVoice;
    set({ status: 'connecting', error: undefined });
    let info: VoiceInfo;
    try {
      info = await api.voice(session);
    } catch (e) {
      set({ status: 'error', error: (e as Error).message });
      return;
    }
    try {
      await Promise.all(info.channels.map((g) => this.joinRoom(info.url, g.channel, g.token)));
      const channels = info.channels.map((c) => c.channel);
      const prefTx = useStore.getState().voice.tx;
      const tx = channels.includes(prefTx) ? prefTx : channels[0]!;
      set({ channels, status: 'ready' });
      await this.setTx(tx);
      setMediaSession(`${session.self.callsign} · ${VOICE_CHANNEL_META[tx].label}`, () => ptt.toggle('headset'));
    } catch (e) {
      console.error('voice connect failed', e);
      set({ status: 'error', error: (e as Error).message });
      this.retryTimer = window.setTimeout(() => this.reconnect(), 8000);
    }
  }

  private async reconnect() {
    if (!this.session) return;
    const s = this.session;
    await this.disconnect(false);
    await this.connect(s);
  }

  private async joinRoom(url: string, channel: VoiceChannel, token: string) {
    const room = new Room({
      adaptiveStream: false,
      dynacast: false,
      disconnectOnPageLeave: true,
      audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      publishDefaults: { dtx: true, red: true, audioPreset: AudioPresets.speech, stopMicTrackOnMute: false },
    });

    room
      .on(RoomEvent.TrackSubscribed, (track: RemoteTrack) => {
        if (track.kind !== Track.Kind.Audio) return;
        const el = track.attach();
        el.dataset.channel = channel;
        el.setAttribute('playsinline', '');
        document.body.appendChild(el);
        this.audioEls.add(el);
      })
      .on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => {
        for (const el of track.detach()) {
          this.audioEls.delete(el);
          el.remove();
        }
      })
      .on(RoomEvent.TrackUnmuted, (pub: TrackPublication, p: Participant) => {
        if (p.isLocal || pub.kind !== Track.Kind.Audio) return;
        sfx.rxStart();
        const v = useStore.getState().voice;
        useStore.getState().setVoice({ rx: { ...v.rx, [channel]: p.name || p.identity } });
      })
      .on(RoomEvent.TrackMuted, (pub: TrackPublication, p: Participant) => {
        if (p.isLocal || pub.kind !== Track.Kind.Audio) return;
        this.rxStopped(channel, p);
      })
      .on(RoomEvent.ParticipantDisconnected, (p: Participant) => this.rxStopped(channel, p))
      .on(RoomEvent.AudioPlaybackStatusChanged, () => {
        if (!room.canPlaybackAudio) void room.startAudio().catch(() => {});
      })
      .on(RoomEvent.Disconnected, () => {
        if (this.rooms.get(channel) !== room) return;
        useStore.getState().setVoice({ status: 'error', error: `${VOICE_CHANNEL_META[channel].short} disconnected` });
        clearTimeout(this.retryTimer);
        this.retryTimer = window.setTimeout(() => this.reconnect(), 3000);
      });

    await room.connect(url, token, { autoSubscribe: true });
    await room.startAudio().catch(() => {});
    this.rooms.set(channel, room);
  }

  private rxStopped(channel: VoiceChannel, p: Participant) {
    const v = useStore.getState().voice;
    if (v.rx[channel] !== (p.name || p.identity)) return;
    sfx.rxEnd();
    const rx = { ...v.rx };
    delete rx[channel];
    useStore.getState().setVoice({ rx });
  }

  /** Move the (muted) mic publication to another channel. */
  async setTx(channel: VoiceChannel) {
    const room = this.rooms.get(channel);
    if (!room) return;
    if (useStore.getState().voice.transmitting) await this.keyUp();
    if (!this.mic) {
      this.mic = await createLocalAudioTrack({ echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 });
    }
    if (this.txRoom && this.txRoom !== room) {
      await this.txRoom.localParticipant.unpublishTrack(this.mic, false).catch(() => {});
    }
    if (this.txRoom !== room) {
      await room.localParticipant.publishTrack(this.mic, {
        source: Track.Source.Microphone,
        dtx: true,
        red: true,
        audioPreset: AudioPresets.speech,
      });
      await this.mic.mute();
      this.txRoom = room;
    }
    useStore.getState().setVoice({ tx: channel });
  }

  async keyDown() {
    const v = useStore.getState().voice;
    if (v.status !== 'ready' || !this.mic || v.transmitting) {
      if (v.status !== 'ready') sfx.error();
      return;
    }
    this.keyedAt = performance.now();
    useStore.getState().setVoice({ transmitting: true });
    sfx.txStart();
    navigator.vibrate?.(30);
    await this.mic.unmute();
    if (isNative()) void Tactical.setTransmitting({ on: true }).catch(() => {});
  }

  async keyUp() {
    const v = useStore.getState().voice;
    if (!v.transmitting || !this.mic) return;
    // Tail: keep the mic open ~150 ms so the last syllable is not clipped.
    const held = performance.now() - this.keyedAt;
    await new Promise((r) => setTimeout(r, held < 300 ? 300 - held : 150));
    await this.mic.mute();
    useStore.getState().setVoice({ transmitting: false });
    sfx.txEnd();
    if (isNative()) void Tactical.setTransmitting({ on: false }).catch(() => {});
  }

  async disconnect(forget = true) {
    clearTimeout(this.retryTimer);
    if (forget) this.session = null;
    const rooms = [...this.rooms.values()];
    this.rooms.clear();
    this.txRoom = null;
    await Promise.allSettled(rooms.map((r) => r.disconnect()));
    this.mic?.stop();
    this.mic = null;
    for (const el of this.audioEls) el.remove();
    this.audioEls.clear();
    useStore.getState().setVoice({ status: 'off', channels: [], transmitting: false, rx: {} });
  }
}

export const voice = new VoiceManager();

/** Unifies on-screen button, keyboard, headset and volume keys into one PTT state machine. */
export const ptt = {
  down(_source: string) {
    void voice.keyDown();
  },
  up(_source: string) {
    void voice.keyUp();
  },
  toggle(source: string) {
    if (useStore.getState().voice.transmitting) ptt.up(source);
    else ptt.down(source);
  },
};
