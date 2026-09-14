import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ledger } from '../src/ledger/ledger.ts';
import { World } from '../src/worldfs/world.ts';
import { fixedClock } from '../src/core/clock.ts';
import { parseWindow, vitals } from '../src/analytics/vitals.ts';
import type { Agent, Tier } from '../src/core/types.ts';

const NOW = '2026-08-25T12:00:00.000Z';

const agent = (id: string, tier: Tier, reportsTo: string | null = 'ceo'): Agent => ({
  id, name: id[0]!.toUpperCase() + id.slice(1), tier, role: tier,
  department: '', reportsTo, status: 'active', activity: '', mandate: '',
  hiredAt: '2026-08-01T00:00:00.000Z', hiredBy: null, model: 'claude-opus-5',
});

let clock: ReturnType<typeof fixedClock>;
let ledger: Ledger;
let world: World;
let root: string;

/**
 * A whole shift, at the clock's current time: woke, did those things, slept.
 * Each thing is `[kind, subject, data]` in the order `emit` takes them — the
 * subject is not decoration, it is how a posting is told from a rewrite.
 */
const shift = (
  who: string, did: Array<[string, (string | null)?, unknown?]>, turns = 4, costUsd = 0.1,
  meter: Record<string, number | string> = {},
): void => {
  ledger.emit(who, 'agent.woke', null, { resumed: false });
  for (const [kind, subject, data] of did) ledger.emit(who, kind, subject ?? null, data);
  ledger.emit(who, 'agent.slept', null, { turns, costUsd, ...meter });
};

/** What staff.ts writes onto a shift that reported usage. */
const meter = (
  tokensIn: number, tokensOut: number, cacheRead = 0, cacheWrite = 0,
): Record<string, number> => ({
  tokens: tokensIn + tokensOut + cacheRead + cacheWrite,
  tokensIn, tokensOut, cacheRead, cacheWrite,
});

/**
 * The window is half-open — `[since, until)` — so that a figure and the same
 * figure a window earlier cannot both claim an event on the seam. A frozen
 * clock stamps the work and the report with the same instant, which real time
 * never does, so the report is taken a tick after the work.
 */
const report = (spec = '7.days') => {
  clock.advance(1);
  return vitals({ ledger, world, clock, commonsCeiling: 40 }, spec);
};

beforeEach(() => {
  clock = fixedClock(NOW);
  root = mkdtempSync(join(tmpdir(), 'riff-vitals-'));
  ledger = new Ledger(':memory:', clock);
  world = new World(root, clock);
  world.ensure();
  ledger.upsertAgent(agent('chair', 'board', null));
  ledger.upsertAgent(agent('ceo', 'executive', 'chair'));
  ledger.upsertAgent(agent('rae', 'lead'));
  ledger.upsertAgent(agent('vim', 'member', 'rae'));
});

const cleanup = () => rmSync(root, { recursive: true, force: true });

describe('the window', () => {
  test('a window is bounded at both ends, so a previous one is expressible', () => {
    const w = parseWindow('7.days', Date.parse(NOW));
    assert.equal(w.until, NOW);
    assert.equal(w.since, '2026-08-18T12:00:00.000Z');
    assert.equal(w.days, 7);
  });

  test('the spellings people actually type all parse', () => {
    const at = Date.parse(NOW);
    assert.equal(parseWindow('24.hours', at).days, 1);
    assert.equal(parseWindow('2 weeks', at).days, 14);
    assert.equal(parseWindow('1.month', at).days, 30);
  });

  test('a window nobody can parse is a week, not a crash', () => {
    const w = parseWindow('since the dawn of time', Date.parse(NOW));
    assert.equal(w.days, 7);
    assert.equal(w.spec, '7.days');
  });

  test('a zero-length window is a typo, and is labelled as the week it read', () => {
    const w = parseWindow('0.days', Date.parse(NOW));
    assert.equal(w.days, 7);
    assert.equal(w.spec, '7.days');
  });

  test('nothing outside the window is counted', () => {
    clock.set('2026-08-01T09:00:00.000Z');       // three weeks before NOW
    shift('rae', [['commons.posted', 'commons/a.md']]);
    clock.set(NOW);
    assert.equal(report('7.days').commons.posted, 0);
    assert.equal(report('30.days').commons.posted, 1);
    cleanup();
  });
});

describe('shifts', () => {
  test('turns and dollars come off the sleeping event, the only place they are written', () => {
    shift('rae', [['commons.posted']], 6, 0.25);
    shift('vim', [['message.sent', null, { recipients: 1 }]], 4, 0.15);
    const v = report();
    assert.equal(v.shifts.slept, 2);
    assert.equal(v.shifts.turns, 10);
    assert.equal(Number(v.shifts.costUsd.toFixed(2)), 0.4);
    assert.equal(Number(v.shifts.costPerShift.toFixed(2)), 0.2);
    cleanup();
  });

  test('a shift that woke, spent and left nothing behind is barren', () => {
    shift('rae', [['commons.posted', 'commons/a.md']]);
    shift('vim', []);
    const v = report();
    assert.equal(v.shifts.barren, 1);
    cleanup();
  });

  // Reading the company is not producing anything, and an agent that only
  // ever reads is the expensive failure this figure exists to name.
  test('a shift that only made the gate allow reads is still barren', () => {
    shift('vim', [['gate.allow', null, { rule: 'transparency.read_is_loud' }]]);
    assert.equal(report().shifts.barren, 1);
    cleanup();
  });

  test('a shift whose waking fell before the window is not called barren', () => {
    clock.set('2026-08-10T09:00:00.000Z');
    ledger.emit('vim', 'agent.woke', null, {});
    clock.set(NOW);
    ledger.emit('vim', 'agent.slept', null, { turns: 3, costUsd: 0.1 });
    const v = report();
    assert.equal(v.shifts.slept, 1);
    assert.equal(v.shifts.barren, 0);
    cleanup();
  });

  test('failed and overran shifts are the loop failing, and get their own rate', () => {
    shift('rae', [['commons.posted', 'commons/a.md']]);
    ledger.emit('vim', 'agent.woke', null, {});
    ledger.emit('vim', 'shift.overran', null, {});
    ledger.emit('vim', 'agent.failed', null, { error: 'nope' });
    const v = report();
    assert.equal(v.shifts.overran, 1);
    assert.equal(v.shifts.failed, 1);
    assert.equal(v.shifts.troubleRate, 1);       // 2 of 2 wakings went wrong
    cleanup();
  });

  test('one agent burning most of the bill shows, where a total hides it', () => {
    shift('rae', [['commons.posted', 'commons/a.md']], 4, 0.90);
    shift('vim', [['message.sent']], 4, 0.10);
    assert.equal(report().shifts.costShareTop, 0.9);
    cleanup();
  });

  test('an empty window reports zero rather than NaN', () => {
    const v = report();
    assert.equal(v.shifts.costPerShift, 0);
    assert.equal(v.shifts.troubleRate, 0);
    assert.equal(v.talk.perCommit, 0);
    assert.equal(v.work.completionRate, 0);
    cleanup();
  });
});

describe('rule 6 — what the commons claim can be checked against', () => {
  test('additions and removals are counted apart, and the difference is the accretion', () => {
    ledger.emit('rae', 'commons.posted', 'commons/a.md', {});
    ledger.emit('rae', 'commons.posted', 'commons/b.md', {});
    ledger.emit('rae', 'commons.removed', 'commons/c.md', {});
    const v = report();
    assert.equal(v.commons.added, 2);
    assert.equal(v.commons.removed, 1);
    assert.equal(v.commons.net, 1);
    cleanup();
  });

  // A company that rewrites the same page all week is thinking, not growing.
  // Counting every posting as growth reported accretion on a shelf whose
  // contents had not changed — the figure disagreed with what it held.
  test('rewriting a page that already existed is a revision, not growth', () => {
    clock.set('2026-08-01T09:00:00.000Z');
    ledger.emit('rae', 'commons.posted', 'commons/doctrine.md', {});   // before the window
    clock.set(NOW);
    ledger.emit('rae', 'commons.posted', 'commons/doctrine.md', {});
    ledger.emit('rae', 'commons.posted', 'commons/doctrine.md', {});
    ledger.emit('rae', 'commons.posted', 'commons/new.md', {});
    const v = report('7.days');
    assert.equal(v.commons.posted, 3);
    assert.equal(v.commons.added, 1);
    assert.equal(v.commons.revised, 2);
    assert.equal(v.commons.net, 1);
    cleanup();
  });

  // Remove one to add one is the act Rule 6 exists to encourage. Reading the
  // first appearance over all of history called the return a rewrite, so the
  // one company doing the right thing scored as though it had done nothing.
  test('a page taken off the shelf and put back is an addition, not a rewrite', () => {
    clock.set('2026-08-01T09:00:00.000Z');
    ledger.emit('rae', 'commons.posted', 'commons/doctrine.md', {});
    clock.set('2026-08-05T09:00:00.000Z');
    ledger.emit('rae', 'commons.removed', 'commons/doctrine.md', {});
    clock.set(NOW);
    ledger.emit('rae', 'commons.posted', 'commons/doctrine.md', {});
    const v = report('7.days');
    assert.equal(v.commons.added, 1);
    assert.equal(v.commons.revised, 0);
    cleanup();
  });

  test('a page removed AFTER its last posting stays a rewrite, not an addition', () => {
    clock.set('2026-08-01T09:00:00.000Z');
    ledger.emit('rae', 'commons.posted', 'commons/doctrine.md', {});
    clock.set(NOW);
    ledger.emit('rae', 'commons.posted', 'commons/doctrine.md', {});
    ledger.emit('rae', 'commons.removed', 'commons/doctrine.md', {});
    const v = report('7.days');
    assert.equal(v.commons.added, 0);
    assert.equal(v.commons.revised, 1);
    cleanup();
  });

  test('a page posted twice inside one window is one addition, not two', () => {
    ledger.emit('rae', 'commons.posted', 'commons/a.md', {});
    ledger.emit('rae', 'commons.posted', 'commons/a.md', {});
    const v = report();
    assert.equal(v.commons.posted, 2);
    assert.equal(v.commons.added, 1);
    cleanup();
  });

  test('a ceiling that never refused anything is untested, not proven', () => {
    shift('rae', [['commons.posted', 'commons/a.md']]);
    assert.equal(report().commons.refused, 0);
    cleanup();
  });

  test('the refusals that cite the ceiling are the ones that count', () => {
    ledger.emit('rae', 'gate.deny', 'commons/x.md', { rule: 'R6.commons_full', capability: 'commons.write' });
    ledger.emit('rae', 'gate.deny', null, { rule: 'R4.not_treasurer', capability: 'spend' });
    const v = report();
    assert.equal(v.commons.refused, 1);
    assert.equal(v.gate.deny, 2);
    cleanup();
  });
});

describe('the gate', () => {
  // Allows outnumber refusals by orders of magnitude and sort to the head of
  // the same list. Taking the top twenty overall and dropping allows in the
  // console would have left the one section that exists to show refusals
  // showing nothing at all, on exactly the busy company that needed it.
  test('the listed rules are refusals, however many allows are ahead of them', () => {
    for (let i = 0; i < 40; i++) {
      for (let j = 0; j <= i; j++) {
        ledger.emit('rae', 'gate.allow', null, { rule: `R2.autonomy`, capability: `cap${i}` });
      }
    }
    ledger.emit('rae', 'gate.deny', null, { rule: 'R4.not_treasurer', capability: 'spend' });
    const v = report();

    assert.equal(v.gate.allow, 820);
    assert.equal(v.gate.deny, 1);
    assert.equal(v.gate.rules.every((r) => r.kind !== 'allow'), true);
    assert.equal(v.gate.rules.some((r) => r.rule === 'R4.not_treasurer'), true);
    cleanup();
  });
});

describe('the org chart — the same claim, asked of the payroll', () => {
  test('hires and retirements net out, and the board is not headcount', () => {
    shift('ceo', [['role.filled'], ['role.filled'], ['role.retired']]);
    const v = report();
    assert.equal(v.org.hired, 2);
    assert.equal(v.org.retired, 1);
    assert.equal(v.org.net, 1);
    assert.equal(v.org.headcount, 3);            // ceo, rae, vim — not chair
    cleanup();
  });

  test('depth and the widest span come off the reporting lines', () => {
    const v = report();
    assert.equal(v.org.depth, 3);                // vim → rae → ceo, and the board is not a layer
    assert.equal(v.org.widest, 1);
    cleanup();
  });

  // The schema's foreign key stops anyone writing this deliberately, so the
  // only way it occurs is the way it occurred in the field: a rename that
  // moved a row and left its reports pointing at the name that used to exist.
  test('a reporting line pointing at nobody is counted, not ignored', () => {
    ledger.upsertAgent(agent('kit', 'member', 'rae'));
    ledger.db.exec('PRAGMA foreign_keys = OFF');
    ledger.db.exec("UPDATE agents SET id='raewood' WHERE id='rae'");
    ledger.db.exec('PRAGMA foreign_keys = ON');
    assert.equal(report().org.orphans, 2);       // kit and vim both reported to rae
    cleanup();
  });
});

describe('who a commit belongs to', () => {
  // The world is a real git repo here: attribution reads what git recorded,
  // and a fake would prove only that the fake agrees with itself.
  //
  // Git stamps a commit from the system clock, which the frozen clock cannot
  // move. So these tests run the ledger at real time too, and the two halves
  // of the window agree again.
  beforeEach(() => {
    clock.set(new Date());
    world.git.init();
  });

  /**
   * Re-sync before reading. Shelling out to git takes real milliseconds, so a
   * clock frozen when the test started closes the window BEFORE the commits
   * the test just made — which failed about one run in four.
   */
  const readBack = () => { clock.set(new Date()); return report(); };
  const commit = (as: { id: string; name: string }, file: string) => {
    world.writeCommons(file, { title: file, author: as.id, updated: clock.iso() }, '# x\n');
    world.git.commitAs(as, `${as.id}: ${file}`);
  };

  test('a commit is attributed by the id in the author email, not the display name', () => {
    commit({ id: 'rae', name: 'Rae' }, 'one.md');
    const v = readBack();
    assert.equal(v.talk.byStaff, 1);
    assert.equal(v.people.find((p) => p.id === 'rae')?.commits, 1);
    cleanup();
  });

  // The email domain has already changed once under a running company, and
  // display names get renamed. The local part is the only stable half.
  test('the same person under a different email domain is still that person', () => {
    commit({ id: 'rae', name: 'Rae' }, 'one.md');
    world.writeCommons('two.md', { title: 'two', author: 'rae', updated: clock.iso() }, '# y\n');
    world.git.commitAs({ id: 'rae', name: 'Rae Renamed' }, 'rae: two');
    assert.equal(readBack().people.find((p) => p.id === 'rae')?.commits, 2);
    cleanup();
  });

  test('the harness commits to the world too, and is not staff', () => {
    commit({ id: 'rae', name: 'Rae' }, 'one.md');
    const v = readBack();
    assert.equal(v.talk.unattributed >= 1, true);
    assert.equal(v.talk.byStaff, 1);
    assert.equal(v.talk.commits, v.talk.byStaff + v.talk.unattributed);
    cleanup();
  });

  // Diluting the denominator with the harness's own commits flatters every
  // ratio built on it, which is how a company looks cheaper than it is.
  test('cost and mail are measured against real work, not against every commit', () => {
    shift('rae', [['message.sent'], ['message.sent']], 4, 1.0);
    commit({ id: 'rae', name: 'Rae' }, 'one.md');
    const v = readBack();
    assert.equal(v.talk.byStaff, 1);
    assert.equal(v.talk.perCommit, 2);             // 2 messages ÷ 1 real commit
    assert.equal(v.talk.costPerCommit, 1.0);
    cleanup();
  });
});

describe('talk against work', () => {
  test('a broadcast is one message and as many deliveries as it reached', () => {
    shift('rae', [['message.sent', null, { recipients: 22 }], ['message.sent', null, { recipients: 1 }]]);
    const v = report();
    assert.equal(v.talk.messages, 2);
    assert.equal(v.talk.deliveries, 23);
    assert.equal(v.talk.broadcastFanout, 11.5);
    cleanup();
  });

  test('a message whose payload lost its recipient count still delivered once', () => {
    shift('rae', [['message.sent']]);
    assert.equal(report().talk.deliveries, 1);
    cleanup();
  });
});

describe('the envelope', () => {
  test('a draft waiting on the board carries how long it has waited', () => {
    clock.set('2026-08-24T12:00:00.000Z');
    ledger.createApproval({
      requestedBy: 'rae', capability: 'external.write', tier: 'board',
      summary: 'publish the launch post', target: null,
    });
    clock.set(NOW);
    const v = report();
    assert.equal(v.envelope.filed, 1);
    assert.equal(v.envelope.pending, 1);
    // Not exactly 24: the report is taken a tick after the draft was filed.
    assert.ok(Math.abs(v.envelope.oldestPendingHours! - 24) < 0.01);
    assert.equal(v.envelope.medianDecisionHours, null);
    cleanup();
  });

  // A draft filed before the window and still undecided has neither a
  // requested_at nor a decided_at inside it, so a window-scoped read cannot
  // see it — and the longer the board leaves it, the more certain it is to
  // vanish from the very figure that exists to report exactly that.
  test('the oldest draft on the board is visible however long ago it was filed', () => {
    clock.set('2026-08-01T12:00:00.000Z');        // three weeks before NOW
    ledger.createApproval({
      requestedBy: 'rae', capability: 'external.write', tier: 'board',
      summary: 'the one nobody has answered', target: null,
    });
    clock.set(NOW);
    const v = report('7.days');
    assert.equal(v.envelope.pending, 1);
    assert.ok((v.envelope.oldestPendingHours ?? 0) > 500);
    cleanup();
  });

  test('decision latency is measured from filing to ruling, not from now', () => {
    clock.set('2026-08-24T12:00:00.000Z');
    const a = ledger.createApproval({
      requestedBy: 'rae', capability: 'external.write', tier: 'board',
      summary: 'ship it', target: null,
    });
    clock.set('2026-08-24T18:00:00.000Z');
    ledger.decideApproval(a.id, 'chair', true, 'go');
    clock.set(NOW);
    const v = report();
    assert.equal(v.envelope.approved, 1);
    assert.equal(v.envelope.medianDecisionHours, 6);
    cleanup();
  });
});

describe('the window before this one', () => {
  test('every figure comes with the same figure from the window before it', () => {
    clock.set('2026-08-12T09:00:00.000Z');        // inside the previous 7 days
    shift('rae', [['commons.posted', 'commons/a.md'], ['commons.posted', 'commons/b.md']], 4, 0.50);
    clock.set('2026-08-24T09:00:00.000Z');        // inside this one
    shift('rae', [['commons.posted', 'commons/b.md']], 4, 0.20);
    clock.set(NOW);

    const v = report('7.days');
    assert.equal(v.commons.posted, 1);
    assert.equal(v.previous?.posted, 2);
    assert.equal(v.previous?.shifts, 1);
    assert.equal(Number(v.previous?.costUsd.toFixed(2)), 0.5);
    cleanup();
  });

  test('the comparison stops after one step rather than walking back forever', () => {
    shift('rae', [['commons.posted', 'commons/a.md']]);
    const v = report();
    assert.equal(v.previous !== null, true);
    // `previous` is a flat set of scalars, so there is nowhere for a second
    // comparison to hide even if the recursion were ever to run twice.
    assert.equal(Object.values(v.previous!).every((x) => typeof x === 'number'), true);
    cleanup();
  });
});

describe('who did the work', () => {
  test('somebody who did nothing at all is left out of the table entirely', () => {
    shift('rae', [['commons.posted', 'commons/a.md']]);
    const v = report();
    assert.deepEqual(v.people.map((p) => p.id), ['rae']);
    assert.equal(v.people[0]?.posted, 1);
    assert.equal(v.people[0]?.shifts, 1);
    cleanup();
  });

  test('gate refusals are attributed to the person who ran into them', () => {
    shift('vim', [['message.sent']]);
    ledger.emit('vim', 'gate.deny', null, { rule: 'R4.not_treasurer', capability: 'spend' });
    const v = report();
    assert.equal(v.people.find((p) => p.id === 'vim')?.denied, 1);
    cleanup();
  });
});

/**
 * The company runs on a subscription. `costUsd` is the SDK's imputed list
 * price and nobody is billed it; tokens and the rate-limit window are the
 * resources that genuinely run out, so they are counted in their own right.
 */
describe('what the company consumed', () => {
  test('tokens are counted apart from the dollars nobody is billed', () => {
    shift('rae', [['commons.posted', 'commons/a.md']], 4, 0.5, meter(1_000, 500, 8_000, 2_000));
    const v = report();
    assert.equal(v.tokens.total, 11_500);
    assert.equal(v.tokens.input, 1_000);
    assert.equal(v.tokens.output, 500);
    assert.equal(v.tokens.cacheRead, 8_000);
    assert.equal(v.tokens.cacheWrite, 2_000);
    // The dollar figure is still reported; it is simply a different claim.
    assert.equal(v.shifts.costUsd, 0.5);
    cleanup();
  });

  test('a shift that never reported usage is a gap, not a zero', () => {
    shift('rae', [['message.sent']], 4, 0.1, meter(1_000, 1_000));
    shift('vim', [['message.sent']]);
    const v = report();
    assert.equal(v.shifts.slept, 2);
    // Averaging 2,000 over both shifts would report half of what the one
    // measured shift actually consumed.
    assert.equal(v.tokens.measured, 1);
    assert.equal(v.tokens.perShift, 2_000);
    cleanup();
  });

  test('a company with no usage reported anywhere says so rather than zero', () => {
    shift('rae', [['message.sent']]);
    const v = report();
    assert.equal(v.tokens.measured, 0);
    assert.equal(v.tokens.total, 0);
    assert.equal(v.limits.seen, 0);
    cleanup();
  });

  test('cached input is told from fresh, because only one of them is paid twice', () => {
    shift('rae', [['message.sent']], 4, 0.1, meter(1_000, 0, 3_000, 0));
    const v = report();
    // 3,000 cached against 4,000 of input in total.
    assert.equal(v.tokens.cacheHitRate, 0.75);
    cleanup();
  });

  test('a failed shift still spent the window, and is counted for it', () => {
    ledger.emit('rae', 'agent.woke', null, { resumed: false });
    ledger.emit('rae', 'agent.failed', null, { error: 'boom', ...meter(5_000, 100) });
    const v = report();
    assert.equal(v.shifts.failed, 1);
    assert.equal(v.tokens.total, 5_100);
    // It failed. It must not read as a shift that produced anything.
    assert.equal(v.shifts.slept, 0);
    cleanup();
  });

  test('the weekly window is reported apart from the five-hour one', () => {
    // The figure an operator plans around. A five-hour window at 99% is back
    // within the afternoon; a weekly at 60% governs the rest of the week, and
    // collapsing them into one number loses exactly that distinction.
    shift('rae', [['message.sent']], 4, 0.1, {
      ...meter(100, 100),
      utilization: 0.99, limitType: 'five_hour', weekUtilization: 0.6,
    });
    const v = report();
    assert.equal(v.limits.latest, 0.99);
    assert.equal(v.limits.type, 'five_hour');
    assert.deepEqual(v.limits.week, { latest: 0.6, peak: 0.6 });
    cleanup();
  });

  test('the five-hour window is reported even when the week is the tighter one', () => {
    // It used to be visible only when it was the binding window, so the
    // reading that says whether the operator can work this afternoon vanished
    // from the record exactly as the week filled up.
    shift('rae', [['message.sent']], 4, 0.1, {
      ...meter(100, 100),
      utilization: 0.8, limitType: 'seven_day', weekUtilization: 0.8,
      used_five_hour: 0.12, used_seven_day: 0.8,
    });
    const v = report();
    assert.deepEqual(v.limits.fiveHour, { latest: 0.12, peak: 0.12 });
    assert.deepEqual(v.limits.week, { latest: 0.8, peak: 0.8 });
    cleanup();
  });

  test('the five-hour window keeps its own peak, not the tightest window\'s', () => {
    shift('rae', [['message.sent']], 4, 0.1,
      { ...meter(100, 100), used_five_hour: 0.9, weekUtilization: 0.3, utilization: 0.9 });
    shift('rae', [['message.sent']], 4, 0.1,
      { ...meter(100, 100), used_five_hour: 0.2, weekUtilization: 0.31, utilization: 0.31 });
    const v = report();
    assert.deepEqual(v.limits.fiveHour, { latest: 0.2, peak: 0.9 });
    cleanup();
  });

  test('a reset stamp is carried through so the report can say when it comes back', () => {
    shift('rae', [['message.sent']], 4, 0.1, {
      ...meter(100, 100), used_five_hour: 0.4, resets_five_hour: 1_800_000_000,
    });
    const v = report();
    assert.equal(v.limits.resets['five_hour'], 1_800_000_000);
    cleanup();
  });

  test('shifts from before the per-window record contribute no five-hour reading', () => {
    // 0% would read as a window with everything still to spend.
    shift('rae', [['message.sent']], 4, 0.1,
      { ...meter(100, 100), utilization: 0.5, limitType: 'five_hour' });
    const v = report();
    assert.equal(v.limits.fiveHour, null);
    assert.deepEqual(v.limits.resets, {});
    cleanup();
  });

  test('a company that never heard a weekly reading says so rather than zero', () => {
    shift('rae', [['message.sent']], 4, 0.1,
      { ...meter(100, 100), utilization: 0.5, limitType: 'five_hour' });
    const v = report();
    assert.equal(v.limits.seen, 1);
    // 0% weekly would read as a fresh week with everything still to spend.
    assert.equal(v.limits.week, null);
    cleanup();
  });

  test('the subscription window reports where it stands and how close it came', () => {
    shift('rae', [['message.sent']], 4, 0.1,
      { ...meter(100, 100), utilization: 0.9, limitType: 'five_hour' });
    shift('rae', [['message.sent']], 4, 0.1,
      { ...meter(100, 100), utilization: 0.4, limitType: 'five_hour' });
    const v = report();
    // Latest is what is left now; peak is how close the company has come.
    assert.equal(v.limits.latest, 0.4);
    assert.equal(v.limits.peak, 0.9);
    assert.equal(v.limits.type, 'five_hour');
    assert.equal(v.limits.seen, 2);
    cleanup();
  });

  test('tokens are attributed to the person who spent them', () => {
    shift('rae', [['message.sent']], 4, 0.1, meter(9_000, 1_000));
    shift('vim', [['message.sent']], 4, 0.1, meter(400, 100));
    const v = report();
    assert.equal(v.people.find((p) => p.id === 'rae')?.tokens, 10_000);
    assert.equal(v.people.find((p) => p.id === 'vim')?.tokens, 500);
    cleanup();
  });

  test('consumption is a trend, so a heavier week can be seen as one', () => {
    shift('rae', [['message.sent']], 4, 0.1, meter(1_000, 1_000));
    const v = report();
    assert.equal(v.previous?.tokens, 0);
    assert.equal(v.tokens.total, 2_000);
    cleanup();
  });
});

/**
 * A window is wall clock; a company only exists while its scheduler is up.
 * The first real measurement was 21.4 running hours inside a 30-day window —
 * a 3% duty cycle — which makes every per-day rate read off that window wrong
 * by a factor of thirty-three.
 */
describe('how much of the window the company actually worked', () => {
  test('running time is the stretches between starting and pausing', () => {
    ledger.emit('company', 'work.started', null, {});
    clock.advance(2 * 3_600_000);
    ledger.emit('company', 'work.paused', null, {});
    clock.advance(20 * 3_600_000);   // idle, and not counted
    ledger.emit('company', 'work.started', null, {});
    clock.advance(1 * 3_600_000);
    ledger.emit('company', 'work.paused', null, {});
    const v = report();
    assert.equal(v.run.hours, 3);
    cleanup();
  });

  test('a company still running when the window closes is counted to the edge', () => {
    ledger.emit('company', 'work.started', null, {});
    clock.advance(4 * 3_600_000);
    // No pause: it is still working. Dropping the open stretch would report
    // a company that has run all day as one that never started.
    const v = report();
    assert.equal(v.run.hours, 4);
    cleanup();
  });

  test('a company already running when the window opens is not credited from zero', () => {
    // Started well before the window. Counting only events inside it reads a
    // company that had been up for days as one that started when we looked.
    ledger.emit('company', 'work.started', null, {});
    clock.advance(10 * 86_400_000);
    const v = report('2.days');
    assert.equal(v.run.hours, 48);
    assert.equal(v.run.dutyCycle, 1);
    cleanup();
  });

  test('the duty cycle says how badly a per-day rate would mislead', () => {
    ledger.emit('company', 'work.started', null, {});
    clock.advance(3_600_000);           // one hour of work
    ledger.emit('company', 'work.paused', null, {});
    const v = report('1.days');         // inside a 24-hour window
    assert.equal(v.run.hours, 1);
    assert.ok(Math.abs(v.run.dutyCycle - 1 / 24) < 0.001, `duty cycle was ${v.run.dutyCycle}`);
    cleanup();
  });

  test('rates are per running hour, and a company that never ran divides by nothing', () => {
    shift('rae', [['message.sent']], 4, 6, meter(1_000, 1_000));
    const v = report();
    // No work.started at all: the scheduler was never up, so there is no hour
    // to divide by. A NaN or an Infinity here blanks the whole console.
    assert.equal(v.run.hours, 0);
    assert.equal(v.run.costPerHour, 0);
    assert.equal(v.run.tokensPerHour, 0);
    assert.equal(v.run.shiftsPerHour, 0);
    cleanup();
  });

  test('cost an hour worked is the figure a duty cycle cannot distort', () => {
    ledger.emit('company', 'work.started', null, {});
    shift('rae', [['message.sent']], 4, 10, meter(3_000, 1_000));
    clock.advance(2 * 3_600_000);
    ledger.emit('company', 'work.paused', null, {});
    const v = report('30.days');
    assert.equal(v.run.hours, 2);
    assert.equal(v.run.costPerHour, 5);          // $10 over two hours
    assert.equal(v.run.tokensPerHour, 2_000);    // 4,000 tokens over two hours
    cleanup();
  });
});


/**
 * A company runs only when the operator runs it.
 *
 * One measured here worked 21.4 hours across a 30-day window. Any figure that
 * ages the staff's work by the calendar charges them for every week nobody
 * switched them on — so a team that was simply paused would be told it had
 * stopped having ideas.
 */
describe('the staff are never scored by time they were switched off', () => {
  /** A project, committed to the world's git at the clock's current time. */
  const project = (name: string): void => {
    world.writeDoc(`projects/${name}/README.md`, { data: {}, body: name });
    world.git.commitAs({ id: 'rae', name: 'Rae' }, `start ${name}`);
  };

  test('a project is aged by hours worked, not days elapsed', () => {
    ledger.emit('company', 'work.started', null, {});
    project('alpha');
    clock.advance(2 * 3_600_000);
    ledger.emit('company', 'work.paused', null, {});
    // Twelve days pass with the company switched off. None of it is the
    // staff's, and none of it may age their work.
    clock.advance(12 * 86_400_000);
    const v = report('30.days');
    assert.equal(v.novelty.newestAgeHours, 2);
    cleanup();
  });

  test('a company that never ran has no age to charge anybody for', () => {
    project('alpha');
    clock.advance(9 * 86_400_000);
    const v = report('30.days');
    assert.equal(v.novelty.newestAgeHours, 0);
    cleanup();
  });

  test('with no projects at all the age is a gap, not a zero', () => {
    const v = report('30.days');
    assert.equal(v.novelty.newestAgeHours, null);
    assert.equal(v.novelty.carrying, 0);
    cleanup();
  });

  test('the newest project sets the age, not the first one', () => {
    ledger.emit('company', 'work.started', null, {});
    project('alpha');
    clock.advance(5 * 3_600_000);
    project('beta');
    clock.advance(1 * 3_600_000);
    ledger.emit('company', 'work.paused', null, {});
    const v = report('30.days');
    assert.equal(v.novelty.carrying, 2);
    // beta is one worked hour old; alpha is six. The question the figure
    // answers is "how long since anything was new", so beta wins.
    assert.equal(v.novelty.newestAgeHours, 1);
    cleanup();
  });
});
