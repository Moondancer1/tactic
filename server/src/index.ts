import fs from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyRequest } from 'fastify';
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

const PRIVATE_IP = /^(::ffff:)?(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)|^::1$|^f[cd]/i;

/**
 * Real client address behind Caddy (and optionally Cloudflare Tunnel). The nearest proxy appends the
 * peer to X-Forwarded-For; private hops (cloudflared, caddy) are skipped. When every hop is private
 * the request came through Cloudflare, which puts the visitor into CF-Connecting-IP.
 */
function clientIp(req: FastifyRequest): string {
  const peer = req.socket.remoteAddress ?? '';
  if (!PRIVATE_IP.test(peer)) return peer;
  const hops = String(req.headers['x-forwarded-for'] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (let i = hops.length - 1; i >= 0; i--) if (!PRIVATE_IP.test(hops[i]!)) return hops[i]!;
  return (req.headers['cf-connecting-ip'] as string | undefined) || peer;
}

const app = Fastify({
  logger: { level: config.isProd ? 'info' : 'debug' },
  bodyLimit: 256 * 1024,
});

// The web client is same-origin (no CORS needed). Cross-origin callers: the APK WebView and explicit extras.
const allowedOrigins = new Set(['https://localhost', 'capacitor://localhost', 'http://localhost', ...config.corsOrigins]);
await app.register(cors, {
  origin: (origin, cb) => cb(null, !origin || allowedOrigins.has(origin) || allowedOrigins.has('*')),
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
});
await app.register(rateLimit, { global: false, keyGenerator: clientIp });
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

// Cloudflare Quick Tunnel (local mode without a domain): log the rotating *.trycloudflare.com URL and
// write it to DATA_DIR/tunnel-url.txt so the operator can hand it out. Nothing is published anywhere.
let lastTunnel = '';
async function logTunnelUrl() {
  try {
    const res = await fetch('http://tunnel:20241/metrics', { signal: AbortSignal.timeout(3000) });
    const m = res.ok ? (await res.text()).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i) : null;
    if (!m || m[0] === lastTunnel) return;
    lastTunnel = m[0];
    app.log.info(`Active Cloudflare quick tunnel: ${lastTunnel}`);
    fs.writeFileSync(path.join(config.dataDir, 'tunnel-url.txt'), `${lastTunnel}\n`, 'utf8');
  } catch {
    /* no quick tunnel in this deployment */
  }
}
void logTunnelUrl();
setInterval(() => void logTunnelUrl(), 15_000).unref();
