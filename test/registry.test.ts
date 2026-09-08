import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, readdirSync,
         readFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';

/**
 * One installation, many companies.
 *
 * Every test here runs against a throwaway HOME, because the module reads
 * ~/.riff at import time and a test that can archive the operator's real
 * company is not a test.
 */
const run = (script: string): string => {
  const home = process.env['TEST_HOME']!;
  return execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    // RIFF_ROOT is the containment boundary; HOME alone is not, because
    // a module that snapshots homedir() at import escapes it.
    env: { ...process.env, HOME: home, RIFF_ROOT: join(home, '.riff'), RIFF_COMPANY_ID: '' },
    cwd: process.cwd(),
  });
};

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'riff-registry-'));
  process.env['TEST_HOME'] = home;
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env['TEST_HOME'];
});

describe('companies are separate worlds', () => {
  test('founding two leaves each with its own staff, ledger and repo', () => {
    const out = run(`
      const { Registry } = await import('${process.cwd()}/src/company/registry.ts');
      const { systemClock } = await import('${process.cwd()}/src/core/clock.ts');
      const r = new Registry(systemClock);
      const a = r.found({ name: 'Alpha Works', business: 'one', ceo: 'Ash', chair: 'Cali' });
      const b = r.found({ name: 'Beta Works', business: 'two', ceo: 'Bay', chair: 'Cali' });
      if (!a.ok || !b.ok) throw new Error('found failed');

      a.company.ledger.emit('ash', 'test.marker', null, {});
      console.log(JSON.stringify({
        slugs: r.list().map((c) => c.slug).sort(),
        ceoA: a.company.cfg.ceo.name,
        ceoB: b.company.cfg.ceo.name,
        seqA: a.company.ledger.latestSeq(),
        seqB: b.company.ledger.latestSeq(),
        sameLedgerFile: a.company.cfg.ledgerPath === b.company.cfg.ledgerPath,
      }));
    `);
    const r = JSON.parse(out) as Record<string, unknown>;
    assert.deepEqual(r['slugs'], ['alpha-works', 'beta-works']);
    assert.equal(r['ceoA'], 'Ash');
    assert.equal(r['ceoB'], 'Bay');
    assert.equal(r['sameLedgerFile'], false);
    // An event in one must not appear in the other's sequence.
    assert.ok((r['seqA'] as number) > (r['seqB'] as number), JSON.stringify(r));
  });

  test('a name already taken is refused rather than merged into', () => {
    const out = run(`
      const { Registry } = await import('${process.cwd()}/src/company/registry.ts');
      const { systemClock } = await import('${process.cwd()}/src/core/clock.ts');
      const r = new Registry(systemClock);
      r.found({ name: 'Alpha Works', business: '', ceo: 'Ash', chair: 'Cali' });
      const again = r.found({ name: 'alpha works', business: '', ceo: 'Other', chair: 'Cali' });
      console.log(JSON.stringify({ ok: again.ok, reason: again.ok ? null : again.reason }));
    `);
    const r = JSON.parse(out) as { ok: boolean; reason: string };
    assert.equal(r.ok, false);
    assert.match(r.reason, /already exists/);
  });

  test('an unknown slug returns nothing instead of inventing a company', () => {
    const out = run(`
      const { Registry } = await import('${process.cwd()}/src/company/registry.ts');
      const { systemClock } = await import('${process.cwd()}/src/core/clock.ts');
      const r = new Registry(systemClock);
      r.found({ name: 'Alpha Works', business: '', ceo: 'Ash', chair: 'Cali' });
      console.log(JSON.stringify({ got: r.get('nope'), count: r.list().length }));
    `);
    assert.deepEqual(JSON.parse(out), { got: null, count: 1 });
  });
});

describe('managing a company', () => {
  test('renaming the label leaves the folder alone', () => {
    const out = run(`
      const { Registry } = await import('${process.cwd()}/src/company/registry.ts');
      const { systemClock } = await import('${process.cwd()}/src/core/clock.ts');
      const r = new Registry(systemClock);
      r.found({ name: 'Alpha Works', business: 'one', ceo: 'Ash', chair: 'Cali' });
      const res = await r.update('alpha-works', { name: 'Alpha Industries' });
      const after = r.list()[0];
      console.log(JSON.stringify({ res, slug: after.slug, name: after.name, business: after.business }));
    `);
    const r = JSON.parse(out) as Record<string, unknown>;
    assert.deepEqual(r['res'], { ok: true, slug: 'alpha-works' });
    assert.equal(r['slug'], 'alpha-works', 'the folder must not move on a label change');
    assert.equal(r['name'], 'Alpha Industries');
    assert.equal(r['business'], 'one', 'an unset field must not be blanked');
  });

  test('renaming the slug moves the folder and rewrites the stored paths', () => {
    const out = run(`
      const { Registry } = await import('${process.cwd()}/src/company/registry.ts');
      const { systemClock } = await import('${process.cwd()}/src/core/clock.ts');
      const r = new Registry(systemClock);
      r.found({ name: 'Alpha Works', business: '', ceo: 'Ash', chair: 'Cali' });
      await r.update('alpha-works', { slug: 'alpha' });
      const c = r.get('alpha');
      console.log(JSON.stringify({
        slugs: r.list().map((x) => x.slug),
        home: c.cfg.home.endsWith('/companies/alpha'),
        world: c.cfg.worldDir.endsWith('/companies/alpha/world'),
        ledgerOpens: c.ledger.latestSeq() >= 0,
      }));
    `);
    const r = JSON.parse(out) as Record<string, unknown>;
    assert.deepEqual(r['slugs'], ['alpha']);
    assert.equal(r['home'], true);
    assert.equal(r['world'], true);
    assert.equal(r['ledgerOpens'], true, 'the moved ledger must still open');
  });

  test('archiving moves the company aside and never deletes it', () => {
    const out = run(`
      const { Registry } = await import('${process.cwd()}/src/company/registry.ts');
      const { systemClock } = await import('${process.cwd()}/src/core/clock.ts');
      const r = new Registry(systemClock);
      const a = r.found({ name: 'Alpha Works', business: '', ceo: 'Ash', chair: 'Cali' });
      if (a.ok) a.company.world.writeCommons('doctrine/x.md', { title: 'x' }, 'body');
      const res = await r.archive('alpha-works');
      console.log(JSON.stringify({ res, left: r.list().length }));
    `);
    const r = JSON.parse(out) as { res: { ok: boolean; at: string }; left: number };
    assert.equal(r.res.ok, true);
    assert.equal(r.left, 0, 'it must leave the company list');
    assert.ok(existsSync(r.res.at), 'the directory must still exist');
    assert.ok(existsSync(join(r.res.at, 'world', 'commons', 'doctrine', 'x.md')),
      'the world and its documents must survive intact');
    assert.ok(existsSync(join(r.res.at, 'world', '.git')), 'git history must survive');
  });
});

describe('working, and staying that way', () => {
  test('a company records whether it should be working, and resumes', () => {
    // A scheduler lives in a process; the operator's intent does not. Restarting
    // the server used to pause everything while the console reported idle.
    const out = run(`
      const { Registry } = await import('${process.cwd()}/src/company/registry.ts');
      const { systemClock } = await import('${process.cwd()}/src/core/clock.ts');
      const first = new Registry(systemClock);
      first.found({ name: 'Alpha Works', business: '', ceo: 'Ash', chair: 'Cali' });
      first.found({ name: 'Beta Works', business: '', ceo: 'Bay', chair: 'Cali' });
      await first.setRunning('alpha-works', true);
      const wantedAfterStart = first.list().map((c) => [c.slug, c.wanted]);
      for (const c of first.opened()) { await c.scheduler.stop(); c.ledger.close(); }

      // A brand new process, exactly as a server restart would see it.
      const second = new Registry(systemClock);
      const beforeResume = second.list().map((c) => [c.slug, c.running]);
      const resumed = second.resume();
      const afterResume = second.list().map((c) => [c.slug, c.running]);
      for (const c of second.opened()) { await c.scheduler.stop(); c.ledger.close(); }
      console.log(JSON.stringify({ wantedAfterStart, beforeResume, resumed, afterResume }));
    `);
    const r = JSON.parse(out) as Record<string, any>;
    assert.deepEqual(r['wantedAfterStart'].sort(), [['alpha-works', true], ['beta-works', false]]);
    // Nothing runs until resume is called — opening a company must not start it.
    assert.deepEqual(r['beforeResume'].sort(), [['alpha-works', false], ['beta-works', false]]);
    assert.deepEqual(r['resumed'], ['alpha-works']);
    assert.deepEqual(r['afterResume'].sort(), [['alpha-works', true], ['beta-works', false]]);
  });

  test('pausing is remembered too, so a restart does not undo it', () => {
    const out = run(`
      const { Registry } = await import('${process.cwd()}/src/company/registry.ts');
      const { systemClock } = await import('${process.cwd()}/src/core/clock.ts');
      const r = new Registry(systemClock);
      r.found({ name: 'Alpha Works', business: '', ceo: 'Ash', chair: 'Cali' });
      await r.setRunning('alpha-works', true);
      await r.setRunning('alpha-works', false);
      for (const c of r.opened()) { await c.scheduler.stop(); c.ledger.close(); }
      const fresh = new Registry(systemClock);
      const resumed = fresh.resume();
      for (const c of fresh.opened()) { await c.scheduler.stop(); c.ledger.close(); }
      console.log(JSON.stringify({ wanted: fresh.list()[0].wanted, resumed }));
    `);
    assert.deepEqual(JSON.parse(out), { wanted: false, resumed: [] });
  });

  test('a run that ends on its own bound is remembered as stopped', () => {
    // Only the API wrote the flag, so a run that ended on maxTicks or a
    // deadline left `running: true` behind and the next process started the
    // company again — with the bound gone, because the bound lived only in
    // memory. Lathe's one-hour trial ended at 23:05 on 2026-09-07 and a
    // rebuild three hours later resumed it unbounded.
    //
    // maxTicks: 0 trips the bound on the first pass of the loop, before
    // anybody is selected, so this costs no shift.
    const out = run(`
      const { Registry } = await import('${process.cwd()}/src/company/registry.ts');
      const { systemClock } = await import('${process.cwd()}/src/core/clock.ts');
      const r = new Registry(systemClock);
      r.found({ name: 'Alpha Works', business: '', ceo: 'Ash', chair: 'Cali' });
      await r.setRunning('alpha-works', true, { maxTicks: 0 });
      // The loop is async; give it the one turn it needs to reach the bound.
      for (let i = 0; i < 50 && r.list()[0].running; i++) await new Promise((f) => setTimeout(f, 20));
      const stopped = !r.list()[0].running;
      for (const c of r.opened()) { await c.scheduler.stop(); c.ledger.close(); }

      const fresh = new Registry(systemClock);
      const resumed = fresh.resume();
      for (const c of fresh.opened()) { await c.scheduler.stop(); c.ledger.close(); }
      console.log(JSON.stringify({ stopped, wanted: fresh.list()[0].wanted, resumed }));
    `);
    assert.deepEqual(JSON.parse(out), { stopped: true, wanted: false, resumed: [] });
  });
});

describe('the legacy layout', () => {
  test('a company stored flat is moved into companies/, git and all', () => {
    // The first version put one company directly in ~/.riff. Anyone who
    // ran Riff before this existed has a live world there.
    const root = join(home, '.riff');
    mkdirSync(join(root, 'world', 'commons'), { recursive: true });
    writeFileSync(join(root, 'config.json'), JSON.stringify({
      version: 1, home: root, worldDir: join(root, 'world'), ledgerPath: join(root, 'ledger.db'),
      company: { name: 'Old Company', business: 'legacy' },
      board: [{ id: 'cali', name: 'Cali', role: 'Chairman' }],
      ceo: { id: 'vale', name: 'Vale' }, connectors: {},
    }));
    writeFileSync(join(root, 'ledger.db'), '');
    writeFileSync(join(root, 'world', 'commons', 'kept.md'), 'still here');
    execFileSync('git', ['-C', join(root, 'world'), 'init', '-q', '-b', 'main']);

    const out = run(`
      const { migrateLegacyLayout, listCompanies, resolveConfig } = await import('${process.cwd()}/src/core/config.ts');
      const moved = migrateLegacyLayout();
      const again = migrateLegacyLayout();
      console.log(JSON.stringify({ moved, again, list: listCompanies(), home: resolveConfig().home }));
    `);
    const r = JSON.parse(out) as Record<string, any>;
    assert.deepEqual(r['moved'], { moved: 'old-company' });
    assert.equal(r['again'], null, 'migration must be idempotent');
    assert.equal(r['list'][0].name, 'Old Company');

    const moved = join(root, 'companies', 'old-company');
    assert.ok(existsSync(join(moved, 'world', 'commons', 'kept.md')), 'documents must move');
    assert.ok(existsSync(join(moved, 'world', '.git')), 'the repository must move');
    assert.ok(!existsSync(join(root, 'world')), 'nothing may be left behind');
    // The stored config recorded absolute paths from the old location.
    assert.equal(r['home'], moved);
  });

  test('a fresh install has no legacy layout to move', () => {
    mkdirSync(join(home, '.riff'), { recursive: true });
    const out = run(`
      const { migrateLegacyLayout } = await import('${process.cwd()}/src/core/config.ts');
      console.log(JSON.stringify(migrateLegacyLayout()));
    `);
    assert.equal(JSON.parse(out), null);
  });
});

describe('naming a company when several exist', () => {
  test('one company is unambiguous; several without a name is refused', () => {
    const out = run(`
      const { Registry } = await import('${process.cwd()}/src/company/registry.ts');
      const { systemClock } = await import('${process.cwd()}/src/core/clock.ts');
      const { resolveConfig, isOperatorError } = await import('${process.cwd()}/src/core/config.ts');
      const r = new Registry(systemClock);
      r.found({ name: 'Alpha Works', business: '', ceo: 'Ash', chair: 'Cali' });
      const single = resolveConfig().company.name;
      r.found({ name: 'Beta Works', business: '', ceo: 'Bay', chair: 'Cali' });
      let refused = null;
      try { resolveConfig(); } catch (e) { refused = { operator: isOperatorError(e), msg: e.message }; }
      const named = resolveConfig(process.cwd(), 'beta-works').company.name;
      console.log(JSON.stringify({ single, refused, named }));
    `);
    const r = JSON.parse(out) as Record<string, any>;
    assert.equal(r['single'], 'Alpha Works', 'a lone company needs no naming');
    assert.equal(r['refused'].operator, true, 'ambiguity is an operator error, not a crash');
    assert.match(r['refused'].msg, /alpha-works, beta-works/);
    assert.equal(r['named'], 'Beta Works');
  });
});

describe('opening a company is not something that happened to it', () => {
  test('open and close leaves no trace in the log; a real pause still does', () => {
    // `stop` announced itself unconditionally, so every restart of the server
    // appended a `work.paused` describing nothing. An append-only log is only
    // worth reading if everything in it is an event.
    const out = run(`
      const { Registry } = await import('${process.cwd()}/src/company/registry.ts');
      const { systemClock } = await import('${process.cwd()}/src/core/clock.ts');
      const r = new Registry(systemClock);
      const a = r.found({ name: 'Quiet Co', business: 'x', ceo: 'Quill', chair: 'Cali' });
      if (!a.ok) throw new Error('found failed');
      const mark = a.company.ledger.latestSeq();
      await r.close('quiet-co');

      const kinds = [];
      for (let i = 0; i < 3; i++) {
        const again = new Registry(systemClock);
        const c = again.get('quiet-co');
        kinds.push(...c.ledger.eventsSince(mark).map((e) => e.kind));
        await again.close('quiet-co');
      }

      const last = new Registry(systemClock);
      await last.setRunning('quiet-co', true);
      await last.setRunning('quiet-co', false);
      const real = last.get('quiet-co').ledger.eventsSince(mark).map((e) => e.kind);
      console.log(JSON.stringify({ onOpen: kinds, real }));
    `);
    const r = JSON.parse(out) as { onOpen: string[]; real: string[] };
    assert.deepEqual(r.onOpen, [], 'opening a paused company must write nothing');
    assert.ok(r.real.includes('work.started'), 'starting is still recorded');
    assert.ok(r.real.includes('work.paused'), 'pausing something that was running is still recorded');
  });
});

describe('the environment seeds a company; it never renames one', () => {
  // The container sets RIFF_COMPANY and RIFF_CEO to placeholder defaults so a
  // fresh installation can bootstrap. Those used to win on every read, which
  // renamed every existing company "Untitled Company" and reported its CEO as
  // `ceo` — an id constitutionFor() makes the executive and the sole
  // treasurer, and genesis hires. Two real companies gained a phantom
  // executive before anyone noticed the label was wrong.
  const withEnv = (extra: string) => JSON.parse(execFileSync(process.execPath,
    ['--input-type=module', '-e', `
      const { Registry } = await import('${process.cwd()}/src/company/registry.ts');
      const { systemClock } = await import('${process.cwd()}/src/core/clock.ts');
      const { resolveConfig } = await import('${process.cwd()}/src/core/config.ts');
      const r = new Registry(systemClock);
      const a = r.found({ name: 'Real Co', business: 'real work', ceo: 'Vale', chair: 'Cali' });
      if (!a.ok) throw new Error('found failed');
      await r.close('real-co');
      const cfg = resolveConfig(process.cwd(), 'real-co');
      console.log(JSON.stringify({
        name: cfg.company.name, business: cfg.company.business,
        ceo: cfg.ceo, chair: cfg.board[0].name,
        staff: new Registry(systemClock).get('real-co').ledger.listAgents().map((x) => x.id).sort(),
      }));
    `],
    { encoding: 'utf8', cwd: process.cwd(),
      env: { ...process.env, HOME: home, RIFF_ROOT: join(home, '.riff'),
             RIFF_COMPANY_ID: '', ...JSON.parse(extra) } })) as Record<string, unknown>;

  test('placeholder identity in the environment leaves a real company alone', () => {
    const r = withEnv(JSON.stringify({
      RIFF_COMPANY: 'Untitled Company', RIFF_BUSINESS: '', RIFF_CEO: 'CEO', RIFF_CHAIR: 'Chair',
    }));
    assert.equal(r['name'], 'Real Co', 'the container default must not rename a company');
    assert.equal(r['business'], 'real work');
    assert.equal(r['chair'], 'Cali');
    assert.deepEqual(r['ceo'], { id: 'vale', name: 'Vale' },
      'the CEO id is the executive AND the treasurer — it must come from disk');
    // The phantom that bug produced: opening the company hired a second
    // executive nobody asked for.
    assert.deepEqual(r['staff'], ['cali', 'vale'], 'no phantom `ceo` may be hired');
  });

  test('with nothing stored, the environment still seeds a new company', () => {
    // Bootstrapping a container from environment alone must keep working.
    const r = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', `
      const { resolveConfig } = await import('${process.cwd()}/src/core/config.ts');
      const c = resolveConfig(process.cwd());
      console.log(JSON.stringify({ name: c.company.name, ceo: c.ceo.name }));
    `], { encoding: 'utf8', cwd: process.cwd(),
      env: { ...process.env, HOME: home, RIFF_ROOT: join(home, '.riff-empty'),
             RIFF_COMPANY_ID: '', RIFF_COMPANY: 'Seeded Co', RIFF_CEO: 'Ada' } })) as Record<string, unknown>;
    assert.equal(r['name'], 'Seeded Co');
    assert.equal(r['ceo'], 'Ada');
  });
});

describe('founding happens once', () => {
  // genesis re-asserted the board and the CEO from config.json on every open.
  // It read as self-healing and behaved as overwriting: upsertAgent's ON
  // CONFLICT clause sets activity, status, tier, role and mandate from config,
  // so a CEO a day into its work had its activity reset to "founding the
  // company" every time somebody looked at the company.
  test('opening a company does not rewrite what its staff are doing', () => {
    const out = run(`
      const { Registry } = await import('${process.cwd()}/src/company/registry.ts');
      const { systemClock } = await import('${process.cwd()}/src/core/clock.ts');
      const r = new Registry(systemClock);
      const a = r.found({ name: 'Steady Co', business: 'x', ceo: 'Vale', chair: 'Cali' });
      if (!a.ok) throw new Error('found failed');

      // The CEO gets to work, as it would on its first shift.
      a.company.ledger.setActivity('vale', 'shipping the seam test');
      const hired = a.company.ledger.getAgent('vale').hiredAt;
      await r.close('steady-co');

      // Somebody opens the company three times, as the console does.
      let seen = [];
      for (let i = 0; i < 3; i++) {
        const again = new Registry(systemClock);
        const v = again.get('steady-co').ledger.getAgent('vale');
        seen.push(v.activity);
        await again.close('steady-co');
      }
      const last = new Registry(systemClock).get('steady-co');
      console.log(JSON.stringify({
        seen,
        hiredUnchanged: last.ledger.getAgent('vale').hiredAt === hired,
        staff: last.ledger.listAgents().map((x) => x.id).sort(),
      }));
    `);
    const r = JSON.parse(out) as { seen: string[]; hiredUnchanged: boolean; staff: string[] };
    assert.deepEqual(r.seen, ['shipping the seam test', 'shipping the seam test', 'shipping the seam test'],
      'opening a company must not reset the CEO to "founding the company"');
    assert.equal(r.hiredUnchanged, true);
    assert.deepEqual(r.staff, ['cali', 'vale'], 'and must not hire anyone');
  });
});

describe('what someone says they are doing leaves a trace', () => {
  test('setting an activity is recorded; setting it to the same thing is not', () => {
    // activity was the one field with no history behind it, which is why two
    // CEOs overwritten with "founding the company" could not be recovered.
    const out = run(`
      const { Registry } = await import('${process.cwd()}/src/company/registry.ts');
      const { systemClock } = await import('${process.cwd()}/src/core/clock.ts');
      const r = new Registry(systemClock);
      const a = r.found({ name: 'Trace Co', business: 'x', ceo: 'Vale', chair: 'Cali' });
      if (!a.ok) throw new Error('found failed');
      const mark = a.company.ledger.latestSeq();
      a.company.ledger.setActivity('vale', 'reading the brief');
      a.company.ledger.setActivity('vale', 'reading the brief');   // no change
      a.company.ledger.setActivity('vale', 'writing the charter');
      const ev = a.company.ledger.eventsSince(mark).filter((e) => e.kind === 'agent.activity');
      console.log(JSON.stringify({
        count: ev.length,
        data: ev.map((e) => JSON.parse(e.dataJson)),
      }));
    `);
    const r = JSON.parse(out) as { count: number; data: Array<Record<string, string>> };
    assert.equal(r.count, 2, 'a repeated activity should not be recorded twice');
    assert.equal(r.data[0]!['activity'], 'reading the brief');
    assert.equal(r.data[1]!['activity'], 'writing the charter');
    assert.equal(r.data[1]!['from'], 'reading the brief', 'the previous value is what makes it recoverable');
  });
});

describe('founding says everything a founding decides', () => {
  // Every one of these was a manual config.json edit before the API grew the
  // field, and the board one was a live bug: the second seat was written in
  // after founding, so the roster never had it while the gate still read its
  // standing from config.
  test('a second board seat is seeded at founding, not written in afterwards', () => {
    const out = run(`
      const { Registry } = await import('${process.cwd()}/src/company/registry.ts');
      const { systemClock } = await import('${process.cwd()}/src/core/clock.ts');
      const r = new Registry(systemClock);
      const c = r.found({ name: 'Two Seats', business: 'b', ceo: 'Juno', chair: 'Cali',
                          board: [{ name: 'Marvin', role: 'Board' }] });
      if (!c.ok) throw new Error(c.reason);
      const rows = c.company.ledger.listAgents().filter((a) => a.tier === 'board');
      console.log(JSON.stringify(rows.map((a) => [a.id, a.role]).sort()));
    `);
    assert.deepEqual(JSON.parse(out), [['cali', 'Chairman'], ['marvin', 'Board']]);
  });

  test('a board seat may be a bare name, and takes the default role', () => {
    const out = run(`
      const { Registry } = await import('${process.cwd()}/src/company/registry.ts');
      const { systemClock } = await import('${process.cwd()}/src/core/clock.ts');
      const r = new Registry(systemClock);
      const c = r.found({ name: 'Bare Name', business: 'b', ceo: 'Juno', chair: 'Cali',
                          board: [{ name: 'Marvin' }] });
      if (!c.ok) throw new Error(c.reason);
      console.log(c.company.cfg.board.map((b) => b.id + ':' + b.role).join(','));
    `);
    assert.equal(out.trim(), 'cali:Chairman,marvin:Board');
  });

  test('a board seat sharing the CEO\'s name is refused, not silently overwritten', () => {
    // genesis seeds the board and then the CEO, both with upsertAgent. The
    // shared id replaced the board row with an executive one and left the
    // gate granting board standing to the CEO's own seat.
    const out = run(`
      const { Registry } = await import('${process.cwd()}/src/company/registry.ts');
      const { systemClock } = await import('${process.cwd()}/src/core/clock.ts');
      const r = new Registry(systemClock);
      const c = r.found({ name: 'Same Name', business: 'b', ceo: 'Juno', chair: 'Cali',
                          board: [{ name: 'Juno' }] });
      console.log(c.ok ? 'FOUNDED' : c.reason);
    `);
    assert.match(out, /cannot be both the CEO and on the board/);
  });

  test('two board seats with the same name are refused', () => {
    const out = run(`
      const { Registry } = await import('${process.cwd()}/src/company/registry.ts');
      const { systemClock } = await import('${process.cwd()}/src/core/clock.ts');
      const r = new Registry(systemClock);
      const c = r.found({ name: 'Twice Over', business: 'b', ceo: 'Juno', chair: 'Marvin',
                          board: [{ name: 'Marvin' }] });
      console.log(c.ok ? 'FOUNDED' : c.reason);
    `);
    assert.match(out, /two board members would both answer to marvin/);
  });

  test('policy and release route are set at founding and clamped on the way in', () => {
    const out = run(`
      const { Registry } = await import('${process.cwd()}/src/company/registry.ts');
      const { systemClock } = await import('${process.cwd()}/src/core/clock.ts');
      const r = new Registry(systemClock);
      const c = r.found({ name: 'Set At Founding', business: 'b', ceo: 'Juno', chair: 'Cali',
                          policy: { concurrency: 3, baseIntervalMinutes: 10, maxTurns: 99999 },
                          release: 'bundle' });
      if (!c.ok) throw new Error(c.reason);
      const p = c.company.cfg.policy;
      console.log(JSON.stringify({ concurrency: p.concurrency, interval: p.baseIntervalMinutes,
                                   maxTurns: p.maxTurns, release: c.company.cfg.release }));
    `);
    // 99999 turns is clamped to the ceiling rather than accepted or refused.
    assert.deepEqual(JSON.parse(out), { concurrency: 3, interval: 10, maxTurns: 400, release: 'bundle' });
  });

  test('an omitted policy is every default, not a policy of zeroes', () => {
    const out = run(`
      const { Registry } = await import('${process.cwd()}/src/company/registry.ts');
      const { DEFAULT_POLICY } = await import('${process.cwd()}/src/core/config.ts');
      const { systemClock } = await import('${process.cwd()}/src/core/clock.ts');
      const r = new Registry(systemClock);
      const c = r.found({ name: 'No Policy', business: 'b', ceo: 'Juno', chair: 'Cali' });
      if (!c.ok) throw new Error(c.reason);
      console.log(JSON.stringify(c.company.cfg.policy) === JSON.stringify(DEFAULT_POLICY)
        ? 'DEFAULTS' : JSON.stringify(c.company.cfg.policy));
    `);
    assert.equal(out.trim(), 'DEFAULTS');
  });

  test('an unknown release route is the safe one, not the bundle', () => {
    const out = run(`
      const { Registry } = await import('${process.cwd()}/src/company/registry.ts');
      const { systemClock } = await import('${process.cwd()}/src/core/clock.ts');
      const r = new Registry(systemClock);
      const c = r.found({ name: 'Odd Route', business: 'b', ceo: 'Juno', chair: 'Cali',
                          release: 'publish-everywhere' });
      if (!c.ok) throw new Error(c.reason);
      console.log(c.company.cfg.release);
    `);
    assert.equal(out.trim(), 'none');
  });
});

/** Bring the gateway up against the throwaway installation. */
const serve = async (): Promise<{ port: number; kill: () => void }> => {
  const port = 4400 + (process.pid % 400);
  const child = spawn(process.execPath, ['src/gateway/server.ts'], {
    cwd: process.cwd(), stdio: 'ignore',
    env: { ...process.env, HOME: home, RIFF_ROOT: join(home, '.riff'),
           RIFF_COMPANY_ID: '', PORT: String(port) },
  });
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 250));
    try { await fetch(`http://localhost:${port}/api/companies`); return { port, kill: () => child.kill('SIGTERM') }; }
    catch { /* not listening yet */ }
  }
  child.kill('SIGTERM');
  throw new Error('the gateway never came up');
};

describe('the API can found a company without anyone editing config.json', () => {
  test('a brief longer than a paragraph arrives whole', async () => {
    // It used to be sliced to 2000 characters with no error. Fathom's fifth
    // brief is 3755, and the cut landed four paragraphs before the one that
    // names the acceptance test — so the company was founded on instructions
    // that stopped mid-word and nobody was told.
    const brief = ('This company has no assigned field. ').repeat(120).trim();
    assert.ok(brief.length > 2000, 'the fixture has to be longer than the old cap');
    const { port, kill } = await serve();
    try {
      const r = await fetch(`http://localhost:${port}/api/companies`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Whole Brief', ceo: 'Juno', chair: 'Cali', business: brief,
          board: [{ name: 'Marvin', role: 'Board' }],
          policy: { concurrency: 3, baseIntervalMinutes: 10 },
          release: 'bundle', running: false,
        }),
      });
      const body = await r.json() as {
        slug: string; company: { business: string };
        board: Array<{ id: string }>; policy: { concurrency: number; baseIntervalMinutes: number };
        release: string; running: boolean;
      };
      assert.equal(r.status, 201, JSON.stringify(body));
      assert.equal(body.company.business.length, brief.length, 'the brief must not be truncated');
      assert.deepEqual(body.board.map((b) => b.id), ['cali', 'marvin']);
      assert.equal(body.policy.concurrency, 3);
      assert.equal(body.policy.baseIntervalMinutes, 10);
      assert.equal(body.release, 'bundle');
      assert.equal(body.running, false, 'running:false founds without spending anything');
    } finally { kill(); }
  });

  test('a brief past the ceiling is refused, so nobody founds on half of one', async () => {
    const { port, kill } = await serve();
    try {
      const r = await fetch(`http://localhost:${port}/api/companies`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Too Much', ceo: 'Juno', chair: 'Cali',
                               business: 'x'.repeat(20_001), running: false }),
      });
      const body = await r.json() as { error?: string };
      assert.equal(r.status, 400);
      assert.match(body.error ?? '', /20001 characters/);
      const listing = await (await fetch(`http://localhost:${port}/api/companies`)).json() as { companies: unknown[] };
      assert.deepEqual(listing.companies, [], 'and nothing was founded');
    } finally { kill(); }
  });
});

describe('what a script used to do, the API does', () => {
  test('an agent is renamed id and all, through one call', async () => {
    // The id is a foreign key in six tables and a folder name in the world, so
    // renaming by hand left an id nobody answers to scattered through both.
    const { port, kill } = await serve();
    try {
      await fetch(`http://localhost:${port}/api/companies`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Renaming Co', ceo: 'Ceo', chair: 'Cali', running: false }),
      });
      const r = await fetch(`http://localhost:${port}/api/agents/rename`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ company: 'renaming-co', who: 'ceo', name: 'Marlowe' }),
      });
      const body = await r.json() as { from?: string; to?: string; error?: string };
      assert.equal(r.status, 200, JSON.stringify(body));
      assert.deepEqual([body.from, body.to], ['ceo', 'marlowe']);

      const state = await (await fetch(`http://localhost:${port}/api/state?c=renaming-co`)).json() as
        { agents: Array<{ id: string; name: string }> };
      assert.ok(state.agents.some((a) => a.id === 'marlowe' && a.name === 'Marlowe'));
      assert.ok(!state.agents.some((a) => a.id === 'ceo'), 'the old id must be gone, not left beside it');
      assert.ok(existsSync(join(home, '.riff/companies/renaming-co/world/staff/marlowe')),
        'the world folder moves with the id');
    } finally { kill(); }
  });

  test('renaming onto a name someone already answers to is refused', async () => {
    const { port, kill } = await serve();
    try {
      await fetch(`http://localhost:${port}/api/companies`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Clash Co', ceo: 'Ceo', chair: 'Cali',
                               board: [{ name: 'Marlowe' }], running: false }),
      });
      const r = await fetch(`http://localhost:${port}/api/agents/rename`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ company: 'clash-co', who: 'ceo', name: 'Marlowe' }),
      });
      assert.equal(r.status, 409);
      assert.match((await r.json() as { error: string }).error, /already exists/);
    } finally { kill(); }
  });

  test('a world image is served, and nothing else is', async () => {
    // The commons is prose with screenshots in it — a vendor's own product,
    // a page somebody rendered — and a reader had to leave the console and go
    // and find the PNG on disk, because /api/doc hands back JSON.
    const { port, kill } = await serve();
    try {
      await fetch(`http://localhost:${port}/api/companies`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Gallery Co', ceo: 'Juno', chair: 'Cali', running: false }),
      });
      const world = join(home, '.riff/companies/gallery-co/world');
      mkdirSync(join(world, 'shots'), { recursive: true });
      // The eight bytes every PNG starts with, and enough of one to be a file.
      writeFileSync(join(world, 'shots/grid.png'),
        Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'));
      writeFileSync(join(world, 'shots/secret.env'), 'ANTHROPIC_API_KEY=sk-do-not-serve-this');

      const at = (q: string) => fetch(`http://localhost:${port}/api/file?c=gallery-co&path=${q}`);

      const img = await at('shots%2Fgrid.png');
      assert.equal(img.status, 200);
      assert.equal(img.headers.get('content-type'), 'image/png');
      assert.equal(img.headers.get('x-content-type-options'), 'nosniff',
        'an image must not be sniffed into being markup');
      assert.equal(Buffer.from(await img.arrayBuffer()).subarray(1, 4).toString(), 'PNG');

      // The world is full of things a model wrote. A console that serves any
      // file in it on request is one bad path from serving a pasted credential.
      assert.equal((await at('shots%2Fsecret.env')).status, 415, 'only images');
      assert.equal((await at('..%2F..%2F..%2F..%2Fetc%2Fhosts')).status, 415,
        'refused on the extension before the path is even resolved');
      assert.equal((await at('..%2F..%2Fconfig.json.png')).status, 403,
        'and a path leaving the world is refused even wearing an image name');
      assert.equal((await at('shots%2Fabsent.png')).status, 403);
    } finally { kill(); }
  });

  test('the board can retire a seat without the CEO proposing it first', async () => {
    // retire_role is a TOOL, so removal ran CEO-proposes / board-ratifies —
    // which has no route at all when the CEO is the seat to remove. A company
    // whose line of business the board had killed was left with a chief
    // executive who would have had to propose his own dismissal.
    const { port, kill } = await serve();
    try {
      await fetch(`http://localhost:${port}/api/companies`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Payroll Co', ceo: 'Juno', chair: 'Cali', running: false }),
      });
      const r = await fetch(`http://localhost:${port}/api/agents/retire`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ company: 'payroll-co', who: 'juno', why: 'the line of business is closed' }),
      });
      const body = await r.json() as { retired?: string; finishing?: boolean; error?: string };
      assert.equal(r.status, 200, JSON.stringify(body));
      assert.equal(body.retired, 'juno');
      assert.equal(body.finishing, false, 'nobody was mid-shift');

      const state = await (await fetch(`http://localhost:${port}/api/state?c=payroll-co`)).json() as
        { agents: Array<{ id: string }> };
      assert.ok(!state.agents.some((a) => a.id === 'juno'), 'a departed seat is off the roster');

      // The reason is the point of the record — a removal nobody wrote a
      // reason for is one nobody can review afterwards.
      const events = await (await fetch(`http://localhost:${port}/api/events?c=payroll-co`)).json() as
        { events: Array<{ kind: string; subject: string | null; dataJson: string | null }> };
      const gone = events.events.find((e) => e.kind === 'role.retired');
      assert.ok(gone, 'the ledger says it happened');
      assert.equal(gone?.subject, 'juno');
      const said = JSON.parse(gone?.dataJson ?? '{}') as Record<string, unknown>;
      assert.equal(said['why'], 'the line of business is closed');
      assert.equal(said['by'], 'board', 'and says the board did it, not a colleague');
    } finally { kill(); }
  });

  test('retiring refuses the board, a stranger, and a removal with no reason', async () => {
    // Standing comes from the constitution, so a board that can retire itself
    // can retire the only seat able to undo the retirement.
    const { port, kill } = await serve();
    try {
      await fetch(`http://localhost:${port}/api/companies`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Guarded Co', ceo: 'Juno', chair: 'Cali', running: false }),
      });
      const ask = (b: Record<string, string>) =>
        fetch(`http://localhost:${port}/api/agents/retire`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ company: 'guarded-co', ...b }),
        });

      assert.equal((await ask({ who: 'cali', why: 'no' })).status, 409, 'the board cannot be retired');
      assert.equal((await ask({ who: 'nobody', why: 'no' })).status, 404);
      assert.equal((await ask({ who: 'juno', why: '   ' })).status, 400, 'a reason is not optional');

      const state = await (await fetch(`http://localhost:${port}/api/state?c=guarded-co`)).json() as
        { agents: Array<{ id: string }> };
      assert.ok(state.agents.some((a) => a.id === 'juno'), 'and none of that removed anyone');

      // Twice is not a second removal.
      assert.equal((await ask({ who: 'juno', why: 'closing the seat' })).status, 200);
      assert.equal((await ask({ who: 'juno', why: 'again' })).status, 409);
    } finally { kill(); }
  });

  test('a second board member can speak, and nobody else can be spoken for', async () => {
    // /api/say sent as board[0] whatever it was told, so a board of two had
    // one voice and the second seat existed nowhere the company could hear it.
    const { port, kill } = await serve();
    try {
      const found = await fetch(`http://localhost:${port}/api/companies`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Two Voices', ceo: 'Juno',
                               board: [{ name: 'Cali' }, { name: 'Marvin' }], running: false }),
      });
      const founded = await found.json() as { board?: Array<{ id: string }>; error?: string };
      assert.equal(found.status, 201, JSON.stringify(founded));
      // Read the seats back rather than naming them: founding seeds a chair of
      // its own when none is given, so the ids are the server's to decide.
      const seats = founded.board?.map((m) => m.id) ?? [];
      assert.ok(seats.includes('cali') && seats.includes('marvin'), JSON.stringify(seats));
      const second = seats[seats.length - 1]!;

      const say = (b: Record<string, unknown>) =>
        fetch(`http://localhost:${port}/api/say?c=two-voices`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ to: 'juno', ...b }),
        });

      assert.equal((await say({ text: 'from the chair' })).status, 200);
      assert.equal((await say({ text: 'from the other seat', from: second })).status, 200);
      // The console authenticates as the operator, not as any agent, so naming
      // a staff member here would put words in a colleague's mouth.
      const impostor = await say({ text: 'not mine to send', from: 'juno' });
      assert.equal(impostor.status, 403);
      assert.match((await impostor.json() as { error: string }).error, /not on the board/);

      const box = await (await fetch(`http://localhost:${port}/api/inbox?c=two-voices&scope=all`)).json() as
        { messages: Array<{ from: string; body: string }> };
      const senders = [...new Set(box.messages.map((m) => m.from))].sort();
      assert.deepEqual(senders, [seats[0]!, second].sort(),
        'both seats are heard, and the impostor sent nothing');
    } finally { kill(); }
  });

  test('a run can be given a deadline and a wake-up budget', async () => {
    // An unattended run on somebody else's machine gets hard stops, because a
    // subscription window is shared with the person who owns it.
    const { port, kill } = await serve();
    try {
      await fetch(`http://localhost:${port}/api/companies`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Bounded Co', ceo: 'Ceo', chair: 'Cali', running: false }),
      });
      const r = await fetch(`http://localhost:${port}/api/companies/bounded-co/running`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ running: true, hours: 8, maxTicks: 40 }),
      });
      const body = await r.json() as { running: boolean; until?: string; maxTicks?: number };
      assert.equal(body.running, true);
      assert.equal(body.maxTicks, 40);
      assert.ok(body.until, 'a deadline was asked for and has to come back');
      assert.ok(Date.parse(body.until) > Date.now(), 'and it has to be in the future');
      await fetch(`http://localhost:${port}/api/companies/bounded-co/running`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ running: false }),
      });
    } finally { kill(); }
  });

  test('a run started without bounds is not held to the last run\'s', () => {
    // The bounds belong to the run. A deadline that outlived the run it was
    // set for would stop the next one before it began.
    const out = run(`
      const { Registry } = await import('${process.cwd()}/src/company/registry.ts');
      const { systemClock } = await import('${process.cwd()}/src/core/clock.ts');
      const r = new Registry(systemClock);
      const c = r.found({ name: 'Unbounded Co', business: 'b', ceo: 'Ceo', chair: 'Cali' });
      if (!c.ok) throw new Error(c.reason);
      await r.setRunning('unbounded-co', true, { until: Date.now() - 1000, maxTicks: 1 });
      await r.setRunning('unbounded-co', false);
      await r.setRunning('unbounded-co', true);
      const last = c.company.ledger.lastEvent(['work.started']);
      const o = JSON.parse(last.dataJson).options;
      console.log(JSON.stringify({ until: o.until, maxTicks: o.maxTicks }));
      await r.setRunning('unbounded-co', false);
    `);
    assert.deepEqual(JSON.parse(out), { until: null, maxTicks: null });
  });
});

describe('a fresh installation starts empty', () => {
  test('the server founds nothing, and still serves', async () => {
    // It used to found "Untitled Company" so a new checkout was never blank.
    // The first thing anyone saw was a company they had not asked for, sitting
    // next to the one they came to import — and importing is what a second
    // machine does first.
    const port = 4400 + (process.pid % 400);
    const child = spawn(process.execPath, ['src/gateway/server.ts'], {
      cwd: process.cwd(), stdio: 'ignore',
      env: { ...process.env, HOME: home, RIFF_ROOT: join(home, '.riff'),
             RIFF_COMPANY_ID: '', PORT: String(port) },
    });
    try {
      type Listing = { companies: unknown[] };
      let body: Listing | null = null;
      for (let i = 0; i < 40 && !body; i++) {
        await new Promise((r) => setTimeout(r, 250));
        try { body = await (await fetch(`http://localhost:${port}/api/companies`)).json() as Listing; }
        catch { /* not listening yet */ }
      }
      assert.ok(body, 'the server should come up against an empty installation');
      assert.deepEqual(body.companies, [], 'and found nothing on its own');
      // Deliberately not asserting the console renders: that needs desk/dist,
      // which this job does not build. The browser suite covers it.
    } finally { child.kill('SIGTERM'); }
  });
});

describe('a shift records how full its context got', () => {
  const staff = () => readFileSync(new URL('../src/runtime/staff.ts', import.meta.url), 'utf8');

  test('context is all three token fields, not the one called input', () => {
    // A live probe read input_tokens=2 against a 30,433-token context: the
    // rest sat in cache_creation on the first turn and cache_read after.
    // Watching only input_tokens is a threshold that can never be crossed.
    const src = staff();
    for (const f of ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']) {
      assert.ok(src.includes(`'${f}'`), `context must include ${f}`);
    }
  });

  test('the window comes from the agent\'s own model, not whichever is first', () => {
    // modelUsage carries an auxiliary Haiku at 200K next to a main model at
    // 1M. Keyed wrong, the percentage is measured against the wrong ceiling.
    assert.match(staff(), /modelUsage\?\.\[agent\.model\]\?\.contextWindow/);
  });

  test('a shift that never got a turn reports no context rather than zero', () => {
    // 0% meaning "unknown" is worse than a gap, because it averages.
    assert.match(staff(), /const context = \(\): Record<string, number> => \(contextTokens/);
  });

  test('compaction is recorded, because it means our own threshold was too high', () => {
    const src = staff();
    assert.match(src, /subtype === 'compact_boundary'/);
    assert.match(src, /'session\.compacted'/);
    assert.match(src, /preTokens: c\.pre_tokens/);
  });

  test('the sleep record carries it however the shift ended', () => {
    const slept = staff().match(/'agent\.slept'[^;]*/g) ?? [];
    assert.equal(slept.length, 1);
    assert.match(slept[0]!, /\.\.\.context\(\)/);
  });
});

describe('a shift records the ceiling it ran under', () => {
  test('the stale second default is gone, so the fallback cannot drift', () => {
    // staff.ts carried its own `?? 24` long after the ceiling moved to 60.
    // It never fired, because the scheduler always passes a value — which is
    // exactly why it sat there wrong.
    const staff = readFileSync(new URL('../src/runtime/staff.ts', import.meta.url), 'utf8');
    assert.ok(!/maxTurns: d\.maxTurns \?\? \d+/.test(staff),
      'the turn ceiling must fall back to DEFAULT_POLICY, not to a literal');
    assert.match(staff, /d\.maxTurns \?\? DEFAULT_POLICY\.maxTurns/);
  });

  test('agent.slept carries the ceiling, so 62 of 60 reads as finished not broken', () => {
    // num_turns counts the loop; maxTurns caps the model's turns. They differ
    // by a couple, so the count alone looks like the limit failed.
    const staff = readFileSync(new URL('../src/runtime/staff.ts', import.meta.url), 'utf8');
    const slept = staff.match(/'agent\.slept'[^;]*/g) ?? [];
    assert.equal(slept.length, 1, 'one place a shift is recorded, however it ended');
    assert.match(slept[0]!, /ceiling/);
    assert.match(slept[0]!, /truncated/, 'and whether the ceiling is what ended it');
  });

  test('the ceiling is caught where it actually arrives — the result, not the catch', () => {
    // SDK 0.3.243 does not throw on the turn ceiling. It returns a result with
    // subtype 'error_max_turns' and num_turns = maxTurns + 1; measured at
    // budgets of 3 and 6, with and without adaptive thinking. Watching only
    // the catch for /Reached maximum number of turns/ meant every truncated
    // shift was recorded as one that chose to stop: 119 shifts in
    // lafollett-labs, three of them cut at the ceiling, truncated never set.
    const staff = readFileSync(new URL('../src/runtime/staff.ts', import.meta.url), 'utf8');
    assert.match(staff, /m\.subtype === 'error_max_turns'\) truncated = true/,
      'a returned error_max_turns must mark the shift truncated');
  });

  test('a shift that ran more than one leg says so, so turns over ceiling explains itself', () => {
    // juno finished at 61 turns under a ceiling of 30 with no rotation and no
    // truncation, and the shift kept nothing that could say how. One leg
    // cannot do that, so more than one ran and left no trace.
    const staff = readFileSync(new URL('../src/runtime/staff.ts', import.meta.url), 'utf8');
    assert.match(staff, /legs\.push\(\{ budget: maxTurns, turns: m\.num_turns, subtype: m\.subtype \}\)/);
    const slept = (staff.match(/'agent\.slept'[^;]*/g) ?? [])[0]!;
    assert.match(slept, /legs\.length > 1 \|\| turns > ceiling/,
      'recorded only when the single number cannot explain the shift');
  });
});

describe('the house style is a cost control, not a preference', () => {
  const staff = () => readFileSync(new URL('../src/runtime/staff.ts', import.meta.url), 'utf8');

  test('it sits in the cached half of the context, not the volatile half', () => {
    // In buildTickPrompt it would be paid for again on every single wake-up,
    // which is the opposite of what it is there to do.
    const src = staff();
    const system = src.slice(src.indexOf('const buildSystemPrompt'), src.indexOf('const buildTickPrompt'));
    assert.match(system, /HOUSE_STYLE/);
    assert.doesNotMatch(src.slice(src.indexOf('const buildTickPrompt')), /HOUSE_STYLE/);
  });

  test('brevity is never asked for at the cost of a failure nobody then hears about', () => {
    assert.match(staff(), /never about substance/);
  });
});

describe('the founder can say more than a phrase about what to build', () => {
  test('a paragraph is set out on its own, not read into the middle of a sentence', () => {
    // "You are the CEO of X, a company in We are building tooling for teams
    // who…" — the brief was written assuming two or three words.
    const out = run(`
      const { Registry } = await import('${process.cwd()}/src/company/registry.ts');
      const { systemClock } = await import('${process.cwd()}/src/core/clock.ts');
      const r = new Registry(systemClock);
      const brief = 'We build instruments for people who work on boats.\\n\\n'
        + 'Not a platform. Not a marketplace. Physical sensors that survive salt water,'
        + ' and software plain enough to read on deck in the rain.';
      const a = r.found({ name: 'Tidewater', business: brief, ceo: 'Rook', chair: 'Cali' });
      if (!a.ok) throw new Error('found failed');
      const w = a.company.world;
      const persona = w.readDoc('staff/rook/persona.md').body;
      const charter = w.readDoc('constitution.md').body;

      const b = r.found({ name: 'Terse', business: 'marine sensing', ceo: 'Wren', chair: 'Cali' });
      if (!b.ok) throw new Error('second found failed');
      const short = b.company.world.readDoc('staff/wren/persona.md').body;

      console.log(JSON.stringify({
        opener: persona.split('\\n').find((l) => l.startsWith('You are the CEO')),
        personaKeepsBrief: persona.includes('survive salt water'),
        personaHeads: persona.includes('## What the founder set out'),
        charterKeepsBrief: charter.includes('survive salt water'),
        charterInlines: charter.includes('**Line of business:** We build'),
        mandate: a.company.ledger.getAgent('rook').mandate,
        shortOpener: short.split('\\n').find((l) => l.startsWith('You are the CEO')),
        shortMandate: b.company.ledger.getAgent('wren').mandate,
      }));
    `);
    const r = JSON.parse(out) as Record<string, unknown>;
    // The sentence stops at the company name rather than swallowing a paragraph.
    assert.equal(r['opener'], 'You are the CEO of **Tidewater**.');
    assert.equal(r['personaHeads'], true, 'the brief gets a heading of its own');
    assert.equal(r['personaKeepsBrief'], true, 'and every word of it survives');
    assert.equal(r['charterKeepsBrief'], true, 'the constitution carries it too');
    assert.equal(r['charterInlines'], false, 'but not squeezed onto a "Line of business:" line');
    assert.match(String(r['mandate']), /does real work in its field/,
      'a mandate is one line in a table; a paragraph does not belong in it');

    // A short line of business still reads exactly as it always did.
    assert.equal(r['shortOpener'], 'You are the CEO of **Terse**, a company in marine sensing.');
    assert.match(String(r['shortMandate']), /does real work in marine sensing/);
  });
});

describe('the whole company is readable, not only the board\'s slice', () => {
  test('a broadcast is one message again, however many rows it took', () => {
    // Sending to everyone writes one row per recipient. Read back as company
    // traffic that is one message, not four copies of it.
    const out = run(`
      const { Registry } = await import('${process.cwd()}/src/company/registry.ts');
      const { systemClock } = await import('${process.cwd()}/src/core/clock.ts');
      const r = new Registry(systemClock);
      const a = r.found({ name: 'Talkative', business: 'x', ceo: 'Vale', chair: 'Cali' });
      if (!a.ok) throw new Error('found failed');
      const l = a.company.ledger;
      l.upsertAgent({ id: 'ora', name: 'Ora', tier: 'lead', role: 'Head', department: '',
        reportsTo: 'vale', status: 'active', activity: '', mandate: '',
        hiredAt: systemClock.iso(), hiredBy: 'vale', model: 'm' });

      const fanout = l.sendMessage('vale', null, 'to the whole company');
      l.sendMessage('vale', 'ora', 'just for you');
      l.sendMessage('ora', 'vale', 'and back');

      const all = l.allMessages('cali');
      console.log(JSON.stringify({
        fanout,
        rows: l.db.prepare('SELECT COUNT(*) n FROM messages').get().n,
        collapsed: all.length,
        broadcasts: all.filter((m) => m.broadcast).map((m) => ({ to: m.to, body: m.body })),
        directed: all.filter((m) => !m.broadcast).map((m) => m.from + '->' + m.to).sort(),
        boardSlice: l.messagesFor('cali').length,
      }));
    `);
    const r = JSON.parse(out) as Record<string, unknown>;
    // The sender is not a recipient of their own broadcast.
    assert.equal(r['fanout'], 2, 'cali and ora each get a row; vale does not');
    assert.equal(r['rows'], 4, 'two broadcast rows plus two direct');
    assert.equal(r['collapsed'], 3, 'read back as three messages');
    assert.deepEqual(r['broadcasts'], [{ to: null, body: 'to the whole company' }],
      'a collapsed broadcast names no single recipient, because it had none');
    assert.deepEqual(r['directed'], ['ora->vale', 'vale->ora']);
    // And the board's own inbox is still just its slice.
    assert.equal(r['boardSlice'], 1, 'cali got the broadcast and nothing else');
  });

  test('your own unread mail stays unread when you widen the view', () => {
    // Reading the whole company dropped read state entirely, so your own
    // unread mail vanished the moment you looked past your own slice. Read
    // state belongs to a recipient — the viewer's row is the one that counts.
    const out = run(`
      const { Registry } = await import('${process.cwd()}/src/company/registry.ts');
      const { systemClock } = await import('${process.cwd()}/src/core/clock.ts');
      const r = new Registry(systemClock);
      const a = r.found({ name: 'Readable', business: 'x', ceo: 'Vale', chair: 'Cali' });
      if (!a.ok) throw new Error('found failed');
      const l = a.company.ledger;
      l.upsertAgent({ id: 'ora', name: 'Ora', tier: 'lead', role: 'Head', department: '',
        reportsTo: 'vale', status: 'active', activity: '', mandate: '',
        hiredAt: systemClock.iso(), hiredBy: 'vale', model: 'm' });

      l.sendMessage('vale', 'cali', 'for the chair');
      l.sendMessage('vale', 'ora', 'between colleagues');
      l.sendMessage('vale', null, 'to the whole company');

      const before = l.allMessages('cali');
      const mineBefore = before.filter((m) => m.yours && !m.readAt).map((m) => m.body).sort();

      // Marking one read from the whole-company view has to hit YOUR row: the
      // group's MIN(id) is usually somebody else's, and markRead is scoped to
      // to_agent, so a wrong id silently does nothing.
      const chairs = before.find((m) => m.body === 'for the chair');
      const marked = l.markRead('cali', [chairs.id], true);

      const after = l.allMessages('cali');
      console.log(JSON.stringify({
        mineBefore,
        overheardIsNotYours: before.find((m) => m.body === 'between colleagues').yours,
        broadcastIsYours: before.find((m) => m.body === 'to the whole company').yours,
        marked,
        mineAfter: after.filter((m) => m.yours && !m.readAt).map((m) => m.body).sort(),
        unreadCount: l.unreadCount('cali'),
      }));
    `);
    const r = JSON.parse(out) as Record<string, unknown>;
    assert.deepEqual(r['mineBefore'], ['for the chair', 'to the whole company'],
      'both of the things addressed to you, and nothing else');
    assert.equal(r['overheardIsNotYours'], false, 'mail between colleagues is not yours to read');
    assert.equal(r['broadcastIsYours'], true, 'a broadcast reached you like everyone else');
    assert.equal(r['marked'], 1, 'the id offered from the wide view is your own row');
    assert.deepEqual(r['mineAfter'], ['to the whole company']);
    assert.equal(r['unreadCount'], 1, 'and the sidebar agrees');
  });

  test('mail you sent is in your own inbox, not only in the whole-company view', () => {
    // Filtering the inbox on to_agent alone meant a message the board wrote
    // vanished the instant it was sent: an empty inbox, no evidence the send
    // had happened, and the scope toggle that would have shown it was itself
    // hidden by the empty list.
    const out = run(`
      const { Registry } = await import('${process.cwd()}/src/company/registry.ts');
      const { systemClock } = await import('${process.cwd()}/src/core/clock.ts');
      const r = new Registry(systemClock);
      const a = r.found({ name: 'Outbox', business: 'x', ceo: 'Vale', chair: 'Cali' });
      if (!a.ok) throw new Error('found failed');
      const l = a.company.ledger;
      l.upsertAgent({ id: 'ora', name: 'Ora', tier: 'lead', role: 'Head', department: '',
        reportsTo: 'vale', status: 'active', activity: '', mandate: '',
        hiredAt: systemClock.iso(), hiredBy: 'vale', model: 'm' });

      l.sendMessage('cali', 'vale', 'section one, before anything else');
      l.sendMessage('cali', ['vale', 'ora'], 'and hire someone');
      l.sendMessage('vale', 'ora', 'between colleagues');

      const mine = l.messagesFor('cali');
      console.log(JSON.stringify({
        bodies: mine.map((m) => m.body).sort(),
        fanoutCollapsed: mine.filter((m) => m.body === 'and hire someone').length,
        recipients: mine.find((m) => m.body === 'and hire someone'),
        sentIsNotYours: mine.find((m) => m.body === 'section one, before anything else').yours,
        unreadCount: l.unreadCount('cali'),
      }));
    `);
    const r = JSON.parse(out) as Record<string, unknown>;
    assert.deepEqual(r['bodies'], ['and hire someone', 'section one, before anything else'],
      'both of the things you sent, and none of the mail between colleagues');
    assert.equal(r['fanoutCollapsed'], 1, 'two recipients is still one message you wrote');
    const fanout = r['recipients'] as Record<string, unknown>;
    assert.equal(fanout['to'], 'ora');
    assert.deepEqual(fanout['alsoTo'], ['vale'], 'and it names everyone it went to');
    assert.equal(r['sentIsNotYours'], false,
      'a message you sent carries the recipient\'s read state, so it is not yours to mark');
    assert.equal(r['unreadCount'], 0, 'and writing to someone does not make you unread mail');
  });

  test('answering mail between two colleagues reaches both of them', () => {
    // Nobody can read a conversation they were left out of, so a reply that
    // went to the sender alone left the other half never knowing.
    const out = run(`
      const { Registry } = await import('${process.cwd()}/src/company/registry.ts');
      const { systemClock } = await import('${process.cwd()}/src/core/clock.ts');
      const r = new Registry(systemClock);
      const a = r.found({ name: 'Overheard', business: 'x', ceo: 'Vale', chair: 'Cali' });
      if (!a.ok) throw new Error('found failed');
      const l = a.company.ledger;
      l.upsertAgent({ id: 'ora', name: 'Ora', tier: 'lead', role: 'Head', department: '',
        reportsTo: 'vale', status: 'active', activity: '', mandate: '',
        hiredAt: systemClock.iso(), hiredBy: 'vale', model: 'm' });

      l.sendMessage('vale', 'ora', 'draft the pricing page');
      const delivered = l.sendMessage('cali', ['vale', 'ora'], 'talk to legal first');

      const reply = l.allMessages('cali').find((m) => m.from === 'cali');
      console.log(JSON.stringify({
        delivered,
        collapsed: l.allMessages('cali').length,
        broadcast: reply.broadcast,
        reached: [reply.to, ...reply.alsoTo].sort(),
        valeHeard: l.messagesFor('vale').some((m) => m.body === 'talk to legal first'),
        oraHeard: l.messagesFor('ora').some((m) => m.body === 'talk to legal first'),
      }));
    `);
    const r = JSON.parse(out) as Record<string, unknown>;
    assert.equal(r['delivered'], 2, 'both parties, not just the one who wrote');
    assert.equal(r['collapsed'], 2, 'the reply reads as one message, not two copies');
    assert.equal(r['broadcast'], false, 'naming two people is not telling everybody');
    assert.deepEqual(r['reached'], ['ora', 'vale']);
    assert.equal(r['valeHeard'], true);
    assert.equal(r['oraHeard'], true, 'the colleague who was written to hears it too');
  });
});

