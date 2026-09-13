import type { Agent, AgentId } from '../core/types.ts';
import type { ServiceRoute } from '../core/config.ts';
import type { Ledger } from '../ledger/ledger.ts';
import type { Gate } from '../policy/gate.ts';
import type { World } from '../worldfs/world.ts';
import type { Clock } from '../core/clock.ts';
import { tick, type TickResult } from './staff.ts';
import { worstWindow, isWeekly, isKnownLimit } from './limits.ts';
import { roundIsDue } from './cadence.ts';
import type { SDKRateLimitInfo } from '@anthropic-ai/claude-agent-sdk';
import { applyApproved } from './executor.ts';
import { RANK } from '../core/types.ts';

export type SchedulerOptions = {
  /** How often a staff member wakes, in ms. Scaled by rank — the CEO
   *  keeps a closer eye on things than a member. */
  baseIntervalMs: number;
  /** How many staff may be awake at once. Protects rate limits and your wallet,
   *  and keeps the feed legible. */
  concurrency: number;
  /**
   * Hard stop for the whole company, in USD per local day — inference cost,
   * NOT the staff's Rule 4 spending money. Null on a Claude subscription,
   * where inference is covered and the real constraint is the rate limiter
   * below. Keep a number here only when running on metered API billing.
   */
  dailyBudgetUsd: number | null;
  /** Ceiling on a single wake-up. Null on a subscription, same reasoning. */
  perTickBudgetUsd: number | null;
  /**
   * Start stretching intervals once subscription utilization passes this.
   * Coasting to the limit and getting rejected wastes a whole window; slowing
   * down early keeps the company alive across it.
   */
  throttleAboveUtilization: number;
  /**
   * Stop outright once the window is this far spent, so the operator keeps
   * headroom for their own work. Throttling only slows the company down; on a
   * subscription a company that never stops will take the whole window, and
   * the person who pays for it finds it gone. 1 disables the stop.
   */
  pauseAboveUtilization: number;
  maxTurns: number;
  /**
   * Replace an agent's conversation mid-shift once it is this much of the
   * model's context window full (0-100). 0 leaves it to the runtime's own
   * compaction. See CompanyPolicy.rotateAtContextPct.
   */
  rotateAtContextPct: number;
  /**
   * Somewhere with real disk for toolchain caches. Empty leaves every one of
   * them on its default, which is under $HOME — a tmpfs that is also the
   * session store. See cacheEnv in staff.ts.
   */
  cacheDir: string;
  /**
   * The CLI's config + transcript store (CLAUDE_CONFIG_DIR), on the volume
   * rather than the container's tmpfs HOME. Empty leaves it on the default
   * under $HOME, which the container wipes on every restart — so a shift never
   * resumes and always starts cold. See sessionStore / sandboxFilesystem.
   */
  configDir: string;
  /**
   * Hard ceilings for an unattended run. Neither is a cost estimate — they are
   * stops. Leaving something unbounded running on somebody's machine overnight
   * is not a thing to do, and a subscription that gets exhausted at 3am means
   * they cannot work in the morning.
   */
  maxTicks: number | null;
  /** Epoch ms. The scheduler stops itself here regardless of anything else. */
  until: number | null;
  /**
   * Wall clock one shift may take before it is stopped, in ms. 0 disables it.
   *
   * The other ceilings all count something the model does, and none of them
   * move while a shift waits on something that never answers — which also
   * holds one of `concurrency` slots for as long as it waits.
   */
  shiftTimeoutMs: number;
  /**
   * How long a run may last from the moment it starts, in ms. 0 is no limit.
   *
   * `until` was only ever set when a caller passed one, so Start with no
   * arguments — and a boot resume, which passes nothing — was an unbounded
   * run. See CompanyPolicy.maxSessionHours.
   */
  maxSessionMs: number;
  /** Attach the per-leg operation trace to blind/tools-missing events. See
   *  CompanyPolicy.blindTrace. */
  blindTrace: boolean;
};

/** Defaults assume a Claude subscription: no dollar caps, paced by rate limit. */
export const DEFAULT_SCHEDULE: SchedulerOptions = {
  baseIntervalMs: 5 * 60_000,
  concurrency: 3,
  dailyBudgetUsd: null,
  perTickBudgetUsd: null,
  maxTicks: null,
  until: null,
  throttleAboveUtilization: 0.7,
  pauseAboveUtilization: 0.92,
  // Read a file, edit it, run the tests, read the failure, fix it: five turns
  // before anything works. At 24 every shift of a coding company was cut.
  maxTurns: 60,
  rotateAtContextPct: 50,
  cacheDir: '',
  configDir: '',
  // 1.6x the longest shift ever recorded here. See CompanyPolicy.
  shiftTimeoutMs: 45 * 60_000,
  maxSessionMs: 2 * 60 * 60_000,
  blindTrace: false,
};

type Deps = {
  ledger: Ledger; gate: Gate; world: World; clock: Clock;
  connectors?: Record<string, { type: 'http' | 'sse'; url: string; headers?: Record<string, string> }>;
  release?: 'none' | 'bundle';
  /** This company, and the services its product may reach through the
   *  key-injecting proxy — passed to each shift so it can mint a scoped token. */
  companySlug?: string;
  services?: Record<string, ServiceRoute>;
  options?: Partial<SchedulerOptions>;
  onTick?: (r: TickResult) => void;
  /**
   * A bound ended the run, so the company is no longer meant to be working.
   *
   * Stopping through the API writes that down; stopping on maxTicks or a
   * deadline did not, because the scheduler has no idea a config file exists.
   * So `running: true` outlived every bounded run, and the next process to
   * read it started the company again — unbounded, since the bound lived only
   * in memory. Lathe's one-hour trial on 2026-09-07 ended at 23:05 and was
   * resumed with no ceiling by a rebuild three hours later, which is exactly
   * the overnight run the bounds exist to prevent.
   */
  onBoundReached?: (why: string) => void;
};

/**
 * Who works next, when more people are due than there are slots.
 *
 * Longest-waiting first, NOT highest rank. Rank already buys its advantage in
 * #intervalFor, where a senior comes due about twice as often as a member.
 * Sorting by rank here spent it a second time: with ten staff and three slots
 * the same seniors won every contest, and a member could sit due, be passed
 * over, and still be due on the next pass, indefinitely. Invisible at two
 * staff, and a mystery about idle juniors at ten.
 *
 * Rank breaks ties so the order stays deterministic when two people have
 * waited exactly as long — which, on a company where nobody has run yet, is
 * everybody.
 */
export const selectDue = (
  staff: Agent[],
  opts: { now: number; nextDue: Map<AgentId, number>; inFlight: Set<AgentId>; slots: number },
): Agent[] => {
  const overdue = (a: Agent): number => opts.now - (opts.nextDue.get(a.id) ?? 0);
  return staff
    .filter((a) => a.tier !== 'board' && a.status === 'active')
    .filter((a) => !opts.inFlight.has(a.id))
    .filter((a) => overdue(a) >= 0)
    .sort((a, b) => overdue(b) - overdue(a) || RANK[a.tier] - RANK[b.tier])
    .slice(0, Math.max(0, opts.slots));
};

/**
 * House Rule 5, as a property of the system rather than a request in a prompt:
 * the company keeps working whether or not anyone is watching.
 *
 * Staff are woken on a stagger rather than all at once — partly for rate
 * limits and cost, partly because twenty-two agents waking simultaneously
 * makes the company look like a seizure instead of a place where people work.
 */
/** Windows older than this are not trusted to pace on. A dead poller freezes
 *  the last reading, and pacing on a stale "all clear" would over-run the real
 *  window; past this the company falls back to its spend and session-time caps
 *  and says so once. Generous against the poll cadence, so one missed poll is
 *  not called blind. */
const WINDOW_STALE_MS = 30 * 60_000;

export class Scheduler {
  #d: Deps;
  #opts: SchedulerOptions;
  #running = false;
  #abort = new AbortController();
  #nextDue = new Map<AgentId, number>();
  /** In-flight shifts, so stop() can wait for them rather than abandoning them. */
  #flights = new Set<Promise<void>>();
  #inFlight = new Set<AgentId>();
  #draining = false;
  #spentToday = 0;
  #spendDay: string;
  #ticks = 0;
  /** >1 stretches every interval. Raised as the subscription window fills. */
  #throttle = 1;
  /** Epoch ms. The company rests until the rate-limit window resets. */
  #pausedUntil = 0;
  /**
   * Whether pacing is flying without a fresh window reading. Starts true — a
   * company has no windows until the poller feeds it — so the first fresh
   * reading announces itself once (pacing_restored) and a feed that later dies
   * announces itself once (pacing_blind), rather than either being silent. See
   * pacing() and usagePoll.ts.
   */
  #pacingBlind = true;
  #lastRateLimit: SDKRateLimitInfo | null = null;
  /**
   * The most recent reading of each window, kept apart rather than collapsed.
   *
   * A subscription has several running at once — five-hour, seven-day, and
   * per-model seven-day — and they are all live constraints. Keeping only the
   * last event paced the company off whichever happened to arrive: a five-hour
   * window that had just reset read 15% and put the throttle back to 1 while
   * the weekly sat at 92%, so the company sprinted into the ceiling that takes
   * days rather than hours to recover.
   */
  #windows = new Map<string, SDKRateLimitInfo>();
  #readAt = new Map<string, number>();
  /** When the last round of shifts began. Zero so the first one fires at once. */
  #lastRound = 0;

  constructor(d: Deps) {
    this.#d = d;
    this.#opts = { ...DEFAULT_SCHEDULE, ...d.options };
    this.#spendDay = d.clock.day();

    // Where the rotation was when the last process stopped.
    //
    // This map used to start empty, which made `overdue` equal `now` for
    // everybody — a dead heat resolved by rank and then by array order, which
    // is hire order. So the first round after EVERY restart woke the same
    // people: with two slots and three staff, the third was never picked.
    //
    // Measured on Lathe over 53 wakes: marlow 45.3%, idris 37.7%, rue 17.0%,
    // where an even split is 33.3%. Simulated against selectDue itself, a
    // one-round run gives marlow 50%, idris 50%, rue 0% — and a company
    // started, bounded and rebuilt as often as this one is is almost all
    // first rounds. Rue was hired ten seconds after Idris and that is the
    // whole of why he came third.
    //
    // The rotation belongs to the company, not to the process that happens to
    // be running it. Same lesson as the running flag.
    for (const [id, at] of d.ledger.lastWorked()) this.#nextDue.set(id, at);
  }

  get running(): boolean { return this.#running; }

  /** When this run ends, after the policy ceiling has had its say. Null is
   *  unbounded, which only a company with maxSessionHours 0 can be. */
  get until(): number | null { return this.#running ? this.#opts.until : null; }
  get spentTodayUsd(): number { return this.#spentToday; }
  get ticks(): number { return this.#ticks; }
  get rateLimit(): SDKRateLimitInfo | null { return this.#lastRateLimit; }

  /**
   * The window closest to stopping the company, which is the only one worth
   * pacing against. Null until some window has reported.
   */
  get binding(): SDKRateLimitInfo | null { return worstWindow(this.#windows, isKnownLimit); }

  /**
   * Every window by name, for the console.
   *
   * `rateLimit` alone is whichever window reported last, so a front page built
   * on it showed one number and could not say which window it was — and the
   * five-hour one, the only figure that decides whether the operator can work
   * this afternoon, was usually not it.
   */
  get windows(): Array<{ kind: string; utilization: number | null; resetsAt: number | null;
                        readAt: number }> {
    return [...this.#windows].map(([kind, w]) => ({
      kind,
      utilization: w.utilization ?? null,
      resetsAt: w.resetsAt ?? null,
      // When it was read, because a paused company keeps its last reading and
      // a five-hour window resets. Without this the console cannot tell a
      // figure from a minute ago apart from one from before the reset.
      readAt: this.#readAt.get(kind) ?? 0,
    }));
  }

  /**
   * The weekly window specifically. It is the one an operator plans around:
   * a five-hour window spent at lunchtime is back by dinner, and a seven-day
   * one spent on Tuesday is gone for the week.
   */
  get weekly(): SDKRateLimitInfo | null { return worstWindow(this.#windows, isWeekly); }
  get pausedUntil(): number { return this.#pausedUntil; }

  /** Who is mid-shift this second. The console shows it live. */
  get awake(): AgentId[] { return [...this.#inFlight]; }

  /**
   * Paused, but still letting the last shifts finish on their own.
   *
   * The console needs to tell this apart from both running and stopped: it is
   * the only state where nobody new will be woken and yet somebody is still
   * working, and the operator is usually waiting on it before a rebuild.
   */
  get draining(): boolean { return this.#draining; }

  /** When each active agent is next due, so the console can say "in 4 min". */
  dueAt(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [id, at] of this.#nextDue) out[id] = at;
    return out;
  }

  /**
   * Pace the company off the subscription's own rate-limit signal.
   *
   * 'rejected' means the window is spent — resting until it resets beats
   * hammering a wall and burning the next window on retries. 'allowed_warning'
   * and high utilization stretch the intervals instead, so the company slows
   * down rather than stopping dead.
   */
  #applyRateLimit(info: SDKRateLimitInfo): void {
    this.#lastRateLimit = info;
    this.#windows.set(info.rateLimitType ?? 'unknown', info);
    this.#readAt.set(info.rateLimitType ?? 'unknown', Date.now());

    // A refusal is about the window that refused, whether or not it is the
    // fullest one — there is nothing to pace, the door is shut.
    if (info.status === 'rejected') {
      this.#pausedUntil = normaliseResetsAt(info.resetsAt) ?? Date.now() + 15 * 60_000;
      this.#d.ledger.emit('company', 'company.rate_limited', null, {
        rateLimitType: info.rateLimitType, resumesAt: new Date(this.#pausedUntil).toISOString(),
      });
      return;
    }

    // Everything below reads the fullest window rather than the one that just
    // reported. Any of them can stop the company, so the binding one is the
    // only honest input to a decision about slowing down.
    this.#repace(this.binding ?? info);
  }

  /**
   * Fold an out-of-band usage reading into the same pacing the shift-reported
   * signal drives. The windows come from `/api/oauth/usage`, read with a
   * `user:profile` credential and injected through the gateway, because the
   * spend credential can be a `setup-token` that cannot read them itself.
   *
   * They are the subscription's windows, not this company's, so every running
   * company is paced off them: a plan at 85% must slow all of them, not only
   * whichever one happened to catch a `rate_limit_event` in its last shift.
   * This is the steady source that signal never was — 15 of 155 shifts carried
   * one in one run, none at all across a whole night in another (see limits.ts).
   */
  applyUsage(windows: Iterable<readonly [string, SDKRateLimitInfo]>): void {
    const now = Date.now();
    let any = false;
    for (const [kind, info] of windows) {
      this.#windows.set(kind, info);
      this.#readAt.set(kind, now);
      any = true;
    }
    if (!any) return;
    const worst = this.binding;
    // So the console's `rateLimit` reflects the freshest reading, not the last
    // shift's stale one.
    if (worst) this.#lastRateLimit = worst;
    this.#repace(worst);
  }

  /**
   * Recompute throttle and pause from the fullest known window. Shared by the
   * shift-reported signal and the injected usage reading, so the two cannot
   * pace the company by different rules.
   */
  #repace(worst: SDKRateLimitInfo | null): void {
    if (!worst) return;
    const u = worst.utilization ?? 0;

    // The operator's headroom. Slowing down still spends the window, just
    // later; only stopping leaves any of it for the person who pays for it.
    if (this.#opts.pauseAboveUtilization < 1 && u >= this.#opts.pauseAboveUtilization) {
      this.#pausedUntil = normaliseResetsAt(worst.resetsAt) ?? Date.now() + 15 * 60_000;
      this.#d.ledger.emit('company', 'company.usage_paused', null, {
        utilization: u, ceiling: this.#opts.pauseAboveUtilization,
        rateLimitType: worst.rateLimitType,
        resumesAt: new Date(this.#pausedUntil).toISOString(),
      });
      return;
    }

    const prev = this.#throttle;
    this.#throttle = worst.status === 'allowed_warning' ? 3
      : u > this.#opts.throttleAboveUtilization ? 1 + (u - this.#opts.throttleAboveUtilization) * 6
      : 1;
    if (Math.abs(this.#throttle - prev) > 0.25) {
      this.#d.ledger.emit('company', 'company.throttled', null, {
        utilization: u, factor: Number(this.#throttle.toFixed(2)), rateLimitType: worst.rateLimitType,
      });
    }
  }

  /**
   * What the company is pacing on right now, and whether it can trust it.
   *
   * Windows when a reading is fresh; otherwise the fallback the operator set —
   * the daily spend cap, then the session-time deadline (which always stops an
   * unattended run). `blind` is true when no window is fresh enough to trust: a
   * dead poller freezes the last reading, and pacing on a stale "all clear"
   * would over-run the real window, so past WINDOW_STALE_MS the company leans on
   * those caps instead. `now` is injectable for tests; the readings are stamped
   * with Date.now() (see applyUsage), so this compares against the same clock.
   */
  pacing(now = Date.now()): { blind: boolean; windowAgeMs: number | null; fallback: 'spend' | 'time' | 'none' } {
    let newest = 0;
    for (const t of this.#readAt.values()) if (t > newest) newest = t;
    const windowAgeMs = newest > 0 ? now - newest : null;
    const blind = windowAgeMs == null || windowAgeMs > WINDOW_STALE_MS;
    const fallback = this.#opts.dailyBudgetUsd != null ? 'spend'
      : (this.#opts.until != null || this.#opts.maxSessionMs > 0) ? 'time'
        : 'none';
    return { blind, windowAgeMs, fallback };
  }

  /** Rank sets cadence: an executive wakes about 1.5x as often as a member. */
  #intervalFor(a: Agent): number {
    const rank = RANK[a.tier];
    const factor = 1 + rank * 0.35;
    // Jitter so ticks never phase-lock into a thundering herd.
    //
    // It was `hash(a.id) % 30`, which is a constant per person and therefore
    // not jitter at all: it never de-phased anything and instead handed each
    // agent a permanent interval multiplier between 0.85 and 1.14, a 34%
    // spread that never moved. Idris drew 1.14 and Nadia drew 1.14, and both
    // sit at the bottom of their companies' wake counts — 29.1 minutes
    // against Rue's 22.2 on the same tier, forever.
    //
    // Rolled per wake, it does what the comment always claimed.
    const jitter = 0.85 + Math.random() * 0.3;
    return this.#opts.baseIntervalMs * factor * jitter * this.#throttle;
  }

  #rolloverIfNewDay(): void {
    const today = this.#d.clock.day();
    if (today !== this.#spendDay) {
      this.#spendDay = today;
      this.#spentToday = 0;
      this.#d.ledger.emit('company', 'budget.rollover', null, { day: today });
    }
  }

  /**
   * Begin working, optionally with hard stops.
   *
   * A run left going on somebody else's machine gets a deadline and a wake-up
   * budget, because a subscription window is shared with the person who owns
   * it. Bounds belong to the run rather than to the company's policy: the same
   * company is started unattended one night and watched the next.
   */
  start(bounds?: { until?: number | null; maxTicks?: number | null }): void {
    if (this.#running) return;
    this.#running = true;
    this.#ticks = 0;
    this.#lastRound = 0;
    // The run's own ceiling, which applies whether or not anybody asked for
    // one. A caller may ask for less; asking for more does not get it, and
    // the deadline goes back on the response so the clip is never silent.
    const cap = this.#opts.maxSessionMs > 0 ? Date.now() + this.#opts.maxSessionMs : null;
    const asked = bounds?.until ?? null;
    this.#opts.until = cap == null ? asked
      : asked == null ? cap
      : Math.min(asked, cap);
    this.#opts.maxTicks = bounds?.maxTicks ?? null;
    this.#abort = new AbortController();
    this.#d.ledger.emit('company', 'work.started', null, { options: this.#opts });
    void this.#loop();
  }

  /**
   * Stop, and WAIT for anyone mid-shift to finish.
   *
   * Aborting the loop does not abort a shift already in the SDK. Returning
   * before those settle means the caller closes the ledger underneath them,
   * and the shift crashes the process on its closing `agent.slept` — which is
   * exactly what a server shutdown used to do to whoever was working.
   *
   * `drain` is the difference between waiting for a shift and killing it.
   * Without it the abort reaches the SDK and the shift dies where it stands,
   * losing the work and writing `agent.failed: Claude Code process aborted by
   * user` — three of those in Fathom's log on 2026-09-03 are the operator
   * pressing Pause, not anything going wrong. Draining leaves the abort alone
   * and simply stops waking anybody, so the loop falls out within its 2s sleep
   * and the shifts already running end by writing their journals.
   */
  async stop(opts?: { drain?: boolean }): Promise<void> {
    // Stopping what was never started is not an event. `start` has always
    // guarded against announcing itself twice; `stop` did not, so every open
    // and close of a paused company appended a `work.paused` describing
    // nothing that happened. Restart the server ten times and the log grew
    // ten entries. The wait below still runs unconditionally — a second
    // caller must not return while a shift is in flight.
    const wasRunning = this.#running;
    this.#running = false;
    if (!opts?.drain) this.#abort.abort();
    this.#draining = opts?.drain === true && this.#flights.size > 0;
    try {
      if (this.#flights.size) await Promise.allSettled([...this.#flights]);
    } finally {
      this.#draining = false;
    }
    // A drain can be overtaken: the operator waits out a long shift, changes
    // their mind and presses Start before it lands. Announcing a pause then
    // would put `work.paused` after the `work.started` that is now true.
    if (wasRunning && !this.#running) {
      this.#d.ledger.emit('company', 'work.paused', null, { spentTodayUsd: this.#spentToday });
    }
  }

  #track(p: Promise<void>): void {
    this.#flights.add(p);
    void p.catch(() => { /* #wake reports its own failures */ })
      .finally(() => this.#flights.delete(p));
  }

  async #loop(): Promise<void> {
    while (this.#running) {
      this.#rolloverIfNewDay();

      // The bounds of an unattended run, checked before anything else. Both
      // drain: a run left going overnight ends with nobody watching, and
      // killing the shift that happens to be in flight when the clock runs out
      // loses everything it did since its last journal entry — the one outcome
      // an operator who set a deadline was trying to avoid.
      if (this.#opts.maxTicks != null && this.#ticks >= this.#opts.maxTicks) {
        this.#d.ledger.emit('company', 'scheduler.stopped', null,
          { why: 'tick ceiling reached', ticks: this.#ticks });
        this.#d.onBoundReached?.('tick ceiling reached');
        await this.stop({ drain: true });
        break;
      }
      if (this.#opts.until != null && Date.now() >= this.#opts.until) {
        this.#d.ledger.emit('company', 'scheduler.stopped', null,
          { why: 'deadline reached', ticks: this.#ticks });
        this.#d.onBoundReached?.('deadline reached');
        await this.stop({ drain: true });
        break;
      }

      // Announce once when the window feed goes stale or comes back: the
      // throttle is then flying on a frozen reading, and the company is really
      // governed by its spend and session-time caps until fresh windows return.
      // Silent otherwise. See usagePoll.ts for the feed this depends on.
      const pace = this.pacing();
      if (pace.blind !== this.#pacingBlind) {
        this.#pacingBlind = pace.blind;
        this.#d.ledger.emit('company',
          pace.blind ? 'company.pacing_blind' : 'company.pacing_restored', null,
          pace.blind
            ? { windowAgeMs: pace.windowAgeMs, fallback: pace.fallback }
            : { windowAgeMs: pace.windowAgeMs });
      }

      // Rate-limited: rest rather than hammering a spent window.
      if (Date.now() < this.#pausedUntil) {
        await sleep(30_000, this.#abort.signal);
        continue;
      }
      // Metered-billing stop. Null on a subscription, where this never trips.
      if (this.#opts.dailyBudgetUsd != null && this.#spentToday >= this.#opts.dailyBudgetUsd) {
        await sleep(30_000, this.#abort.signal);
        continue;
      }

      const now = Date.now();

      // One cadence for the company, not one per person.
      //
      // baseIntervalMinutes used to space out only an INDIVIDUAL's shifts, so
      // a roster of four on a ten-minute interval never rested: while the CEO
      // waited out his ten minutes the other three were already due, and the
      // queue never emptied. Measured over 70 minutes of a real run, the
      // shifts totalled 69.9 of them — a duty cycle of 100%, and every hire
      // silently made the company spend faster.
      //
      // Now the interval gates ROUNDS. Every interval, up to `concurrency`
      // agents wake; nobody wakes in between. Rank still decides who comes due
      // first, which is what selectDue and #intervalFor are for.
      if (!roundIsDue(now, this.#lastRound, this.#opts.baseIntervalMs, this.#throttle)) {
        await sleep(2_000, this.#abort.signal);
        continue;
      }

      const slots = this.#opts.concurrency - this.#inFlight.size;
      const due = selectDue(this.#d.ledger.listAgents(), {
        now, nextDue: this.#nextDue, inFlight: this.#inFlight, slots,
      });

      // A round that woke somebody starts the clock, and so does one that could
      // not because every slot was busy — the company was working, which is
      // what the clock measures.
      //
      // Only the third case holds the gate open: slots free and nobody due yet.
      // Then the company is idle and waiting, and the next agent should start
      // the moment they come due rather than sit out the rest of the interval.
      //
      // Conflating the two was a hole. With shifts longer than the interval,
      // every round found no free slot, the clock never advanced, and each
      // finishing shift was replaced immediately — the same continuous
      // operation this gate exists to stop, arrived at from the other side.
      if (due.length || slots <= 0) this.#lastRound = now;
      for (const a of due) this.#track(this.#wake(a));

      // Approved work is applied by the company, never by the requester — so a
      // staff member cannot enact its own escalation.
      applyApproved(this.#d.ledger, this.#d.world, this.#d.clock,
        Object.keys(this.#d.connectors ?? {}), this.#d.release ?? 'none',
        this.#d.gate.constitution.board);

      await sleep(2_000, this.#abort.signal);
    }
  }

  async #wake(a: Agent): Promise<void> {
    this.#inFlight.add(a.id);
    this.#ticks++;
    try {
      const r = await tick({
        agent: a, ledger: this.#d.ledger, gate: this.#d.gate,
        world: this.#d.world, clock: this.#d.clock,
        ...(this.#opts.perTickBudgetUsd != null ? { maxBudgetUsd: this.#opts.perTickBudgetUsd } : {}),
        maxTurns: this.#opts.maxTurns,
        rotateAtContextPct: this.#opts.rotateAtContextPct,
        ...(this.#opts.shiftTimeoutMs > 0 ? { shiftTimeoutMs: this.#opts.shiftTimeoutMs } : {}),
        ...(this.#opts.blindTrace ? { blindTrace: true } : {}),
        // The engine's own state, so the shift can wind down before the cap and
        // pace on the window instead of learning it by being throttled.
        ...(this.#opts.until != null ? { sessionEndsAt: this.#opts.until } : {}),
        ...(this.#windows.size ? { usageWindows: this.windows.map(
          (w) => ({ kind: w.kind, utilization: w.utilization })) } : {}),
        ...(this.#opts.cacheDir ? { cacheDir: this.#opts.cacheDir } : {}),
        ...(this.#opts.configDir ? { configDir: this.#opts.configDir } : {}),
        ...(this.#d.connectors ? { connectors: this.#d.connectors } : {}),
        ...(this.#d.release ? { release: this.#d.release } : {}),
        ...(this.#d.companySlug && this.#d.services && Object.keys(this.#d.services).length
          ? { companySlug: this.#d.companySlug, services: this.#d.services } : {}),
        signal: this.#abort.signal,
      });
      this.#spentToday += r.costUsd;
      // Every window the shift saw, so the fullest one is chosen from all of
      // them rather than from whichever arrived last.
      for (const [, w] of r.windows ?? []) this.#applyRateLimit(w);
      if (r.rateLimit) this.#applyRateLimit(r.rateLimit);
      this.#d.onTick?.(r);
    } finally {
      this.#inFlight.delete(a.id);
      this.#nextDue.set(a.id, Date.now() + this.#intervalFor(a));
    }
  }

  /** Wake someone immediately — used by "call a meeting" and by direct address. */
  nudge(id: AgentId): void { this.#nextDue.set(id, 0); }
}

/** resetsAt has arrived as both epoch-seconds and epoch-ms; normalise. */
const normaliseResetsAt = (v: number | undefined): number | null => {
  if (v == null || !Number.isFinite(v)) return null;
  return v < 1e12 ? v * 1000 : v;
};

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((res) => {
    if (signal.aborted) return res();
    const t = setTimeout(res, ms);
    signal.addEventListener('abort', () => { clearTimeout(t); res(); }, { once: true });
  });
