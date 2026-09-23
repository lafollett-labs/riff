import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ledger } from '../src/ledger/ledger.ts';
import { World } from '../src/worldfs/world.ts';
import { Gate, type CommonsView } from '../src/policy/gate.ts';
import { constitutionFor } from '../src/policy/rules.ts';
import { fixedClock } from '../src/core/clock.ts';
import { makeCanUseTool, makePreToolCheck, PRE_CHECKED, shellIsContained } from '../src/runtime/permissions.ts';
import { createTools, TOOL_NAMESPACE, TOOL_PREFIX } from '../src/runtime/tools.ts';
import type { Agent, Tier } from '../src/core/types.ts';
import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk';

/**
 * canUseTool is the chokepoint. Everything else in the policy layer is only
 * as good as this function, and it had no test at all.
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
let gate: Gate;
let capabilities: Record<string, string>;
let toolNames: string[];

const can = (opts: { actor?: string; contained?: boolean } = {}) =>
  makeCanUseTool({
    actor: opts.actor ?? 'rae', world, gate,
    toolCapabilities: capabilities as never,
    ...(opts.contained === undefined ? {} : { contained: opts.contained }),
  });

const call = async (tool: string, input: Record<string, unknown> = {}, opts = {}) =>
  can(opts)(tool, input, { signal: AbortSignal.timeout(5_000) } as never);

/** Narrow to the branch under test, and fail loudly with the other one. */
const denied = (r: PermissionResult | null, what = ''): { message: string } => {
  assert.ok(r && r.behavior === 'deny', `${what} expected a deny, got ${JSON.stringify(r)}`);
  return r;
};
const allowed = (r: PermissionResult | null, what = ''): void => {
  assert.ok(r && r.behavior === 'allow', `${what} expected an allow, got ${JSON.stringify(r)}`);
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'riff-perm-'));
  clock = fixedClock('2026-08-25T09:00:00.000Z');
  ledger = new Ledger(':memory:', clock);
  ledger.upsertAgent(agent('chair', 'board', null));
  ledger.upsertAgent(agent('ceo', 'executive', 'chair'));
  ledger.upsertAgent(agent('rae', 'lead'));

  world = new World(join(dir, 'world'), clock);
  const commons: CommonsView = { count: () => world.commonsCount(), exists: (p) => world.exists(p) };
  gate = new Gate(ledger, constitutionFor({ ceo: 'ceo', board: ['chair'] }), commons);
  const built = createTools({ ledger, world, gate, clock, actor: 'rae' } as never);
  capabilities = built.capabilities;
  toolNames = built.toolNames;
});

afterEach(() => { ledger.close(); rmSync(dir, { recursive: true, force: true }); });

describe('the chokepoint', () => {
  test('spawning a subagent is named by the tool the CLI has now', async () => {
    // The list said `Task` after the CLI renamed it `Agent`. Today the CLI
    // does not ask about the spawn; should it start to, subagents are allowed
    // by name, not refused by default, and what they do is gated in turn.
    allowed(await call('Agent', { description: 'look', prompt: 'read' }), 'Agent');
    denied(await call('Task', {}), 'the old name is unknown now');
  });

  test('the prefix it matches on is the one the SDK actually produces', async () => {
    // These were two independent strings in two files. When the MCP server was
    // renamed and this was not, every company tool fell through to the
    // default-deny — a whole shift of refusals with no error raised anywhere.
    assert.equal(TOOL_PREFIX, `mcp__${TOOL_NAMESPACE}__`);

    for (const bare of Object.keys(capabilities)) {
      allowed(await call(`${TOOL_PREFIX}${bare}`), bare);
    }
  });

  test('every REGISTERED company tool is recognised by the gate, not just the mapped ones', async () => {
    // The test above iterates the capability MAP, so a tool that is registered
    // on the server but missing from the map slips past it — which is exactly
    // how portfolio and retire_project shipped dead, denied as "Unknown company
    // tool" the moment a staff member reached for them. Iterate what the model
    // is actually offered.
    for (const name of toolNames) allowed(await call(`${TOOL_PREFIX}${name}`), name);
    assert.ok(toolNames.includes('portfolio'), 'portfolio must be a registered, gated tool');
    assert.ok(toolNames.includes('retire_project'), 'retire_project must be a registered, gated tool');
  });

  test('an unrecognised tool is refused, so a new SDK tool is not a new power', async () => {
    denied(await call('SomeToolShippedNextVersion', { anything: true }));
  });

  test('a tool under the right prefix that we never defined is still refused', async () => {
    denied(await call(`${TOOL_PREFIX}drop_the_database`));
  });

  test('a company tool named after a prototype key is refused, not inherited from Object.prototype', async () => {
    // `toString`/`constructor`/etc. resolve off Object.prototype, so a bare
    // lookup or an `in` check would treat them as mapped and allow them.
    for (const name of ['toString', 'constructor', 'hasOwnProperty', 'valueOf']) {
      denied(await call(`${TOOL_PREFIX}${name}`), name);
    }
  });
});

describe('the shell is decided by where the runtime is', () => {
  test('refused on the operator machine, and the refusal says why', async () => {
    assert.match(denied(await call('Bash', { command: 'ls' }, { contained: false })).message, /container/i);
  });

  test('offered inside the container, because that is what the box is for', async () => {
    allowed(await call('Bash', { command: 'npm test' }, { contained: true }));
  });

  test('every shell tool follows the same decision, not just Bash', async () => {
    for (const t of ['Bash', 'BashOutput', 'KillShell', 'KillTask']) {
      denied(await call(t, {}, { contained: false }), t);
      allowed(await call(t, {}, { contained: true }), t);
    }
  });

  test('the environment variable alone is not enough to open a shell', () => {
    // A mistyped export on someone's laptop must not hand out a terminal. The
    // marker is given, not probed: in the factory it is really there, and this
    // test once failed there for asserting the laptop's answer.
    const noMarker = () => false;
    assert.equal(shellIsContained({ RIFF_CONTAINED: '1' } as never, noMarker), false);
    assert.equal(shellIsContained({} as never, noMarker), false);
  });

  test('the container marker alone is not enough either', () => {
    const marker = () => true;
    assert.equal(shellIsContained({} as never, marker), false);
    assert.equal(shellIsContained({ RIFF_CONTAINED: 'true' } as never, marker), false);
    assert.equal(shellIsContained({ RIFF_CONTAINED: '1' } as never, marker), true);
  });
});

describe('paths are classified before they are allowed', () => {
  test('anything outside the world is refused outright', async () => {
    for (const p of ['/etc/passwd', '../../.ssh/id_rsa', join(dir, 'elsewhere.txt')]) {
      assert.match(denied(await call('Read', { file_path: p }), p).message, /outside the company/);
    }
  });

  test('a read tool with no path is refused rather than guessed at', async () => {
    denied(await call('Read', {}));
  });

  test('own files are allowed; a colleague\'s writes escalate', async () => {
    allowed(await call('Write', { file_path: 'staff/rae/notes/x.md' }));

    // Writing on someone else's desk needs the CEO's signature (R2).
    const other = denied(await call('Write', { file_path: 'staff/ceo/notes/x.md' }));
    assert.match(other.message, /approval|queued|pending/i);

    // Reading it is allowed — and logged, which is the point.
    allowed(await call('Read', { file_path: 'staff/ceo/persona.md' }));
  });

  test('an escalation tells the agent to stop, not to try again', async () => {
    assert.match(denied(await call('Write', { file_path: 'staff/ceo/notes/y.md' })).message, /Do not retry/);
  });
});

describe('the gate is actually wired to the session', () => {
  const staff = readFileSync(new URL('../src/runtime/staff.ts', import.meta.url), 'utf8');

  test("staff sessions run in the one mode that consults the gate", () => {
    // Measured against the SDK, twice each, with a deny-everything handler and
    // a model asked to write a file: 'default' consults canUseTool and the
    // write is refused; 'auto' never calls it and the file lands. 'auto' is
    // not bypassPermissions — it judges actions with a model of its own — but
    // it judges them instead of the gate, and a model's judgement is exactly
    // the kind of control that can be argued with in a prompt.
    assert.match(staff, /permissionMode: 'default'/,
      'staff sessions must run in default mode or the gate is not consulted');
    for (const mode of ['auto', 'bypassPermissions', 'acceptEdits', 'dontAsk']) {
      assert.ok(!staff.includes(`permissionMode: '${mode}'`),
        `permissionMode '${mode}' does not consult canUseTool; the gate would be off`);
    }
  });

  test('every session is handed canUseTool at all', () => {
    assert.match(staff, /canUseTool: gated/,
      'a session without canUseTool has no gate, whatever the mode says');
    assert.match(staff, /const gated: CanUseTool = [^;]*makeCanUseTool|makeCanUseTool\(/,
      'and what it is handed has to be the real gate, not a stand-in');
  });

  test('a dead resumed stream is caught by its own error, not inferred from silence', () => {
    // A resumed session can bring the control stream up dead: canUseTool is
    // never reached (gateCalls stays 0) and every tool comes back
    // `AbortError: Stream closed`. The shift reads that error, resets the stale
    // session and retakes the leg cold — rather than counting silent turns and
    // guessing, which killed 44 healthy shifts that opened on read-only shell.
    assert.match(staff, /gateCalls\+\+/, 'the gate-answered guard still needs the count');
    assert.match(staff, /streamClosedResult\(m\)/, 'the dead stream is read from its own error');
    assert.match(staff, /staleSession = true/, 'and marked for a cold retake');
    assert.match(staff, /stop\.abort\(\)/, 'and the leg actually stopped');
  });
});

describe('a waking agent sees both halves of the approval loop', () => {
  const staff = readFileSync(new URL('../src/runtime/staff.ts', import.meta.url), 'utf8');

  test('pending drafts are surfaced at wake, not only decided ones', () => {
    // withdraw_draft shipped and went unused across 139 shifts while nine
    // drafts sat waiting. The tool was reachable; the queue was not. An agent
    // saw only the requests somebody else had already closed.
    assert.match(staff, /Your drafts still waiting on the board/,
      'a waking agent must be shown its own unanswered requests');
    assert.match(staff, /listApprovals\('pending'\)[\s\S]{0,120}requestedBy === agent\.id/,
      "and only its own — a colleague's queue is not this agent's to prune");
  });

  test('the reminder names the tool that acts on it', () => {
    // A list with no verb attached is a list that gets read and left alone.
    const block = staff.slice(staff.indexOf('Your drafts still waiting'));
    assert.match(block.slice(0, 900), /withdraw_draft/,
      'the prompt must name the tool, or the reminder changes nothing');
  });
});

describe('a link is not a way out of the world', () => {
  /**
   * `resolve` folds `..` away, so plain traversal was already caught. A
   * symlink is not: planted inside world/ it resolves textually clean and
   * lands wherever it points. `World.path` refused that; the gate did not.
   *
   * The consequence was worse than one read. Shell can already reach another
   * company directly, so this was no escalation for a shell — but one `ln -s`
   * made the hole permanent and invisible, and every later shift's Read, Grep
   * and Glob followed the link while the ledger recorded an ordinary file of
   * the actor's own.
   */
  test('a symlink out of the world is outside, however it is spelled', async () => {
    const outside = join(dir, 'not-our-company');
    mkdirSync(join(outside, 'commons'), { recursive: true });
    writeFileSync(join(outside, 'commons', 'theirs.md'), 'another company\n');
    mkdirSync(join(world.root, 'staff', 'rae'), { recursive: true });
    symlinkSync(outside, join(world.root, 'staff', 'rae', 'peek'));

    for (const tool of ['Read', 'Grep', 'Glob', 'Write', 'Edit']) {
      const r = denied(await call(tool, {
        file_path: 'staff/rae/peek/commons/theirs.md', content: 'x',
      }), tool);
      assert.match(r.message, /outside the company/, `${tool} followed the link`);
    }
  });

  test('a link to the parent is only a way out if you leave through it', async () => {
    mkdirSync(join(world.root, 'commons'), { recursive: true });
    mkdirSync(join(dir, 'elsewhere'), { recursive: true });
    writeFileSync(join(dir, 'elsewhere', 'theirs.md'), 'not ours\n');
    mkdirSync(join(world.root, 'staff', 'rae'), { recursive: true });
    symlinkSync(dir, join(world.root, 'staff', 'rae', 'up'));

    // Out through the link and away: outside.
    denied(await call('Read', { file_path: 'staff/rae/up/elsewhere/theirs.md' }), 'out via parent');
    // Out through the link and straight back in: still ours, and refusing it
    // would be the check turning into a wall.
    allowed(await call('Read', { file_path: 'staff/rae/up/world/commons' }), 'back into our own world');
  });

  test('a file that does not exist yet is still placed by where it would land', async () => {
    // realpath throws on a missing path, so the check walks up to the deepest
    // ancestor that exists. Writing a NEW file through a link must still fail.
    const outside = join(dir, 'not-our-company');
    mkdirSync(outside, { recursive: true });
    mkdirSync(join(world.root, 'staff', 'rae'), { recursive: true });
    symlinkSync(outside, join(world.root, 'staff', 'rae', 'drop'));
    denied(await call('Write', { file_path: 'staff/rae/drop/new-file.md', content: 'x' }),
      'a new file through a link');
  });

  test('a link inside the world is classified by where it really points', async () => {
    // Named as Rae's own, but it is Wren's. The colleague rule has to follow
    // the link, or `staff/rae/mine` reads a colleague's file as your own.
    mkdirSync(join(world.root, 'staff', 'wren'), { recursive: true });
    writeFileSync(join(world.root, 'staff', 'wren', 'notes.md'), 'wren\n');
    mkdirSync(join(world.root, 'staff', 'rae'), { recursive: true });
    symlinkSync(join(world.root, 'staff', 'wren'), join(world.root, 'staff', 'rae', 'mine'));

    // Reading a colleague is allowed, so this one lands in the gate rather
    // than the classifier — what matters is that it is not treated as `own`.
    const r = await call('Write', { file_path: 'staff/rae/mine/notes.md', content: 'x' });
    const d = denied(r, 'writing a colleague through a link');
    assert.doesNotMatch(d.message, /outside the company/,
      'it is inside the world, just not hers');
  });

  test('an ordinary path still works, so the check is not a wall', async () => {
    mkdirSync(join(world.root, 'staff', 'rae'), { recursive: true });
    writeFileSync(join(world.root, 'staff', 'rae', 'mine.md'), 'mine\n');
    allowed(await call('Read', { file_path: 'staff/rae/mine.md' }), 'own file');
    allowed(await call('Write', { file_path: 'staff/rae/new.md', content: 'x' }), 'new own file');
  });
});

describe('what the CLI approves by itself still crosses the gate', () => {
  // Measured against CLI 2.1.280: Read/Glob/Grep inside world/, a command it
  // calls read-only, and a subagent spawn never reached canUseTool. The
  // pre-check is run from a PreToolUse hook, before the CLI decides.
  const pre = (opts: { contained?: boolean } = {}) => makePreToolCheck({
    actor: 'rae', world, gate, toolCapabilities: capabilities as never,
    ...(opts.contained === undefined ? {} : { contained: opts.contained }),
  });
  const gateEvents = () => ledger.eventsSince(0).filter((e) => e.kind.startsWith('gate.'))
    .map((e) => JSON.parse(e.dataJson ?? '{}').capability as string);

  test('reading a colleague\'s file is on the record, as the rule says it is', async () => {
    const r = await pre()('Read', { file_path: join(world.root, 'staff', 'ceo', 'memory.md') }, 't1');
    allowed(r);
    assert.deepEqual(gateEvents(), ['world.read_other']);
  });

  test('reading your own files or the commons asks nothing, and records nothing', async () => {
    assert.equal(await pre()('Read', { file_path: join(world.root, 'staff', 'rae', 'notes.md') }, 't1'), null);
    assert.equal(await pre()('Read', { file_path: join(world.root, 'commons', 'plan.md') }, 't2'), null);
    assert.equal(await pre()('Grep', { pattern: 'x', path: join(world.root, 'staff', 'rae') }, 't3'), null);
    assert.equal(await pre()('Glob', { pattern: '**/*.md', path: 'commons' }, 't4'), null);
    assert.deepEqual(gateEvents(), []);
  });

  test('a search that reaches colleagues\' files is one recorded read of theirs', async () => {
    // Grep with no path, or over staff/, returns lines from every colleague's
    // memory at once; recorded before, it read as nothing at all.
    const cases: Array<[string, Record<string, unknown>]> = [
      ['Grep', { pattern: 'secret' }],
      ['Grep', { pattern: 'secret', path: 'staff' }],
      ['Grep', { pattern: 'secret', path: 'staff/ceo' }],
      ['Grep', { pattern: 'secret', path: 'staff/rae', glob: '../ceo/**' }],
      ['Glob', { pattern: 'staff/ceo/**' }],
    ];
    for (const [tool, input] of cases) allowed(await pre()(tool, input, 't'), JSON.stringify(input));
    assert.deepEqual(gateEvents(), cases.map(() => 'world.read_other'));
    denied(await pre()('Grep', { pattern: 'x', path: '/etc' }, 't9'), 'outside is refused');
  });

  test('a link in your own folder does not make a search of a colleague\'s private', async () => {
    mkdirSync(join(world.root, 'staff', 'ceo'), { recursive: true });
    mkdirSync(join(world.root, 'staff', 'rae'), { recursive: true });
    symlinkSync(join(world.root, 'staff', 'ceo'), join(world.root, 'staff', 'rae', 'peek'));
    allowed(await pre()('Grep', { pattern: 'x', path: join(world.root, 'staff', 'rae', 'peek') }, 't1'));
    assert.deepEqual(gateEvents(), ['world.read_other']);
  });

  test('the hook matches the tools it names, not their neighbours', () => {
    const m = new RegExp(PRE_CHECKED);
    for (const t of ['Agent', 'Task', 'Read', 'Glob', 'Grep', 'NotebookRead', 'Bash']) assert.ok(m.test(t), t);
    for (const t of ['BashOutput', 'TaskStop', 'TaskOutput', 'TaskCreate', 'ReadMcpResource']) assert.ok(!m.test(t), t);
  });

  test('a read of the repository is refused even inside world/', async () => {
    denied(await pre()('Read', { file_path: join(world.root, '.git', 'config') }, 't1'));
  });

  test('every shell command is asked, the ones the CLI calls read-only included', async () => {
    allowed(await pre({ contained: true })('Bash', { command: 'ls' }, 't1'));
    assert.deepEqual(gateEvents(), ['shell']);
    denied(await pre({ contained: false })('Bash', { command: 'ls' }, 't2'), 'no shell off the container');
  });

  test('a subagent is spawned inside the company, never remotely', async () => {
    allowed(await pre()('Agent', { description: 'look', prompt: 'read' }, 't1'));
    const r = denied(await pre()('Agent', { description: 'look', prompt: 'read', isolation: 'remote' }, 't2'));
    assert.match(r.message, /remote isolation is not available/);
  });

  test('a subagent runs on its seat\'s model, not one it names', async () => {
    const r = denied(await pre()('Agent', { description: 'look', prompt: 'read', model: 'opus' }, 't1'));
    assert.match(r.message, /the board chose for your seat/);
  });
});
