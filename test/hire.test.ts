import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ledger } from '../src/ledger/ledger.ts';
import { World } from '../src/worldfs/world.ts';
import { fillSeat } from '../src/company/hire.ts';
import { fixedClock } from '../src/core/clock.ts';
import type { Agent, Tier } from '../src/core/types.ts';

const clock = fixedClock('2026-08-25T10:00:00.000Z');
const agent = (id: string, tier: Tier, reportsTo: string | null = null): Agent => ({
  id, name: id[0]!.toUpperCase() + id.slice(1), tier, role: tier,
  department: '', reportsTo, status: 'active', activity: '', mandate: '',
  hiredAt: clock.iso(), hiredBy: null, model: 'x', effort: 'company',
});

let dir: string, ledger: Ledger, world: World;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hire-'));
  world = new World(join(dir, 'world'), clock);
  world.ensure();
  ledger = new Ledger(':memory:', clock);
  ledger.upsertAgent(agent('cali', 'board'));
  ledger.upsertAgent(agent('vale', 'executive', 'cali'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('filling a seat', () => {
  // REGRESSION: the CEO's own hire is ALLOWED outright by the gate rather than
  // escalated, and only the escalation path ever created an agent. A seat the
  // CEO proposed was accepted, logged as allowed, and silently dropped.
  test('actually creates the agent — the CEO path used to drop it', () => {
    const r = fillSeat(ledger, world, clock, {
      name: 'Wren', role: 'Head of Instrument', tier: 'lead',
      mandate: 'owns the score', reportsTo: 'vale', proposedBy: 'vale',
    });
    assert.equal(r.ok, true);
    const wren = ledger.getAgent('wren');
    assert.ok(wren, 'the seat was accepted but nobody was hired');
    assert.equal(wren.role, 'Head of Instrument');
    assert.equal(wren.reportsTo, 'vale');
  });

  test('writes a brief carrying the mandate', () => {
    fillSeat(ledger, world, clock, {
      name: 'Wren', role: 'Head of Instrument', tier: 'lead',
      mandate: 'owns the score and may publish it unedited', proposedBy: 'vale',
    });
    const brief = world.readDoc(world.personaPath('wren'))!.body;
    assert.match(brief, /owns the score and may publish it unedited/);
  });

  test('a hire is recorded, so the org chart has a history', () => {
    const before = ledger.latestSeq();
    fillSeat(ledger, world, clock, { name: 'Wren', role: 'Lead', tier: 'lead', proposedBy: 'vale' });
    const kinds = ledger.eventsSince(before).map((e) => e.kind);
    assert.ok(kinds.includes('role.filled'));
  });

  test('refuses a duplicate rather than overwriting someone', () => {
    fillSeat(ledger, world, clock, { name: 'Wren', role: 'Lead', tier: 'lead', proposedBy: 'vale' });
    const again = fillSeat(ledger, world, clock, { name: 'Wren', role: 'Other', tier: 'member', proposedBy: 'vale' });
    assert.equal(again.ok, false);
    assert.equal(ledger.getAgent('wren')!.role, 'Lead', 'the original was overwritten');
  });

  test('refuses a seat with no role', () => {
    assert.equal(fillSeat(ledger, world, clock, { name: 'X', role: '', tier: 'member', proposedBy: 'vale' }).ok, false);
  });
});

describe('the board governs rather than manages', () => {
  test('a seat proposed under a board member is redirected to the proposer', () => {
    const r = fillSeat(ledger, world, clock, {
      name: 'Wren', role: 'Head of Instrument', tier: 'lead',
      reportsTo: 'cali', proposedBy: 'vale',
    });
    assert.equal(r.ok && r.redirected, true);
    assert.equal(ledger.getAgent('wren')!.reportsTo, 'vale', 'the chair became a line manager');
  });

  test('the redirect is logged, not silent — a disagreement should be visible', () => {
    const before = ledger.latestSeq();
    fillSeat(ledger, world, clock, {
      name: 'Wren', role: 'Lead', tier: 'lead', reportsTo: 'cali', proposedBy: 'vale',
    });
    const ev = ledger.eventsSince(before).find((e) => e.kind === 'org.reporting_redirected');
    assert.ok(ev, 'the reporting line was changed with no record of it');
  });

  test('an ordinary reporting line is left alone', () => {
    fillSeat(ledger, world, clock, { name: 'Wren', role: 'Lead', tier: 'lead', proposedBy: 'vale' });
    fillSeat(ledger, world, clock, {
      name: 'Ida', role: 'Analyst', tier: 'member', reportsTo: 'wren', proposedBy: 'wren',
    });
    assert.equal(ledger.getAgent('ida')!.reportsTo, 'wren');
  });
});

/**
 * A board member added to config after founding never reached the roster,
 * because genesis seeds the board once. The CEO then hired a person of that
 * name — the roster had no conflict to find — and the new lead's id was inside
 * the constitution's board list, which is where `Gate.decide` reads standing
 * from. Two records disagreed about who governs.
 */
describe('a name the board answers to is not a seat anyone can fill', () => {
  test('hiring an id that is on the board is refused', () => {
    const r = fillSeat(ledger, world, clock,
      { name: 'Marvin', role: 'Head of Field Research', tier: 'lead', proposedBy: 'vale' },
      ['cali', 'marvin']);
    assert.equal(r.ok, false);
    assert.match((r as { ok: false; reason: string }).reason, /on the board/);
    assert.ok(!ledger.getAgent('marvin'), 'no seat was created');
  });

  test('the refusal does not depend on the board being in the roster', () => {
    assert.ok(!ledger.getAgent('marvin'), 'precondition: never seeded');
    assert.equal(fillSeat(ledger, world, clock,
      { name: 'Marvin', role: 'Lead', tier: 'lead', proposedBy: 'vale' }, ['marvin']).ok, false);
  });

  test('a name no board member answers to is still hireable', () => {
    const r = fillSeat(ledger, world, clock,
      { name: 'Ines', role: 'Principal Maker', tier: 'lead', proposedBy: 'vale' },
      ['cali', 'marvin']);
    assert.equal(r.ok, true);
    assert.equal(ledger.getAgent('ines')?.role, 'Principal Maker');
  });

  test('with no board given, hiring behaves as it always did', () => {
    assert.equal(fillSeat(ledger, world, clock,
      { name: 'Marvin', role: 'Lead', tier: 'lead', proposedBy: 'vale' }).ok, true);
  });
});
