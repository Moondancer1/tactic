// PTT microphone capture on the audio rendering thread (not the UI thread):
// downsample to 16 kHz with a box filter (averaging = cheap anti-aliasing), encode G.711 µ-law,
// and post 640-sample (40 ms) frames to the main thread, which adds the channel header and sends them.
const OUT_RATE = 16000;
const FRAME = 640;

function linearToUlaw(sample) {
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
  for (let mask = 0x4000; (s & mask) === 0 && exponent > 0; exponent--, mask >>= 1);
  const mantissa = (s >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

class VoiceCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.active = false;
    this.ratio = sampleRate / OUT_RATE;
    this.acc = 0;
    this.accN = 0;
    this.pos = 0;
    this.frame = new Uint8Array(FRAME);
    this.n = 0;
    this.port.onmessage = (e) => {
      if (e.data === 'start') {
        this.active = true;
        this.n = 0;
      } else if (e.data === 'stop') {
        // The partial frame (< 40 ms) is dropped: it would reach the server after 'voice.tx off'.
        this.active = false;
        this.n = 0;
      }
    };
  }

  process(inputs) {
    const input = inputs[0] && inputs[0][0];
    if (!this.active || !input) return true;
    for (let i = 0; i < input.length; i++) {
      this.acc += input[i];
      this.accN++;
      this.pos += 1;
      if (this.pos >= this.ratio) {
        this.pos -= this.ratio;
        this.frame[this.n++] = linearToUlaw(this.acc / this.accN);
        this.acc = 0;
        this.accN = 0;
        if (this.n === FRAME) {
          this.port.postMessage(this.frame);
          this.frame = new Uint8Array(FRAME);
          this.n = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor('voice-capture', VoiceCapture);
