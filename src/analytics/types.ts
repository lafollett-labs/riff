/**
 * The shape of a Vitals report — and nothing else.
 *
 * Split out so the console can import the very types the server answers with.
 * `vitals.ts` reaches for the Ledger, the World and the node builtins under
 * them; a browser bundle typechecked against that drags in a runtime it will
 * never have. This module imports nothing but an id alias, so both sides can
 * name the same fields.
 *
 * The console used to restate all ninety of these by hand. Renaming a field
 * on one side then typechecked on both and rendered `undefined`, with no
 * error anywhere — which is not a thing a reader of a report can be expected
 * to notice.
 */
import type { AgentId } from '../core/types.ts';

export type Window = {
  /** What was asked for, verbatim — echoed back so a report can name itself. */
  spec: string;
  /** The cut, as ISO. Both SQL and `git --since` are given this exact string,
   *  so the two halves of a report can never disagree about where it starts. */
  since: string;
  /** Exclusive. Now, for the window being reported; the start of that window
   *  for the one before it. */
  until: string;
  days: number;
};

export type ShiftVitals = {
  woke: number;
  slept: number;
  failed: number;
  /** Shifts stopped on the wall clock: stuck rather than slow. See
   *  CompanyPolicy.shiftTimeoutMinutes. */
  overran: number;
  /** Shifts cut at the turn ceiling with work still in hand. */
  truncated: number;
  /** Shifts stopped between tool calls at their time budget: landed, where
   *  `overran` was killed inside one. See `landing` in src/runtime/staff.ts. */
  outOfTime: number;
  /** Subagents the staff spawned (the Agent tool). Each has its own
   *  subagent.started / subagent.finished pair in the ledger. */
  subagents: number;
  rotated: number;
  rotateFailed: number;
  compacted: number;
  turns: number;
  costUsd: number;
  costPerShift: number;
  turnsPerShift: number;
  /** Failed and overran over woke. The number that says whether the loop works
   *  at all, before any question of whether the work is good. */
  troubleRate: number;
  /** Shifts that woke, spent money and left nothing behind — no document, no
   *  mail, no task, no note. The most expensive thing a company can do is pay
   *  attention to itself, and until now it did not appear in any figure. */
  barren: number;
  /** The largest share of the window's inference bill one person accounts
   *  for. A total hides an agent quietly burning two thirds of it. */
  costShareTop: number;
};

export type ThrottleVitals = { rateLimited: number; throttled: number; usagePaused: number };

export type CommonsVitals = {
  held: number;
  ceiling: number;
  /** Every posting, revisions included. */
  posted: number;
  /** Documents the shelf had never held before. A company that rewrites the
   *  same four pages all week is not accreting, and counting every posting as
   *  growth said it was — on a shelf whose contents had not changed. */
  added: number;
  /** Postings over a document that already existed. Revision is the shape of
   *  a company thinking, and is not the thing Rule 6 bounds. */
  revised: number;
  removed: number;
  /** Additions minus removals. The accretion number Rule 6 exists to bound,
   *  and the one that has to agree with what the shelf actually holds. */
  net: number;
  /** Times the ceiling actually refused a posting. Zero with a full shelf
   *  means the pressure has never been tested, not that it works. */
  refused: number;
};

export type EnvelopeVitals = {
  filed: number;
  approved: number;
  rejected: number;
  withdrawn: number;
  released: number;
  pending: number;
  /** How long the oldest undecided draft has waited. The board is a
   *  bottleneck the company cannot route around, so this is its latency. */
  oldestPendingHours: number | null;
  medianDecisionHours: number | null;
};

export type WorkVitals = {
  opened: number;
  claimed: number;
  done: number;
  dropped: number;
  blocked: number;
  openNow: number;
  /** Finished over finished-plus-abandoned. */
  completionRate: number;
};

export type OrgVitals = {
  /** Everyone but the board. */
  headcount: number;
  hired: number;
  retired: number;
  /** Hires minus retirements. Rule 6 bounds documents and nothing bounds
   *  this, so it is the accretion claim applied to the org chart. */
  net: number;
  /** A reporting line pointing at nobody — the shape a bad rename leaves. */
  orphans: number;
  /** Deepest chain of command, and the widest span in it. The board is not
   *  in either: it governs, it does not manage, so counting the chair as a
   *  layer would report every company as one deeper than it is. */
  depth: number;
  widest: number;
  shiftsPerHead: number;
};

export type TalkVitals = {
  messages: number;
  /** Recipients, not messages. One broadcast to twenty-two people is one row
   *  here and twenty-two inbox reads on everybody's next shift. */
  deliveries: number;
  broadcastFanout: number;
  notes: number;
  memoryConsolidated: number;
  /** Every commit in the world, whoever made it. */
  commits: number;
  /** The ones a member of staff actually made. The world is committed by the
   *  harness too — a repair, an ignore file, the initial layout — and counting
   *  those as company output flatters every ratio below. */
  byStaff: number;
  /** Commits by nobody on the roster: the harness, the company itself, or a
   *  person who worked here under an id that no longer exists. Reported rather
   *  than dropped, because a number that quietly goes missing is worse than a
   *  number that is explained. */
  unattributed: number;
  /** Messages per commit of real work. Agents that talk to each other forever
   *  and land nothing is the failure mode this catches in one figure. */
  perCommit: number;
  /** Dollars of inference per commit of real work. */
  costPerCommit: number;
};

export type MoneyVitals = { spends: number; cents: number; exceptions: number };

/**
 * What the company consumed, which is the figure that means something.
 *
 * Riff runs on a Claude subscription. `costUsd` everywhere else in this module
 * is the SDK's `total_cost_usd`: API list price imputed after the fact, useful
 * as a comparison and billed to nobody. Tokens are the resource that actually
 * depletes, so they are reported in their own right rather than left to be
 * guessed at from a dollar figure that no invoice will ever match.
 */
/**
 * How much of the window the company was actually working.
 *
 * A window is wall clock; a company only exists while its scheduler is
 * running. Thirty days of window over twenty-one hours of work reports a
 * month of operation, and every per-day rate read off it is wrong by the
 * reciprocal of the duty cycle — which was 3% the first time this was
 * measured, so a "$25.59 a day" reading was out by a factor of thirty-three.
 * Rates that mean anything are per running hour.
 */
/**
 * Whether the company is still capable of doing something it has not done.
 *
 * Every other figure here rewards throughput, and a company shipping the
 * sixteenth point release of its first idea scores exactly like one that
 * launched something new. That is the failure R7 exists to make expensive,
 * so it has to be visible before anyone can say whether R7 worked.
 */
export type NoveltyVitals = {
  /** Projects the company is carrying, and what Rule 7 allows. 0 = no ceiling. */
  carrying: number;
  ceiling: number;
  /** Started and retired inside the window. Retiring is the rare one. */
  started: number;
  retired: number;
  /**
   * How many hours the company has actually WORKED since its newest project
   * began — not how long ago that was.
   *
   * A company only exists while its scheduler is up, and one measured here
   * ran 21.4 hours across 30 calendar days. Ageing anything by the calendar
   * charges the staff for every week the operator did not switch them on.
   * Null when there are no projects.
   */
  newestAgeHours: number | null;
  /**
   * Share of staff commits landing in the single busiest project. 1 means
   * every hand on one thing, which is focus or a rut and the age says which.
   */
  concentration: number;
  /** How many distinct projects saw a commit at all in the window. */
  touched: number;
};

export type RunVitals = {
  /** Hours the scheduler was running inside the window. */
  hours: number;
  /** Those hours as a share of the window. 1 is a company that never stopped. */
  dutyCycle: number;
  shiftsPerHour: number;
  tokensPerHour: number;
  /** Imputed list price per running hour. Still not a bill. */
  costPerHour: number;
};

export type TokenVitals = {
  total: number;
  /** Fresh input — the part that was not already paid for by a cache write. */
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  perShift: number;
  /**
   * Cached input as a share of all input. A company that rotates its
   * conversations too eagerly pays the full prompt again each time, and this
   * is where that shows up before the window does.
   */
  cacheHitRate: number;
  /** Shifts that reported usage at all. The rest are gaps, not zeroes. */
  measured: number;
};

/**
 * The subscription window: the ceiling this company actually runs into.
 *
 * `utilization` is a fraction of the window in force, which is why `type`
 * travels with it — 60% of five hours and 60% of seven days are not the same
 * news. Absent when no shift in the window heard from the rate limiter.
 */
export type LimitVitals = {
  /** The most recent reading: what is left right now. */
  latest: number;
  /** The highest reading in the window: how close the company has come. */
  peak: number;
  type: string;
  /** Shifts carrying a reading. Zero means the whole section is unknown. */
  seen: number;
  /**
   * The seven-day window, reported apart from the rest because it is the one
   * an operator plans around. Five hours spent by lunch is back by dinner; a
   * week spent on Tuesday is gone until Tuesday. Null when no shift in the
   * window reported a weekly reading.
   */
  week: { latest: number; peak: number } | null;
  /**
   * The five-hour window. Separate from `latest` because that one is whichever
   * window happened to be tightest, so the five-hour reading disappeared from
   * the report exactly when the week was fuller — and the five-hour is the one
   * that decides whether the operator can work this afternoon.
   */
  fiveHour: { latest: number; peak: number } | null;
  /** Unix seconds each window comes back, when the reading carried one. */
  resets: Record<string, number>;
};

/** A rule that refused something. Allows are counted in the totals but never
 *  listed: there are thousands of them and none is news. */
export type RuleBite = { kind: string; rule: string; capability: string; n: number };

export type PersonVitals = {
  id: AgentId;
  name: string;
  tier: string;
  role: string;
  shifts: number;
  turns: number;
  costUsd: number;
  /** What they consumed of the subscription window, which is the figure that
   *  decides who is expensive. `costUsd` beside it is a list-price comparison. */
  tokens: number;
  commits: number;
  messages: number;
  posted: number;
  filed: number;
  done: number;
  /** Gate refusals against them. A member fighting the gate every shift has
   *  either a bad mandate or a bad idea, and both are worth seeing. */
  denied: number;
};

/**
 * The figures worth reading as a direction rather than a level, over the
 * window immediately before this one. A count with nothing to compare it
 * against is a number, not a signal.
 */
export type Trend = {
  shifts: number; costUsd: number; tokens: number; commits: number; messages: number;
  posted: number; removed: number; filed: number; released: number;
  done: number; dropped: number; overran: number; failed: number;
  hired: number; retired: number; barren: number;
};

export type Vitals = {
  window: Window;
  previous: Trend | null;
  shifts: ShiftVitals;
  run: RunVitals;
  novelty: NoveltyVitals;
  tokens: TokenVitals;
  limits: LimitVitals;
  org: OrgVitals;
  throttle: ThrottleVitals;
  commons: CommonsVitals;
  envelope: EnvelopeVitals;
  work: WorkVitals;
  talk: TalkVitals;
  money: MoneyVitals;
  gate: { allow: number; deny: number; escalate: number; rules: RuleBite[] };
  people: PersonVitals[];
};
