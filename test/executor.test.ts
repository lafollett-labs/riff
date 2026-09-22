import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ledger } from '../src/ledger/ledger.ts';
import { World } from '../src/worldfs/world.ts';
import { fixedClock } from '../src/core/clock.ts';
import { applyApproved } from '../src/runtime/executor.ts';
import type { Agent, Tier } from '../src/core/types.ts';

/**
 * The executor enacts approvals after they are said yes to. A capability that
 * escalates but has no case here falls through to the default noop — marked
 * applied while nothing happens, so the sign-off it required becomes theatre.
 * project.retire shipped needing this case; these tests are its guard.
 *
 * (world.write_other escalates without a case today and is exactly that
 * dead-end, but a pre-existing one: the write's content is never captured in a
 * payload, so a case alone would not enact it. Out of scope here.)
 */

const agent = (id: string, tier: Tier, reportsTo: string | null = 'ceo'): Agent => ({
  id, name: id[0]!.toUpperCase() + id.slice(1), tier, role: tier,
  department: '', reportsTo, status: 'active', activity: '', mandate: '',
  hiredAt: '2026-08-01T00:00:00.000Z', hiredBy: null, model: 'claude-opus-5', effort: 'company',
});

let dir: string;
let clock: ReturnType<typeof fixedClock>;
let ledger: Ledger;
let world: World;

const approvedRetire = (project: string, why: string): string => {
  const ap = ledger.createApproval({
    requestedBy: 'rae', capability: 'project.retire', tier: 'executive',
    summary: `retire ${project}: ${why}`, target: `projects/${project}`,
    payload: { project, why },
  });
  ledger.decideApproval(ap.id, 'ceo', true, 'agreed');
  return ap.id;
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'riff-exec-'));
  clock = fixedClock('2026-08-25T09:00:00.000Z');
  ledger = new Ledger(':memory:', clock);
  // approvals FK agents(id) on both requested_by and decided_by.
  ledger.upsertAgent(agent('ceo', 'executive', null));
  ledger.upsertAgent(agent('rae', 'lead'));
  world = new World(join(dir, 'world'), clock);
  world.ensure();
});

afterEach(() => { ledger.close(); rmSync(dir, { recursive: true, force: true }); });

describe('applying an approved project retirement', () => {
  test('removes the tree the CEO signed off, and records it', () => {
    world.writeDoc('projects/atlas/README.md', { data: { title: 'Atlas' }, body: 'the work' });
    assert.deepEqual(world.listProjects(), ['atlas']);
    approvedRetire('atlas', 'the market moved');

    const before = ledger.latestSeq();
    const n = applyApproved(ledger, world, clock);

    assert.equal(n, 1, 'one approval applied');
    assert.deepEqual(world.listProjects(), [], 'the project tree is gone');
    const retired = ledger.eventsSince(before).find((e) => e.kind === 'project.retired');
    assert.ok(retired, 'a project.retired event is on the record');
    assert.equal(retired!.subject, 'projects/atlas');
  });

  test('is idempotent — a second pass does nothing, and does not throw', () => {
    world.writeDoc('projects/atlas/README.md', { data: { title: 'Atlas' }, body: 'the work' });
    approvedRetire('atlas', 'the market moved');

    assert.equal(applyApproved(ledger, world, clock), 1);
    assert.equal(applyApproved(ledger, world, clock), 0, 'already applied, skipped');
  });

  test('an approval whose project is already gone fails loudly, not silently', () => {
    // Approved, then the project vanished before the executor ran (retired by
    // another path, or renamed). The tree cannot be removed twice; the executor
    // must say so rather than report a phantom success.
    approvedRetire('ghost', 'never existed by the time we got here');

    const before = ledger.latestSeq();
    const n = applyApproved(ledger, world, clock);

    assert.equal(n, 0, 'nothing was actually retired');
    const failed = ledger.eventsSince(before).find((e) => e.kind === 'approval.apply_failed');
    assert.ok(failed, 'the failure is on the record');
  });

  test('a retirement that never got a case would not silently noop', () => {
    // The guard the whole file exists for: if project.retire regressed to the
    // default branch, the tree would survive and this would catch it.
    world.writeDoc('projects/atlas/README.md', { data: { title: 'Atlas' }, body: 'x' });
    approvedRetire('atlas', 'done with it');
    applyApproved(ledger, world, clock);
    assert.equal(world.projectCount(), 0, 'retire must delete, not noop');
  });
});
