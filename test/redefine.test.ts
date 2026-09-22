import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ledger } from '../src/ledger/ledger.ts';
import { World } from '../src/worldfs/world.ts';
import { redefineAgent } from '../src/company/redefine.ts';
import { fixedClock } from '../src/core/clock.ts';
import type { Agent, Tier } from '../src/core/types.ts';

const clock = fixedClock('2026-09-14T10:00:00.000Z');
const agent = (id: string, tier: Tier, over: Partial<Agent> = {}): Agent => ({
  id, name: id[0]!.toUpperCase() + id.slice(1), tier, role: tier,
  department: '', reportsTo: null, status: 'active', activity: '', mandate: 'seat exists to X',
  hiredAt: clock.iso(), hiredBy: null, model: 'x', effort: 'company', ...over,
});

let dir: string, ledger: Ledger, world: World;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'redefine-'));
  world = new World(join(dir, 'world'), clock);
  world.ensure();
  ledger = new Ledger(':memory:', clock);
  ledger.upsertAgent(agent('cali', 'board'));
  ledger.upsertAgent(agent('jack', 'executive', { role: 'CEO', mandate: 'run ShipIt' }));
  // A brief with real frontmatter, the shape a founded agent's persona carries.
  world.writeDoc(world.personaPath('jack'), {
    data: { agent: 'jack', tier: 'executive', role: 'CEO' },
    body: '# Jack\n\nYou are the CEO.\n',
  });
  world.git.commitAs({ id: 'company', name: 'ShipIt' }, 'seed');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const body = (id: string) => world.readDoc(world.personaPath(id))!.body;
const front = (id: string) => world.readDoc(world.personaPath(id))!.data;

describe('redefining an agent after founding', () => {
  test('a new role lands in the ledger — the field the system prompt reads', () => {
    const r = redefineAgent(ledger, world, 'ShipIt', 'jack',
      { role: 'Founder and Principal Engineer' }, 'CEO who builds');
    assert.equal(r.ok, true);
    assert.equal(ledger.getAgent('jack')!.role, 'Founder and Principal Engineer');
    assert.deepEqual(r.ok && r.changed, ['role']);
  });

  test('a role change keeps the persona frontmatter in step even without a new body', () => {
    // The prompt takes role from the ledger, but a header disagreeing with it
    // only misleads the next reader, so the file is rewritten to match.
    redefineAgent(ledger, world, 'ShipIt', 'jack', { role: 'Founder' }, 'why');
    assert.equal(front('jack')['role'], 'Founder');
    assert.match(body('jack'), /You are the CEO\./, 'the body itself is untouched');
  });

  test('a new persona body is written and its prior frontmatter preserved', () => {
    const r = redefineAgent(ledger, world, 'ShipIt', 'jack',
      { persona: '# Jack\n\nYou build the slice with Lynn.\n' }, 'refocus on building');
    assert.equal(r.ok, true);
    assert.match(body('jack'), /You build the slice with Lynn\./);
    // agent/tier survive even though the operator's body carried no frontmatter.
    assert.equal(front('jack')['agent'], 'jack');
    assert.equal(front('jack')['tier'], 'executive');
  });

  test('frontmatter the operator writes into the body wins over the prior', () => {
    redefineAgent(ledger, world, 'ShipIt', 'jack',
      { persona: '---\ntier: lead\n---\n# Jack\n\nbody\n' }, 'demote tier in file');
    assert.equal(front('jack')['tier'], 'lead');
    assert.equal(front('jack')['agent'], 'jack', 'the prior fills what the body omits');
  });

  test('mandate is recorded even though the prompt does not read it', () => {
    const r = redefineAgent(ledger, world, 'ShipIt', 'jack', { mandate: 'build the factory' }, 'why');
    assert.equal(r.ok, true);
    assert.equal(ledger.getAgent('jack')!.mandate, 'build the factory');
  });

  test('only the fields that actually changed are reported and written', () => {
    const r = redefineAgent(ledger, world, 'ShipIt', 'jack',
      { role: 'CEO', persona: '# Jack\n\nnew brief\n' }, 'only the brief changed');
    // role given but identical to current, so it is not in the change set.
    assert.deepEqual(r.ok && r.changed, ['persona']);
  });

  test('the change is recorded as an event and a world commit in the company name', () => {
    const before = ledger.latestSeq();
    redefineAgent(ledger, world, 'ShipIt', 'jack', { role: 'Founder' }, 'the reason on record');
    const ev = ledger.eventsSince(before).find((e) => e.kind === 'agent.redefined');
    assert.ok(ev, 'nothing recorded the redefinition');
    const commit = world.git.since('2026-09-01').find((c) => /Redefine Jack/.test(c.subject));
    assert.ok(commit, 'the persona write was not committed');
    assert.equal(commit!.email, 'company@riff.local', 'an operator edit signed as the company, not the agent');
  });
});

describe('what redefinition refuses', () => {
  test('the board is defined by the charter, not a persona', () => {
    const r = redefineAgent(ledger, world, 'ShipIt', 'cali', { role: 'Overlord' }, 'why');
    assert.equal(r.ok, false);
    assert.match((r as { ok: false; reason: string }).reason, /charter/);
    assert.equal(ledger.getAgent('cali')!.role, 'board', 'the board row was untouched');
  });

  test('a change with no reason is refused — the record needs a why', () => {
    assert.equal(redefineAgent(ledger, world, 'ShipIt', 'jack', { role: 'X' }, '   ').ok, false);
  });

  test('an unknown agent is refused', () => {
    const r = redefineAgent(ledger, world, 'ShipIt', 'ghost', { role: 'X' }, 'why');
    assert.equal(r.ok, false);
    assert.match((r as { ok: false; reason: string }).reason, /no agent/);
  });

  test('an empty change set is refused, and so is one that matches what is on file', () => {
    assert.match((redefineAgent(ledger, world, 'ShipIt', 'jack', {}, 'why') as { ok: false; reason: string }).reason,
      /nothing to change/);
    assert.match((redefineAgent(ledger, world, 'ShipIt', 'jack', { role: 'CEO' }, 'why') as { ok: false; reason: string }).reason,
      /no change/);
  });

  test('over-length fields are refused rather than truncated', () => {
    assert.match((redefineAgent(ledger, world, 'ShipIt', 'jack',
      { role: 'x'.repeat(201) }, 'why') as { ok: false; reason: string }).reason, /role over/);
    assert.match((redefineAgent(ledger, world, 'ShipIt', 'jack',
      { persona: 'x'.repeat(20_001) }, 'why') as { ok: false; reason: string }).reason, /persona over/);
  });
});
