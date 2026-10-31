import type { FastifyInstance } from 'fastify';
import { ClientMsgSchema, type SelfInfo } from '@tactic/shared';
import { verifyToken } from './auth.js';
import { Denied, type Hub } from './hub.js';

const HELLO_TIMEOUT_MS = 5_000;
/** Simple token bucket per socket: burst 40, refill 20/s. */
const BUCKET_MAX = 40;
const BUCKET_REFILL_PER_MS = 20 / 1000;

export function registerWs(app: FastifyInstance, hub: Hub) {
  app.get('/ws', { websocket: true }, (socket) => {
    let self: SelfInfo | null = null;
    let tokens = BUCKET_MAX;
    let last = Date.now();

    const helloTimer = setTimeout(() => {
      if (!self) socket.close(4001, 'hello timeout');
    }, HELLO_TIMEOUT_MS);

    socket.on('message', async (raw, isBinary) => {
      if (isBinary) return;
      const now = Date.now();
      tokens = Math.min(BUCKET_MAX, tokens + (now - last) * BUCKET_REFILL_PER_MS);
      last = now;
      if (tokens < 1) return hub.sendTo(socket, { t: 'error', code: 'rate_limited', message: 'Slow down' });
      tokens -= 1;

      let data: unknown;
      try {
        data = JSON.parse(raw.toString());
      } catch {
        return;
      }
      const parsed = ClientMsgSchema.safeParse(data);
      if (!parsed.success) {
        return hub.sendTo(socket, { t: 'error', code: 'bad_request', message: parsed.error.issues[0]?.message ?? 'invalid' });
      }
      const msg = parsed.data;

      if (!self) {
        if (msg.t !== 'hello') return socket.close(4001, 'hello required');
        self = await verifyToken(msg.token);
        clearTimeout(helloTimer);
        if (!self) {
          hub.sendTo(socket, { t: 'error', code: 'unauthorized', message: 'Session expired, re-join' });
          return socket.close(4003, 'unauthorized');
        }
        return hub.attach(socket, self);
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
