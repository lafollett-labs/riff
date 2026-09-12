import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { resolveConfig, type ServiceRoute } from '../core/config.ts';
import { getSecret } from '../core/secrets.ts';
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

// Headers we never copy onward: the token (replaced), hop-by-hop framing, and
// content-length (fetch recomputes it). The injection header is dropped too, so
// a caller cannot smuggle in its own value on the header we are about to set.
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

const routeFor = (company: string, service: string): ServiceRoute | null => {
  // resolveConfig with an explicit slug reads exactly that company's config;
  // services defaults to {} for a company that declares none.
  const services = resolveConfig(process.cwd(), company).services;
  return services[service] ?? null;
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

  const route = routeFor(scope.company, service);
  // A service the company has not declared gets nothing — same answer whether
  // it is unknown or forbidden, so probing tells an attacker nothing.
  if (!route) return send(res, 404, `no service '${service}' for this company`);

  const key = getSecret(scope.company, route.secret);
  // The route names a secret the vault does not hold: a misconfiguration, not a
  // caller error, and never a reason to forward the call unauthenticated.
  if (key == null) return send(res, 502, `service '${service}' has no credential configured`);

  const target = upstreamURL(route, rest, url.search);

  // Copy the caller's headers minus the ones we must not pass, then inject the
  // credential on the route's header. Default is a bearer Authorization; a
  // service wanting a raw header value sets an empty scheme.
  const headers = new Headers();
  const injectHeader = (route.header ?? 'authorization').toLowerCase();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v == null) continue;
    const lk = k.toLowerCase();
    if (HOP_BY_HOP.has(lk) || lk === injectHeader) continue;
    headers.set(k, Array.isArray(v) ? v.join(', ') : v);
  }
  const scheme = route.scheme ?? 'Bearer';
  headers.set(injectHeader, scheme ? `${scheme} ${key}` : key);

  const method = req.method ?? 'GET';
  const hasBody = method !== 'GET' && method !== 'HEAD';
  const body = hasBody ? await readBody(req) : undefined;

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method,
      headers,
      // NEVER follow a redirect. fetch defaults to 'follow', and undici does
      // not strip a CUSTOM injection header (an X-Api-Key route, say) across a
      // cross-origin hop — so an open redirect on the declared upstream would
      // hand the real key to the redirect's host. Manual hands the 3xx straight
      // back to the caller instead; the key is injected once, to the declared
      // host, and never re-sent.
      redirect: 'manual',
      ...(body && body.length ? { body } : {}),
    });
  } catch (e) {
    console.log(`keyproxy ${scope.company} ${service} -> ${target.host} transport-error`);
    return send(res, 502, `upstream unreachable: ${e instanceof Error ? e.message : String(e)}`);
  }

  // A redirect is refused, not chased and not passed on. `redirect: 'manual'`
  // stops undici from following it (which would re-send the injected key to the
  // redirect's host — the exfil path this guards). It hands back the real 3xx
  // with its Location, so the remaining risk is the CALLER chasing it; we close
  // that too by refusing rather than forwarding the Location. A model API does
  // not legitimately redirect a completion, so failing closed loses nothing.
  if (upstream.status >= 300 && upstream.status < 400 && upstream.headers.has('location')) {
    console.log(`keyproxy ${scope.company} ${service} -> ${target.host} redirect-refused ${upstream.status}`);
    return send(res, 502, 'upstream attempted a redirect, which is not followed');
  }

  // One audit line, and the key is not in it.
  console.log(`keyproxy ${scope.company} ${service} -> ${target.host} ${upstream.status}`);

  const outHeaders: Record<string, string> = {};
  upstream.headers.forEach((v, k) => { if (!HOP_BY_HOP.has(k.toLowerCase())) outHeaders[k] = v; });
  res.writeHead(upstream.status, outHeaders);
  if (upstream.body) {
    Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]).pipe(res);
  } else {
    res.end();
  }
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
