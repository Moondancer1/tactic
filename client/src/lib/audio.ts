// Radio feedback tones (synthesised, no assets) and background-audio keep-alive.
import { useStore } from '../store';

let ctx: AudioContext | null = null;
let noise: AudioBuffer | null = null;

/** Must be called from a user gesture once (login / first tap) to unlock audio on mobile. */
export function unlockAudio() {
  ctx ??= new AudioContext({ latencyHint: 'interactive' });
  if (ctx.state === 'suspended') void ctx.resume();
  if (!noise) {
    noise = ctx.createBuffer(1, ctx.sampleRate * 0.4, ctx.sampleRate);
    const d = noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  startKeepAlive();
}

function enabled() {
  return useStore.getState().settings.radioSounds && ctx;
}

function tone(freq: number, start: number, dur: number, gain = 0.18, type: OscillatorType = 'square') {
  if (!ctx) return;
  const t = ctx.currentTime + start;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type;
  o.frequency.value = freq;
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(gain, t + 0.005);
  g.gain.setValueAtTime(gain, t + dur - 0.01);
  g.gain.linearRampToValueAtTime(0, t + dur);
  o.connect(g).connect(ctx.destination);
  o.start(t);
  o.stop(t + dur + 0.02);
}

function burst(dur: number, gain = 0.12, start = 0) {
  if (!ctx || !noise) return;
  const t = ctx.currentTime + start;
  const src = ctx.createBufferSource();
  src.buffer = noise;
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = 2400;
  bp.Q.value = 0.7;
  const g = ctx.createGain();
  g.gain.setValueAtTime(gain, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  src.connect(bp).connect(g).connect(ctx.destination);
  src.start(t, Math.random() * 0.1, dur);
}

export const sfx = {
  /** TX key-up: short high chirp so the operator knows the channel is open. */
  txStart() {
    if (!enabled()) return;
    tone(1750, 0, 0.06, 0.12, 'sine');
  },
  /** TX release: classic two-tone roger beep. */
  txEnd() {
    if (!enabled()) return;
    tone(1200, 0, 0.07, 0.12, 'sine');
    tone(900, 0.075, 0.08, 0.12, 'sine');
  },
  /** RX open: squelch click. */
  rxStart() {
    if (!enabled()) return;
    burst(0.04, 0.08);
  },
  /** RX close: squelch tail. */
  rxEnd() {
    if (!enabled()) return;
    burst(0.18, 0.1);
  },
  /** Denied / channel busy. */
  error() {
    if (!enabled()) return;
    tone(400, 0, 0.12, 0.15);
    tone(300, 0.14, 0.18, 0.15);
  },
  alert() {
    if (!enabled()) return;
    tone(880, 0, 0.08, 0.1, 'triangle');
    tone(1320, 0.1, 0.12, 0.1, 'triangle');
  },
};

// ---------- background keep-alive ----------
// Mobile browsers suspend pages that are not playing media. A looping near-silent <audio>
// keeps the media session (and WebRTC playout) alive when the screen is locked, and makes
// the page the target for headset Play/Pause buttons via the Media Session API.
let keepAlive: HTMLAudioElement | null = null;

function silentWavUrl(seconds = 2, rate = 8000): string {
  const n = seconds * rate;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const w = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF');
  v.setUint32(4, 36 + n * 2, true);
  w(8, 'WAVE');
  w(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  w(36, 'data');
  v.setUint32(40, n * 2, true);
  // 1-LSB dither instead of pure zeros: some platforms treat digital silence as "not playing".
  for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, i % 2 ? 1 : -1, true);
  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
}

function startKeepAlive() {
  if (keepAlive) {
    if (keepAlive.paused) void keepAlive.play().catch(() => {});
    return;
  }
  keepAlive = new Audio(silentWavUrl());
  keepAlive.loop = true;
  keepAlive.volume = 0.01;
  keepAlive.setAttribute('playsinline', '');
  void keepAlive.play().catch(() => {});
  document.addEventListener('visibilitychange', () => {
    if (ctx?.state === 'suspended') void ctx.resume();
    if (keepAlive?.paused) void keepAlive.play().catch(() => {});
  });
}

export function setMediaSession(title: string, onToggle: () => void) {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({ title, artist: 'Tactic radio', album: 'PTT' });
  // Headset buttons arrive as play/pause on Android Chrome. Each press toggles TX.
  const handler = () => {
    onToggle();
    // Keep the session "playing" so the next press is routed here too.
    if (keepAlive?.paused) void keepAlive.play().catch(() => {});
    navigator.mediaSession.playbackState = 'playing';
  };
  for (const a of ['play', 'pause', 'stop', 'nexttrack', 'previoustrack'] as MediaSessionAction[]) {
    try {
      navigator.mediaSession.setActionHandler(a, handler);
    } catch {
      /* unsupported action */
    }
  }
  navigator.mediaSession.playbackState = 'playing';
}
