// PTT voice over WebSocket (16 kHz G.711 µ-law).
// Works over any HTTPS / Cloudflare Tunnel / LTE / NAT without requiring UDP ports or STUN/TURN.
import { VOICE_CHANNELS, VOICE_CHANNEL_META, voiceChannelsFor, type SelfInfo, type VoiceChannel } from '@tactic/shared';
import { useStore } from '../store';
import { type Session } from './api';
import { getAudioContext, setMediaSession, sfx, unlockAudio } from './audio';
import { isNative, Tactical } from './native';
import { socket } from './socket';

const SAMPLE_RATE = 16000;
const FRAME_SAMPLES = 640; // 40 ms @ 16 kHz

// Precompute 256-entry µ-law -> Float32 [-1..1] lookup table
const ULAW_DECODE = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const u = ~i & 0xff;
  const sign = u & 0x80;
  const exponent = (u >> 4) & 0x07;
  const mantissa = u & 0x0f;
  let sample = ((mantissa << 3) + 0x84) << exponent;
  sample -= 0x84;
  ULAW_DECODE[i] = (sign ? -sample : sample) / 32768;
}

function linearToUlaw(sample: number): number {
  const CLIP = 32635;
  const BIAS = 0x84;
  let s = Math.max(-1, Math.min(1, sample)) * 32767;
  let sign = 0;
  if (s < 0) {
    sign = 0x80;
    s = -s;
  }
  if (s > CLIP) s = CLIP;
  s += BIAS;
  let exponent = 7;
  for (let expMask = 0x4000; (s & expMask) === 0 && exponent > 0; exponent--, expMask >>= 1) {
    /* find segment */
  }
  const mantissa = (s >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

/** Loads the capture worklet once per AudioContext; false where AudioWorklet is unsupported. */
let workletReady: Promise<boolean> | null = null;
function loadCaptureWorklet(ctx: AudioContext): Promise<boolean> {
  if (!ctx.audioWorklet) return Promise.resolve(false);
  workletReady ??= ctx.audioWorklet
    .addModule(`${import.meta.env.BASE_URL}voice-capture-worklet.js`)
    .then(() => true)
    .catch((e) => {
      console.warn('[voice] AudioWorklet unavailable, using ScriptProcessor', e);
      return false;
    });
  return workletReady;
}

class VoiceManager {
  private stream: MediaStream | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  /** Capture on the audio thread (AudioWorklet); ScriptProcessor only as a fallback for very old WebViews. */
  private worklet: AudioWorkletNode | null = null;
  private procNode: ScriptProcessorNode | null = null;
  private muteGain: GainNode | null = null;
  private holding = false;
  private txSeq = 0;
  private keyedAt = 0;
  private tailTimer: number | undefined;
  private micIdleTimer: number | undefined;
  private txBuf = new Uint8Array(2 + FRAME_SAMPLES);
  private txOffset = 0;
  private nextPlayTime: Record<VoiceChannel, number> = { squad: 0, platoon: 0, command: 0 };
  private rxClearTimers: Partial<Record<VoiceChannel, number>> = {};
  private unsubStore: (() => void) | null = null;

  async connect(session: Session) {
    socket.onBinary = (data) => this.onAudioFrame(data);
    this.syncFromSelf(session.self, useStore.getState().connected);

    this.unsubStore?.();
    this.unsubStore = useStore.subscribe((s, prev) => {
      if (s.self !== prev.self || s.connected !== prev.connected) {
        this.syncFromSelf(s.self ?? session.self, s.connected);
      }
    });
  }

  private syncFromSelf(self: SelfInfo | null, connected: boolean) {
    if (!self) return;
    const channels = voiceChannelsFor(self.squad, self.role);
    const cur = useStore.getState().voice;
    const tx = channels.includes(cur.tx) ? cur.tx : channels[0]!;
    const status = connected ? 'ready' : 'connecting';
    useStore.getState().setVoice({ channels, tx, status, error: undefined });
    setMediaSession(`${self.callsign} · ${VOICE_CHANNEL_META[tx].label}`, () => ptt.toggle('headset'));
  }

  /** Switch active transmit channel. */
  async setTx(channel: VoiceChannel) {
    const v = useStore.getState().voice;
    if (!v.channels.includes(channel)) return;
    if (v.transmitting) await this.keyUp();
    useStore.getState().setVoice({ tx: channel });
    const self = useStore.getState().self;
    if (self) setMediaSession(`${self.callsign} · ${VOICE_CHANNEL_META[channel].label}`, () => ptt.toggle('headset'));
  }

  private onAudioFrame(data: Uint8Array) {
    if (data.length < 4 || data[0] !== 0x56) return;
    const chIdx = data[1]!;
    const channel = VOICE_CHANNELS[chIdx];
    if (!channel) return;

    const ctx = getAudioContext();
    const count = data.length - 2;
    const buf = ctx.createBuffer(1, count, SAMPLE_RATE);
    const chData = buf.getChannelData(0);
    for (let i = 0; i < count; i++) {
      chData[i] = ULAW_DECODE[data[i + 2]!]!;
    }

    const src = ctx.createBufferSource();
    src.buffer = buf;

    // Gentle walkie-talkie bandpass + gain boost for outdoor readability
    const gain = ctx.createGain();
    gain.gain.value = 1.35;
    src.connect(gain).connect(ctx.destination);

    const now = ctx.currentTime;
    let startAt = this.nextPlayTime[channel] || 0;
    if (startAt < now) startAt = now + 0.045; // 45 ms jitter buffer
    else if (startAt > now + 0.6) startAt = now + 0.045;
    src.start(startAt);
    this.nextPlayTime[channel] = startAt + buf.duration;

    // Safety fallback: clear RX indicator if voice.rx stop frame was missed
    clearTimeout(this.rxClearTimers[channel]);
    this.rxClearTimers[channel] = window.setTimeout(() => {
      const rx = { ...useStore.getState().voice.rx };
      if (rx[channel]) {
        delete rx[channel];
        useStore.getState().setVoice({ rx });
      }
    }, 1800);
  }

  private async ensureMic(): Promise<boolean> {
    clearTimeout(this.micIdleTimer);
    if (this.stream && this.stream.active && (this.worklet || this.procNode)) return true;
    if (!navigator.mediaDevices?.getUserMedia) {
      useStore.getState().toast('Микрофон недоступен (нужен HTTPS или разрешение)', 'error');
      return false;
    }
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
          sampleRate: SAMPLE_RATE,
        },
      });
      const ctx = getAudioContext();
      this.sourceNode = ctx.createMediaStreamSource(this.stream);
      this.muteGain = ctx.createGain();
      this.muteGain.gain.value = 0;
      this.muteGain.connect(ctx.destination);

      if (await loadCaptureWorklet(ctx)) {
        const node = new AudioWorkletNode(ctx, 'voice-capture', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
        node.port.onmessage = (e: MessageEvent<Uint8Array>) => {
          const chIdx = VOICE_CHANNELS.indexOf(useStore.getState().voice.tx);
          if (chIdx < 0 || !useStore.getState().voice.transmitting) return;
          const frame = new Uint8Array(2 + e.data.length);
          frame[0] = 0x56;
          frame[1] = chIdx;
          frame.set(e.data, 2);
          socket.sendBinary(frame);
        };
        this.sourceNode.connect(node);
        node.connect(this.muteGain); // keeps the node pulled by the graph; output is silent
        this.worklet = node;
        return true;
      }

      this.procNode = ctx.createScriptProcessor(2048, 1, 1);

      const inRate = ctx.sampleRate;
      const ratio = inRate / SAMPLE_RATE;
      let readPos = 0;

      this.procNode.onaudioprocess = (ev) => {
        if (!useStore.getState().voice.transmitting) return;
        const input = ev.inputBuffer.getChannelData(0);
        const chIdx = VOICE_CHANNELS.indexOf(useStore.getState().voice.tx);
        if (chIdx < 0) return;

        while (readPos < input.length) {
          const idx = Math.min(input.length - 1, Math.floor(readPos));
          this.txBuf[2 + this.txOffset++] = linearToUlaw(input[idx]!);
          if (this.txOffset >= FRAME_SAMPLES) {
            this.txBuf[0] = 0x56;
            this.txBuf[1] = chIdx;
            socket.sendBinary(this.txBuf.slice());
            this.txOffset = 0;
          }
          readPos += ratio;
        }
        readPos -= input.length;
      };

      this.sourceNode.connect(this.procNode);
      this.procNode.connect(this.muteGain);
      return true;
    } catch {
      useStore.getState().toast('Разрешите доступ к микрофону для рации', 'error');
      return false;
    }
  }

  private releaseMic() {
    clearTimeout(this.micIdleTimer);
    try {
      this.sourceNode?.disconnect();
      this.worklet?.port.postMessage('stop');
      this.worklet?.disconnect();
      this.procNode?.disconnect();
      this.muteGain?.disconnect();
    } catch {
      /* ignore */
    }
    this.sourceNode = null;
    this.worklet = null;
    this.procNode = null;
    this.muteGain = null;
    if (this.stream) {
      for (const t of this.stream.getTracks()) t.stop();
      this.stream = null;
    }
  }

  async keyDown() {
    clearTimeout(this.tailTimer);
    clearTimeout(this.micIdleTimer);
    unlockAudio();

    const state = useStore.getState();
    const v = state.voice;
    if (!state.connected || v.status !== 'ready') {
      sfx.error();
      return;
    }
    if (this.holding && v.transmitting) return;

    this.holding = true;
    const seq = ++this.txSeq;
    this.keyedAt = performance.now();
    this.txOffset = 0;

    useStore.getState().setVoice({ transmitting: true });
    navigator.vibrate?.(25);
    sfx.txStart();

    const ok = await this.ensureMic();
    if (!ok || !this.holding || this.txSeq !== seq) {
      if (this.txSeq === seq) this.finishStopTx();
      return;
    }

    this.worklet?.port.postMessage('start');
    socket.send({ t: 'voice.tx', channel: useStore.getState().voice.tx, active: true });
    if (isNative()) void Tactical.setTransmitting({ on: true }).catch(() => {});
  }

  async keyUp() {
    if (!this.holding && !useStore.getState().voice.transmitting) return;
    this.holding = false;
    const seq = this.txSeq;
    const held = performance.now() - this.keyedAt;
    const delay = held < 220 ? Math.max(80, 220 - held) : 120;

    clearTimeout(this.tailTimer);
    this.tailTimer = window.setTimeout(() => {
      if (!this.holding && this.txSeq === seq) {
        this.finishStopTx();
      }
    }, delay);
  }

  private finishStopTx() {
    const v = useStore.getState().voice;
    if (!v.transmitting) return;
    this.worklet?.port.postMessage('stop');
    if (this.txOffset > 0) {
      const chIdx = VOICE_CHANNELS.indexOf(v.tx);
      if (chIdx >= 0) {
        this.txBuf[0] = 0x56;
        this.txBuf[1] = chIdx;
        socket.sendBinary(this.txBuf.subarray(0, 2 + this.txOffset).slice());
      }
      this.txOffset = 0;
    }
    useStore.getState().setVoice({ transmitting: false });
    socket.send({ t: 'voice.tx', channel: v.tx, active: false });
    sfx.txEnd();
    if (isNative()) void Tactical.setTransmitting({ on: false }).catch(() => {});

    // Release microphone hardware after 20s of idle so OS mic indicator turns off when not talking
    clearTimeout(this.micIdleTimer);
    this.micIdleTimer = window.setTimeout(() => {
      if (!this.holding && !useStore.getState().voice.transmitting) {
        this.releaseMic();
      }
    }, 20_000);
  }

  async disconnect() {
    this.holding = false;
    this.txSeq++;
    clearTimeout(this.tailTimer);
    this.unsubStore?.();
    this.unsubStore = null;
    this.releaseMic();
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
