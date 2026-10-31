import fs from 'node:fs';
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

/** Capacitor WebView origins (Android uses https://localhost with androidScheme "https"). */
const NATIVE_ORIGINS = ['https://localhost', 'http://localhost', 'capacitor://localhost'];

const app = Fastify({
  logger: { level: config.isProd ? 'info' : 'debug' },
  trustProxy: true,
  bodyLimit: 256 * 1024,
});

await app.register(cors, {
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    const allowed =
      NATIVE_ORIGINS.includes(origin) ||
      origin === config.publicUrl ||
      config.corsOrigins.includes(origin) ||
      (!config.isProd && /^https?:\/\/(localhost|127\.0\.0\.1|192\.168\.\d+\.\d+)(:\d+)?$/.test(origin));
    cb(null, allowed);
  },
  methods: ['GET', 'POST', 'OPTIONS'],
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
    return reply.code(404).send({ error: 'not_found', message: 'Not found' });
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
