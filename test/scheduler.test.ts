import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { selectDue } from '../src/runtime/scheduler.ts';
import { roundIsDue } from '../src/runtime/cadence.ts';
import type { Agent, AgentId, Tier } from '../src/core/types.ts';

const staff = (id: string, tier: Tier): Agent => ({
  id, name: id, tier, role: tier, department: '', reportsTo: 'ceo',
  status: 'active', activity: '', mandate: '',
  hiredAt: '2026-08-01T00:00:00.000Z', hiredBy: null, model: 'claude-opus-5',
});

/** One executive, three leads, six members — the shape that exposes the bug. */
const TEN: Agent[] = [
  staff('ceo', 'executive'),
  ...['lead1', 'lead2', 'lead3'].map((i) => staff(i, 'lead')),
  ...['m1', 'm2', 'm3', 'm4', 'm5', 'm6'].map((i) => staff(i, 'member')),
];

/**
 * Who gets picked when nobody has worked yet.
 *
 * `overdue` is `now - (nextDue ?? 0)`, so an agent the scheduler has never
 * seen is maximally overdue — and so is everybody else. That dead heat falls
 * through to rank and then to array order, which is hire order, and it
 * resolves the same way every time. With two slots and three staff the third
 * person is not picked at all.
 *
 * Measured on Lathe over 53 wakes: marlow 45.3%, idris 37.7%, rue 17.0%
 * against an even 33.3%. Rue was hired ten seconds after Idris.
 */
describe('a company that has just started has no rotation to go on', () => {
  const cold = (ids: string[], slots: number): string[] =>
    selectDue(ids.map((id, i) => staff(id, i === 0 ? 'executive' : 'lead')), {
      now: Date.now(), nextDue: new Map(), inFlight: new Set(), slots,
    }).map((a) => a.id);

  test('everyone unseen is exactly as overdue as everyone else', () => {
    // Which is the fault: it is not that the tie-break is wrong, it is that
    // there is a tie at all, every restart, forever.
    assert.deepEqual(cold(['marlow', 'idris', 'rue'], 3), ['marlow', 'idris', 'rue']);
  });

  test('so the last one hired is never reached when the slots run out', () => {
    assert.deepEqual(cold(['marlow', 'idris', 'rue'], 2), ['marlow', 'idris']);
  });
});

/**
 * The rotation is the company's, not the process's.
 *
 * A scheduler is built fresh on every restart, and this company is started,
 * bounded and rebuilt constantly — so almost every round it runs is a first
 * round. Seeding from the ledger is what makes the tie above stop happening.
 */
describe('the rotation survives the process that was running it', () => {
  test('the scheduler starts from when people last actually worked', () => {
    const src = readFileSync(new URL('../src/runtime/scheduler.ts', import.meta.url), 'utf8');
    assert.match(src, /for \(const \[id, at\] of d\.ledger\.lastWorked\(\)\) this\.#nextDue\.set\(id, at\);/);
    const ledger = readFileSync(new URL('../src/ledger/ledger.ts', import.meta.url), 'utf8');
    // A failed shift is still a turn taken. Counting only agent.slept would
    // send whoever just failed straight back to the front of the queue.
    assert.match(ledger, /kind IN \('agent\.slept','agent\.failed'\) GROUP BY actor/);
  });

  test('the jitter is rolled per wake, so it cannot become a ranking', () => {
    // `hash(a.id) % 30` never changed for a person: a permanent interval
    // multiplier spread across 34%, dressed as jitter. Idris drew 1.14 and
    // waited 29.1 minutes to Rue's 22.2 on the same tier, every time.
    const src = readFileSync(new URL('../src/runtime/scheduler.ts', import.meta.url), 'utf8');
    assert.match(src, /const jitter = 0\.85 \+ Math\.random\(\) \* 0\.3;/);
    assert.doesNotMatch(src, /^const hash = /m,
      'the per-agent hash is gone, not merely unused');
  });
});

describe('ten staff and three slots: everybody works', () => {
  test('nobody is starved over a long run of contested rounds', () => {
    // Rank used to decide this, and rank already decides how often each
    // person comes due. Spent twice, the same seniors won every contest and
    // a member could be due, passed over, and still due, indefinitely.
    const nextDue = new Map<AgentId, number>();
    const shifts = new Map<AgentId, number>(TEN.map((a) => [a.id, 0]));
    // Seniors legitimately come due more often; that is #intervalFor's job.
    const gap = (a: Agent) => (a.tier === 'executive' ? 2 : a.tier === 'lead' ? 3 : 4);

    // Demand must exceed supply or the test proves nothing: ten staff on those
    // gaps want ~4.4 slots a round and there are 2. Under real contention,
    // sorting by rank starves the bottom of the roster.
    let now = 0;
    for (let round = 0; round < 300; round++) {
      now += 1;
      for (const a of selectDue(TEN, { now, nextDue, inFlight: new Set(), slots: 2 })) {
        shifts.set(a.id, shifts.get(a.id)! + 1);
        nextDue.set(a.id, now + gap(a));
      }
    }

    const counts = [...shifts.values()];
    assert.ok(Math.min(...counts) > 0, `somebody never worked: ${JSON.stringify([...shifts])}`);
    // Seniors do run more often — but not to the exclusion of anyone.
    const ceo = shifts.get('ceo')!, worst = Math.min(...counts);
    assert.ok(ceo / worst < 4, `the CEO ran ${ceo} to somebody's ${worst}; that is starvation`);
  });

  test('the longest wait is served first', () => {
    const nextDue = new Map<AgentId, number>([
      ['ceo', 90],      // due 10 ago
      ['lead1', 50],    // due 50 ago
      ['m1', 10],       // due 90 ago — waited longest
      ['m2', 95],       // due 5 ago
    ]);
    const picked = selectDue(TEN.filter((a) => nextDue.has(a.id)),
      { now: 100, nextDue, inFlight: new Set(), slots: 2 }).map((a) => a.id);
    assert.deepEqual(picked, ['m1', 'lead1'], 'lateness decides, not rank');
  });

  test('rank breaks the tie, so a fresh company is deterministic', () => {
    // Nobody has run: everyone is equally overdue. Order must not be arbitrary.
    const picked = selectDue(TEN, { now: 1, nextDue: new Map(), inFlight: new Set(), slots: 3 })
      .map((a) => a.id);
    assert.deepEqual(picked, ['ceo', 'lead1', 'lead2']);
  });

  test('nobody in flight is woken twice, and the board never works', () => {
    const inFlight = new Set<AgentId>(['ceo', 'lead1']);
    const picked = selectDue([...TEN, staff('cali', 'board')],
      { now: 1, nextDue: new Map(), inFlight, slots: 3 }).map((a) => a.id);
    assert.ok(!picked.includes('ceo') && !picked.includes('lead1'));
    assert.ok(!picked.includes('cali'), 'the board is not staff');
  });

  test('no slots means no wakeups, not a negative slice', () => {
    assert.deepEqual(selectDue(TEN, { now: 1, nextDue: new Map(), inFlight: new Set(), slots: -2 }), []);
  });
});

describe('the interval paces the company, not one person at a time', () => {
  /**
   * Replay an hour of the loop's gating, in minutes.
   *
   * Only what decides WHEN work starts: the company gate, selectDue, and each
   * agent's own next-due. Shift length is fixed rather than modelled — the
   * question is how much of the hour the company is working, and a real run
   * answered 100% of it.
   */
  const run = (opts: { minutes: number; interval: number; slots: number; shift: number }) => {
    const nextDue = new Map<AgentId, number>();
    const busyUntil = new Map<AgentId, number>();
    let lastRound = 0;
    let started = 0;
    let workingMinutes = 0;

    for (let now = 1; now <= opts.minutes; now++) {
      const inFlight = new Set([...busyUntil].filter(([, until]) => until > now).map(([id]) => id));
      if (inFlight.size) workingMinutes++;
      if (!roundIsDue(now, lastRound, opts.interval)) continue;

      const slots = opts.slots - inFlight.size;
      const due = selectDue(TEN.slice(0, 4), { now, nextDue, inFlight, slots });
      if (due.length || slots <= 0) lastRound = now;
      if (!due.length) continue;
      for (const a of due) {
        started++;
        busyUntil.set(a.id, now + opts.shift);
        // Rank still staggers an individual; it no longer sets the rate.
        nextDue.set(a.id, now + opts.interval);
      }
    }
    return { started, workingMinutes };
  };

  test('four staff on a fifteen-minute interval do not work the whole hour', () => {
    // The bug this exists for: the gap applied to each person, so with four on
    // the roster somebody was always due. A real 70-minute run logged 69.9
    // minutes of shifts.
    const { started, workingMinutes } = run({ minutes: 60, interval: 15, slots: 2, shift: 4 });
    assert.ok(started <= 8, `at most one round of 2 every 15 minutes, got ${started} shifts`);
    assert.ok(workingMinutes < 40, `the company should rest; it worked ${workingMinutes} of 60 minutes`);
  });

  test('concurrency sets how many wake together, not how often', () => {
    const one = run({ minutes: 60, interval: 15, slots: 1, shift: 4 });
    const two = run({ minutes: 60, interval: 15, slots: 2, shift: 4 });
    assert.ok(two.started > one.started, 'two slots should do more work per round');
    // Rounds are gated the same either way — more hands, not more often.
    assert.ok(two.started <= one.started * 2 + 1,
      `two slots must not start more than twice the rounds: ${one.started} vs ${two.started}`);
  });

  test('shifts longer than the interval do not turn into continuous work', () => {
    // The hole in the first version of this gate. Every round found both slots
    // busy, so the clock never advanced, so each finishing shift was replaced
    // the instant it ended — the same 100% duty cycle, reached from the other
    // side. A busy round has to count as a round.
    const { started, workingMinutes } = run({ minutes: 60, interval: 15, slots: 2, shift: 25 });
    assert.ok(workingMinutes < 55, `the company still never rested: ${workingMinutes} of 60 minutes`);
    assert.ok(started <= 6, `long shifts must not multiply rounds, got ${started}`);
  });

  test('a throttled company starts its rounds further apart', () => {
    // Throttling stretches the company cadence for the same reason it stretches
    // an individual's: pacing against a filling window means fewer rounds, not
    // the same number staggered differently.
    assert.equal(roundIsDue(10 * 60_000, 0, 10 * 60_000, 1), true);
    assert.equal(roundIsDue(10 * 60_000, 0, 10 * 60_000, 3), false);
    assert.equal(roundIsDue(30 * 60_000, 0, 10 * 60_000, 3), true);
  });

  test('the first round fires at once rather than waiting out an interval', () => {
    // lastRound starts at zero, so starting a company does not buy silence —
    // the operator who pressed Start should see a shift, not a quarter hour of
    // nothing. Any real clock is further from zero than any interval.
    assert.ok(roundIsDue(Date.now(), 0, 15 * 60_000), 'a fresh company works immediately');
    // And the round after it waits the full interval.
    const t0 = Date.now();
    assert.equal(roundIsDue(t0 + 60_000, t0, 15 * 60_000), false);
    assert.equal(roundIsDue(t0 + 15 * 60_000, t0, 15 * 60_000), true);
  });
});
