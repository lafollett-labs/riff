import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse,
  type OutgoingHttpHeaders } from 'node:http';
import { request as httpsRequest } from 'node:https';
import {
  resolveConfig, RUNTIME_SERVICE_NAME, RUNTIME_SECRET_NAME, RUNTIME_UPSTREAM, CREDENTIAL_HEADERS,
  runtimeRouteHeaders, runtimeRouteShape, destinationOf, sameDestination, type ServiceRoute,
} from '../core/config.ts';
import {
  openSecret, openInstallSecret, loadOrCreateVaultKey, vaultPublicKey, vaultKeysDir, openCanary,
} from '../core/secrets.ts';
import { readSettings } from '../core/settings.ts';
import { verifyScopedToken } from '../core/proxytoken.ts';
import { INSTALL_SCOPE, unifiedWindows, type UsageSnapshot } from '../core/usage.ts';

/**
 * The key-injecting proxy: the one process that holds a company's real keys, and
 * it runs in its OWN container, so the factory — where the agents are — never
 * does. SECURITY.md is blunt that anything inside the factory is readable by a
 * shell that has run long enough, so "the staff cannot read this key" is only
 * true of a key that is not in their box. This is that box's neighbour.
 *
 * The shape, and every part of it earns its place:
 *   product calls  http://keyproxy/svc/<service>/<path>  with Authorization:
 *     Bearer <scoped-token>   -- a capability, not the key; the agent may read it
 *   proxy verifies the token       -> the company it is scoped to
 *   proxy reads <company>'s config -> the ServiceRoute for <service>
 *   proxy reads the vault          -> the real key (decrypted here, only here)
 *   proxy forwards to route.upstream + <path>, injecting the key as a header
 *   proxy logs one line: company, service, upstream host, status. Never the key.
 *
 * The upstream host is fixed by config, never taken from the request, so a
 * request cannot steer the proxy at another host — the path is appended to a
 * host the operator declared, and a `..` in it is refused rather than resolved.
 */

const PORT = Number(process.env['KEYPROXY_PORT'] ?? 8890);
const MAX_BODY = 10 * 1024 * 1024; // API calls, not uploads.

// Headers we never copy onward, in either direction: the token (replaced on the
// request, absent on the response), hop-by-hop framing, and content-length and
// transfer-encoding (this hop reframes its own body). The injection header is
// dropped from the request too, so a caller cannot smuggle its own value in on
// the header we are about to set. content-encoding is NOT here: this is a byte
// pipe — the proxy never reads or decodes the body, so whatever encoding the
// upstream chose is forwarded untouched for the client to decode.
const HOP_BY_HOP = new Set([
  'host', 'authorization', 'connection', 'keep-alive', 'proxy-authorization',
  'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'content-length',
]);

const FORWARDED_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);

const send = (res: ServerResponse, status: number, body: string): void => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: body }));
};

const readBody = (req: IncomingMessage): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });

/**
 * The reserved `_runtime` route the agents' own Claude inference reaches — built,
 * not stored, so no company can declare it (its leading underscore is barred by
 * SERVICE_NAME_RE) and it never shows in a company's `services`. Type and token
 * come from the SAME tier: a company on its own credential uses its own type and
 * its own vault secret; otherwise the installation default type and the install
 * vault. Never a per-company token under the install type, or vice versa. Fails
 * closed with a message naming where to set the credential.
 */
const runtimeRoute = (company: string):
  { route: ServiceRoute; key: string; install: boolean } | { status: number; msg: string } => {
  // The installation's own scope is not a company and has no config to read:
  // it is always the install default. See INSTALL_SCOPE.
  const own = company === INSTALL_SCOPE ? undefined : resolveConfig(process.cwd(), company).runtimeCredential;
  const type = own?.type ?? readSettings().runtimeCredential?.type ?? 'subscription';
  const opened = own ? openSecret(company, RUNTIME_SECRET_NAME) : openInstallSecret(RUNTIME_SECRET_NAME);
  const key = opened?.value;
  if (key == null) {
    return { status: 502, msg: own
      ? "this company has a runtime credential type but no token; set it in the company's Runtime credential"
      : 'no runtime credential is set; set one in Riff Settings' };
  }
  const { header, scheme } = runtimeRouteShape(type);
  // The route is a constant, but the value still says where it may go: one
  // entered for Anthropic is sent to Anthropic.
  const here = destinationOf({ upstream: RUNTIME_UPSTREAM, header, scheme });
  if (!opened!.to.some((d) => sameDestination(d, here))) {
    return { status: 502, msg: 'the runtime credential was not stored for Anthropic; set it again' };
  }
  return {
    route: { upstream: RUNTIME_UPSTREAM, secret: RUNTIME_SECRET_NAME, header, scheme, headers: runtimeRouteHeaders(type) },
    key,
    install: !own,
  };
};

/**
 * The plan's windows, as the last runtime response on the installation's own
 * credential reported them. Only that credential: a company on its own is a
 * different account, and its figures are not the plan the operator paces by.
 * In memory — a restart forgets it until the next call, and the gateway's feed
 * asks for one when a reading is stale.
 */
let installUsage: UsageSnapshot | null = null;

const routeFor = (company: string, service: string): ServiceRoute | null => {
  // resolveConfig with an explicit slug reads exactly that company's config;
  // services defaults to {} for a company that declares none.
  const services = resolveConfig(process.cwd(), company).services;
  // Object.hasOwn, never `services[service]` alone: a probe for `constructor` or
  // `toString` would otherwise resolve to an inherited Object.prototype member
  // and answer differently from a genuinely-unknown service, leaking that the
  // name is special. An undeclared service — whatever its name — is one answer.
  return Object.hasOwn(services, service) ? services[service]! : null;
};

/**
 * Append a request path to the upstream's own path. The host is taken from the
 * declared upstream and never from the request, so a request contributes only a
 * path suffix — it cannot steer the proxy at another host. `..` never reaches
 * here: `new URL` in the handler normalises the request path before the /svc
 * match, so a traversal attempt no longer looks like a /svc request at all.
 */
const upstreamURL = (route: ServiceRoute, rest: string, search: string): URL => {
  const u = new URL(route.upstream);
  const base = u.pathname.endsWith('/') ? u.pathname.slice(0, -1) : u.pathname;
  const tail = rest.startsWith('/') ? rest : `/${rest}`;
  u.pathname = base + tail;
  u.search = search;
  return u;
};

export const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'keyproxy'}`);

  if (url.pathname === '/healthz') { res.writeHead(200); res.end('ok'); return; }

  // What the gateway seals secrets to. Public by definition: it opens nothing.
  if (url.pathname === '/vault/public-key' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(vaultPublicKey()));
    return;
  }

  // Proof that this proxy opens what the gateway sealed, asked once, before the
  // gateway deletes the key it can no longer need. Opens the canary only: its
  // vault name is one no secret has, so no stored value opens here.
  if (url.pathname === '/vault/verify' && req.method === 'POST') {
    let digest: string;
    try {
      digest = openCanary(JSON.parse((await readBody(req)).toString('utf8')) as Parameters<typeof openCanary>[0]);
    } catch { return send(res, 400, 'not a canary this key opens'); }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ digest }));
    return;
  }

  // The plan's windows, for the gateway only. Percentages and reset times, no
  // secret — but a company's own token must not read the installation's plan,
  // so it takes the install scope, which only the gateway can mint.
  if (url.pathname === '/usage' && req.method === 'GET') {
    const auth = req.headers['authorization'];
    const scope = typeof auth === 'string' && auth.startsWith('Bearer ') ? verifyScopedToken(auth.slice(7)) : null;
    if (scope?.company !== INSTALL_SCOPE) return send(res, 401, 'the usage reading takes the install scope');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(installUsage ?? { at: null, windows: [] }));
    return;
  }

  // /svc/<service>/<rest...>
  const m = /^\/svc\/([^/]+)(\/.*)?$/.exec(url.pathname);
  if (!m) return send(res, 404, 'not a /svc/<service> request');
  const service = decodeURIComponent(m[1]!);
  const rest = m[2] ?? '/';

  const auth = req.headers['authorization'];
  const token = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const scope = token ? verifyScopedToken(token) : null;
  if (!scope) return send(res, 401, 'missing or invalid scoped token');

  // The reserved runtime route is synthesized from the credential type; every
  // other service is a declared route whose secret the vault holds.
  let route: ServiceRoute;
  let key: string;
  let readsPlan = false;
  if (service === RUNTIME_SERVICE_NAME) {
    const rt = runtimeRoute(scope.company);
    if ('status' in rt) return send(res, rt.status, rt.msg);
    route = rt.route;
    key = rt.key;
    readsPlan = rt.install;
  } else if (scope.company === INSTALL_SCOPE) {
    // The install scope exists to reach the runtime route and the usage reading.
    return send(res, 404, `no service '${service}' for this company`);
  } else {
    const declared = routeFor(scope.company, service);
    // A service the company has not declared gets nothing — same answer whether
    // it is unknown or forbidden, so probing tells an attacker nothing.
    if (!declared) return send(res, 404, `no service '${service}' for this company`);
    // What validateServiceRoute refuses, refused again here: the config file is
    // the gateway's to write, and the gateway is what this proxy does not trust.
    if (declared.secret === RUNTIME_SECRET_NAME) {
      return send(res, 403, `service '${service}' names the runtime credential, which no service route may send`);
    }
    const dest = destinationOf(declared);
    if (!CREDENTIAL_HEADERS.has(dest.header)) {
      return send(res, 403, `service '${service}' injects on '${dest.header}', which is not a credential header`);
    }
    const opened = openSecret(scope.company, declared.secret);
    // The route names a secret the vault does not hold: a misconfiguration, not a
    // caller error, and never a reason to forward the call unauthenticated.
    if (opened == null) return send(res, 502, `service '${service}' has no credential configured`);
    // Where the value may go was sealed into it when it was entered. A route
    // pointed anywhere else since — another host, another header, another
    // scheme — gets nothing until the key is entered again for it.
    if (!opened.to.some((d) => sameDestination(d, dest))) {
      console.log(`keyproxy ${scope.company} ${service} -> ${new URL(declared.upstream).host} destination-refused`);
      return send(res, 502, `service '${service}' sends its key to ${dest.origin} on '${dest.header}', ` +
        `which is not where it was stored for; enter the key again to send it there`);
    }
    route = declared;
    key = opened.value;
  }

  // TRACE and its kin answer with the request they were sent, key included; an
  // upstream that honours one hands the key to whoever asked.
  if (!FORWARDED_METHODS.has(req.method ?? '')) return send(res, 405, `method ${req.method} is not forwarded`);

  const target = upstreamURL(route, rest, url.search);

  // Defense in depth beyond validateServiceRoute (enforced on the API path but
  // bypassed by a hand-edited or imported config): never inject a real key onto a
  // plaintext hop. https anywhere; http ONLY to loopback (same-host test and dev
  // upstreams). Anything else — a stray ftp://, an http:// to a real host — is
  // refused here rather than transmitted or thrown on downstream. URL.hostname
  // returns IPv6 bracketed, so the loopback set matches the bracketed form; the
  // numeric shorthands (127.1, 0x7f000001) normalise to 127.0.0.1 already.
  const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(target.hostname);
  if (!(target.protocol === 'https:' || (target.protocol === 'http:' && loopback))) {
    console.log(`keyproxy ${scope.company} ${service} -> ${target.host} plaintext-refused`);
    return send(res, 502, 'refusing to send a credential to a non-https upstream');
  }

  // Copy the caller's headers minus the ones we must not pass, then inject the
  // credential on the route's header. Default is a bearer Authorization; a
  // service wanting a raw header value sets an empty scheme.
  const headers: OutgoingHttpHeaders = {};
  // The same reading of the route the destination check made, so what was
  // checked is what is sent.
  const { header: injectHeader, scheme } = destinationOf(route);
  for (const [k, v] of Object.entries(req.headers)) {
    if (v == null) continue;
    const lk = k.toLowerCase();
    if (HOP_BY_HOP.has(lk) || lk === injectHeader) continue;
    headers[lk] = v; // IncomingMessage keys are already lowercase
  }
  // Static, non-secret headers the route declares (e.g. the `anthropic-beta`
  // flag and a `claude-code` user-agent an OAuth upstream requires). Applied
  // AFTER the caller's headers so a route-declared value wins over one the
  // product sent — that is what lets a route force `user-agent: claude-code/…`.
  // Defense in depth for a hand-edited/imported config that bypassed
  // validateServiceRoute: skip framing headers and the credential header so a
  // static entry can never clobber what the proxy owns; the credential is
  // injected last regardless, so it always wins.
  if (route.headers) {
    for (const [k, v] of Object.entries(route.headers)) {
      const lk = k.toLowerCase();
      if (HOP_BY_HOP.has(lk) || lk === injectHeader) continue;
      // `anthropic-beta` is a comma-separated list, and Claude Code sends its own
      // — the context-management beta its auto-compaction needs, among others.
      // Overwriting it dropped those, and the API then rejected the request
      // body's `context_management` field with `400 Extra inputs are not
      // permitted`, failing every long-context shift on the runtime route. So for
      // this one header MERGE the route's required flag into the caller's list
      // (deduped) instead of replacing it; every other header still wins outright.
      const prev = headers[lk];
      if (lk === 'anthropic-beta' && (typeof prev === 'string' || Array.isArray(prev))) {
        const prevStr = Array.isArray(prev) ? prev.join(',') : prev;
        const seen = new Set<string>();
        for (const b of `${prevStr},${v}`.split(',').map((s) => s.trim()).filter(Boolean)) seen.add(b);
        headers[lk] = [...seen].join(',');
      } else {
        headers[lk] = v;
      }
    }
  }
  headers[injectHeader] = scheme ? `${scheme} ${key}` : key;

  const method = req.method ?? 'GET';
  const hasBody = method !== 'GET' && method !== 'HEAD';
  const body = hasBody ? await readBody(req) : undefined;

  // A byte pipe over a node builtin, NOT fetch: the keyproxy image ships no
  // node_modules, so undici's request() is unavailable, and fetch would decode
  // the body (which this proxy never reads) only to force us to re-frame it.
  // node:http(s).request forwards the body untouched and — unlike fetch — never
  // follows a redirect, so the key is injected once, to the declared host, and
  // an open redirect can never carry it onward. https validates the upstream
  // cert against the image's ca-certificates; the validator holds upstream to
  // https, and http is here only for a same-host test upstream.
  const doRequest = target.protocol === 'https:' ? httpsRequest : httpRequest;
  await new Promise<void>((resolve) => {
    // Answer the caller once, then settle the wait. Guarded so a second terminal
    // event (a timeout that fires as the body ends, a client abort racing an
    // upstream error) can never write twice or throw on a spent response.
    const fail = (code: number, msg: string): void => {
      if (!res.headersSent && !res.destroyed) send(res, code, msg);
      else if (!res.writableEnded && !res.destroyed) res.end();
      resolve();
    };
    const upstreamReq = doRequest(target, { method, headers }, (up) => {
      // The whole callback is guarded: it runs outside the Promise executor, so a
      // throw here (a header value writeHead rejects) would otherwise escape both
      // this Promise and handle()'s catch — an uncaught hang, not a 500.
      try {
        const status = up.statusCode ?? 502;
        // A drain can surface a stream error (an upstream that closes mid-body);
        // catch it so it can never become an unhandled 'error' on a future runtime.
        up.on('error', () => fail(502, 'upstream stream error'));
        // A redirect is refused, not chased and not passed on. Nothing follows it
        // (the core client does not auto-follow), so the injected key never reaches
        // the redirect's host; we also do not forward the Location, closing the
        // caller chasing it. Refuse on the header's PRESENCE (even empty), matching
        // the old redirect:'manual' guard. A model API does not redirect a call.
        if (status >= 300 && status < 400 && 'location' in up.headers) {
          up.resume(); // drain so the socket can be reused/closed
          console.log(`keyproxy ${scope.company} ${service} -> ${target.host} redirect-refused ${status}`);
          return fail(502, 'upstream attempted a redirect, which is not followed');
        }
        // One audit line, and the key is not in it.
        console.log(`keyproxy ${scope.company} ${service} -> ${target.host} ${status}`);
        if (readsPlan) {
          const windows = unifiedWindows(up.headers);
          if (windows.length) installUsage = { at: Date.now(), windows };
        }
        const outHeaders: OutgoingHttpHeaders = {};
        for (const [k, v] of Object.entries(up.headers)) {
          if (v == null || HOP_BY_HOP.has(k.toLowerCase())) continue;
          outHeaders[k] = v;
        }
        res.writeHead(status, outHeaders);
        up.pipe(res);
        up.on('end', () => resolve());
      } catch (e) {
        up.resume(); // don't leave the upstream socket hanging
        console.log(`keyproxy ${scope.company} ${service} -> ${target.host} relay-error`);
        fail(502, 'relay error');
      }
    });
    upstreamReq.on('error', (e) => {
      console.log(`keyproxy ${scope.company} ${service} -> ${target.host} transport-error`);
      // Never the error's text: a TLS failure quoted the Host header, and a key
      // routed onto Host came straight back to the caller in it.
      fail(502, 'upstream unreachable');
    });
    // node:http has NO default timeout (undici's fetch applied ~300s), so a
    // stalling upstream would hang this request forever — and on the SHARED
    // keyproxy, stalled requests pile up open sockets until it serves no company.
    // Bound it and fail closed; destroy() lands in the 'error' handler above.
    // Read here, not at module load, so a test can shorten it without a reimport.
    const timeoutMs = Number(process.env['KEYPROXY_UPSTREAM_TIMEOUT_MS'] ?? 120_000);
    upstreamReq.setTimeout(timeoutMs, () => upstreamReq.destroy(new Error('upstream timeout')));
    // A killed shift (or any client disconnect) must release the upstream socket
    // too, or the same handle leak accrues from the caller side.
    res.on('close', () => { if (!res.writableEnded) upstreamReq.destroy(); });
    if (body && body.length) upstreamReq.end(body);
    else upstreamReq.end();
  });
};

export const start = (port = PORT): ReturnType<typeof createServer> => {
  // Made before the first request, so the gateway's fetch of the public key
  // never races its creation.
  let kid: string;
  try {
    ({ kid } = loadOrCreateVaultKey());
  } catch (e) {
    // Said as the fix, not a stack: on a rootful Linux daemon /keys is not
    // this user's until someone makes it so.
    console.error(`keyproxy: cannot read or create the vault key in ${vaultKeysDir()} ` +
      `(${e instanceof Error ? e.message : String(e)}), running as uid ${process.getuid?.() ?? '?'}.\n` +
      `  Give the host directory behind RIFF_KEYS (default ~/.riff-keys) to this uid, or set UID/GID ` +
      `in docker/.env and uncomment the keyproxy's user: line in compose.yaml.`);
    process.exit(1);
  }
  console.log(`keyproxy vault key ${kid}`);
  const server = createServer((req, res) => {
    handle(req, res).catch((e) => {
      // A handler that throws must still answer, and must not leak a stack that
      // could carry a fragment of something sensitive.
      if (!res.headersSent) send(res, 500, 'internal proxy error');
      else res.end();
      console.log(`keyproxy error: ${e instanceof Error ? e.message : String(e)}`);
    });
  });
  server.listen(port, () => console.log(`keyproxy listening on :${port}`));
  return server;
};

// Started as the container's command; import it in a test without listening.
if (process.argv[1] && process.argv[1].endsWith('keyproxy/main.ts')) start();
