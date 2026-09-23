import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { sandboxFilesystem, cliConfinement, confinedSpawn } from '../src/runtime/staff.ts';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { homedir } from 'node:os';
import { installRoot } from '../src/core/config.ts';

/**
 * The one boundary CRITICAL-001 turned on: the shift sandbox must hide the whole
 * installation root, because the secrets store (master.key, secrets/<slug>.vault,
 * keyproxy.secret) sits there. bubblewrap reads are allow-by-default and Linux
 * only, so this asserts the deny list — not a live read — is correct.
 */
describe('the shift sandbox hides the whole installation root, not just companies/', () => {
  const world = '/data/companies/shipit/world';

  beforeEach(() => { process.env['RIFF_ROOT'] = '/data'; });
  afterEach(() => { delete process.env['RIFF_ROOT']; });

  const denied = (fs: { denyRead: string[] }, p: string): boolean =>
    fs.denyRead.some((d) => p === d || p.startsWith(d + '/'));

  test('denyRead names the installation root itself', () => {
    assert.ok(sandboxFilesystem(world).denyRead.includes(installRoot()));
  });

  test('every secrets-store path and both neighbours fall under a denied root', () => {
    const fs = sandboxFilesystem(world);
    assert.ok(denied(fs, '/data/master.key'), 'master.key must be hidden');
    assert.ok(denied(fs, '/data/secrets/fathom.vault.json'), 'another company vault must be hidden');
    assert.ok(denied(fs, '/data/keyproxy.secret'), 'the token-signing secret must be hidden');
    assert.ok(denied(fs, '/data/archive/gone-co'), 'archived companies must be hidden');
    assert.ok(denied(fs, '/data/companies/fathom'), 'neighbour companies must still be hidden');
  });

  test('the company keeps its own home through a more-specific allow', () => {
    assert.ok(sandboxFilesystem(world).allowRead.includes('/data/companies/shipit'));
  });

  // The transcript store moved onto the volume under the company's own home, so
  // the home the shift may read now contains its own conversation history. The
  // deny has to follow it there, or a shift greps back everything it ever said.
  describe('the transcript store on the volume is denied even inside the allowed home', () => {
    const configDir = '/data/companies/shipit/.claude';

    test('the config dir is denied outright', () => {
      assert.ok(sandboxFilesystem(world, configDir).denyRead.includes(configDir));
    });

    test('transcripts and session state under it fall under the deny', () => {
      const fs = sandboxFilesystem(world, configDir);
      assert.ok(denied(fs, '/data/companies/shipit/.claude/projects/-data-companies-shipit-world/x.jsonl'),
        'a shift cannot read its own transcripts');
      assert.ok(denied(fs, '/data/companies/shipit/.claude/.claude.json'), 'nor the CLI state file');
    });

    test('the configDir deny is scoped to .claude and does not shadow the world', () => {
      // The installRoot deny reaches the world too, but allowRead overrides it
      // (more-specific-wins, bubblewrap's job). What this asserts is that the
      // config-store deny we added is narrow: it must not itself cover the world.
      const fs = sandboxFilesystem(world, configDir);
      const worldFile = '/data/companies/shipit/world/src/index.ts';
      assert.ok(!worldFile.startsWith(configDir + '/'),
        'the world is outside the denied config dir');
      assert.ok(fs.allowRead.includes('/data/companies/shipit'));
    });

    test('the shared $HOME store stays denied even when the on-volume one is set', () => {
      // The deny is additive, not either/or: /home/labs is one tmpfs shared by
      // every company, and reads there are allow-by-default, so dropping its deny
      // when configDir is set would make any residual the CLI leaves there a
      // cross-company read. Both stores denied, always.
      const withCfg = sandboxFilesystem(world, configDir);
      assert.ok(withCfg.denyRead.some((d) => d.endsWith('/.claude/projects')), 'default $HOME store still denied');
      assert.ok(withCfg.denyRead.includes(configDir), 'and the on-volume store too');
      const noCfg = sandboxFilesystem(world);
      assert.ok(noCfg.denyRead.some((d) => d.endsWith('/.claude/projects')), 'default store denied with no configDir');
    });
  });
});

describe('a shift may build beside its world but not rewrite what governs it', () => {
  const world = '/data/companies/shipit/world';
  beforeEach(() => { process.env['RIFF_ROOT'] = '/data'; });
  afterEach(() => { delete process.env['RIFF_ROOT']; });

  test('the ledger, the transcript and the config refuse writes, WAL files included', () => {
    // Measured in a contained probe before this: every one took a write, and
    // config.json took a rename. A shell that can write its ledger can approve
    // its own drafts and raise its own effort.
    const { denyWrite } = sandboxFilesystem(world);
    for (const f of ['config.json', 'ledger.db', 'ledger.db-wal', 'ledger.db-shm',
                     'transcript.db', 'transcript.db-wal', 'transcript.db-shm']) {
      assert.ok(denyWrite.includes(`/data/companies/shipit/${f}`), f);
    }
  });

  test('the home stays writable for a toolchain, and world/ is a mount of its own', () => {
    // Read-only home was measured to stop the CLI's sandbox starting at all.
    // world/ listed separately is its own mount, which cannot be renamed.
    const { allowWrite } = sandboxFilesystem(world);
    assert.ok(allowWrite.includes('/data/companies/shipit'));
    assert.ok(allowWrite.includes(world));
  });
});

describe('the CLI itself sees only its company, so a file tool cannot follow a link out', () => {
  // The gate vets a file tool's path in the factory, then the CLI opens it; a
  // parallel shell could swap a directory for a link in between (R3-1). Measured
  // in the factory with a real shift through this view: master.key absent, a
  // Read aimed at it "File does not exist", a Write to config.json refused.
  const home = '/data/companies/shipit';
  beforeEach(() => { process.env['RIFF_ROOT'] = '/data'; });
  afterEach(() => { delete process.env['RIFF_ROOT']; });

  /** Index of a flag followed by its operands, or -1. */
  const at = (args: string[], ...seq: string[]): number =>
    args.findIndex((_, i) => seq.every((s, j) => args[i + j] === s));

  test('the installation root is emptied before the company home is put back', () => {
    // bubblewrap applies mounts in order: the other way round, the tmpfs would
    // bury the company's own home too, or the root would stay in view.
    const a = cliConfinement(home);
    const root = at(a, '--tmpfs', '/data');
    const own = at(a, '--bind', home, home);
    assert.ok(root >= 0 && own > root);
  });

  test('the control files are read-only over the writable home, and a missing one fails closed', () => {
    const a = cliConfinement(home);
    const own = at(a, '--bind', home, home);
    for (const f of ['config.json', 'ledger.db', 'transcript.db']) {
      const p = `${home}/${f}`;
      assert.ok(at(a, '--ro-bind', p, p) > own, f);
    }
    // Only the WAL sidecars come and go with the database being open.
    for (const f of ['ledger.db-wal', 'ledger.db-shm', 'transcript.db-wal', 'transcript.db-shm']) {
      const p = `${home}/${f}`;
      assert.ok(at(a, '--ro-bind-try', p, p) > own, f);
    }
  });

  test('nothing under the installation root is mounted but the home and its control files', () => {
    // A stray bind of secrets/ or master.key would pass every ordering test.
    const a = cliConfinement(home);
    const binds = new Set(['--bind', '--bind-try', '--ro-bind', '--ro-bind-try', '--dev-bind', '--dev-bind-try']);
    const allowed = new Set([home, ...['config.json', 'ledger.db', 'ledger.db-wal', 'ledger.db-shm',
      'transcript.db', 'transcript.db-wal', 'transcript.db-shm'].map((f) => `${home}/${f}`)]);
    a.forEach((x, i) => {
      if (!binds.has(x)) return;
      const src = a[i + 1]!;
      if (src === '/data' || src.startsWith('/data/')) assert.ok(allowed.has(src), `${x} ${src}`);
    });
    // And the home goes back in only after every tmpfs, or one would bury it.
    const own = at(a, '--bind', home, home);
    a.forEach((x, i) => { if (x === '--tmpfs') assert.ok(i < own, `tmpfs ${a[i + 1]} after the home`); });
  });

  test('every tmpfs is sized, so a runaway build fails with ENOSPC instead of the gateway', () => {
    const a = cliConfinement(home);
    a.forEach((x, i) => {
      if (x === '--tmpfs') assert.equal(a[i - 2], '--size', `unsized tmpfs ${a[i + 1]}`);
    });
  });

  test('the shell\'s own caches exist in the fresh home, so they stay writable', () => {
    // The shell's sandbox skips an allowWrite path that does not exist.
    const a = cliConfinement(home);
    for (const d of ['.npm', '.cache', '.undo']) assert.ok(at(a, '--dir', `${homedir()}/${d}`) >= 0, d);
  });

  test('a home that is not a company under companies/ is refused, not half-confined', () => {
    for (const bad of ['/data', '/data/companies', '/data/world', '/elsewhere/co',
                       '/data/companies/../x', '/data/companies/co/deeper']) {
      assert.throws(() => cliConfinement(bad), /refusing to confine/, bad);
    }
  });

  test('the CLI is started inside the view, its stderr read, and a missing bwrap named', () => {
    const calls: Array<{ cmd: string; argv: string[] }> = [];
    const said: string[] = [];
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(),
      stderr: new PassThrough() });
    const fake = ((cmd: string, argv: string[]) => { calls.push({ cmd, argv }); return child; }) as never;
    confinedSpawn(home, (s) => said.push(s), fake)(
      { command: '/app/claude', args: ['--print'], cwd: `${home}/world`, env: {}, signal: new AbortController().signal });
    assert.equal(calls[0]!.cmd, 'bwrap');
    const argv = calls[0]!.argv;
    assert.deepEqual(argv.slice(argv.indexOf('--')), ['--', '/app/claude', '--print']);
    assert.deepEqual(argv.slice(0, argv.indexOf('--')), cliConfinement(home));
    child.stderr.write('No conversation found\n');
    child.emit('error', new Error('spawn bwrap ENOENT'));
    assert.deepEqual(said, ['No conversation found\n', 'bwrap: spawn bwrap ENOENT\n']);
  });

  test('the shared home and /tmp are fresh, and the view dies with the gateway', () => {
    const a = cliConfinement(home);
    assert.ok(at(a, '--tmpfs', homedir()) >= 0);
    assert.ok(at(a, '--tmpfs', '/tmp') >= 0);
    assert.ok(a.includes('--die-with-parent'));
    // Everything else read-only: the rootfs already is, and nothing else is bound writable.
    assert.equal(at(a, '--ro-bind', '/', '/'), 0);
    assert.equal(a.filter((x) => x === '--bind').length, 2); // /proc and the home
  });

  test('connector headers reach the CLI through a file in its view, never its arguments', async () => {
    const calls: Array<{ argv: string[]; stdio: unknown[] }> = [];
    const said: string[] = [];
    const fd3 = new PassThrough();
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(),
      stderr: new PassThrough() });
    Object.assign(child, { stdio: [child.stdin, child.stdout, child.stderr, fd3] });
    const fake = ((_: string, argv: string[], o: { stdio: unknown[] }) => {
      calls.push({ argv, stdio: o.stdio }); return child;
    }) as never;
    const json = JSON.stringify({ mcpServers: { mail: { type: 'http', url: 'https://x', headers: { Authorization: 'Bearer SEKRIT' } } } });
    confinedSpawn(home, (s) => said.push(s), fake)({ command: '/app/claude',
      args: ['--print', '--mcp-config', json, '--strict-mcp-config'],
      cwd: `${home}/world`, env: {}, signal: new AbortController().signal });
    const { argv, stdio } = calls[0]!;
    assert.ok(!argv.join(' ').includes('SEKRIT'));
    assert.deepEqual(argv.slice(argv.indexOf('--')),
      ['--', '/app/claude', '--print', '--mcp-config', '/data/mcp.json', '--strict-mcp-config']);
    // After the root is emptied, or the tmpfs would bury it. What keeps it from
    // another company is the view's own namespace; the company's own shell can
    // read the same headers in its config.json anyway.
    const data = at(argv, '--ro-bind-data', '3', '/data/mcp.json');
    assert.ok(data > at(argv, '--tmpfs', '/data'));
    assert.equal(stdio.length, 4);
    assert.equal(await new Promise<string>((r) => { let b = ''; fd3.on('data', (c) => { b += c; }).on('end', () => r(b)); }), json);
    // A bwrap that never read it must not crash the gateway.
    fd3.emit('error', new Error('write EPIPE'));
    assert.deepEqual(said, ['bwrap: mcp config: write EPIPE\n']);
  });

  test('an --mcp-config it cannot move out of argv refuses the shift', () => {
    let spawned = 0;
    const fake = (() => { spawned++; return {}; }) as never;
    const start = confinedSpawn(home, () => {}, fake);
    const opts = { command: '/app/claude', cwd: `${home}/world`, env: {}, signal: new AbortController().signal };
    for (const args of [['--mcp-config={"mcpServers":{}}'], ['--mcp-config', '/elsewhere.json'],
                        ['--mcp-config', '{}', '--mcp-config', '{}']]) {
      assert.throws(() => start({ ...opts, args }), /refusing to start a shift/, args.join(' '));
    }
    assert.equal(spawned, 0);
  });

  test('the SDK this repo runs hands over connector headers in no argument', async () => {
    // Pinned against the real SDK, not a hand-built argv: an upgrade that
    // changes how it passes MCP servers trips here rather than in production.
    const { query } = await import('@anthropic-ai/claude-agent-sdk');
    let argv: string[] = [];
    const real = (await import('node:child_process')).spawn;
    const fake = ((_: string, a: string[], o: object) => { argv = a; return real('true', [], o); }) as never;
    const q = query({ prompt: 'hi', options: {
      settingSources: [], strictMcpConfig: true,
      mcpServers: { mail: { type: 'http', url: 'https://mail.invalid/mcp', headers: { Authorization: 'Bearer SEKRIT' } } },
      spawnClaudeCodeProcess: confinedSpawn(home, () => {}, fake),
    } });
    // `true` exits at once; however the SDK takes that, the argv is what counts.
    try { for await (const _ of q) { /* nothing arrives */ } } catch { /* expected */ }
    assert.ok(argv.includes('--ro-bind-data'), argv.join(' '));
    assert.ok(!argv.join(' ').includes('SEKRIT'));
  });

  test('a CLI with no MCP servers gets no extra descriptor', () => {
    const calls: Array<{ argv: string[]; stdio: unknown[] }> = [];
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(),
      stderr: new PassThrough() });
    const fake = ((_: string, argv: string[], o: { stdio: unknown[] }) => {
      calls.push({ argv, stdio: o.stdio }); return child;
    }) as never;
    confinedSpawn(home, () => {}, fake)({ command: '/app/claude', args: ['--print'],
      cwd: `${home}/world`, env: {}, signal: new AbortController().signal });
    assert.ok(!calls[0]!.argv.includes('--ro-bind-data'));
    assert.equal(calls[0]!.stdio.length, 3);
  });
});
