/**
 * Vitals — what the company actually did, as numbers.
 *
 * Every figure here is a projection over the event log, the ledger's own
 * tables and the world's git history. Nothing is recorded for it and no table
 * backs it: a metric breaks neither a rule nor a render, so by the house split
 * it is not a row. The window is therefore free — ask ninety days of a company
 * two weeks old and the answer is simply smaller.
 *
 * The README makes empirical claims: that agents accrete structure and never
 * remove any, that the envelope is the one door outward, that Rule 6 is the
 * load-bearing one. This module is where those claims become checkable, which
 * is the same standard the commit log is held to.
 */
import type { Ledger } from '../ledger/ledger.ts';
import type { World } from '../worldfs/world.ts';
import type { Clock } from '../core/clock.ts';
import type { AgentId, Event } from '../core/types.ts';
import type {
  CommonsVitals, EnvelopeVitals, LimitVitals, MoneyVitals, OrgVitals, PersonVitals,
  NoveltyVitals, RunVitals, ShiftVitals, TalkVitals, TokenVitals, Trend, Vitals, Window,
  WorkVitals,
} from './types.ts';

export type * from './types.ts';


const MS: Record<string, number> = {
  hour: 3_600_000,
  day: 86_400_000,
  week: 7 * 86_400_000,
  month: 30 * 86_400_000,
};

/**
 * Accepts what `git log --since` accepts of the forms anyone actually types:
 * `3.days`, `12 hours`, `2.weeks`. Anything else falls back to a week rather
 * than throwing, because a mistyped window on a status command should still
 * print a report.
 */
export const parseWindow = (spec: string, endAt: number): Window => {
  const m = /^(\d+)[.\s_-]*(hour|day|week|month)s?$/i.exec(spec.trim());
  const n = m ? Number(m[1]) : 0;
  // A zero-length window is a typo, not a request. Fall back whole — echoing
  // the spec the caller typed while reporting a week would label the report
  // with a window it did not read.
  const ok = m != null && n > 0;
  const unit = ok ? m[2]!.toLowerCase() : 'day';
  const ms = (MS[unit] ?? MS['day']!) * (ok ? n : 7);
  return {
    spec: ok ? spec.trim() : '7.days',
    since: new Date(endAt - ms).toISOString(),
    until: new Date(endAt).toISOString(),
    days: ms / MS['day']!,
  };
};

/**
 * What counts as having done something. A shift that woke, spent money and
 * emitted none of these read the company and went back to sleep — which is
 * the expensive failure the totals were hiding.
 */
const PRODUCTIVE = [
  'commons.posted', 'commons.removed', 'message.sent', 'note.written',
  'task.opened', 'task.claimed', 'task.done', 'task.dropped',
  'memory.consolidated', 'gate.escalate', 'external.released', 'role.filled',
] as const;

/** Ratios over an empty window are 0, not NaN — a report is not a place to
 *  print "NaN" at a person who simply has not run the company yet. */
const over = (part: number, whole: number): number => (whole > 0 ? part / whole : 0);

const median = (xs: number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};

const hoursBetween = (a: string, b: string): number =>
  (Date.parse(b) - Date.parse(a)) / 3_600_000;

const data = (e: Event): Record<string, unknown> => {
  if (!e.dataJson) return {};
  try {
    const v: unknown = JSON.parse(e.dataJson);
    return v && typeof v === 'object' ? v as Record<string, unknown> : {};
  } catch {
    return {};
  }
};

const numberOf = (o: Record<string, unknown>, k: string): number => {
  const v = o[k];
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
};

/** The scalars worth reading as a direction, lifted out of a full report. */
const trendOf = (v: Vitals): Trend => ({
  shifts: v.shifts.slept,
  costUsd: v.shifts.costUsd,
  tokens: v.tokens.total,
  commits: v.talk.byStaff,
  messages: v.talk.messages,
  posted: v.commons.added,
  removed: v.commons.removed,
  filed: v.envelope.filed,
  released: v.envelope.released,
  done: v.work.done,
  dropped: v.work.dropped,
  overran: v.shifts.overran,
  failed: v.shifts.failed,
  hired: v.org.hired,
  retired: v.org.retired,
  barren: v.shifts.barren,
});

export type VitalsDeps = {
  ledger: Ledger;
  world: World;
  clock: Clock;
  commonsCeiling: number;
  /** R7's ceiling, for reporting it beside what the company is carrying. */
  portfolioCeiling?: number;
};

export const vitals = (
  d: VitalsDeps,
  spec = '7.days',
  /** Where the window ends. The report walks itself back by one window to
   *  fill in `previous`; nothing else should pass this. */
  endAt = d.clock.now().getTime(),
  /** False on the inner call that builds `previous`, so it does not recurse. */
  compare = true,
): Vitals => {
  const window = parseWindow(spec, endAt);
  const { since, until } = window;

  // One pass over the histogram, indexed two ways: totals for the company,
  // and per-actor for the table at the bottom of the report.
  const counts = d.ledger.eventCounts(since, until);
  const total = new Map<string, number>();
  const mine = new Map<AgentId, Map<string, number>>();
  for (const c of counts) {
    total.set(c.kind, (total.get(c.kind) ?? 0) + c.n);
    let m = mine.get(c.actor);
    if (!m) mine.set(c.actor, (m = new Map()));
    m.set(c.kind, (m.get(c.kind) ?? 0) + c.n);
  }
  const n = (kind: string): number => total.get(kind) ?? 0;
  const nOf = (who: AgentId, kind: string): number => mine.get(who)?.get(kind) ?? 0;

  // One ordered pass over the kinds whose payload has to be read rather than
  // counted, plus the two that bracket a shift. `agent.slept` is the only
  // place a shift's turns and dollars are written down, and walking woke →
  // slept in sequence is the only way to tell a shift that did something from
  // one that woke, read the company, and went back to sleep.
  const shiftLog = d.ledger.eventsOfKinds(
    ['agent.woke', 'agent.slept', 'agent.failed', ...PRODUCTIVE], since, until);

  const turnsBy = new Map<AgentId, number>();
  const costBy = new Map<AgentId, number>();
  const tokensBy = new Map<AgentId, number>();
  const tok = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  // Shifts that reported usage at all. Dividing by `slept` instead would
  // quietly average in every shift that died before its first turn.
  let measured = 0;
  // The subscription window, read off whichever shift reported last. A shift
  // that never heard from the rate limiter contributes nothing rather than a
  // zero, which would read as "plenty left".
  let limitLatest = 0;
  let limitPeak = 0;
  let limitType = '';
  let limitSeen = 0;
  let weekLatest = 0;
  let weekPeak = 0;
  let weekSeen = 0;
  let fiveLatest = 0;
  let fivePeak = 0;
  let fiveSeen = 0;
  const resets: Record<string, number> = {};

  /**
   * Read the meter off a shift that ended, however it ended.
   *
   * A failed shift is the one most worth counting: it consumed the window and
   * produced nothing, which is invisible in a dollar figure nobody pays and
   * invisible again in a turn count that stops at the error.
   */
  const readMeter = (who: AgentId, dj: Record<string, unknown>): void => {
    const n = numberOf(dj, 'tokens');
    if (n > 0) {
      measured++;
      tok.input += numberOf(dj, 'tokensIn');
      tok.output += numberOf(dj, 'tokensOut');
      tok.cacheRead += numberOf(dj, 'cacheRead');
      tok.cacheWrite += numberOf(dj, 'cacheWrite');
      tokensBy.set(who, (tokensBy.get(who) ?? 0) + n);
    }
    const u = numberOf(dj, 'utilization');
    if (u > 0) {
      limitSeen++;
      limitLatest = u;
      limitPeak = Math.max(limitPeak, u);
      const kind = dj['limitType'];
      if (typeof kind === 'string' && kind) limitType = kind;
    }
    const w = numberOf(dj, 'weekUtilization');
    if (w > 0) {
      weekSeen++;
      weekLatest = w;
      weekPeak = Math.max(weekPeak, w);
    }
    // Written by name since the shift that records every window it was told
    // about, rather than only the tightest one. Older shifts carry neither key
    // and contribute nothing, which is the same as any other unread meter.
    const five = numberOf(dj, 'used_five_hour');
    if (five > 0) {
      fiveSeen++;
      fiveLatest = five;
      fivePeak = Math.max(fivePeak, five);
    }
    for (const [k, val] of Object.entries(dj)) {
      if (k.startsWith('resets_') && typeof val === 'number') resets[k.slice('resets_'.length)] = val;
    }
  };
  const busy = new Set<AgentId>();      // has produced since waking
  const open = new Set<AgentId>();      // woke inside this window
  let slept = 0;
  let turns = 0;
  let costUsd = 0;
  let truncated = 0;
  let outOfTime = 0;
  let subagents = 0;
  let barren = 0;
  let deliveries = 0;
  const posted: Array<{ path: string; at: string }> = [];

  for (const e of shiftLog) {
    if (e.kind === 'agent.woke') { open.add(e.actor); busy.delete(e.actor); continue; }

    if (e.kind === 'agent.slept') {
      const dj = data(e);
      const t = numberOf(dj, 'turns');
      const c = numberOf(dj, 'costUsd');
      readMeter(e.actor, dj);
      slept++;
      turns += t;
      costUsd += c;
      subagents += numberOf(dj, 'subagents');
      if (dj['landed'] === 'time') outOfTime++;
      else if (dj['truncated'] === true) truncated++;
      turnsBy.set(e.actor, (turnsBy.get(e.actor) ?? 0) + t);
      costBy.set(e.actor, (costBy.get(e.actor) ?? 0) + c);
      // A shift whose waking fell before the window is not evidence of
      // anything — only a shift seen end to end can be called barren.
      if (open.has(e.actor) && !busy.has(e.actor)) barren++;
      open.delete(e.actor);
      busy.delete(e.actor);
      continue;
    }

    // A shift that failed still spent the window, and is the case the meter
    // exists for. It closes the shift without ever counting as productive.
    if (e.kind === 'agent.failed') {
      readMeter(e.actor, data(e));
      open.delete(e.actor);
      busy.delete(e.actor);
      continue;
    }

    // One broadcast is one row here and a message in twenty-two inboxes.
    if (e.kind === 'message.sent') deliveries += Math.max(1, numberOf(data(e), 'recipients'));
    if (e.kind === 'commons.posted' && e.subject) posted.push({ path: e.subject, at: e.at });
    busy.add(e.actor);
  }

  const woke = n('agent.woke');
  const failed = n('agent.failed');
  const overran = n('shift.overran');
  const costliest = Math.max(0, ...costBy.values());
  const shifts: ShiftVitals = {
    woke,
    slept,
    failed,
    overran,
    truncated,
    outOfTime,
    subagents,
    rotated: n('session.rotated'),
    rotateFailed: n('session.rotate_failed'),
    compacted: n('session.compacted'),
    turns,
    costUsd,
    costPerShift: over(costUsd, slept),
    turnsPerShift: over(turns, slept),
    // A shift stopped on the clock is trouble in the same way a failed one is:
    // it woke, held a slot, and produced nothing anyone asked for.
    troubleRate: over(failed + overran, woke),
    barren,
    costShareTop: over(costliest, costUsd),
  };

  /**
   * How long the company was actually working inside the window.
   *
   * `work.started` and `work.paused` bracket a scheduler that is running.
   * The state at `since` has to come from before the window, or a company
   * that had been running for a week reads as one that started when the
   * window opened — and if it never paused, `until` closes the last stretch.
   */
  const runningHours = (from: string, to: string): number => {
    const marks = d.ledger.eventsOfKinds(['work.started', 'work.paused'], from, to);
    const before = d.ledger.lastEvent(['work.started', 'work.paused'], from);
    let openedAt: number | null = before?.kind === 'work.started' ? Date.parse(from) : null;
    let ms = 0;
    for (const e of marks) {
      if (e.kind === 'work.started') { openedAt ??= Date.parse(e.at); continue; }
      if (openedAt != null) { ms += Date.parse(e.at) - openedAt; openedAt = null; }
    }
    if (openedAt != null) ms += Date.parse(to) - openedAt;
    return ms / 3_600_000;
  };

  const runHours = runningHours(since, until);
  const windowHours = window.days * 24;

  const totalTokens = tok.input + tok.output + tok.cacheRead + tok.cacheWrite;
  const allInput = tok.input + tok.cacheRead + tok.cacheWrite;
  const tokens: TokenVitals = {
    total: totalTokens,
    input: tok.input,
    output: tok.output,
    cacheRead: tok.cacheRead,
    cacheWrite: tok.cacheWrite,
    perShift: over(totalTokens, measured),
    cacheHitRate: over(tok.cacheRead, allInput),
    measured,
  };

  const run: RunVitals = {
    hours: Math.round(runHours * 100) / 100,
    dutyCycle: over(runHours, windowHours),
    shiftsPerHour: over(slept, runHours),
    tokensPerHour: over(totalTokens, runHours),
    costPerHour: over(costUsd, runHours),
  };

  /**
   * Whether the company can still do something it has not done.
   *
   * Everything else here rewards throughput, so a company shipping the
   * sixteenth point release of its first idea outscores one that launched
   * something. R7 exists to make that expensive; this is what says whether
   * it worked, and it has to be readable before the rule is judged.
   */
  const projects = d.world.listProjects();
  const perProject = projects.map((name) => ({
    name,
    commits: d.world.git.commitsTouching(`projects/${name}`, since, until),
    first: d.world.git.firstCommitAt(`projects/${name}`),
  }));
  const projectCommits = perProject.reduce((s, p) => s + p.commits, 0);
  const newest = perProject
    .filter((p) => p.first)
    .sort((a, b) => Date.parse(b.first!) - Date.parse(a.first!))[0];
  const novelty: NoveltyVitals = {
    carrying: projects.length,
    ceiling: d.portfolioCeiling ?? 0,
    // A project whose first commit lands inside the window was started in it.
    started: perProject.filter((p) => p.first && p.first >= since && p.first < until).length,
    retired: n('project.retired'),
    // In the company's own hours, never in calendar days.
    //
    // A company runs when the operator runs it: this one worked 21.4 hours
    // across a 30-day window. Ageing a project by the calendar charges it for
    // every week nobody switched the company on, so a team that was simply
    // paused would be told it had stopped having ideas. Running hours is the
    // only clock the staff are actually present for.
    newestAgeHours: newest?.first
      ? Math.round(runningHours(newest.first, until) * 10) / 10
      : null,
    concentration: over(Math.max(0, ...perProject.map((p) => p.commits)), projectCommits),
    touched: perProject.filter((p) => p.commits > 0).length,
  };

  const limits: LimitVitals = {
    latest: limitLatest,
    peak: limitPeak,
    type: limitType,
    seen: limitSeen,
    week: weekSeen ? { latest: weekLatest, peak: weekPeak } : null,
    fiveHour: fiveSeen ? { latest: fiveLatest, peak: fivePeak } : null,
    resets,
  };

  const gateRows = d.ledger.gateDecisions(since, until);
  const gateKind = (k: string): number =>
    gateRows.filter((r) => r.kind === k).reduce((s, r) => s + r.n, 0);

  // A posting adds a document when the shelf was not already holding it:
  // either it had never appeared at all, or it had been removed before this
  // posting put it back. Everything else is a rewrite of a page that was
  // already there, which is a company thinking rather than a company growing.
  const firstSeen = d.ledger.commonsHistory();
  const lastRemoved = d.ledger.commonsRemovals();
  const added = new Set(posted
    .filter((p) => {
      if ((firstSeen.get(p.path)?.created ?? '') >= since) return true;
      const gone = lastRemoved.get(p.path);
      return gone != null && gone < p.at;
    })
    .map((p) => p.path)).size;

  const removed = n('commons.removed');
  const commons: CommonsVitals = {
    held: d.world.commonsCount(),
    ceiling: d.commonsCeiling,
    posted: posted.length,
    added,
    revised: posted.length - added,
    removed,
    net: added - removed,
    refused: gateRows
      .filter((r) => r.rule === 'R6.commons_full')
      .reduce((s, r) => s + r.n, 0),
  };

  const approvals = d.ledger.approvalsBetween(since, until);
  const filed = approvals.filter((a) => a.requestedAt >= since && a.requestedAt < until);
  const decided = approvals.filter((a) => a.decidedAt != null && a.decidedAt >= since && a.decidedAt < until);
  // Still pending is a CURRENT state, not something that happened inside the
  // window. Reading it out of the window dropped exactly the drafts that had
  // waited longest — the ones this figure exists to surface — so the worse the
  // board's backlog got, the healthier the report claimed it was.
  const pending = d.ledger.listApprovals('pending');
  const envelope: EnvelopeVitals = {
    filed: filed.length,
    approved: decided.filter((a) => a.state === 'approved').length,
    rejected: decided.filter((a) => a.state === 'rejected').length,
    withdrawn: n('approval.withdrawn'),
    released: n('external.released'),
    pending: pending.length,
    oldestPendingHours: pending.length
      ? Math.max(...pending.map((a) => hoursBetween(a.requestedAt, until)))
      : null,
    medianDecisionHours: median(
      decided.map((a) => hoursBetween(a.requestedAt, a.decidedAt!)),
    ),
  };

  const tasks = d.ledger.listTasks();
  const done = n('task.done');
  const dropped = n('task.dropped');
  const work: WorkVitals = {
    opened: n('task.opened'),
    claimed: n('task.claimed'),
    done,
    dropped,
    blocked: n('task.blocked'),
    openNow: tasks.filter((t) => t.status !== 'done' && t.status !== 'dropped').length,
    completionRate: over(done, done + dropped),
  };

  // Git records the agent id in the author email and the display name beside
  // it. Key on the id: the display name is what a rename changes, and the
  // email domain has already changed once under a company that kept working
  // across the change, so the local part is the only stable half.
  const roster = d.ledger.listAgents(true);
  const ids = new Set(roster.map((a) => a.id));
  const names = new Map(roster.map((a) => [a.name, a.id]));

  const commits = d.world.git.since(since, until);
  const commitsBy = new Map<AgentId, number>();
  let unattributed = 0;
  for (const c of commits) {
    const local = c.email.split('@')[0] ?? '';
    const who = ids.has(local) ? local : names.get(c.author);
    if (who == null) { unattributed++; continue; }
    commitsBy.set(who, (commitsBy.get(who) ?? 0) + 1);
  }
  const byStaff = commits.length - unattributed;

  const messages = n('message.sent');
  const talk: TalkVitals = {
    messages,
    deliveries,
    broadcastFanout: over(deliveries, messages),
    notes: n('note.written'),
    memoryConsolidated: n('memory.consolidated'),
    commits: commits.length,
    byStaff,
    unattributed,
    perCommit: over(messages, byStaff),
    costPerCommit: over(costUsd, byStaff),
  };

  const spends = d.ledger.spendBetween(since, until);
  const money: MoneyVitals = {
    spends: spends.reduce((s, r) => s + r.n, 0),
    cents: spends.reduce((s, r) => s + r.cents, 0),
    exceptions: n('spend.exception'),
  };

  const people: PersonVitals[] = roster
    .map((a) => ({
      id: a.id,
      name: a.name,
      tier: a.tier,
      role: a.role,
      shifts: nOf(a.id, 'agent.slept'),
      turns: turnsBy.get(a.id) ?? 0,
      costUsd: costBy.get(a.id) ?? 0,
      tokens: tokensBy.get(a.id) ?? 0,
      commits: commitsBy.get(a.id) ?? 0,
      messages: nOf(a.id, 'message.sent'),
      posted: nOf(a.id, 'commons.posted'),
      filed: filed.filter((ap) => ap.requestedBy === a.id).length,
      done: nOf(a.id, 'task.done'),
      denied: nOf(a.id, 'gate.deny'),
    }))
    .filter((p) => p.shifts || p.commits || p.messages || p.posted || p.filed || p.done)
    .sort((x, y) => y.commits - x.commits || y.shifts - x.shifts);

  // Rule 6 bounds the shelf. Nothing bounds the payroll, and twenty-two
  // agents waking on a schedule is where the money actually goes — so the
  // accretion claim gets asked of the org chart too.
  const staff = d.ledger.listAgents().filter((a) => a.tier !== 'board');
  const byBoss = new Map<AgentId, number>();
  for (const a of staff) {
    if (a.reportsTo) byBoss.set(a.reportsTo, (byBoss.get(a.reportsTo) ?? 0) + 1);
  }
  const org: OrgVitals = {
    headcount: staff.length,
    hired: n('role.filled'),
    retired: n('role.retired'),
    net: n('role.filled') - n('role.retired'),
    orphans: staff.filter((a) => a.reportsTo && !d.ledger.getAgent(a.reportsTo)).length,
    depth: Math.max(0, ...staff.map(
      (a) => d.ledger.chainOfCommand(a.id).filter((x) => x.tier !== 'board').length)),
    widest: Math.max(0, ...byBoss.values()),
    shiftsPerHead: over(slept, staff.length),
  };

  // The window before this one, at the same length. Recursion stops after one
  // step because the inner call is given no window to compare against.
  const previous: Trend | null = compare
    ? trendOf(vitals(d, spec, Date.parse(since), false))
    : null;

  return {
    window,
    previous,
    shifts,
    run,
    novelty,
    tokens,
    limits,
    org,
    throttle: {
      rateLimited: n('company.rate_limited'),
      throttled: n('company.throttled'),
      usagePaused: n('company.usage_paused'),
    },
    commons,
    envelope,
    work,
    talk,
    money,
    gate: {
      allow: gateKind('allow'),
      deny: gateKind('deny'),
      escalate: gateKind('escalate'),
      // Refusals only, and cut server-side. Allows outnumber them by orders
      // of magnitude and sort to the head, so taking the top twenty overall
      // and dropping allows afterwards would have left the one section that
      // exists to show refusals with nothing in it.
      rules: gateRows.filter((r) => r.kind !== 'allow').slice(0, 20),
    },
    people,
  };
};
