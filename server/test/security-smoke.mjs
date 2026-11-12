// End-to-end security smoke test against a running server (dev mode: admin = admin:admin).
//   node server/test/security-smoke.mjs [http://127.0.0.1:3000]
// Covers the audit fixes: tickets instead of stored passwords, network passwords, marker hijack,
// cross-network object writes, PIN lockout, token revocation (kick), ended-network tokens,
// GPS teleport filter, chat replay dedupe.
import assert from 'node:assert/strict';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3000';
const ADMIN = process.env.ADMIN_AUTH ?? 'admin:admin';
const sfx = Math.random().toString(36).slice(2, 6).toUpperCase();

async function http(method, path, { token, body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
const admin = (method, path, body) => http(method, path, { token: ADMIN, body });

/** WebSocket client that records every frame and lets the test wait for one. */
function connect(token) {
  const ws = new WebSocket(BASE.replace(/^http/, 'ws') + '/ws');
  const frames = [];
  const waiters = [];
  let closeCode = null;
  ws.onmessage = (e) => {
    if (typeof e.data !== 'string') return;
    const m = JSON.parse(e.data);
    frames.push(m);
    for (const w of [...waiters]) if (w.pred(m)) (waiters.splice(waiters.indexOf(w), 1), w.resolve(m));
  };
  ws.onclose = (e) => (closeCode = e.code);
  const opened = new Promise((r) => (ws.onopen = r)).then(() => ws.send(JSON.stringify({ t: 'hello', token })));
  return {
    frames,
    get closeCode() {
      return closeCode;
    },
    send: async (m) => (await opened, ws.send(JSON.stringify(m))),
    wait: (pred, ms = 3000) =>
      new Promise((resolve, reject) => {
        const hit = frames.find(pred);
        if (hit) return resolve(hit);
        waiters.push({ pred, resolve });
        setTimeout(() => reject(new Error('timeout waiting for frame')), ms);
      }),
    closed: (ms = 3000) =>
      new Promise((resolve, reject) => {
        const t0 = Date.now();
        const tick = () => (closeCode != null ? resolve(closeCode) : Date.now() - t0 > ms ? reject(new Error('socket not closed')) : setTimeout(tick, 50));
        tick();
      }),
    close: () => ws.close(),
  };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const error = (code) => (m) => m.t === 'error' && m.code === code;

let passed = 0;
async function check(name, fn) {
  await fn();
  passed++;
  console.log(`  ok  ${name}`);
}

// ---------- setup ----------
const A = `RIFLE${sfx}`, B = `SCOUT${sfx}`, L = `LEAD${sfx}`;
for (const [callsign, role] of [[A, 'rifleman'], [B, 'rifleman'], [L, 'leader']]) {
  assert.equal((await admin('POST', '/api/admin/users', { callsign, password: 'secret-pw', squad: 'alpha', role })).status, 201);
}
const t1 = (await admin('POST', '/api/admin/matches', { name: `T1-${sfx}`, password: 'team-one' })).body;
const t2 = (await admin('POST', '/api/admin/matches', { name: `T2-${sfx}`, password: 'team-two' })).body;
assert.match(t1.commandPin, /^\d{6}$/, 'server generates a random 6-digit PIN');

const ticket = async (cs) => (await http('POST', '/api/auth/verify', { body: { callsign: cs, password: 'secret-pw' } })).body.ticket;
const join = async (tk, matchId, matchPassword) => http('POST', '/api/auth/join', { token: tk, body: { matchId, matchPassword } });

console.log(`security smoke against ${BASE}`);

await check('network creation requires a password', async () => {
  assert.equal((await admin('POST', '/api/admin/matches', { name: 'open' })).status, 400);
});

await check('login: unknown user and wrong password look identical', async () => {
  const a = await http('POST', '/api/auth/verify', { body: { callsign: `NOPE${sfx}`, password: 'x' } });
  const b = await http('POST', '/api/auth/verify', { body: { callsign: A, password: 'wrong-pw' } });
  assert.equal(a.status, 401);
  assert.deepEqual(a.body, b.body);
});

await check('network list needs a ticket and hides join codes', async () => {
  assert.equal((await http('GET', '/api/networks')).status, 401);
  const res = await http('GET', '/api/networks', { token: await ticket(A) });
  assert.equal(res.status, 200);
  assert.ok(res.body.networks.every((n) => !('code' in n)));
});

await check("other team's network: wrong/missing password rejected", async () => {
  const tk = await ticket(A);
  assert.equal((await join(tk, t2.id)).status, 403);
  assert.equal((await join(tk, t2.id, 'team-one')).status, 403);
  assert.equal((await join(tk, t1.id, 'team-one')).status, 200);
});

const tkA = await ticket(A), tkB = await ticket(B), tkL = await ticket(L);
const sA = (await join(tkA, t1.id, 'team-one')).body;
const sB = (await join(tkB, t1.id, 'team-one')).body;
const sL = (await join(tkL, t1.id, 'team-one')).body;
const wsA = connect(sA.token), wsB = connect(sB.token), wsL = connect(sL.token);
await Promise.all([wsA, wsB, wsL].map((w) => w.wait((m) => m.t === 'snapshot')));

await check('every connect hands out a fresh session token', async () => {
  const self = await wsA.wait((m) => m.t === 'self' && m.token);
  assert.ok(self.token.length > 20);
});

await check('rifleman cannot hijack an objective by re-sending it as a contact', async () => {
  await wsL.send({ t: 'marker.upsert', marker: { id: `obj${sfx}`, kind: 'objective', label: 'ALFA', lat: 40.4, lon: 49.8 } });
  await wsA.wait((m) => m.t === 'marker' && m.marker.id === `obj${sfx}`);
  await wsA.send({ t: 'marker.upsert', marker: { id: `obj${sfx}`, kind: 'contact', label: 'X', lat: 1, lon: 1, ttlSec: 5 } });
  await wsA.wait(error('forbidden'));
  await wsA.send({ t: 'marker.delete', id: `obj${sfx}` });
  await sleep(300);
  assert.equal(wsA.frames.filter(error('forbidden')).length, 2);
});

await check('same object id in another network does not touch this one', async () => {
  const s2 = (await join(await ticket(B), t2.id, 'team-two')).body;
  const ws2 = connect(s2.token);
  await ws2.wait((m) => m.t === 'snapshot');
  await ws2.send({ t: 'marker.upsert', marker: { id: `obj${sfx}`, kind: 'contact', label: 'EVIL', lat: 2, lon: 2 } });
  await ws2.wait((m) => m.t === 'marker' && m.marker.id === `obj${sfx}`);
  ws2.close();
  const fresh = connect(sL.token);
  const snap = await fresh.wait((m) => m.t === 'snapshot');
  const obj = snap.markers.find((m) => m.id === `obj${sfx}`);
  assert.equal(obj.kind, 'objective');
  assert.equal(obj.label, 'ALFA');
  fresh.close();
});

await check('command PIN locks after 5 wrong attempts (even the right PIN is refused)', async () => {
  for (let i = 0; i < 5; i++) {
    await wsB.send({ t: 'squad.set', squad: 'command', role: 'commander', pin: `00000${i}` });
    await sleep(5200); // squad.set is rate limited to 1 per 5 s after a burst of 3
  }
  await wsB.send({ t: 'squad.set', squad: 'command', role: 'commander', pin: t1.commandPin });
  await wsB.wait((m) => m.t === 'error' && m.code === 'rate_limited' && /PIN/.test(m.message), 8000);
});

await check('GPS teleport is dropped, normal movement accepted', async () => {
  const now = Date.now();
  await wsA.send({ t: 'pos', lat: 40.40000, lon: 49.80000, acc: 5, heading: null, speed: null, ts: now });
  await wsB.wait((m) => m.t === 'players' && m.players.some((p) => p.id === sA.self.id && p.lat === 40.4));
  await sleep(1100);
  await wsA.send({ t: 'pos', lat: 41.4, lon: 49.8, acc: 5, heading: null, speed: null, ts: now + 1000 }); // 111 km in 1 s
  await sleep(1100);
  await wsA.send({ t: 'pos', lat: 40.40005, lon: 49.80000, acc: 5, heading: null, speed: null, ts: now + 2000 }); // 5 m
  await wsB.wait((m) => m.t === 'players' && m.players.some((p) => p.id === sA.self.id && p.lat === 40.40005));
  assert.ok(!wsB.frames.some((m) => m.t === 'players' && m.players.some((p) => p.id === sA.self.id && p.lat === 41.4)));
});

await check('chat replayed from an offline outbox is delivered once', async () => {
  const msg = { t: 'chat', id: `dup${sfx}`, channel: 'all', text: `hello ${sfx}` };
  await wsA.send(msg);
  await wsA.send(msg);
  await sleep(500);
  assert.equal(wsB.frames.filter((m) => m.t === 'chat' && m.msg.text === `hello ${sfx}`).length, 1);
});

await check('kick revokes socket, session token and ticket', async () => {
  assert.equal((await admin('POST', `/api/admin/users/${A}/kick`)).status, 200);
  assert.equal(await wsA.closed(), 4003);
  assert.equal((await http('POST', '/api/telemetry', { token: sA.token, body: [{ lat: 1, lon: 1, ts: Date.now() }] })).status, 401);
  assert.equal((await http('GET', '/api/networks', { token: tkA })).status, 401);
  const again = connect(sA.token);
  assert.equal(await again.closed(), 4003);
});

await check('token of an ended network is never moved into another network', async () => {
  assert.equal((await admin('POST', `/api/admin/matches/${t1.id}/end`)).status, 200);
  assert.equal(await wsB.closed(), 4004);
  assert.equal((await http('POST', '/api/telemetry', { token: sL.token, body: [{ lat: 1, lon: 1, ts: Date.now() }] })).status, 410);
  const again = connect(sL.token);
  assert.equal(await again.closed(), 4004);
});

wsL.close();
await admin('POST', `/api/admin/matches/${t2.id}/end`);
for (const cs of [A, B, L]) await admin('DELETE', `/api/admin/users/${cs}`);
console.log(`all ${passed} checks passed`);
process.exit(0);
