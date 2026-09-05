import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { systemClock } from '../core/clock.ts';
import {
  guessKeeperName, listCompanies, migrateLegacyLayout, resolveSlug,
} from '../core/config.ts';
import { Registry, type Company } from '../company/registry.ts';
import { renameAgent } from '../company/rename.ts';
import { vitals } from '../analytics/vitals.ts';
import { exportCompany, exportName, importCompany } from '../company/transfer.ts';
import { isOperatorError, installRoot } from '../core/config.ts';
import { takeInstallationLock, type Lock } from '../core/lock.ts';
import { readFile } from 'node:fs/promises';
import { createReadStream, createWriteStream, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
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
      // Pausing kills whoever is mid-shift; draining lets them finish first.
      // Both are wanted: the operator waiting to rebuild wants the journal
      // written, and the operator watching a run go wrong wants it to stop
      // now. The default stays the immediate one, because that is what every
      // existing caller of this endpoint already means by it.
      const drain = !run && b['drain'] === true;
      const ok = await registry.setRunning(target, run, bounds, { drain });
      return ok ? json(res, {
        slug: target, running: run,
        ...(drain ? { draining: true } : {}),
        ...(run && bounds.until ? { until: new Date(bounds.until).toISOString() } : {}),
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
      const r = await registry.update(target, {
        ...(typeof b['name'] === 'string' ? { name: b['name'] } : {}),
        ...(typeof b['business'] === 'string' ? { business: b['business'] } : {}),
        ...(typeof b['slug'] === 'string' ? { slug: b['slug'] } : {}),
        // Clamped in readPolicy, so a hand-written value cannot ask for a
        // thousand concurrent agents or a turn ceiling of zero.
        ...(b['policy'] && typeof b['policy'] === 'object'
          ? { policy: b['policy'] as Record<string, number> } : {}),
        ...(b['release'] === 'bundle' || b['release'] === 'none' ? { release: b['release'] } : {}),
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
      const { cfg, ledger, world, gate, constitution, scheduler } = co;

      if (p === '/api/state' && method === 'GET') {
        const agents = ledger.listAgents();
        return json(res, {
          slug: co.slug,
          company: cfg.company,
          policy: cfg.policy,
          board: cfg.board,
          ceo: cfg.ceo,
          // Settable at founding and by PATCH, and until now readable nowhere:
          // an operator could turn a company's releases on and have no way to
          // confirm it had happened.
          release: cfg.release,
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
          const abs = world.path(rel);
          if (!statSync(abs).isFile()) return json(res, { error: 'not found' }, 404);
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
          createReadStream(abs).pipe(res);
          return;
        } catch {
          // Missing, or a path trying to leave the world.
          return json(res, { error: 'forbidden' }, 403);
        }
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
        await registry.setRunning(co.slug, true);
        return json(res, { running: true });
      }
      if (p === '/api/close' && method === 'POST') {
        await registry.setRunning(co.slug, false);
        return json(res, { running: false });
      }

      // Wake one person, once. The first shift of a new company is the one
      // worth watching, and waiting out a scheduling interval to see it is a
      // bad first impression.
      if (p === '/api/wake' && method === 'POST') {
        const b = await readBody(req);
        const who = typeof b['who'] === 'string' && b['who'] ? b['who'] : cfg.ceo.id;
        if (!ledger.getAgent(who)) return json(res, { error: `no agent '${who}'` }, 404);
        scheduler.nudge(who);
        if (!scheduler.running) await registry.setRunning(co.slug, true);
        return json(res, { waking: who, running: true });
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

  // A scheduler lives in a process; the operator's intent does not. Anything
  // left running goes back to work rather than quietly stopping on a restart.
  const resumed = new Set(registry.resume());

  const all = registry.list();
  console.log(`\n  Riff · ${all.length} compan${all.length === 1 ? 'y' : 'ies'}`);
  for (const c of all) {
    const mark = c.running ? (resumed.has(c.slug) ? '● resumed' : '● working') : '○ paused ';
    console.log(`    ${mark}  ${c.slug.padEnd(22)} ${c.name}${c.business ? ` — ${c.business}` : ''}`);
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
