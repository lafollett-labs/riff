import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse,
  type OutgoingHttpHeaders } from 'node:http';
import { request as httpsRequest } from 'node:https';
import {
  resolveConfig, RUNTIME_SERVICE_NAME, RUNTIME_SECRET_NAME, RUNTIME_UPSTREAM,
  runtimeRouteHeaders, runtimeRouteShape, type ServiceRoute,
} from '../core/config.ts';
import { getSecret, getInstallSecret } from '../core/secrets.ts';
import { readSettings } from '../core/settings.ts';
import { verifyScopedToken } from '../core/proxytoken.ts';

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
  { route: ServiceRoute; key: string } | { status: number; msg: string } => {
  const own = resolveConfig(process.cwd(), company).runtimeCredential;
  const type = own?.type ?? readSettings().runtimeCredential?.type ?? 'subscription';
  const key = own ? getSecret(company, RUNTIME_SECRET_NAME) : getInstallSecret(RUNTIME_SECRET_NAME);
  if (key == null) {
    return { status: 502, msg: own
      ? "this company has a runtime credential type but no token; set it in the company's Runtime credential"
      : 'no runtime credential is set; set one in Riff Settings' };
  }
  const { header, scheme } = runtimeRouteShape(type);
  return {
    route: { upstream: RUNTIME_UPSTREAM, secret: RUNTIME_SECRET_NAME, header, scheme, headers: runtimeRouteHeaders(type) },
    key,
  };
};

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
  if (service === RUNTIME_SERVICE_NAME) {
    const rt = runtimeRoute(scope.company);
    if ('status' in rt) return send(res, rt.status, rt.msg);
    route = rt.route;
    key = rt.key;
  } else {
    const declared = routeFor(scope.company, service);
    // A service the company has not declared gets nothing — same answer whether
    // it is unknown or forbidden, so probing tells an attacker nothing.
    if (!declared) return send(res, 404, `no service '${service}' for this company`);
    const secret = getSecret(scope.company, declared.secret);
    // The route names a secret the vault does not hold: a misconfiguration, not a
    // caller error, and never a reason to forward the call unauthenticated.
    if (secret == null) return send(res, 502, `service '${service}' has no credential configured`);
    route = declared;
    key = secret;
  }

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
  const injectHeader = (route.header ?? 'authorization').toLowerCase();
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
      headers[lk] = v;
    }
  }
  const scheme = route.scheme ?? 'Bearer';
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
      fail(502, `upstream unreachable: ${e instanceof Error ? e.message : String(e)}`);
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
