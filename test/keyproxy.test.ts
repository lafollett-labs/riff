import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, get as httpGet, type Server, type IncomingMessage } from 'node:http';
import { gzipSync, gunzipSync } from 'node:zlib';
import type { AddressInfo } from 'node:net';

/**
 * The proxy holds the real key; the factory never does. These tests stand up a
 * fake upstream and prove the real key reaches IT while the scoped token the
 * caller sent does not — the whole point of the container split, exercised
 * without a container.
 */

let root: string;
let secrets: typeof import('../src/core/secrets.ts');
let proxytoken: typeof import('../src/core/proxytoken.ts');
let keyproxy: typeof import('../src/keyproxy/main.ts');

let upstream: Server;
let proxy: Server;
let attacker: Server;
let blackhole: Server;
let attackerHits: number;
let seen: { path: string; auth: string | undefined; token: string | undefined; body: string } | null;

const listen = (s: Server): Promise<number> =>
  new Promise((res) => s.listen(0, '127.0.0.1', () => res((s.address() as AddressInfo).port)));
const close = (s: Server): Promise<void> => new Promise((res) => s.close(() => res()));

const readAll = (req: IncomingMessage): Promise<string> =>
  new Promise((res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => res(b)); });

const port = (s: Server): number => (s.address() as AddressInfo).port;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'riff-keyproxy-'));
  process.env['RIFF_ROOT'] = join(root, '.riff');
  secrets = await import('../src/core/secrets.ts');
  proxytoken = await import('../src/core/proxytoken.ts');
  keyproxy = await import('../src/keyproxy/main.ts');
  seen = null;
  attackerHits = 0;

  // A host the proxy must NEVER be steered to. If a redirect were followed, the
  // injected key would land here.
  attacker = createServer((req, res) => { attackerHits++; res.writeHead(200); res.end('captured'); });
  const attackerPort = await listen(attacker);

  // A fake upstream that records what it received. A path containing 'redirect'
  // answers 302 toward the attacker, to exercise redirect handling.
  upstream = createServer(async (req, res) => {
    seen = {
      path: req.url ?? '',
      auth: req.headers['authorization'] as string | undefined,
      token: req.headers['x-scoped'] as string | undefined,
      body: await readAll(req),
    };
    if ((req.url ?? '').includes('redirect')) {
      res.writeHead(302, { location: `http://127.0.0.1:${attackerPort}/stolen` });
      res.end();
      return;
    }
    if ((req.url ?? '').includes('gzip')) {
      // A real upstream (OpenRouter) gzips its JSON. The proxy is a byte pipe, so
      // it must forward the gzip body AND content-encoding untouched for the
      // client to decode — never decode-and-reframe it.
      res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
      res.end(gzipSync(JSON.stringify({ ok: true, zipped: true })));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  const upPort = await listen(upstream);

  // Accepts the TCP connection and never answers — undici's fetch bounded this
  // with a default timeout; node:http does not, so the proxy must impose its own.
  blackhole = createServer(() => { /* deliberately never responds */ });
  const blackholePort = await listen(blackhole);

  // One company. Two services: the default bearer-Authorization route, and one
  // whose credential is injected on a CUSTOM header (X-Api-Key) — the case
  // undici does NOT strip across a redirect, so it is the one that must be
  // proven safe by not following redirects at all.
  const home = join(process.env['RIFF_ROOT']!, 'companies', 'shipit');
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'config.json'), JSON.stringify({
    version: 1,
    company: { name: 'ShipIt', business: '' },
    services: {
      openrouter: { upstream: `http://127.0.0.1:${upPort}/api/v1`, secret: 'OPENROUTER_API_KEY' },
      custom: { upstream: `http://127.0.0.1:${upPort}/api`, secret: 'CUSTOM_KEY', header: 'x-api-key', scheme: '' },
      stall: { upstream: `http://127.0.0.1:${blackholePort}/`, secret: 'OPENROUTER_API_KEY' },
    },
  }));
  secrets.putSecret('shipit', 'OPENROUTER_API_KEY', 'sk-or-v1-REALKEY');
  secrets.putSecret('shipit', 'CUSTOM_KEY', 'CUSTOM-REAL-KEY');

  proxy = createServer((req, res) => keyproxy.handle(req, res).catch(() => {
    if (!res.headersSent) { res.writeHead(500); res.end(); }
  }));
  await listen(proxy);
});

afterEach(async () => {
  await close(proxy);
  await close(upstream);
  await close(attacker);
  await close(blackhole);
  rmSync(root, { recursive: true, force: true });
  delete process.env['RIFF_ROOT'];
});

const call = (path: string, token: string, body?: string) =>
  fetch(`http://127.0.0.1:${port(proxy)}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body }),
  });

describe('the real key reaches the upstream and the scoped token does not', () => {
  test('the injected Authorization is the real key, not the token', async () => {
    const token = proxytoken.mintScopedToken('shipit', 3600);
    const r = await call('/svc/openrouter/chat/completions', token, '{"model":"x"}');
    assert.equal(r.status, 200);
    assert.equal(seen?.path, '/api/v1/chat/completions');
    assert.equal(seen?.auth, 'Bearer sk-or-v1-REALKEY');
    assert.equal(seen?.body, '{"model":"x"}');
    // The capability the caller held never left the proxy.
    assert.ok(!(seen?.auth ?? '').includes(token));
  });

  test('a gzip-encoded upstream response is passed through untouched, for the client to decode', async () => {
    // The proxy is a byte pipe: it must forward the upstream's gzip body AND its
    // content-encoding header unchanged, never decoding (it never reads the body).
    // Read the raw bytes off the socket — fetch would auto-decode and hide the
    // proof. Before passthrough the proxy decoded and forwarded a stale header,
    // and a client gunzipping plaintext threw "incorrect header check".
    const token = proxytoken.mintScopedToken('shipit', 3600);
    const got = await new Promise<{ status: number; encoding: string | undefined; raw: Buffer }>((resolve, reject) => {
      const r = httpGet({ host: '127.0.0.1', port: port(proxy), path: '/svc/openrouter/gzip',
        headers: { authorization: `Bearer ${token}` } }, (resp) => {
        const chunks: Buffer[] = [];
        resp.on('data', (c: Buffer) => chunks.push(c));
        resp.on('end', () => resolve({
          status: resp.statusCode ?? 0,
          encoding: resp.headers['content-encoding'] as string | undefined,
          raw: Buffer.concat(chunks),
        }));
      });
      r.on('error', reject);
    });
    assert.equal(got.status, 200);
    assert.equal(got.encoding, 'gzip', 'the upstream encoding must be forwarded, not stripped');
    assert.equal(got.raw[0], 0x1f); assert.equal(got.raw[1], 0x8b); // still gzip on the wire
    assert.deepEqual(JSON.parse(gunzipSync(got.raw).toString()), { ok: true, zipped: true });
  });

  test('the query string is preserved', async () => {
    const token = proxytoken.mintScopedToken('shipit', 3600);
    await call('/svc/openrouter/models?foo=bar', token);
    assert.equal(seen?.path, '/api/v1/models?foo=bar');
  });
});

describe('nothing gets through without a valid, scoped, declared route', () => {
  test('no token is 401 and never touches the upstream', async () => {
    const r = await fetch(`http://127.0.0.1:${port(proxy)}/svc/openrouter/x`);
    assert.equal(r.status, 401);
    assert.equal(seen, null);
  });

  test('an invalid token is 401', async () => {
    const r = await call('/svc/openrouter/x', 'not-a-real-token');
    assert.equal(r.status, 401);
    assert.equal(seen, null);
  });

  test('a service the company has not declared is 404', async () => {
    const token = proxytoken.mintScopedToken('shipit', 3600);
    const r = await call('/svc/anthropic/x', token);
    assert.equal(r.status, 404);
    assert.equal(seen, null);
  });

  test('a prototype-chain name is unknown like any other, not a 502 that reveals it is special', async () => {
    // `services['constructor']` would resolve to an inherited Object.prototype
    // member and slip past a truthiness check, answering 502 ("no credential")
    // instead of 404 — telling a prober the name is special. Object.hasOwn in
    // routeFor makes it one answer: unknown is unknown.
    const token = proxytoken.mintScopedToken('shipit', 3600);
    for (const probe of ['constructor', 'toString', 'hasOwnProperty']) {
      const r = await call(`/svc/${probe}/x`, token);
      assert.equal(r.status, 404, probe);
      assert.equal(seen, null);
    }
  });

  test('a declared route whose secret is missing is 502, not an unauthenticated call', async () => {
    secrets.deleteSecret('shipit', 'OPENROUTER_API_KEY');
    const token = proxytoken.mintScopedToken('shipit', 3600);
    const r = await call('/svc/openrouter/x', token);
    assert.equal(r.status, 502);
    assert.equal(seen, null);
  });

  test('a token for another company cannot use this one\'s route', async () => {
    // fathom has no config here, so its token resolves to a company with no
    // 'openrouter' service — 404, and shipit's key is never read.
    const token = proxytoken.mintScopedToken('fathom', 3600);
    const r = await call('/svc/openrouter/x', token);
    assert.equal(r.status, 404);
    assert.equal(seen, null);
  });
});

describe('a redirect from the upstream never carries the key onward', () => {
  test('a custom-header route: the redirect is refused and the attacker gets nothing', async () => {
    const token = proxytoken.mintScopedToken('shipit', 3600);
    const r = await call('/svc/custom/redirect', token, '{}');
    // The proxy refuses the redirect rather than chasing it.
    assert.equal(r.status, 502);
    // The declared upstream saw the real key (that call is legitimate)...
    assert.equal(seen?.path, '/api/redirect');
    // ...but the attacker host the redirect pointed at was never contacted, so
    // the injected X-Api-Key never left with it.
    assert.equal(attackerHits, 0);
  });

  test('the default bearer route also does not follow redirects', async () => {
    const token = proxytoken.mintScopedToken('shipit', 3600);
    const r = await call('/svc/openrouter/redirect', token, '{}');
    assert.equal(r.status, 502);
    assert.equal(attackerHits, 0);
  });
});

describe('the request cannot steer the proxy off its declared host', () => {
  test('a traversal path normalises away and never reaches the upstream', async () => {
    // fetch/URL normalise `..` before the request is sent, so it stops looking
    // like a /svc request at all — 404, and the upstream host (fixed by config)
    // was never in play.
    const token = proxytoken.mintScopedToken('shipit', 3600);
    const r = await call('/svc/openrouter/../../../etc/passwd', token);
    assert.equal(r.status, 404);
    assert.equal(seen, null);
  });
});

describe('the shared proxy stays available when an upstream misbehaves', () => {
  test('a stalling upstream is bounded and fails closed, not left to hang (KP-1)', async () => {
    // node:http has no default upstream timeout, so without a bound the request
    // hangs forever and open sockets accrue on the shared proxy. Shorten the
    // deadline for the test; a blackhole upstream accepts TCP and never answers.
    process.env['KEYPROXY_UPSTREAM_TIMEOUT_MS'] = '300';
    try {
      const token = proxytoken.mintScopedToken('shipit', 3600);
      const r = await call('/svc/stall/x', token);
      assert.equal(r.status, 502, 'the timeout must turn a stall into a closed failure');
    } finally {
      delete process.env['KEYPROXY_UPSTREAM_TIMEOUT_MS'];
    }
  });
});
