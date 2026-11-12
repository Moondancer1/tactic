import type { FastifyInstance } from 'fastify';
import { ClientMsgSchema, type SelfInfo } from '@tactic/shared';
import { verifyToken } from './auth.js';
import { Denied, type Hub } from './hub.js';

const HELLO_TIMEOUT_MS = 10_000;
/** Simple token bucket per socket: burst 60, refill 30/s. */
const BUCKET_MAX = 60;
const BUCKET_REFILL_PER_MS = 30 / 1000;
/** Separate bucket for binary voice frames (~25 frames/s at 40ms): burst 120, refill 60/s. */
const AUDIO_BUCKET_MAX = 120;
const AUDIO_REFILL_PER_MS = 60 / 1000;

export function registerWs(app: FastifyInstance, hub: Hub) {
  app.get('/ws', { websocket: true }, (socket) => {
    let self: SelfInfo | null = null;
    let helloPromise: Promise<SelfInfo | null> | null = null;
    let tokens = BUCKET_MAX;
    let last = Date.now();
    let audioTokens = AUDIO_BUCKET_MAX;
    let lastAudio = Date.now();

    const helloTimer = setTimeout(() => {
      if (!self) socket.close(4001, 'hello timeout');
    }, HELLO_TIMEOUT_MS);

    socket.on('message', async (raw, isBinary) => {
      const now = Date.now();

      if (isBinary) {
        if (!self) return;
        audioTokens = Math.min(AUDIO_BUCKET_MAX, audioTokens + (now - lastAudio) * AUDIO_REFILL_PER_MS);
        lastAudio = now;
        if (audioTokens < 1) return;
        audioTokens -= 1;
        const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer);
        hub.onAudio(self, buf);
        return;
      }

      tokens = Math.min(BUCKET_MAX, tokens + (now - last) * BUCKET_REFILL_PER_MS);
      last = now;
      if (tokens < 1) return hub.sendTo(socket, { t: 'error', code: 'rate_limited', message: 'Слишком много сообщений — подождите' });
      tokens -= 1;

      let data: unknown;
      try {
        data = JSON.parse(raw.toString());
      } catch {
        return;
      }
      const parsed = ClientMsgSchema.safeParse(data);
      if (!parsed.success) {
        return hub.sendTo(socket, { t: 'error', code: 'bad_request', message: 'Некорректные данные' });
      }
      const msg = parsed.data;

      if (!self) {
        if (msg.t === 'hello') {
          helloPromise = (async () => {
            const verified = await verifyToken(msg.token);
            clearTimeout(helloTimer);
            if (!verified) {
              hub.sendTo(socket, { t: 'error', code: 'unauthorized', message: 'Сессия истекла — войдите заново' });
              socket.close(4003, 'unauthorized');
              return null;
            }
            self = verified;
            await hub.attach(socket, verified);
            return verified;
          })();
          await helloPromise;
          return;
        }
        if (helloPromise) {
          self = await helloPromise;
          if (!self) return;
        } else {
          return socket.close(4001, 'hello required');
        }
      }

      try {
        await hub.apply(self, msg, socket);
      } catch (err) {
        if (err instanceof Denied) return hub.sendTo(socket, { t: 'error', code: err.code, message: err.message });
        app.log.error(err);
      }
    });

    socket.on('close', () => clearTimeout(helloTimer));
  });
}
