// Radio feedback tones (synthesised, no assets), shared AudioContext, TTS, and background-audio keep-alive.
import { useStore } from '../store';
import { isNative, Tactical } from './native';

let ctx: AudioContext | null = null;
let noise: AudioBuffer | null = null;

/** Returns the shared AudioContext (creating/resuming it if needed). */
export function getAudioContext(): AudioContext {
  ctx ??= new AudioContext({ latencyHint: 'interactive' });
  if (ctx.state === 'suspended') void ctx.resume().catch(() => {});
  return ctx;
}

/** Must be called from a user gesture once (login / first tap) to unlock audio on mobile. */
export function unlockAudio() {
  const c = getAudioContext();
  if (!noise) {
    noise = c.createBuffer(1, Math.floor(c.sampleRate * 0.25), c.sampleRate);
    const d = noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  startKeepAlive();
}

function enabled() {
  return useStore.getState().settings.radioSounds && ctx;
}

/** Soft, low-frequency muffled click (never a piercing high-pitched beep that reveals position). */
function softClick(freq: number, start: number, dur: number, gain = 0.025) {
  if (!ctx) return;
  const t = ctx.currentTime + start;
  const o = ctx.createOscillator();
  const lp = ctx.createBiquadFilter();
  const g = ctx.createGain();
  o.type = 'sine';
  o.frequency.setValueAtTime(freq, t);
  o.frequency.exponentialRampToValueAtTime(Math.max(80, freq * 0.6), t + dur);
  lp.type = 'lowpass';
  lp.frequency.value = 500;
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(gain, t + 0.003);
  g.gain.exponentialRampToValueAtTime(0.0005, t + dur);
  o.connect(lp).connect(g).connect(ctx.destination);
  o.start(t);
  o.stop(t + dur + 0.01);
}

function burst(dur: number, gain = 0.02, start = 0) {
  if (!ctx || !noise) return;
  const t = ctx.currentTime + start;
  const src = ctx.createBufferSource();
  src.buffer = noise;
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = 900;
  bp.Q.value = 1.2;
  const g = ctx.createGain();
  g.gain.setValueAtTime(gain, t);
  g.gain.exponentialRampToValueAtTime(0.0005, t + dur);
  src.connect(bp).connect(g).connect(ctx.destination);
  src.start(t, Math.random() * 0.05, dur);
}

export const sfx = {
  /** TX key-up: subtle low click (silent by default unless radioSounds is enabled). */
  txStart() {
    if (!enabled()) return;
    softClick(260, 0, 0.02, 0.025);
  },
  /** TX release: subtle low double-click. */
  txEnd() {
    if (!enabled()) return;
    softClick(220, 0, 0.02, 0.02);
    softClick(170, 0.025, 0.025, 0.02);
  },
  /** RX open: very soft squelch click. */
  rxStart() {
    if (!enabled()) return;
    burst(0.02, 0.018);
  },
  /** RX close: very soft squelch tail. */
  rxEnd() {
    if (!enabled()) return;
    burst(0.05, 0.02);
  },
  /** Denied / channel busy: tactile vibration only, never a loud speaker tone. */
  error() {
    navigator.vibrate?.([30, 50, 30]);
  },
  alert() {
    navigator.vibrate?.([40, 40, 80]);
    if (!enabled()) return;
    softClick(340, 0, 0.04, 0.03);
  },
};

// ---------- background keep-alive ----------
// Mobile browsers suspend pages that are not playing media. A looping near-silent <audio>
// keeps the media session (and WebRTC / WebAudio playout) alive when the screen is locked, and makes
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
    if (ctx?.state === 'suspended') void ctx.resume().catch(() => {});
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

// ---------- Text-to-Speech (TTS: RU + EN, Microsoft / System voices) ----------
let cachedVoices: SpeechSynthesisVoice[] = [];
if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
  const loadVoices = () => {
    cachedVoices = window.speechSynthesis.getVoices();
  };
  loadVoices();
  window.speechSynthesis.onvoiceschanged = loadVoices;
}

function pickVoice(langPrefix: 'ru' | 'en'): SpeechSynthesisVoice | null {
  const voices = cachedVoices.length
    ? cachedVoices
    : typeof window !== 'undefined' && 'speechSynthesis' in window
      ? window.speechSynthesis.getVoices()
      : [];
  const matching = voices.filter((v) => v.lang.toLowerCase().startsWith(langPrefix));
  if (!matching.length) return null;
  // Prefer Microsoft voices (e.g., Microsoft Irina / Pavel / Dmitry / Svetlana / David / Zira / Mark)
  const msVoice = matching.find((v) => /microsoft/i.test(v.name));
  if (msVoice) return msVoice;
  const localVoice = matching.find((v) => v.localService);
  return localVoice ?? matching[0]!;
}

/**
 * Splits mixed Russian/English text into language-consistent segments so that
 * both Cyrillic and Latin phrases are spoken with native RU / EN voices.
 */
function splitByLang(text: string): Array<{ seg: string; lang: 'ru-RU' | 'en-US' }> {
  const parts = text
    .split(/(?=[.!?;:\n]+|\b)/)
    .map((s) => s.trim())
    .filter(Boolean);
  const out: Array<{ seg: string; lang: 'ru-RU' | 'en-US' }> = [];
  for (const part of parts) {
    const hasRu = /[а-яё]/i.test(part);
    const hasEn = /[a-z]/i.test(part);
    const lang: 'ru-RU' | 'en-US' = hasRu ? 'ru-RU' : hasEn ? 'en-US' : out[out.length - 1]?.lang ?? 'ru-RU';
    if (out.length > 0 && out[out.length - 1]!.lang === lang) {
      out[out.length - 1]!.seg += ' ' + part;
    } else {
      out.push({ seg: part, lang });
    }
  }
  return out.length ? out : [{ seg: text, lang: /[а-яё]/i.test(text) ? 'ru-RU' : 'en-US' }];
}

// Per-message retrigger cooldown so accidental repeated taps or duplicate events don't queue endless loops.
const TTS_MIN_RETRIGGER_MS = 3500;
const ttsCooldowns = new Map<string, number>();

export function canRetriggerTts(key: string, textLength = 20): boolean {
  const now = Date.now();
  const until = ttsCooldowns.get(key) ?? 0;
  if (now < until) return false;
  const cooldownMs = Math.max(TTS_MIN_RETRIGGER_MS, Math.min(10_000, textLength * 75));
  ttsCooldowns.set(key, now + cooldownMs);
  if (ttsCooldowns.size > 200) {
    for (const [k, exp] of ttsCooldowns) {
      if (exp < now) ttsCooldowns.delete(k);
    }
  }
  return true;
}

/**
 * Speaks a message using TTS (supports Russian and English automatically).
 * On Android APK uses native Android TextToSpeech; on Desktop/Web uses SpeechSynthesis (preferring Microsoft voices).
 * Includes per-message retrigger threshold and flushes stale queue on manual click.
 */
export function speakTts(rawText: string, force = false, msgId?: string): boolean {
  const text = rawText.replace(/\s+/g, ' ').trim();
  if (!text) return false;
  if (!force && !useStore.getState().settings.tts) return false;

  const key = msgId ? `id:${msgId}` : `txt:${text.toLowerCase()}`;
  if (!canRetriggerTts(key, text.length)) return false;

  const segments = splitByLang(text);

  if (isNative()) {
    segments.forEach(({ seg, lang }, idx) => {
      // On manual click (force=true), the first segment flushes any queued speech so it never piles up.
      void Tactical.speak({ text: seg, lang, flush: force && idx === 0 }).catch(() => {});
    });
    return true;
  }

  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return false;
  try {
    // If manually clicked (or if too many utterances piled up), clear the queue first so messages don't loop.
    if (force || window.speechSynthesis.pending) {
      window.speechSynthesis.cancel();
    }
    for (const { seg, lang } of segments) {
      const u = new SpeechSynthesisUtterance(seg);
      u.lang = lang;
      u.rate = 1.05;
      const v = pickVoice(lang === 'ru-RU' ? 'ru' : 'en');
      if (v) u.voice = v;
      window.speechSynthesis.speak(u);
    }
    return true;
  } catch {
    return false;
  }
}
