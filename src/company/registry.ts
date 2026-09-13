import { Ledger } from '../ledger/ledger.ts';
import { World } from '../worldfs/world.ts';
import { Gate } from '../policy/gate.ts';
import { constitutionFor, type Constitution } from '../policy/rules.ts';
import { Scheduler } from '../runtime/scheduler.ts';
import { found } from './genesis.ts';
import {
  archiveDir, companyHome, DEFAULT_POLICY, listCompanies, persisted, readPolicy,
  resolveConfig, scaffoldConfig, setRunningFlag, slugId,
  type CompanyPolicy, type CompanyRef, type RiffConfig, type ServiceRoute,
} from '../core/config.ts';
import type { Clock } from '../core/clock.ts';
import type { SDKRateLimitInfo } from '@anthropic-ai/claude-agent-sdk';
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { atomicWriteFileSync } from '../core/atomicwrite.ts';
import { dropVault } from '../core/secrets.ts';
import { join } from 'node:path';

/**
 * One installation, many companies.
 *
 * Each company is a directory with its own world, ledger and constitution, and
 * nothing about one reaches into another — separate SQLite files, separate git
 * repositories, separate schedulers. That isolation is the point: founding a
 * second company must not be able to disturb the first.
 *
 * Contexts are opened lazily and kept, because a ledger connection and a
 * scheduler are expensive to build and the console switches between companies
 * on a click.
 */
export type Company = {
  slug: string;
  cfg: RiffConfig;
  ledger: Ledger;
  world: World;
  gate: Gate;
  constitution: Constitution;
  scheduler: Scheduler;
};

/**
 * Apply a single route set/remove onto a company's existing routes. update()
 * calls this against the config it just read from disk, so two concurrent writes
 * compose rather than the second overwriting the first.
 */
const mergeServices = (
  existing: Record<string, ServiceRoute> | undefined,
  set?: { name: string; route: ServiceRoute },
  remove?: string,
): Record<string, ServiceRoute> => {
  const next = { ...(existing ?? {}) };
  if (set) next[set.name] = set.route;
  if (remove) delete next[remove];
  return next;
};

export class Registry {
  readonly #clock: Clock;
  readonly #open = new Map<string, Company>();
  /** The latest subscription-wide usage windows, injected via POST /api/usage. */
  #usage: { windows: Array<readonly [string, SDKRateLimitInfo]>; at: number } | null = null;

  constructor(clock: Clock) { this.#clock = clock; }

  /**
   * Fold a subscription-wide usage reading into every running company.
   *
   * The five-hour and seven-day windows belong to the plan, not to any one
   * company, so all of them pace off the same reading. Kept here as well, so a
   * company started after the reading arrives is seeded with it rather than
   * pacing blind until the next poll.
   */
  injectUsage(windows: Array<readonly [string, SDKRateLimitInfo]>): void {
    this.#usage = { windows, at: this.#clock.now().getTime() };
    for (const c of this.#open.values()) c.scheduler.applyUsage(windows);
  }

  /** The last injected usage reading, for the console and the usage MCP tool. */
  get usage(): { windows: Array<readonly [string, SDKRateLimitInfo]>; at: number } | null {
    return this.#usage;
  }

  /**
   * Every company, each carrying whether it is actually working.
   *
   * A company that has never been opened cannot be running, so the absence of
   * an entry in #open is itself the answer — no need to touch its ledger.
   */
  list(): Array<CompanyRef & { running: boolean; awake: string[]; draining: boolean }> {
    return listCompanies().map((c) => {
      const open = this.#open.get(c.slug);
      return {
        ...c,
        running: open?.scheduler.running ?? false,
        awake: open ? open.scheduler.awake : [],
        draining: open?.scheduler.draining ?? false,
      };
    });
  }

  has(slug: string): boolean { return existsSync(companyHome(slug)); }

  /** Start or pause one company by slug, opening it if needed. */
  async setRunning(
    slug: string, run: boolean,
    bounds?: { until?: number | null; maxTicks?: number | null },
    opts?: { drain?: boolean },
  ): Promise<boolean> {
    const c = this.get(slug);
    if (!c) return false;
    // Written before the scheduler is touched, not after.
    //
    // #loop checks its bounds at the top, before its first await, so a run
    // with a bound already spent calls back into setRunningFlag(false) inside
    // start() — and a write afterwards put `true` straight back over it. That
    // is the whole bug this callback exists to fix, reappearing one line
    // later. Recording the intent first also matches what the flag means: it
    // is what the operator asked for, not a report of the scheduler's state.
    setRunningFlag(c.cfg.home, run);
    if (run) {
      c.scheduler.start(bounds);
      // Seed the fresh scheduler with the plan's current windows, so it paces
      // correctly from its first round instead of blind until the next poll.
      if (this.#usage) c.scheduler.applyUsage(this.#usage.windows);
    } else if (opts?.drain) {
      // Answer now, finish later. A drain waits out a whole shift — up to ten
      // minutes at 30 turns — and a request held open that long is a request
      // that times out somewhere between the console and here. The scheduler
      // reports `draining` until the last shift lands, which is what the
      // console watches and what up.sh polls.
      void c.scheduler.stop({ drain: true }).catch(() => { /* stop reports its own */ });
    } else {
      await c.scheduler.stop();
    }
    return true;
  }

  /**
   * Start every company the operator left running. Called once on boot, so a
   * restart does not silently pause work somebody asked for.
   */
  resume(): string[] {
    const back: string[] = [];
    for (const ref of listCompanies()) {
      if (!ref.wanted) continue;
      const c = this.get(ref.slug);
      if (!c) continue;
      c.scheduler.start();
      if (this.#usage) c.scheduler.applyUsage(this.#usage.windows);
      back.push(ref.slug);
    }
    return back;
  }

  /** Open a company, founding nothing. Returns null if the slug is unknown. */
  get(slug: string): Company | null {
    const already = this.#open.get(slug);
    if (already) return already;
    if (!this.has(slug)) return null;
    return this.#build(slug, resolveConfig(process.cwd(), slug));
  }

  /**
   * Found a new company.
   *
   * Board, policy and release route belong to the founding rather than to a
   * later edit, because genesis seeds the roster on the first run only. A
   * board member written into config afterwards was hireable while still
   * carrying board authority — the gate reads standing from config and the
   * roster had never heard of them. Founding a company the way the operator
   * meant it therefore has to be one call, which is why every one of these
   * was previously done by editing config.json by hand.
   */
  found(input: {
    name: string; business: string; ceo: string; chair: string;
    board?: readonly { name: string; role?: string }[];
    policy?: unknown;
    release?: unknown;
  }): { ok: true; company: Company } | { ok: false; reason: string } {
    const name = input.name.trim();
    if (!name) return { ok: false, reason: 'a company needs a name' };
    const slug = slugId(name);
    if (this.has(slug)) return { ok: false, reason: `${slug} already exists` };

    const chair = input.chair.trim() || 'Chair';
    const ceo = input.ceo.trim() || 'CEO';
    const ceoId = slugId(ceo);
    const board = [
      { id: slugId(chair), name: chair, role: 'Chairman' },
      ...(input.board ?? []).map((m) => {
        const n = m.name.trim();
        return { id: slugId(n), name: n, role: m.role?.trim() || 'Board' };
      }),
    ];

    // genesis seeds the board and then the CEO, both with upsertAgent, so a
    // shared id does not collide loudly — it replaces the board row with an
    // executive one and leaves the gate granting board standing to a seat the
    // roster says is the CEO.
    const seen = new Set<string>();
    for (const m of board) {
      if (!m.id) return { ok: false, reason: 'a board member needs a name' };
      if (m.id === ceoId) return { ok: false, reason: `${m.id} cannot be both the CEO and on the board` };
      if (seen.has(m.id)) return { ok: false, reason: `two board members would both answer to ${m.id}` };
      seen.add(m.id);
    }

    const home = companyHome(slug);
    const cfg: RiffConfig = {
      version: 1,
      home,
      worldDir: `${home}/world`,
      ledgerPath: `${home}/ledger.db`,
      company: { name, business: input.business.trim() },
      board,
      ceo: { id: ceoId, name: ceo },
      connectors: {},
      services: {},
      release: input.release === 'bundle' ? 'bundle' : 'none',
      // Absent means every default, and every named field is clamped, so a
      // request cannot ask for a thousand concurrent agents.
      policy: input.policy === undefined ? DEFAULT_POLICY : readPolicy(input.policy),
    };
    scaffoldConfig(cfg);
    return { ok: true, company: this.#build(slug, cfg) };
  }

  #build(slug: string, cfg: RiffConfig): Company {
    const { ledger, world } = found(cfg, this.#clock);
    // Made at open, so a volume that cannot be written to says so now rather
    // than a day later in the middle of somebody's build.
    const cacheDir = join(cfg.home, 'scratch', 'cache');
    mkdirSync(cacheDir, { recursive: true });
    const p = cfg.policy;
    const constitution = constitutionFor({
      ceo: cfg.ceo.id,
      board: cfg.board.map((b) => b.id),
      commonsCeiling: p.commonsCeiling,
      portfolioCeiling: p.portfolioCeiling,
      dailyCapCents: p.dailyCapCents,
    });
    const gate = new Gate(ledger, constitution, {
      count: () => world.commonsCount(),
      exists: (p) => world.exists(p),
    }, {
      count: () => world.projectCount(),
      has: (name) => world.listProjects().includes(name),
    });
    const scheduler = new Scheduler({
      ledger, gate, world, clock: this.#clock,
      options: {
        maxTurns: p.maxTurns,
        rotateAtContextPct: p.rotateAtContextPct,
        // Beside the world, never inside it: the end-of-turn commit stages the
        // whole tree, and a build cache is not part of anybody's work.
        cacheDir,
        concurrency: p.concurrency,
        baseIntervalMs: Math.round(p.baseIntervalMinutes * 60_000),
        throttleAboveUtilization: p.throttleAboveUtilization,
        pauseAboveUtilization: p.pauseAboveUtilization,
        shiftTimeoutMs: Math.round(p.shiftTimeoutMinutes * 60_000),
        maxSessionMs: Math.round(p.maxSessionHours * 60 * 60_000),
        blindTrace: p.blindTrace,
      },
      // A run that ends on its own bound is as stopped as one the operator
      // stopped, and has to be recorded the same way or the next boot starts
      // it again with the bound gone. See Deps.onBoundReached.
      onBoundReached: () => { setRunningFlag(cfg.home, false); },
      ...(Object.keys(cfg.connectors ?? {}).length ? { connectors: cfg.connectors } : {}),
      ...(cfg.release === 'bundle' ? { release: 'bundle' as const } : {}),
      // The company and its declared services travel with the scheduler so each
      // shift can mint a scoped token for the key-injecting proxy. Only when
      // there is a service to reach — a company with none pays nothing for this.
      ...(Object.keys(cfg.services ?? {}).length ? { companySlug: slug, services: cfg.services } : {}),
    });
    const company: Company = { slug, cfg, ledger, world, gate, constitution, scheduler };
    this.#open.set(slug, company);
    return company;
  }

  /**
   * Let go of a company: stop its scheduler and close its ledger.
   * Anything that moves a company's directory must do this first, because an
   * open SQLite handle and a renamed path disagree about where the file is.
   */
  async close(slug: string, opts?: { drain?: boolean }): Promise<void> {
    const c = this.#open.get(slug);
    if (!c) return;
    // Drains by default. A rename moves the directory, and it cannot be moved
    // out from under an agent still writing to it — waiting out the shift is
    // both the kind order and the only correct one.
    //
    // Archiving passes drain:false, and that is not an oversight. The operator
    // has typed the company's name to confirm they are putting it away; making
    // them then wait out a ten-minute shift for a company they are removing is
    // the wrong trade. Pause it first if the shift matters.
    await c.scheduler.stop({ drain: opts?.drain !== false });
    c.ledger.close();
    this.#open.delete(slug);
  }

  /**
   * Change what a company is called.
   *
   * The display name and the slug are deliberately independent. Renaming a
   * company should not have to move its directory, and a directory move should
   * not be a side effect of fixing a typo in a title.
   *
   * Who the CEO and the chair ARE is not editable here. Their ids are on every
   * approval, note and commit already made, and changing one mid-life orphans
   * all of it — renameAgent in ./rename.ts does that job properly, and
   * POST /api/agents/rename is how anyone reaches it.
   */
  async update(
    slug: string,
    patch: { name?: string; business?: string; slug?: string; policy?: Partial<CompanyPolicy>;
             release?: 'none' | 'bundle';
             // A service route is a DELTA, not a whole map: the caller names the
             // one route to set or remove and update() merges it against the
             // config it reads fresh below. A caller that instead computed the
             // full map from its own in-memory snapshot would drop a concurrent
             // write — two sets racing, the second overwriting the first.
             setService?: { name: string; route: ServiceRoute }; deleteService?: string },
  ): Promise<{ ok: true; slug: string } | { ok: false; reason: string }> {
    if (!this.has(slug)) return { ok: false, reason: `no company '${slug}'` };

    const wanted = patch.slug?.trim() ? slugId(patch.slug) : slug;
    if (wanted !== slug && this.has(wanted)) return { ok: false, reason: `${wanted} already exists` };

    // The scheduler reads its dials once, at construction, so a policy change
    // only means anything after the company is let go and built again. That
    // must not quietly pause a company that was working.
    //
    // Only rebuild when something structural moved. Editing the brief used to
    // close and reopen the company like everything else, which aborted whoever
    // was mid-shift: on 2026-09-05 three shifts died as `Claude Code process
    // aborted by user` because the brief was edited twice while Lathe worked.
    // A brief is read at wake, so the running shift would not have seen the new
    // one either way — the restart cost work and bought nothing.
    const structural = wanted !== slug || patch.policy !== undefined || patch.release !== undefined;
    const wasRunning = listCompanies().find((c) => c.slug === slug)?.wanted ?? false;
    if (structural) await this.close(slug);

    const from = companyHome(slug);
    const to = companyHome(wanted);
    if (wanted !== slug) renameSync(from, to);

    const path = join(to, 'config.json');
    const cfg = JSON.parse(readFileSync(path, 'utf8')) as RiffConfig;
    const next: RiffConfig = {
      ...cfg,
      home: to,
      worldDir: join(to, 'world'),
      ledgerPath: join(to, 'ledger.db'),
      company: {
        name: patch.name?.trim() || cfg.company.name,
        business: patch.business?.trim() ?? cfg.company.business,
      },
      policy: readPolicy({ ...readPolicy(cfg.policy), ...(patch.policy ?? {}) }),
      // The route work leaves by. Settable here because it was settable
      // nowhere: founding took it, nothing else did, and turning a company's
      // releases on afterwards meant hand-editing config.json on a running
      // installation — which is how a live company got its directory moved
      // out from under an open ledger.
      ...(patch.release ? { release: patch.release } : {}),
      // Merged against the config just read from disk, so concurrent route
      // writes compose instead of clobbering. Deliberately NOT in the
      // `structural` set below: the proxy reads a company's routes fresh from
      // disk on every request, so a new route is live the moment this file is
      // written — no restart, and nothing that could abort a shift mid-write the
      // way a rebuild does. A company already running picks the route's injected
      // token-env up at its next start, since the scheduler reads services once
      // at construction; routes are normally set while a company is stopped.
      ...((patch.setService || patch.deleteService)
        ? { services: mergeServices(cfg.services, patch.setService, patch.deleteService) } : {}),
    };
    // Where it lives is the directory's job to say, not the file's.
    atomicWriteFileSync(path, JSON.stringify(persisted(next), null, 2) + '\n');
    if (structural) {
      if (wasRunning) await this.setRunning(wanted, true);
    } else {
      // The company stayed open, so its in-memory config is now the stale copy
      // and /api/state would keep serving the old brief until something else
      // reopened it.
      const open = this.#open.get(slug);
      if (open) this.#open.set(slug, { ...open, cfg: next });
    }
    return { ok: true, slug: wanted };
  }

  /**
   * Remove a company from the list without destroying it. The directory moves
   * to ~/.riff/archive/<slug>-<stamp>/, git history and all.
   */
  async archive(slug: string): Promise<{ ok: true; at: string } | { ok: false; reason: string }> {
    if (!this.has(slug)) return { ok: false, reason: `no company '${slug}'` };
    await this.close(slug, { drain: false });
    const dir = archiveDir();
    mkdirSync(dir, { recursive: true });
    const stamp = this.#clock.iso().replace(/[:.]/g, '-');
    const at = join(dir, `${slug}-${stamp}`);
    renameSync(companyHome(slug), at);
    // Secrets live outside the company home, so the move above does not carry
    // them off. Drop them rather than archive them: a decryptable credential
    // blob for a company nobody is running is a liability, not a backup, and a
    // restored company re-enters its keys.
    dropVault(slug);
    return { ok: true, at };
  }

  /** Every company currently held open, for shutdown. */
  opened(): Company[] { return [...this.#open.values()]; }
}
