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
  // Dev mode (default admin:admin) listens on loopback only; containers set NODE_ENV=production.
  host: env('HOST', isProd ? '0.0.0.0' : '127.0.0.1'),
  dataDir: path.resolve(env('DATA_DIR', './data')),
  jwtSecret: env('JWT_SECRET', isProd ? undefined : 'dev-insecure-jwt-secret-change-me-0000000000'),
  /** Admin panel login. In production there is NO default password: set ADMIN_PASSWORD in .env. */
  adminUser: env('ADMIN_USER', 'admin'),
  adminPassword: process.env.ADMIN_PASSWORD || (isProd ? '' : 'admin'),
  /** Optional machine token for scripts / webhooks (Authorization: Bearer <ADMIN_TOKEN>). */
  adminToken: process.env.ADMIN_TOKEN || '',
  redisUrl: process.env.REDIS_URL || '',
  /** Extra origins allowed to call the API cross-origin (the APK's https://localhost is always allowed). */
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

/** Values that are published in this repository's examples and must never run in production. */
const PUBLIC_DEFAULTS = [
  'dev-insecure-jwt-secret-change-me-0000000000',
  'local-only-jwt-secret-0123456789abcdef0123456789abcdef',
  'change-me-64-hex',
  'change-me-random-jwt-secret-at-least-32-chars',
  'change-me-admin-password',
  'change-me-admin-pass',
  'change-me-admin-token',
  'A123456a',
  'admin',
];

if (config.isProd) {
  if (config.jwtSecret.length < 32) throw new Error('JWT_SECRET must be at least 32 chars');
  if (config.adminPassword && config.adminPassword.length < 10) throw new Error('ADMIN_PASSWORD must be at least 10 chars');
  for (const [name, v] of [
    ['JWT_SECRET', config.jwtSecret],
    ['ADMIN_PASSWORD', config.adminPassword],
    ['ADMIN_TOKEN', config.adminToken],
  ] as const) {
    if (v && PUBLIC_DEFAULTS.includes(v)) throw new Error(`${name} is a public example value — generate a real secret (scripts/gen-env.sh or scripts/local.ps1)`);
  }
}
