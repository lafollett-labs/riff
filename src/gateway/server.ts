import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { systemClock } from '../core/clock.ts';
import {
  guessKeeperName, listCompanies, migrateLegacyLayout, resolveSlug, validateServiceRoute,
  readRuntimeCredential, RUNTIME_SECRET_NAME,
} from '../core/config.ts';
import { Registry, type Company } from '../company/registry.ts';
import { runtimeCredentialHealth } from '../runtime/credential.ts';
import { renameAgent } from '../company/rename.ts';
import { redefineAgent } from '../company/redefine.ts';
import { modelCatalog } from '../runtime/models.ts';
import { EFFORTS, INHERIT, isEffort, isModelId, type StaffDefaults } from '../core/models.ts';
import { vitals } from '../analytics/vitals.ts';
import { exportCompany, exportName, importCompany } from '../company/transfer.ts';
import { isOperatorError, installRoot } from '../core/config.ts';
import { takeInstallationLock, type Lock } from '../core/lock.ts';
import {
  putSecret, listSecretNames, deleteSecret, hasSecret,
  putInstallSecret, hasInstallSecret, deleteInstallSecret,
} from '../core/secrets.ts';
import { readSettings, setDefaultRuntimeCredentialType, clearDefaultRuntimeCredential,
         setUsagePollMinutes, DEFAULT_USAGE_POLL_MINUTES, MAX_USAGE_POLL_MINUTES } from '../core/settings.ts';
import { startUsageFeed } from '../runtime/usageFeed.ts';
import { shellIsContained } from '../runtime/permissions.ts';
import { readFile } from 'node:fs/promises';
import { createReadStream, createWriteStream, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { openWithin } from '../worldfs/within.ts';
import { pipeline } from 'node:stream/promises';
import { extname, join, resolve, sep } from 'node:path';

const PORT = Number(process.env['PORT'] ?? 4173);
const clock = systemClock;

// The first layout put one company flat in ~/.riff. Move it before
// anything opens it, so an existing world is never stranded by an upgrade.
const migrated = migrateLegacyLayout();

/**
 * One writer per installation, taken before anything opens a ledger.
 *
 * The host and the container mount the same ~/.riff on purpose — a company
 * founded one way is there the other way. Two servers on it is not a
 * conflicting file, it is two schedulers waking the same staff: doubled spend,
 * two sessions committing to one git repository, and a ledger recording both
 * their accounts of what happened.
 *
 * The failure this prevents is mundane and easy: forget the server running in
 * a terminal, start the container, and both are live against the same worlds.
 */
let lock: Lock;
try {
  lock = takeInstallationLock();
} catch (e) {
  if (isOperatorError(e)) { console.error(`\n  ${(e as Error).message}\n`); process.exit(1); }
  throw e;
}

const registry = new Registry(clock);

// A fresh installation starts empty, and says so.
//
// This used to found "Untitled Company" so a new checkout was never blank. It
// meant the first thing anyone saw was a company they did not ask for, sitting
// next to the one they came to import — and importing is exactly what a second
// machine does first. The console has an empty state that offers both founding
// and importing; that is a better first screen than a placeholder.
//
// RIFF_COMPANY and friends still seed a company when one is founded, so a
// container can be brought up configured from environment alone.

// ---------------------------------------------------------------- SSE fan-out
// Per company. A watcher on one company must never receive another's events —
// that would leak one company's activity into a different company's console.
const watchers = new Map<string, Set<ServerResponse>>();
const lastSeq = new Map<string, number>();

setInterval(() => {
  for (const [slug, set] of watchers) {
    if (!set.size) continue;
    const c = registry.get(slug);
    if (!c) continue;
    const from = lastSeq.get(slug) ?? c.ledger.latestSeq();
    const fresh = c.ledger.eventsSince(from, 200);
    if (!fresh.length) continue;
    lastSeq.set(slug, fresh[fresh.length - 1]!.seq);
    const payload = JSON.stringify({ events: fresh });
    for (const w of set) {
      try { w.write(`event: tick\ndata: ${payload}\n\n`); } catch { set.delete(w); }
    }
  }
}, 700).unref();

const json = (res: ServerResponse, body: unknown, status = 200): void => {
  const s = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s) });
  res.end(s);
};

/**
 * Refuse a start no runtime credential can back, rather than letting the company
 * wake and fail every shift until someone reads the ledger — which is exactly how
 * a run limped on through the night on 2026-09-11. Answers 503, because the fix is
 * setting a credential, not a malformed request, and names it. A no-op outside the
 * container: see runtimeCredentialHealth.
 */
const refuseIfNoCredential = (res: ServerResponse, slug: string): boolean => {
  const cred = runtimeCredentialHealth(slug);
  if (cred.live) return false;
  json(res, { error: `cannot start ${slug}: ${cred.why}`, fix: cred.fix }, 503);
  return true;
};

/** An upload of at most this. A company is megabytes; a mistake is gigabytes. */
const MAX_UPLOAD = 512 * 1024 * 1024;

/**
 * Spool a raw request body to a file.
 *
 * An exported company carries its whole git history, so this is tens of
 * megabytes on a good day. Buffering that in memory to write it straight back
 * out helps nobody.
 */
const spool = async (req: IncomingMessage, to: string): Promise<number> => {
  let size = 0;
  const out = createWriteStream(to);
  await pipeline(
    (async function* () {
      for await (const c of req) {
        size += (c as Buffer).length;
        if (size > MAX_UPLOAD) throw new Error('upload too large');
        yield c as Buffer;
      }
    })(),
    out,
  );
  return size;
};

/**
 * Read a raw binary request body, refusing anything past `max`. The JSON
 * readBody caps at 1MB and parses; an image is neither, so it needs its own.
 */
const readBinaryBody = async (req: IncomingMessage, max: number): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > max) throw new Error('body too large');
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
};

/**
 * Why a model setting is refused, or null. The catalog is the CLI's own list;
 * the value already stored is let through, so a seat on a model the CLI has
 * since dropped can still have its effort changed without being moved.
 */
const modelRefusal = async (model: unknown, current?: string): Promise<string | null> => {
  if (!isModelId(model)) return 'model must be a model id or alias';
  if (model === current) return null;
  const { models } = await modelCatalog();
  return models.some((m) => m.value === model) ? null
    : `'${model}' is not a model this installation offers: one of ${models.map((m) => m.value).join(', ')}`;
};

/**
 * The extension for an image, decided by its bytes rather than the client's
 * word. Only raster types a paste or a screenshot actually produces — SVG is
 * refused because it is the one "image" that can carry script, and nothing
 * pastes one anyway. Unrecognized bytes return null and the upload is refused,
 * so the world never gains a file whose contents do not match its name.
 */
const sniffImage = (b: Buffer): string | null => {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b.length >= 6 && b.toString('latin1', 0, 4) === 'GIF8') return 'gif';
  if (b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  // AVIF/HEIF: an ISO-BMFF 'ftyp' box whose major/compatible brand is avif.
  if (b.length >= 12 && b.toString('latin1', 4, 8) === 'ftyp' && b.toString('latin1', 8, 12).startsWith('avi')) return 'avif';
  return null;
};

const readBody = async (req: IncomingMessage): Promise<Record<string, unknown>> => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 1_000_000) throw new Error('body too large');
    chunks.push(c as Buffer);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>; }
  catch { return {}; }
};

const DESK = resolve(import.meta.dirname, '../../desk/dist');

/**
 * What /api/file will serve. An allowlist rather than a lookup with a
 * fallback: an unknown extension is a refusal, so a file the staff invented
 * an extension for cannot be served as anything at all.
 */
const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif',
};
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.ico': 'image/x-icon',
};

const serveDesk = async (res: ServerResponse, urlPath: string): Promise<void> => {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const abs = resolve(DESK, rel);
  // A built asset path is ours; anything climbing out of it is not.
  const target = abs === DESK || abs.startsWith(DESK + sep) ? abs : join(DESK, 'index.html');
  try {
    const body = await readFile(target);
    res.writeHead(200, { 'content-type': MIME[extname(target)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    try {
      // Unknown paths fall through to the SPA so client routes survive reload.
      const body = await readFile(join(DESK, 'index.html'));
      res.writeHead(200, { 'content-type': MIME['.html']! });
      res.end(body);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('The Desk has not been built. Run: npm run desk:build');
    }
  }
};

/**
 * A brief used to be a line of business, so 2000 characters was generous and
 * quietly dropping the rest was harmless. It is now the thing that steers the
 * company: Fathom's fifth brief is 3755 characters, and the cut landed
 * mid-word, four paragraphs before the one naming the acceptance test. A
 * company founded on half its instructions reads as a company that ignored
 * them. Refuse, and say by how much.
 */
const BRIEF_MAX = 20_000;
const briefTooLong = (s: string): string | null =>
  s.length > BRIEF_MAX
    ? `brief is ${s.length} characters; a company will hold ${BRIEF_MAX}`
    : null;

/** A board reaches the API as names or as {name, role}; both mean a seat. */
const boardFrom = (raw: readonly unknown[]): Array<{ name: string; role?: string }> =>
  raw.flatMap((m) => {
    if (typeof m === 'string') return m.trim() ? [{ name: m }] : [];
    if (!m || typeof m !== 'object') return [];
    const o = m as Record<string, unknown>;
    const name = typeof o['name'] === 'string' ? o['name'] : '';
    if (!name.trim()) return [];
    return [typeof o['role'] === 'string' ? { name, role: o['role'] } : { name }];
  });

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const p = url.pathname;
  const method = req.method ?? 'GET';

  try {
    // ------------------------------------------------- the installation
    if (p === '/api/companies' && method === 'GET') {
      return json(res, { companies: registry.list(), active: resolveSlug() });
    }

    // The plan's windows, as the keyproxy last read them off the runtime
    // credential's own responses (see src/runtime/usageFeed.ts). Nothing posts
    // them any more: the host poller that did is gone.
    if (p === '/api/usage' && method === 'GET') {
      const u = registry.usage;
      if (!u) return json(res, { at: null, windows: [] });
      return json(res, {
        at: new Date(u.at).toISOString(),
        windows: u.windows.map(([kind, w]) => ({
          kind,
          utilization: w.utilization ?? null,
          resetsAt: w.resetsAt ? new Date(w.resetsAt * 1000).toISOString() : null,
        })),
      });
    }

    // The models a seat may be given, as the bundled CLI lists them. The same
    // list for every company, so it is not behind ?c=.
    if (p === '/api/models' && method === 'GET') {
      return json(res, await modelCatalog());
    }

    // Installation-level settings — the Riff-level surface, not any one company.
    // Today just the DEFAULT runtime credential: the type in settings.json, the
    // token value in the install vault. GET reports the type and whether a value
    // is set; it never returns the value.
    if (p === '/api/settings' && method === 'GET') {
      return json(res, {
        runtimeCredential: readSettings().runtimeCredential ?? null,
        runtimeCredentialSet: hasInstallSecret(RUNTIME_SECRET_NAME),
        usagePollMinutes: readSettings().usagePollMinutes ?? DEFAULT_USAGE_POLL_MINUTES,
        usagePollMax: MAX_USAGE_POLL_MINUTES,
      });
    }
    // How stale the usage reading may get before a one-token refresh. Its own
    // route: the credential PUT below moves a type and a token together, and
    // this has nothing to do with either.
    if (p === '/api/settings/usage' && method === 'PUT') {
      const b = await readBody(req);
      const m = b['usagePollMinutes'];
      if (typeof m !== 'number' || !Number.isFinite(m) || m < 0 || m > MAX_USAGE_POLL_MINUTES) {
        return json(res, { error: `usagePollMinutes must be a number of minutes from 0 (off) to ${MAX_USAGE_POLL_MINUTES}` }, 400);
      }
      setUsagePollMinutes(m);
      return json(res, { usagePollMinutes: readSettings().usagePollMinutes ?? DEFAULT_USAGE_POLL_MINUTES });
    }
    if (p === '/api/settings' && method === 'PUT') {
      const b = await readBody(req);
      const rc = readRuntimeCredential(b['runtimeCredential']);
      if (b['runtimeCredential'] !== undefined && !rc) {
        return json(res, { error: 'runtimeCredential.type must be "subscription" or "apiKey"' }, 400);
      }
      // Strip ONLY surrounding CR/LF from the token (the paste artifact that 401s
      // silently), never inner bytes. Stored in the install vault, never echoed.
      const value = typeof b['value'] === 'string' ? b['value'].replace(/^[\r\n]+|[\r\n]+$/g, '') : '';
      // A token and its type travel together: the keyproxy injects a subscription
      // token as Bearer and an API key as x-api-key, so a value stored with no
      // resolvable type would be sent in the wrong shape and 401 silently.
      const effectiveType = rc?.type ?? readSettings().runtimeCredential?.type;
      if (value && !effectiveType) {
        return json(res, { error: 'set a credential type before or with the token value' }, 400);
      }
      // The stored token is provider-specific (a subscription Bearer vs an API
      // x-api-key), so setting or changing the type without a fresh value would
      // leave the wrong token under the new shape. Type and value move together;
      // a value alone (no type) is a rotation that keeps the existing type.
      if (rc && !value) {
        return json(res, { error: 'provide the token value along with the credential type' }, 400);
      }
      try {
        if (rc) setDefaultRuntimeCredentialType(rc.type);
        if (value) putInstallSecret(RUNTIME_SECRET_NAME, value);
      } catch (e) {
        return json(res, { error: e instanceof Error ? e.message : String(e) }, 400);
      }
      return json(res, {
        ok: true,
        runtimeCredential: readSettings().runtimeCredential ?? null,
        runtimeCredentialSet: hasInstallSecret(RUNTIME_SECRET_NAME),
      });
    }
    // Clear the installation default: drop both the type and the vault value, so a
    // company that was inheriting it now resolves nothing and cannot run until a
    // default (or its own override) is set. A company with its OWN credential is
    // unaffected. The two deletes mirror the per-company revert below.
    if (p === '/api/settings' && method === 'DELETE') {
      clearDefaultRuntimeCredential();
      deleteInstallSecret(RUNTIME_SECRET_NAME);
      return json(res, { ok: true, runtimeCredential: null, runtimeCredentialSet: false });
    }

    if (p === '/api/companies' && method === 'POST') {
      const b = await readBody(req);
      const business = String(b['business'] ?? '');
      const tooLong = briefTooLong(business);
      if (tooLong) return json(res, { error: tooLong }, 400);
      const r = registry.found({
        name: String(b['name'] ?? ''),
        business,
        ceo: String(b['ceo'] ?? ''),
        chair: String(b['chair'] ?? guessKeeperName()),
        ...(Array.isArray(b['board']) ? { board: boardFrom(b['board']) } : {}),
        ...(b['policy'] && typeof b['policy'] === 'object' ? { policy: b['policy'] } : {}),
        ...(typeof b['release'] === 'string' ? { release: b['release'] } : {}),
      });
      if (!r.ok) return json(res, { error: r.reason }, 409);
      // A company founded on purpose starts working on purpose. Its CEO has an
      // empty world and a mandate, and the first thing anyone wants to see is
      // what it does with them. `running: false` is for the caller founding
      // several and reading them over before any of them spends anything.
      const start = b['running'] !== false;
      if (start) await registry.setRunning(r.company.slug, true);
      return json(res, {
        slug: r.company.slug,
        company: r.company.cfg.company,
        ceo: r.company.cfg.ceo,
        board: r.company.cfg.board,
        policy: r.company.cfg.policy,
        release: r.company.cfg.release,
        running: start,
      }, 201);
    }

    /*
     * Carrying a company off this machine and back onto another.
     *
     * The export is a snapshot taken while the company may still be working —
     * the ledger copy is consistent because VACUUM INTO makes it so, but a
     * file a staff member is halfway through writing is caught halfway. Pause
     * first if that matters.
     */
    if (p.startsWith('/api/companies/') && p.endsWith('/export') && method === 'GET') {
      const target = p.slice('/api/companies/'.length, -'/export'.length);
      const dir = join(installRoot(), '.transfer');
      mkdirSync(dir, { recursive: true });
      const work = mkdtempSync(join(dir, 'download-'));
      const file = join(work, exportName(target));
      try {
        exportCompany(target, file);
        res.writeHead(200, {
          'content-type': 'application/gzip',
          'content-length': String(statSync(file).size),
          'content-disposition': `attachment; filename="${exportName(target)}"`,
        });
        await pipeline(createReadStream(file), res);
      } catch (e) {
        if (!res.headersSent) {
          const known = isOperatorError(e);
          return json(res, { error: known ? (e as Error).message : 'export failed' }, known ? 404 : 500);
        }
        res.destroy();
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
      return;
    }

    /*
     * The other direction. The body is the archive itself rather than a
     * multipart form: there is exactly one file, and parsing multipart to
     * discover that would be work for its own sake.
     */
    if (p === '/api/companies/import' && method === 'POST') {
      const dir = join(installRoot(), '.transfer');
      mkdirSync(dir, { recursive: true });
      const work = mkdtempSync(join(dir, 'upload-'));
      const file = join(work, 'incoming.tar.gz');
      try {
        const size = await spool(req, file);
        if (!size) return json(res, { error: 'nothing was uploaded' }, 400);
        const name = url.searchParams.get('name')?.trim();
        const landed = importCompany(file, { ...(name ? { name } : {}) });
        return json(res, {
          slug: landed.slug, renamed: landed.renamed, manifest: landed.manifest,
        }, 201);
      } catch (e) {
        const known = isOperatorError(e);
        return json(res, { error: known ? (e as Error).message : String((e as Error).message ?? e) },
          known ? 422 : 500);
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
    }

    // Start or pause a company without switching to it, so the operator can
    // run several at once and see which ones are working.
    if (p.startsWith('/api/companies/') && p.endsWith('/running') && method === 'POST') {
      const target = p.slice('/api/companies/'.length, -'/running'.length);
      const b = await readBody(req);
      // Hard stops for a run nobody is watching. They belong to the run, not
      // to the company's policy — the same company is left going overnight one
      // day and watched the next, and a deadline that outlived the run it was
      // set for would stop the next one early.
      const hours = Number(b['hours']);
      const ticks = Number(b['maxTicks']);
      const bounds = {
        until: Number.isFinite(hours) && hours > 0 ? Date.now() + hours * 3_600_000 : null,
        maxTicks: Number.isFinite(ticks) && ticks > 0 ? Math.round(ticks) : null,
      };
      const run = b['running'] === true;
      if (run && refuseIfNoCredential(res, target)) return;
      // A pause drains: nobody new is woken and whoever is mid-shift finishes
      // writing. Killing them is `hard`, and it has to be asked for by name.
      //
      // The default used to be the other way round, and on 2026-09-05 three
      // shifts died as `Claude Code process aborted by user` because an
      // operator edited a brief while the company was working. A shift cut off
      // that way still costs a full window and loses everything since its last
      // journal entry, so the destructive one is the one that gets the flag.
      const drain = !run && b['hard'] !== true;
      const ok = await registry.setRunning(target, run, bounds, { drain });
      // Read back rather than echoed. A run is capped by the company's
      // maxSessionHours whether or not anyone asked for a deadline, so the
      // requested figure is not always the one in force — and reporting the
      // one that is not in force is how an operator plans a night around a
      // deadline that already passed.
      const until = ok && run ? (registry.get(target)?.scheduler.until ?? null) : null;
      return ok ? json(res, {
        slug: target, running: run,
        ...(drain ? { draining: true } : {}),
        ...(until ? { until: new Date(until).toISOString() } : {}),
        ...(run && bounds.maxTicks ? { maxTicks: bounds.maxTicks } : {}),
      }) : json(res, { error: `no company '${target}'` }, 404);
    }

    // Renaming an agent moves an id that is a foreign key in six tables and a
    // folder name in the world. It lived in a script, which meant the console
    // could show a seat called `ceo` and offer no way to give it a name.
    if (p === '/api/agents/rename' && method === 'POST') {
      const b = await readBody(req);
      const slug = String(b['company'] ?? '') || (resolveSlug() ?? '');
      const co = slug ? registry.get(slug) : null;
      if (!co) return json(res, { error: `no company '${slug}'` }, 404);
      const r = renameAgent(co.ledger, co.world, co.cfg.company.name,
                            String(b['who'] ?? ''), String(b['name'] ?? ''));
      return r.ok ? json(res, r) : json(res, { error: r.reason }, 409);
    }

    // Retiring from the board's side. `retire_role` has always existed as a
    // TOOL, which means the CEO proposes and the board ratifies — fine until
    // the CEO is the thing that needs replacing, and then the only route to
    // removing someone runs through the person you want removed. Fathom sat
    // in exactly that position: a line of business the board had killed, and
    // a chief executive who would have had to propose his own dismissal.
    if (p === '/api/agents/retire' && method === 'POST') {
      const b = await readBody(req);
      const slug = String(b['company'] ?? '') || (resolveSlug() ?? '');
      const co = slug ? registry.get(slug) : null;
      if (!co) return json(res, { error: `no company '${slug}'` }, 404);

      const who = String(b['who'] ?? '');
      const why = String(b['why'] ?? '').slice(0, 400);
      if (!why.trim()) return json(res, { error: 'say why' }, 400);

      const a = co.ledger.getAgent(who);
      if (!a) return json(res, { error: `no agent '${who}'` }, 404);
      // Same rule the tool enforces, for the same reason: standing comes from
      // the constitution, and a board that can retire itself can retire the
      // only seat able to undo it.
      if (a.tier === 'board') return json(res, { error: 'the board cannot be retired' }, 409);
      if (a.status === 'departed') return json(res, { error: `${a.name} has already left` }, 409);

      // Retiring someone mid-shift would abandon a session holding a write.
      // The seat is marked on the way out and the scheduler stops choosing it,
      // so an in-flight shift finishes and is simply never woken again.
      const working = co.scheduler.awake.includes(who);

      co.ledger.upsertAgent({ ...a, status: 'departed' });
      co.ledger.emit('board', 'role.retired', who, { why, by: 'board', ...(working ? { finishing: true } : {}) });
      return json(res, { retired: who, name: a.name, finishing: working });
    }

    // Redefining an agent post-founding. `mandate` was set once at genesis and
    // `role` at hire, with no way to change either afterwards — so altering what
    // an agent *is* meant hand-editing persona.md under a stopped company. This
    // is that edit as an operation: role and the persona body are the levers the
    // system prompt actually reads, mandate is recorded for the board, and the
    // persona write is committed in the world so a shift's `git add -A` cannot
    // sign an operator's edit with the agent's name. Takes effect next shift.
    if (p === '/api/agents/redefine' && method === 'POST') {
      const b = await readBody(req);
      const slug = String(b['company'] ?? '') || (resolveSlug() ?? '');
      const co = slug ? registry.get(slug) : null;
      if (!co) return json(res, { error: `no company '${slug}'` }, 404);

      const has = (k: string): boolean => Object.prototype.hasOwnProperty.call(b, k);
      const r = redefineAgent(co.ledger, co.world, co.cfg.company.name,
        String(b['who'] ?? ''),
        {
          ...(has('role') ? { role: String(b['role'] ?? '') } : {}),
          ...(has('mandate') ? { mandate: String(b['mandate'] ?? '') } : {}),
          ...(has('persona') ? { persona: String(b['persona'] ?? '') } : {}),
        },
        String(b['why'] ?? ''));
      if (r.ok) return json(res, r);
      // 404 no such agent; 409 a rule refuses (the board) or there is nothing to
      // reconcile; 400 for the rest, which are bad input (no reason, over a cap).
      const code = r.reason.startsWith('no agent') ? 404
        : (r.reason.includes('charter') || r.reason.startsWith('no change')) ? 409
          : 400;
      return json(res, { error: r.reason }, code);
    }

    // A seat's own model and effort, overriding the company's. Board-only by
    // construction: this endpoint is the one way in, and no staff tool reaches
    // it — a seat that could raise its own effort would, and the operator's
    // window would pay. `company` hands a setting back to the company default.
    // Takes effect at the seat's next shift; one in flight keeps what it began.
    if (p === '/api/agents/model' && method === 'POST') {
      const b = await readBody(req);
      const slug = String(b['company'] ?? '') || (resolveSlug() ?? '');
      const co = slug ? registry.get(slug) : null;
      if (!co) return json(res, { error: `no company '${slug}'` }, 404);

      const a = co.ledger.getAgent(String(b['who'] ?? ''));
      if (!a) return json(res, { error: `no agent '${String(b['who'] ?? '')}'` }, 404);
      if (a.tier === 'board') return json(res, { error: 'the board is human; it has no model' }, 409);
      if (a.status === 'departed') return json(res, { error: `${a.name} has left` }, 409);

      const has = (k: string): boolean => Object.prototype.hasOwnProperty.call(b, k);
      const model = has('model') ? b['model'] : a.model;
      const effort = has('effort') ? b['effort'] : a.effort;
      if (model !== INHERIT) {
        const why = await modelRefusal(model, a.model);
        if (why) return json(res, { error: why }, 400);
      }
      if (effort !== INHERIT && !isEffort(effort)) {
        return json(res, { error: `effort must be 'company' or one of ${EFFORTS.join(', ')}` }, 400);
      }
      const next = { model: String(model), effort: String(effort) };
      if (next.model === a.model && next.effort === a.effort) return json(res, { who: a.id, ...next, changed: false });

      co.ledger.upsertAgent({ ...a, ...next });
      co.ledger.emit('board', 'agent.model', a.id, {
        model: next.model, effort: next.effort,
        was: { model: a.model, effort: a.effort },
      });
      return json(res, { who: a.id, ...next, changed: true });
    }

    if (p.startsWith('/api/companies/') && (method === 'PATCH' || method === 'DELETE')) {
      const target = p.slice('/api/companies/'.length);

      if (method === 'DELETE') {
        // Archived, never deleted. A company is a git repository with real
        // history in it, and the console is not the right place to destroy one.
        const r = await registry.archive(target);
        watchers.delete(target);
        lastSeq.delete(target);
        return r.ok ? json(res, { archived: target, at: r.at }) : json(res, { error: r.reason }, 404);
      }

      const b = await readBody(req);
      if (typeof b['business'] === 'string') {
        const tooLong = briefTooLong(b['business']);
        if (tooLong) return json(res, { error: tooLong }, 400);
      }
      const was = registry.list().find((c) => c.slug === target)?.business ?? '';

      // The company's model and effort. Checked here rather than clamped like
      // policy: a model the CLI does not offer is not a value to round to the
      // nearest one, it is a typo that would fail every shift at wake.
      let staff: Partial<StaffDefaults> | undefined;
      if (b['staff'] && typeof b['staff'] === 'object') {
        const s = b['staff'] as Record<string, unknown>;
        const current = registry.get(target)?.cfg.staff;
        staff = {};
        if (s['model'] !== undefined) {
          const why = await modelRefusal(s['model'], current?.model);
          if (why) return json(res, { error: why }, 400);
          staff.model = String(s['model']);
        }
        if (s['effort'] !== undefined) {
          if (!isEffort(s['effort'])) return json(res, { error: `effort must be one of ${EFFORTS.join(', ')}` }, 400);
          staff.effort = s['effort'];
        }
      }
      const r = await registry.update(target, {
        ...(typeof b['name'] === 'string' ? { name: b['name'] } : {}),
        ...(typeof b['business'] === 'string' ? { business: b['business'] } : {}),
        ...(typeof b['slug'] === 'string' ? { slug: b['slug'] } : {}),
        // Clamped in readPolicy, so a hand-written value cannot ask for a
        // thousand concurrent agents or a turn ceiling of zero.
        ...(b['policy'] && typeof b['policy'] === 'object'
          ? { policy: b['policy'] as Record<string, number> } : {}),
        ...(b['release'] === 'bundle' || b['release'] === 'none' ? { release: b['release'] } : {}),
        ...(staff ? { staff } : {}),
      });
      if (!r.ok) return json(res, { error: r.reason }, 409);
      if (r.slug !== target) { watchers.delete(target); lastSeq.delete(target); }

      // A brief revised after founding otherwise reaches nobody. It was copied
      // into the constitution and the CEO's papers on day one and never read
      // again — editing config.json changes a file no agent has open. So the
      // founder's new words are delivered the way the founder's words always
      // are: as mail the CEO reads on their next waking. Rewriting the
      // constitution behind them is not ours to do; it is theirs to amend.
      const co2 = registry.get(r.slug);
      if (co2 && co2.cfg.company.business !== was) {
        const from = co2.cfg.board[0]?.id ?? 'board';
        const to = co2.cfg.ceo.id;
        const text = co2.cfg.company.business
          ? `The founder has revised the brief for ${co2.cfg.company.name}.\n\n`
            + `${co2.cfg.company.business}\n\n`
            + `The constitution still says what it said on day one. Amending it is yours.`
          : `The founder has withdrawn the written brief for ${co2.cfg.company.name}.`;
        co2.ledger.sendMessage(from, to, text);
        co2.ledger.emit(from, 'company.brief', to, { was, now: co2.cfg.company.business });
        co2.scheduler.nudge(to);
      }
      return json(res, { slug: r.slug });
    }

    // ------------------------------------------------- one company
    // Every route below acts on exactly one company, named by ?c=. Refusing an
    // unknown slug matters more than it looks: without it a typo would silently
    // fall back to some other company and write to it.
    const slug = url.searchParams.get('c') ?? resolveSlug();
    const co: Company | null = slug ? registry.get(slug) : null;
    if (p.startsWith('/api/') && !co) {
      return json(res, {
        error: slug ? `no company '${slug}'` : 'name a company with ?c=<slug>',
        companies: registry.list().map((c) => c.slug),
      }, 404);
    }
    if (co) {
      const { cfg, ledger, transcript, world, gate, constitution, scheduler } = co;

      if (p === '/api/state' && method === 'GET') {
        const agents = ledger.listAgents();
        return json(res, {
          slug: co.slug,
          company: cfg.company,
          policy: cfg.policy,
          // The model and effort every seat without its own runs on.
          staff: cfg.staff,
          board: cfg.board,
          ceo: cfg.ceo,
          // Settable at founding and by PATCH, and until now readable nowhere:
          // an operator could turn a company's releases on and have no way to
          // confirm it had happened.
          release: cfg.release,
          // The company's own runtime credential, if any: the TYPE (null means it
          // inherits the install default) and whether a token value is stored.
          runtimeCredential: cfg.runtimeCredential ?? null,
          runtimeCredentialSet: hasSecret(co.slug, RUNTIME_SECRET_NAME),
          agents,
          headcount: agents.filter((a) => a.tier !== 'board').length,
          pending: ledger.listApprovals('pending').length,
          pendingBoard: ledger.listApprovals('pending', 'board').length,
          notes: ledger.countNotes(),
          // What is actually addressed to the person reading this console.
          unread: ledger.unreadCount(cfg.board[0]?.id ?? 'board'),
          commons: { held: world.commonsCount(), ceiling: constitution.commonsCeiling },
          tasks: ledger.listTasks().length,
          seq: ledger.latestSeq(),
          running: scheduler.running,
          // Who is mid-shift right now, and when everyone else is next due.
          // Without this the console can say the company is running but not
          // that anything is actually happening.
          awake: scheduler.awake,
          // Paused, but the last shifts are still finishing. Neither running
          // nor stopped, and the operator is usually waiting on exactly this.
          draining: scheduler.draining,
          dueAt: scheduler.dueAt(),
          pausedUntil: scheduler.pausedUntil || null,
          ticks: scheduler.ticks,
          rateLimit: scheduler.rateLimit,
          // Live readings only. A stopped company has no current usage, and a
          // stale reading rendered as "what the plan has left" is worse than
          // an empty panel: a five-hour window resets, and the figure from
          // before it reset says the opposite of the truth. History belongs to
          // /api/vitals, which already derives it from the same shift records.
          windows: scheduler.windows,
        });
      }

      // What just happened, for a console that was not open when it did.
      // The stream carries only what arrives while you watch, so opening the
      // Desk used to show a blank feed no matter how busy the company was.
      if (p === '/api/events' && method === 'GET') {
        const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit') ?? 200)));
        const latest = ledger.latestSeq();
        return json(res, { events: ledger.eventsSince(Math.max(0, latest - limit), limit) });
      }

      if (p === '/api/stream' && method === 'GET') {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
        });
        res.write('retry: 2000\n\n');
        let set = watchers.get(co.slug);
        if (!set) { set = new Set(); watchers.set(co.slug, set); }
        if (!lastSeq.has(co.slug)) lastSeq.set(co.slug, ledger.latestSeq());
        set.add(res);
        const ka = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* gone */ } }, 20_000);
        req.on('close', () => { clearInterval(ka); set.delete(res); });
        return;
      }

      if (p === '/api/approvals' && method === 'GET') return json(res, ledger.listApprovals('pending'));

      if (p.startsWith('/api/approvals/') && method === 'POST') {
        const id = p.slice('/api/approvals/'.length);
        const body = await readBody(req);
        const who = typeof body['as'] === 'string' ? body['as'] : (cfg.board[0]?.id ?? '');
        const ok = gate.decide(id, who, body['approved'] === true,
          typeof body['reason'] === 'string' ? body['reason'] : '');
        return json(res, { ok }, ok ? 200 : 409);
      }

      // What the board already settled. The Envelope showed only the queue, so
      // a company that had published twice and refused twice looked like a
      // company that had never sent anything anywhere.
      if (p === '/api/approvals/decided' && method === 'GET') {
        return json(res, { approvals: ledger.decided(40) });
      }

      if (p === '/api/commons' && method === 'GET') {
        // Alphabetical order is an accident of filenames. The event log knows
        // when each document actually landed, which is the order a newcomer
        // should read them in.
        const history = ledger.commonsHistory();
        const documents = world.listCommons().map((path) => {
          const doc = world.readDoc(path);
          const seen = history.get(path);
          return {
            path,
            // The title an author chose beats anything derivable from a filename.
            title: String(doc?.data['title'] ?? path.split('/').pop()?.replace(/\.md$/, '') ?? path),
            author: doc?.data['author'] == null ? null : String(doc.data['author']),
            updated: doc?.data['updated'] == null ? null : String(doc.data['updated']),
            created: seen?.created ?? null,
            revisions: seen?.revisions ?? 0,
          };
        });
        // Undated documents predate the log; they are the oldest thing here.
        documents.sort((a, b) => (a.created ?? '').localeCompare(b.created ?? ''));
        return json(res, {
          held: world.commonsCount(), ceiling: constitution.commonsCeiling, documents,
        });
      }

      // The board's own mail. Agents write to the chair constantly and there
      // was nowhere to read it — the message existed, the console did not show
      // it, and the only way in was a SQLite query.
      if (p === '/api/inbox' && method === 'GET') {
        const me = cfg.board[0]?.id ?? 'board';
        // ?scope=all is the whole company talking, not just what reached you.
        const everything = url.searchParams.get('scope') === 'all';
        return json(res, {
          me,
          scope: everything ? 'all' : 'mine',
          messages: everything ? ledger.allMessages(me) : ledger.messagesFor(me),
          unread: ledger.unreadCount(me),
        });
      }

      if (p === '/api/inbox/read' && method === 'POST') {
        const b = await readBody(req);
        const me = cfg.board[0]?.id ?? 'board';
        const ids = Array.isArray(b['ids']) ? (b['ids'] as unknown[]).map(String) : undefined;
        const read = b['read'] !== false;
        return json(res, { marked: ledger.markRead(me, ids, read), read });
      }

      // Work in flight, and the two health checks that used to need a terminal.
      if (p === '/api/work' && method === 'GET') {
        const agents = ledger.listAgents();
        return json(res, {
          tasks: ledger.listTasks(),
          notes: ledger.countNotes(),
          // What is actually addressed to the person reading this console.
          unread: ledger.unreadCount(cfg.board[0]?.id ?? 'board'),
          // A reporting line pointing at nobody is the shape a bad rename leaves.
          orphans: agents
            .filter((a) => a.reportsTo && !ledger.getAgent(a.reportsTo))
            .map((a) => ({ id: a.id, name: a.name, reportsTo: a.reportsTo })),
        });
      }

      // Read any document in the world. The board could not review what it
      // could not open — the whole point of the Desk.
      if (p === '/api/doc' && method === 'GET') {
        const rel = url.searchParams.get('path') ?? '';
        try {
          const raw = world.readText(rel);
          if (raw == null) return json(res, { error: 'not found', path: rel }, 404);
          // Frontmatter is bookkeeping. Hand back the prose and the keys apart,
          // so no reader has to skim past a metadata block to reach the writing.
          const doc = rel.endsWith('.md') ? world.readDoc(rel) : null;
          return json(res, {
            path: rel,
            body: doc?.body ?? raw,
            title: doc?.data['title'] == null ? null : String(doc.data['title']),
            author: doc?.data['author'] == null ? null : String(doc.data['author']),
            updated: doc?.data['updated'] == null ? null : String(doc.data['updated']),
          });
        } catch {
          // world.path() throws on anything escaping the world root.
          return json(res, { error: 'forbidden' }, 403);
        }
      }

      // Review a shift: the company's own audit of what a staff member actually
      // did. `agent` is required; `session` picks one of that agent's sessions,
      // defaulting to the most recent. `sessions` lets the console offer the
      // rest without a second round trip.
      if (p === '/api/transcript' && method === 'GET') {
        const who = url.searchParams.get('agent') ?? '';
        if (!who) return json(res, { error: 'name an agent with ?agent=<id>' }, 400);
        const sessions = transcript.sessionsFor(who);
        const wanted = url.searchParams.get('session') ?? sessions[0]?.sessionId ?? null;
        // Forward cursor: `after` is the last seq the reader already has (0 = from
        // the start), `limit` bounds the page so a huge shift or a live tail comes
        // back in chunks. `more` says another page waits; `nextAfter` is the cursor
        // to ask for it (or to poll the tail of a running shift with).
        const after = Math.max(Number(url.searchParams.get('after') ?? 0) || 0, 0);
        const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 500) || 500, 1), 2000);
        const turns = wanted ? transcript.bySession(wanted, { after, limit }) : [];
        const more = turns.length === limit;
        const nextAfter = turns.length ? turns[turns.length - 1]!.seq : after;
        return json(res, { agent: who, sessionId: wanted, sessions, turns, more, nextAfter });
      }

      /*
       * A file out of the world, for the images a document points at.
       *
       * The commons is prose with screenshots in it — a vendor's own product,
       * a page somebody rendered — and until now a reader had to leave the
       * console and go and find the PNG on disk. `/api/doc` cannot serve it:
       * that hands back JSON, and an image is bytes.
       *
       * Confinement is world.path(), the same textual-and-symlink check every
       * other read goes through. On top of it, only image types are served.
       * The world is a git repository full of things a model wrote, and a
       * console that would hand back any file in it on request is one bad
       * path away from serving a credential somebody pasted into a note.
       */
      if (p === '/api/file' && method === 'GET') {
        const rel = url.searchParams.get('path') ?? '';
        const type = IMAGE_TYPES[extname(rel).toLowerCase()];
        if (!type) return json(res, { error: 'not an image' }, 415);
        try {
          // By descriptor: a name checked and then streamed by path could be a
          // link or a FIFO by the time the stream opened it.
          const fd = openWithin(world.root, world.path(rel));
          res.writeHead(200, {
            'content-type': type,
            // Everything here is local and the console re-reads on navigation;
            // caching stops a document with six screenshots refetching them
            // every time somebody opens it.
            'cache-control': 'no-cache',
            // It is an image, and nothing else may talk it into being markup.
            'x-content-type-options': 'nosniff',
            'content-security-policy': "default-src 'none'; sandbox",
          });
          // pipeline, not pipe: a client that goes away mid-image would
          // otherwise leave the descriptor open.
          void pipeline(createReadStream('', { fd }), res).catch(() => {});
          return;
        } catch {
          // Missing, or a path trying to leave the world.
          return json(res, { error: 'forbidden' }, 403);
        }
      }

      /**
       * Store an operator-pasted or chosen image and hand back the world path
       * to reference it by. The bytes are the body; the type is decided by
       * sniffing them, never by the client's content-type — a mislabelled or
       * exotic upload cannot write a file whose name lies about its contents.
       * The store is gitignored (see World.writeAttachment), so this adds
       * nothing to the company's authored history.
       */
      if (p === '/api/attachment' && method === 'POST') {
        let bytes: Buffer;
        try { bytes = await readBinaryBody(req, 12_000_000); }
        catch { return json(res, { error: 'image too large — 12MB max' }, 413); }
        if (!bytes.length) return json(res, { error: 'no image in the request' }, 400);
        const ext = sniffImage(bytes);
        if (!ext) return json(res, { error: 'not a supported image (PNG, JPEG, GIF, WebP or AVIF)' }, 415);
        return json(res, { path: world.writeAttachment(bytes, ext) }, 201);
      }

      if (p === '/api/whathappened' && method === 'GET') {
        const since = url.searchParams.get('since') ?? '3.days';
        return json(res, {
          commits: world.git.since(since),
          contributions: world.git.contributionsSince(since),
        });
      }

      // Whether any of this is working, as numbers rather than as impressions.
      if (p === '/api/vitals' && method === 'GET') {
        return json(res, vitals(
          {
            ledger, world, clock: systemClock,
            commonsCeiling: constitution.commonsCeiling,
            portfolioCeiling: constitution.portfolioCeiling,
          },
          url.searchParams.get('window') ?? '7.days',
        ));
      }

      if (p === '/api/say' && method === 'POST') {
        const body = await readBody(req);
        // A list, because replying to mail between two colleagues has to reach
        // both of them. An empty list is a mistake, not an instruction to
        // address the whole company — only an absent `to` means everyone.
        const raw = body['to'];
        const to = Array.isArray(raw)
          ? raw.filter((v): v is string => typeof v === 'string' && v.trim() !== '')
          : typeof raw === 'string' && raw ? [raw] : null;
        if (Array.isArray(raw) && !to?.length) return json(res, { error: 'no recipient' }, 400);
        const text = String(body['text'] ?? '').slice(0, 4000);
        if (!text) return json(res, { error: 'nothing to say' }, 400);
        // Who is speaking. The chair by default, because that is who this
        // endpoint has always been — but a board of two had only one voice,
        // and a second member with a seat and no way to use it is not on the
        // board in any sense the company can observe. Restricted to the
        // constitution's board: this endpoint is authenticated as the
        // operator, not as any agent, so letting it name a staff member would
        // put words in a colleague's mouth.
        const asked = String(body['from'] ?? '');
        if (asked && !cfg.board.some((m) => m.id === asked)) {
          return json(res, { error: `'${asked}' is not on the board` }, 403);
        }
        const from = asked || cfg.board[0]?.id || 'board';
        const n = ledger.sendMessage(from, to, text);
        ledger.emit(from, 'message.sent', to?.[0] ?? null, { recipients: n, to, text });
        for (const a of to ?? ledger.listAgents().map((x) => x.id)) scheduler.nudge(a);
        return json(res, { delivered: n });
      }

      if (p === '/api/open' && method === 'POST') {
        if (refuseIfNoCredential(res, co.slug)) return;
        await registry.setRunning(co.slug, true);
        return json(res, { running: true });
      }
      // Pause drains; Shutdown is `{"hard":true}`. Same pair as the per-company
      // endpoint, because the footer button and the Companies row have to mean
      // the same thing.
      if (p === '/api/close' && method === 'POST') {
        const b = await readBody(req);
        const drain = b['hard'] !== true;
        await registry.setRunning(co.slug, false, undefined, { drain });
        return json(res, { running: false, ...(drain ? { draining: true } : {}) });
      }

      // Wake one person, once. The first shift of a new company is the one
      // worth watching, and waiting out a scheduling interval to see it is a
      // bad first impression.
      if (p === '/api/wake' && method === 'POST') {
        const b = await readBody(req);
        const who = typeof b['who'] === 'string' && b['who'] ? b['who'] : cfg.ceo.id;
        if (!ledger.getAgent(who)) return json(res, { error: `no agent '${who}'` }, 404);
        // Only a nudge that would start a stopped scheduler needs a credential;
        // nudging a company already working changes nothing about its auth.
        if (!scheduler.running && refuseIfNoCredential(res, co.slug)) return;
        scheduler.nudge(who);
        if (!scheduler.running) await registry.setRunning(co.slug, true);
        return json(res, { waking: who, running: true });
      }

      // A company's secrets: write-only, like GitHub's. The store encrypts at
      // rest and the injecting proxy hands values to a call without them ever
      // entering the factory, so the endpoint that WRITES a value never has a
      // sibling that reads one back. GET returns names, and only names — the
      // one thing a management surface may say about a secret it holds.
      if (p === '/api/secrets' && method === 'GET') {
        // The runtime token is Riff's, not a product secret: it never appears in
        // this list, and PUT/DELETE below refuse it. It is managed only through
        // /api/runtime-credential (per company) and /api/settings (the default).
        return json(res, { names: listSecretNames(co.slug).filter((n) => n !== RUNTIME_SECRET_NAME) });
      }
      if (p === '/api/secrets' && method === 'PUT') {
        const b = await readBody(req);
        // Trim the name (the identifier check rejects whitespace anyway, so this
        // is just friendlier). For the value, strip ONLY surrounding CR/LF — the
        // paste artifact that would inject `sk-…\n` and 401 silently — never all
        // whitespace: the vault is general-purpose and a credential (a DB
        // password, say) may legitimately carry edge spaces we must not corrupt.
        const name = typeof b['name'] === 'string' ? b['name'].trim() : '';
        const value = typeof b['value'] === 'string' ? b['value'].replace(/^[\r\n]+|[\r\n]+$/g, '') : '';
        if (name === RUNTIME_SECRET_NAME) {
          return json(res, { error: `${RUNTIME_SECRET_NAME} is reserved — set it under Runtime credential, not as a secret` }, 400);
        }
        try {
          putSecret(co.slug, name, value);
        } catch (e) {
          // A bad name or an empty value is the caller's error, not a 500.
          return json(res, { error: e instanceof Error ? e.message : String(e) }, 400);
        }
        // Never echo the value. The name is enough to confirm the write landed.
        return json(res, { ok: true, name });
      }
      if (p === '/api/secrets' && method === 'DELETE') {
        const name = url.searchParams.get('name')?.trim() ?? '';
        if (name === RUNTIME_SECRET_NAME) {
          return json(res, { error: `${RUNTIME_SECRET_NAME} is reserved — clear it under Runtime credential` }, 400);
        }
        return json(res, { deleted: deleteSecret(co.slug, name) });
      }

      // A company's OWN runtime credential, overriding the install default. Sets
      // the TYPE (config) and, if given, the token VALUE (vault, reserved name) —
      // the value never crosses the generic secrets endpoints. DELETE reverts to
      // the install default and drops the value.
      if (p === '/api/runtime-credential' && method === 'PUT') {
        const b = await readBody(req);
        const rc = readRuntimeCredential(b);
        if (b['type'] !== undefined && !rc) {
          return json(res, { error: 'type must be "subscription" or "apiKey"' }, 400);
        }
        const value = typeof b['value'] === 'string' ? b['value'].replace(/^[\r\n]+|[\r\n]+$/g, '') : '';
        // Type and token travel together (see /api/settings) — a value stored with
        // no resolvable type would be injected in the wrong shape.
        const effectiveType = rc?.type ?? cfg.runtimeCredential?.type;
        if (value && !effectiveType) {
          return json(res, { error: 'set a credential type before or with the token value' }, 400);
        }
        // Type + value move together (see /api/settings): a type change without a
        // fresh token would run the company on a mismatched shape. A value alone
        // rotates the token under the existing type; use DELETE to revert.
        if (rc && !value) {
          return json(res, { error: 'provide the token value along with the credential type' }, 400);
        }
        try {
          if (rc) {
            const r = await registry.update(co.slug, { runtimeCredential: rc });
            if (!r.ok) return json(res, { error: r.reason }, 409);
          }
          if (value) putSecret(co.slug, RUNTIME_SECRET_NAME, value);
        } catch (e) {
          return json(res, { error: e instanceof Error ? e.message : String(e) }, 400);
        }
        return json(res, {
          ok: true,
          runtimeCredential: rc ?? cfg.runtimeCredential ?? null,
          runtimeCredentialSet: hasSecret(co.slug, RUNTIME_SECRET_NAME),
        });
      }
      if (p === '/api/runtime-credential' && method === 'DELETE') {
        const r = await registry.update(co.slug, { runtimeCredential: null });
        if (!r.ok) return json(res, { error: r.reason }, 409);
        deleteSecret(co.slug, RUNTIME_SECRET_NAME);
        return json(res, { ok: true, runtimeCredential: null, runtimeCredentialSet: false });
      }

      // A company's service routes: which named service the injecting proxy
      // forwards to which upstream, authenticated by which vault secret. Unlike
      // the secrets themselves these hold NO value — a secret NAME, a host, a
      // header — so the whole map is safe to read back. A route points the proxy
      // at a host and names the key to inject; the value lives only in the vault.
      if (p === '/api/services' && method === 'GET') {
        return json(res, { services: cfg.services });
      }
      if (p === '/api/services' && method === 'PUT') {
        const b = await readBody(req);
        const name = typeof b['name'] === 'string' ? b['name'].trim() : '';
        const v = validateServiceRoute(name, b);
        if (!v.ok) return json(res, { error: v.reason }, 400);
        // A delta, not the whole map: update() merges it against the config it
        // reads fresh, so two concurrent writes compose instead of clobbering.
        const r = await registry.update(co.slug, { setService: { name, route: v.route } });
        if (!r.ok) return json(res, { error: r.reason }, 409);
        return json(res, { ok: true, name });
      }
      if (p === '/api/services' && method === 'DELETE') {
        const name = url.searchParams.get('name')?.trim() ?? '';
        // Object.hasOwn, not `in`: `in` walks the prototype chain, so 'toString'
        // or 'constructor' would report deleted for a route that never existed.
        const existed = Object.hasOwn(cfg.services, name);
        if (existed) {
          const r = await registry.update(co.slug, { deleteService: name });
          if (!r.ok) return json(res, { error: r.reason }, 409);
        }
        return json(res, { deleted: existed });
      }
    }

    if (p.startsWith('/api/')) return json(res, { error: 'no such route' }, 404);
    return await serveDesk(res, p);
  } catch (err) {
    return json(res, { error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

server.listen(PORT, () => {
  if (migrated) console.log(`\n  Moved ${migrated.moved} into companies/`);

  // The plan's windows, from the keyproxy. Only where there is one: a gateway
  // run on a host has no keyproxy beside it, and its companies cannot shift.
  if (shellIsContained()) {
    startUsageFeed({ inject: (windows, at) => registry.injectUsage(windows, at) });
  }

  // A scheduler lives in a process; the operator's intent does not. Anything
  // left running goes back to work rather than quietly stopping on a restart.
  //
  // Unless a company's runtime credential does not resolve. Then it would wake,
  // fail to authenticate and spend a shift saying so — the failure of 2026-09-11,
  // twice. So resume each running company only if the keyproxy can resolve its
  // credential (per-company vault, or the install default); one that cannot is
  // held rather than woken to fail silently. This is the automatic hold now that
  // the credential lives in the vault — the old entrypoint credentials-wait that
  // set RIFF_HOLD_PAUSED is gone. RIFF_HOLD_PAUSED remains an operator-only
  // blanket hold (nothing sets it automatically): export it to bring the stack up
  // with everything paused, whatever each company's credential says.
  const held = process.env['RIFF_HOLD_PAUSED'] === '1';
  const resumed = new Set(held ? [] : registry.resume((slug) => runtimeCredentialHealth(slug).live));
  if (held) {
    console.log('\n  Held paused: RIFF_HOLD_PAUSED is set. Start what you want when ready.');
  }

  const all = registry.list();
  console.log(`\n  Riff · ${all.length} compan${all.length === 1 ? 'y' : 'ies'}`);
  for (const c of all) {
    let mark = '○ paused ';
    let why = '';
    if (c.running) {
      if (resumed.has(c.slug)) mark = '● resumed';
      else if (held) mark = '⚠ held   '; // blanket RIFF_HOLD_PAUSED
      else {
        // Running, not resumed, no blanket hold: its credential did not resolve.
        const h = runtimeCredentialHealth(c.slug);
        mark = h.live ? '● working' : '⚠ held   ';
        if (!h.live) why = `  — ${h.why}`;
      }
    }
    console.log(`    ${mark}  ${c.slug.padEnd(22)} ${c.name}${c.business ? ` — ${c.business}` : ''}${why}`);
  }
  console.log(`\n  http://localhost:${PORT}\n`);
});

const shutdown = async () => {
  for (const c of registry.opened()) { await c.scheduler.stop(); }
  for (const set of watchers.values()) for (const w of set) { try { w.end(); } catch { /* gone */ } }
  server.close(() => {
    for (const c of registry.opened()) c.ledger.close();
    lock.release();
    process.exit(0);
  });
  // A hung close must still let go of the lock, or the next start is refused
  // for thirty seconds by a process that no longer exists.
  setTimeout(() => { lock.release(); process.exit(0); }, 3000).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
