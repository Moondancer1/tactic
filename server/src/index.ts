import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import { Bus } from './bus.js';
import { config } from './config.js';
import { store } from './db.js';
import { Hub } from './hub.js';
import { registerRoutes } from './routes.js';
import { registerWs } from './ws.js';

const app = Fastify({
  logger: { level: config.isProd ? 'info' : 'debug' },
  trustProxy: true,
  bodyLimit: 256 * 1024,
});

await app.register(cors, {
  origin: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
});
await app.register(rateLimit, { global: false });
await app.register(websocket, { options: { maxPayload: 64 * 1024 } });

const hub = new Hub(new Bus());
await hub.start((m) => app.log.info(m));

registerRoutes(app, hub);
registerWs(app, hub);

if (fs.existsSync(config.staticDir)) {
  await app.register(fastifyStatic, {
    root: config.staticDir,
    wildcard: false,
    setHeaders(res, filePath) {
      // Hashed assets are immutable; the shell and service worker must revalidate.
      if (/\/assets\//.test(filePath.replace(/\\/g, '/'))) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      else res.setHeader('Cache-Control', 'no-cache');
    },
  });
  // SPA fallback
  app.setNotFoundHandler((req, reply) => {
    if (req.method === 'GET' && !req.url.startsWith('/api') && !req.url.startsWith('/ws')) {
      return reply.type('text/html').header('Cache-Control', 'no-cache').sendFile('index.html');
    }
    return reply.code(404).send({ error: 'not_found', message: 'Не найдено' });
  });
} else {
  app.log.warn(`static dir ${config.staticDir} missing; serving API only`);
}

const shutdown = async (sig: string) => {
  app.log.info(`${sig}: shutting down`);
  await hub.stop();
  await app.close();
  store.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ port: config.port, host: config.host });

// Automatically detect Cloudflare Quick Tunnel URL (even after Docker Desktop restart)
// and publish it to ntfy.sh + /data/tunnel-url.txt so APK and Tactic-Вход.html always connect.
let lastPublishedTunnel = '';
async function syncTunnelUrl() {
  try {
    const res = await fetch('http://tunnel:20241/metrics', { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return;
    const text = await res.text();
    const m = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
    if (!m) return;
    const url = m[0];
    if (url === lastPublishedTunnel) return;
    lastPublishedTunnel = url;
    app.log.info(`Active Cloudflare tunnel URL: ${url}`);
    try {
      fs.writeFileSync(path.join(config.dataDir, 'tunnel-url.txt'), `${url}\n`, 'utf8');
    } catch {
      /* ignore */
    }
    const discoveryTopic = (process.env.DISCOVERY_TOPIC ?? '').trim();
    if (discoveryTopic) {
      await fetch(`https://ntfy.sh/${encodeURIComponent(discoveryTopic)}`, {
        method: 'POST',
        body: url,
        signal: AbortSignal.timeout(5000),
      }).catch(() => {});
    }
  } catch {
    /* tunnel metrics not reachable or not using quick tunnel */
  }
}
void syncTunnelUrl();
setInterval(() => void syncTunnelUrl(), 15_000).unref();
