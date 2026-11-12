import path from 'node:path';

function env(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v !== undefined && v !== '') return v;
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required env var ${name}`);
}

const isProd = process.env.NODE_ENV === 'production';

export const config = {
  isProd,
  port: Number(env('PORT', '3000')),
  host: env('HOST', '0.0.0.0'),
  dataDir: path.resolve(env('DATA_DIR', './data')),
  publicUrl: env('PUBLIC_URL', 'http://localhost:3000'),
  jwtSecret: env('JWT_SECRET', isProd ? undefined : 'dev-insecure-jwt-secret-change-me-0000000000'),
  /** Admin panel login. In production there is NO default password: set ADMIN_PASSWORD in .env. */
  adminUser: env('ADMIN_USER', 'admin'),
  adminPassword: process.env.ADMIN_PASSWORD || (isProd ? '' : 'admin'),
  /** Optional machine token for scripts / webhooks (Authorization: Bearer <ADMIN_TOKEN>). */
  adminToken: process.env.ADMIN_TOKEN || '',
  redisUrl: process.env.REDIS_URL || '',
  livekit: {
    url: process.env.LIVEKIT_URL || '',
    apiKey: process.env.LIVEKIT_API_KEY || '',
    apiSecret: process.env.LIVEKIT_API_SECRET || '',
  },
  corsOrigins: (process.env.CORS_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  retentionDays: Number(env('RETENTION_DAYS', '30')),
  /** Directory with the built client (served as static files). */
  staticDir: path.resolve(env('STATIC_DIR', '../client/dist')),
  /** Position batches are flushed to clients at this cadence. */
  flushMs: 80,
  /** Track history sampling (after-action review). */
  trackSampleMs: 10_000,
  chatHistory: 200,
};

if (config.isProd && config.jwtSecret.length < 32) {
  throw new Error('JWT_SECRET must be at least 32 chars');
}
if (config.isProd && config.adminPassword && config.adminPassword.length < 8) {
  throw new Error('ADMIN_PASSWORD must be at least 8 chars');
}
