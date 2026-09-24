import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, get as httpGet, request as httpRequest, type Server, type IncomingMessage } from 'node:http';
import { gzipSync, gunzipSync } from 'node:zlib';
import type { AddressInfo } from 'node:net';
import { destinationsFor, type ServiceRoute } from '../src/core/config.ts';

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
let seen: { path: string; auth: string | undefined; token: string | undefined; body: string;
  headers: Record<string, string | string[] | undefined> } | null;

const listen = (s: Server): Promise<number> =>
  new Promise((res) => s.listen(0, '127.0.0.1', () => res((s.address() as AddressInfo).port)));
const close = (s: Server): Promise<void> => new Promise((res) => s.close(() => res()));

const readAll = (req: IncomingMessage): Promise<string> =>
  new Promise((res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => res(b)); });

const port = (s: Server): number => (s.address() as AddressInfo).port;

/** Where the fixture company's routes send `name` now: what the gateway binds
 *  a value to when it is entered. */
const bound = (name: string) => destinationsFor(
  (JSON.parse(readFileSync(join(process.env['RIFF_ROOT']!, 'companies', 'shipit', 'config.json'), 'utf8')) as
    { services: Record<string, ServiceRoute> }).services, name);

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
      headers: req.headers,
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
      // The OAuth/subscription shape: a bearer credential PLUS the two static
      // headers Anthropic requires, one of which (user-agent) the caller also
      // sends — so it exercises route-header-wins-over-caller.
      anthropic: {
        upstream: `http://127.0.0.1:${upPort}/v1`, secret: 'ANTHROPIC_AUTH_TOKEN',
        header: 'authorization', scheme: 'Bearer',
        headers: { 'anthropic-beta': 'oauth-2025-04-20', 'user-agent': 'claude-code/test' },
      },
      stall: { upstream: `http://127.0.0.1:${blackholePort}/`, secret: 'OPENROUTER_API_KEY' },
      plaintext: { upstream: 'http://example.com/', secret: 'OPENROUTER_API_KEY' },
    },
  }));
  secrets.putSecret('shipit', 'OPENROUTER_API_KEY', 'sk-or-v1-REALKEY', bound('OPENROUTER_API_KEY'));
  secrets.putSecret('shipit', 'CUSTOM_KEY', 'CUSTOM-REAL-KEY', bound('CUSTOM_KEY'));
  secrets.putSecret('shipit', 'ANTHROPIC_AUTH_TOKEN', 'oauth-REAL-TOKEN', bound('ANTHROPIC_AUTH_TOKEN'));

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

  test('static route headers are injected, and a route header overrides the caller\'s (the OAuth-subscription shape)', async () => {
    const token = proxytoken.mintScopedToken('shipit', 3600);
    const r = await fetch(`http://127.0.0.1:${port(proxy)}/svc/anthropic/messages`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'user-agent': 'product-ua/9', // the caller's own UA, which the route must override
      },
      body: '{"model":"claude"}',
    });
    assert.equal(r.status, 200);
    assert.equal(seen?.path, '/v1/messages');
    // The credential is the real vault token, injected last so it always wins.
    assert.equal(seen?.auth, 'Bearer oauth-REAL-TOKEN');
    assert.ok(!(seen?.auth ?? '').includes(token));
    // The static headers the route declares arrive at the upstream...
    assert.equal(seen?.headers['anthropic-beta'], 'oauth-2025-04-20');
    // ...and a route-declared header wins over the caller's own value.
    assert.equal(seen?.headers['user-agent'], 'claude-code/test');
  });

  test('anthropic-beta MERGES the caller\'s betas with the route\'s, rather than dropping them', async () => {
    // Claude Code sends its own anthropic-beta carrying the context-management
    // beta its auto-compaction needs. Overwriting it with the route's oauth flag
    // dropped it, and the API rejected the body's context_management field with a
    // 400 — every long-context shift failed. The two must arrive together.
    const token = proxytoken.mintScopedToken('shipit', 3600);
    const r = await fetch(`http://127.0.0.1:${port(proxy)}/svc/anthropic/messages`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'anthropic-beta': 'context-management-2025-06-27,fine-grained-tool-streaming-2025-05-14',
      },
      body: '{"model":"claude","context_management":{}}',
    });
    assert.equal(r.status, 200);
    const betas = String(seen?.headers['anthropic-beta']).split(',').map((s) => s.trim());
    assert.ok(betas.includes('oauth-2025-04-20'), 'the route\'s required flag is present');
    assert.ok(betas.includes('context-management-2025-06-27'), 'the caller\'s beta survived');
    assert.ok(betas.includes('fine-grained-tool-streaming-2025-05-14'), 'all the caller\'s betas survived');
  });
});

describe('nothing gets through without a valid, scoped, declared route', () => {
  test('the plan reading takes the install scope, which a company token is not', async () => {
    const { INSTALL_SCOPE } = await import('../src/core/usage.ts');
    const usage = (token?: string) => fetch(`http://127.0.0.1:${port(proxy)}/usage`,
      token ? { headers: { authorization: `Bearer ${token}` } } : {});
    assert.equal((await usage()).status, 401);
    assert.equal((await usage(proxytoken.mintScopedToken('acme', 60))).status, 401,
      'a company token cannot read the installation plan');
    const r = await usage(proxytoken.mintScopedToken(INSTALL_SCOPE, 60));
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { at: null, windows: [] }, 'nothing read yet');
  });

  test('the install scope reaches no company service', async () => {
    const { INSTALL_SCOPE } = await import('../src/core/usage.ts');
    const r = await fetch(`http://127.0.0.1:${port(proxy)}/svc/openrouter/v1/models`,
      { headers: { authorization: `Bearer ${proxytoken.mintScopedToken(INSTALL_SCOPE, 60)}` } });
    assert.equal(r.status, 404);
    assert.equal(seen, null, 'and never touched an upstream');
  });

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
    const r = await call('/svc/undeclared/x', token);
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

  test('a non-https, non-loopback upstream is refused before the key is ever sent (KP-4)', async () => {
    // validateServiceRoute enforces https on the API path, but a hand-edited or
    // imported config can carry an http upstream; the proxy re-asserts it so a
    // real key never rides a plaintext hop. The refusal is pre-connection.
    const token = proxytoken.mintScopedToken('shipit', 3600);
    const r = await call('/svc/plaintext/x', token);
    assert.equal(r.status, 502);
    assert.equal(seen, null, 'the upstream must never be contacted');
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

describe('a key goes only where it was entered for', () => {
  // The gateway writes routes and vault files, and runs npm's newest Agent SDK:
  // a hostile one must not get a key by re-pointing a route or editing a vault.
  const configPath = () => join(process.env['RIFF_ROOT']!, 'companies', 'shipit', 'config.json');
  const vaultPath = () => join(process.env['RIFF_ROOT']!, 'secrets', 'shipit.vault.json');
  const edit = (service: string, patch: Record<string, unknown>) => {
    const cfg = JSON.parse(readFileSync(configPath(), 'utf8'));
    Object.assign(cfg.services[service], patch);
    writeFileSync(configPath(), JSON.stringify(cfg));
  };
  const attackerURL = () => `http://127.0.0.1:${port(attacker)}/api/v1`;

  test('a route moved to another host is refused, and the key never reaches it', async () => {
    const token = proxytoken.mintScopedToken('shipit', 3600);
    edit('openrouter', { upstream: attackerURL() });
    const r = await call('/svc/openrouter/models', token);
    assert.equal(r.status, 502);
    assert.match(((await r.json()) as { error: string }).error, /enter the key again/);
    assert.equal(attackerHits, 0);
  });

  test('so is the first call to it: there is no first use to win', async () => {
    // Re-pointed before the key was ever sent anywhere, as right after a move.
    edit('openrouter', { upstream: attackerURL() });
    assert.equal((await call('/svc/openrouter/models', proxytoken.mintScopedToken('shipit', 3600))).status, 502);
    assert.equal(attackerHits, 0);
  });

  test('a route moved to another header or scheme is refused too', async () => {
    const token = proxytoken.mintScopedToken('shipit', 3600);
    edit('openrouter', { header: 'x-api-key', scheme: '' });
    assert.equal((await call('/svc/openrouter/models', token)).status, 502);
  });

  test('entering the key again is what moves it', async () => {
    edit('openrouter', { upstream: attackerURL() });
    secrets.putSecret('shipit', 'OPENROUTER_API_KEY', 'sk-or-v1-REALKEY', bound('OPENROUTER_API_KEY'));
    assert.equal((await call('/svc/openrouter/models', proxytoken.mintScopedToken('shipit', 3600))).status, 200);
    assert.equal(attackerHits, 1);
  });

  test('another path on the same host is the same destination', async () => {
    edit('openrouter', { upstream: `http://127.0.0.1:${port(upstream)}/other/base` });
    assert.equal((await call('/svc/openrouter/models', proxytoken.mintScopedToken('shipit', 3600))).status, 200);
  });

  test('a destination written into the vault file opens nothing', async () => {
    const vault = JSON.parse(readFileSync(vaultPath(), 'utf8'));
    vault.secrets.OPENROUTER_API_KEY.to.push({ origin: new URL(attackerURL()).origin, header: 'authorization', scheme: 'Bearer' });
    writeFileSync(vaultPath(), JSON.stringify(vault));
    edit('openrouter', { upstream: attackerURL() });
    assert.notEqual((await call('/svc/openrouter/models', proxytoken.mintScopedToken('shipit', 3600))).status, 200);
    assert.equal(attackerHits, 0);
  });

  test('a key entered before any service used it goes nowhere', async () => {
    secrets.putSecret('shipit', 'OPENROUTER_API_KEY', 'sk-or-v1-REALKEY', []);
    assert.equal((await call('/svc/openrouter/models', proxytoken.mintScopedToken('shipit', 3600))).status, 502);
  });

  test('a key is never put on Host, and an upstream failure never quotes what was sent', async () => {
    // Set on Host, the key became the TLS SNI and then the certificate error
    // the proxy returned to the caller.
    edit('openrouter', { header: 'host' });
    const r = await call('/svc/openrouter/models', proxytoken.mintScopedToken('shipit', 3600));
    assert.equal(r.status, 403);
    assert.ok(!(await r.text()).includes('REALKEY'));
    edit('openrouter', { header: 'authorization', upstream: 'https://127.0.0.1:1/' });
    secrets.putSecret('shipit', 'OPENROUTER_API_KEY', 'sk-or-v1-REALKEY', bound('OPENROUTER_API_KEY'));
    const down = await call('/svc/openrouter/models', proxytoken.mintScopedToken('shipit', 3600));
    assert.equal(down.status, 502);
    assert.deepEqual(await down.json(), { error: 'upstream unreachable' });
  });

  test('a method that echoes the request is not forwarded', async () => {
    // node:http, since fetch refuses to send TRACE at all.
    const status = await new Promise<number>((resolve, reject) => {
      const q = httpRequest({ host: '127.0.0.1', port: port(proxy), path: '/svc/openrouter/models', method: 'TRACE',
        headers: { authorization: `Bearer ${proxytoken.mintScopedToken('shipit', 3600)}` } },
        (r) => { r.resume(); resolve(r.statusCode ?? 0); });
      q.on('error', reject);
      q.end();
    });
    assert.equal(status, 405);
    assert.equal(seen, null, 'nothing reached the upstream');
  });

  test('no service route may send the runtime credential', async () => {
    secrets.putSecret('shipit', 'RIFF_RUNTIME_TOKEN', 'sk-ant-oat-RUNTIME', [{ origin: new URL(attackerURL()).origin, header: 'authorization', scheme: 'Bearer' }]);
    edit('openrouter', { upstream: attackerURL(), secret: 'RIFF_RUNTIME_TOKEN' });
    assert.equal((await call('/svc/openrouter/models', proxytoken.mintScopedToken('shipit', 3600))).status, 403);
    assert.equal(attackerHits, 0);
  });

  test('a company named "install" has its own vault, not the installation\'s', async () => {
    secrets.putInstallSecret('RIFF_RUNTIME_TOKEN', 'install-default', []);
    assert.equal(secrets.getSecret('install', 'RIFF_RUNTIME_TOKEN'), null);
    assert.ok(secrets.installVaultPath().endsWith('_install.vault.json'));
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
