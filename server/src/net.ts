import type { FastifyRequest } from 'fastify';

const PRIVATE_IP = /^(::ffff:)?(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)|^::1$|^f[cd]/i;

/**
 * Real client address behind Caddy (and optionally Cloudflare Tunnel). The nearest proxy appends the
 * peer to X-Forwarded-For; private hops (cloudflared, caddy) are skipped. When every hop is private
 * the request came through Cloudflare, which puts the visitor into CF-Connecting-IP.
 * A client-supplied X-Forwarded-For only ever adds hops to the *left*: the rightmost public hop is
 * the one our own proxies (or Cloudflare) appended.
 */
export function clientIp(req: FastifyRequest): string {
  const peer = req.socket.remoteAddress ?? '';
  if (!PRIVATE_IP.test(peer)) return peer;
  const hops = String(req.headers['x-forwarded-for'] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (let i = hops.length - 1; i >= 0; i--) if (!PRIVATE_IP.test(hops[i]!)) return hops[i]!;
  return (req.headers['cf-connecting-ip'] as string | undefined) || peer;
}
