import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

/**
 * Carrying a company to another machine.
 *
 * Same throwaway-HOME discipline as the registry tests: these import, export
 * and delete companies, and a test that can reach the operator's real ones is
 * not a test.
 */
const run = (script: string): string => {
  const home = process.env['TEST_HOME']!;
  return execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, RIFF_ROOT: join(home, '.riff'), RIFF_COMPANY_ID: '' },
    cwd: process.cwd(),
  });
};

const cwd = process.cwd();
const PRELUDE = `
  const { Registry } = await import('${cwd}/src/company/registry.ts');
  const { systemClock } = await import('${cwd}/src/core/clock.ts');
  const T = await import('${cwd}/src/company/transfer.ts');
`;

let home: string;
let out: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'riff-transfer-'));
  out = join(home, 'out');
  mkdirSync(out, { recursive: true });
  process.env['TEST_HOME'] = home;
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env['TEST_HOME'];
});

describe('a company travels whole', () => {
  test('export then import reproduces the ledger, the world and the git history', () => {
    const res = JSON.parse(run(`${PRELUDE}
      const r = new Registry(systemClock);
      const a = r.found({ name: 'Carry Works', business: 'moving things', ceo: 'Rune', chair: 'Cali' });
      if (!a.ok) throw new Error('found failed');
      a.company.ledger.emit('rune', 'test.marker', null, { n: 1 });
      a.company.world.writeCommons('commons/notes.md', { title: 'A note', author: 'rune' }, 'Body.');
      a.company.world.git.commitAs({ id: 'rune', name: 'Rune' }, 'a note');
      const seq = a.company.ledger.latestSeq();
      const commits = a.company.world.git.since('10.years').length;
      await r.close('carry-works');

      const file = '${out}/carry.tar.gz';
      const manifest = T.exportCompany('carry-works', file);

      // Arriving alongside the original, which must be left alone.
      const landed = T.importCompany(file);
      const r2 = new Registry(systemClock);
      const back = r2.get(landed.slug);
      console.log(JSON.stringify({
        manifest,
        slug: landed.slug,
        renamed: landed.renamed,
        seqBefore: seq, seqAfter: back.ledger.latestSeq(),
        commitsBefore: commits,
        historyAfter: back.world.git.since('10.years').map((c) => c.subject + ' — ' + c.author),
        doc: back.world.readDoc('commons/notes.md')?.body.trim(),
        name: back.cfg.company.name,
        slugs: r2.list().map((c) => c.slug).sort(),
      }));
    `)) as Record<string, unknown>;

    // The slug it came from is taken, so it lands beside it rather than on it.
    assert.equal(res['slug'], 'carry-works-2');
    assert.equal(res['renamed'], true);
    assert.deepEqual(res['slugs'], ['carry-works', 'carry-works-2']);

    // Everything that made it a company came with it.
    assert.equal(res['seqAfter'], res['seqBefore']);
    assert.equal(res['doc'], 'Body.');
    assert.equal(res['name'], 'Carry Works');
    assert.equal((res['manifest'] as Record<string, unknown>)['name'], 'Carry Works');

    // Including the history — an export you cannot `git log` is a screenshot.
    // Counting is the wrong check: opening a company commits any scaffolding
    // it finds missing, so a fresh handle legitimately sits one ahead. What
    // must survive is the work itself, still attributed to whoever did it.
    const history = res['historyAfter'] as string[];
    assert.ok(Number(res['commitsBefore']) > 0, 'the world repo should carry commits');
    assert.ok(history.some((c) => c.startsWith('a note') && c.endsWith('Rune')),
      `Rune's commit did not survive the trip: ${JSON.stringify(history)}`);
  });

  test('the audit of what it did travels with it', () => {
    // The transcript store is its own db beside the ledger; a move that carried
    // the ledger but not the audit would land a company with no record of how it
    // got where it is.
    const res = JSON.parse(run(`${PRELUDE}
      const r = new Registry(systemClock);
      const a = r.found({ name: 'Auditco', business: 'x', ceo: 'Ada', chair: 'Cali' });
      if (!a.ok) throw new Error('found failed');
      a.company.transcript.append({ sessionId: 's1', agentId: 'ada', role: 'assistant', kind: 'text', text: 'did the thing' });
      a.company.transcript.append({ sessionId: 's1', agentId: 'ada', role: 'assistant', kind: 'tool_use', name: 'Bash', text: '{}' });
      await r.close('auditco');

      const file = '${out}/audit.tar.gz';
      T.exportCompany('auditco', file);
      const landed = T.importCompany(file);
      const r2 = new Registry(systemClock);
      const back = r2.get(landed.slug);
      const turns = back.transcript.bySession('s1');
      console.log(JSON.stringify({ n: turns.length, kinds: turns.map((t) => t.kind), first: turns[0] ? turns[0].text : null }));
    `)) as Record<string, unknown>;
    assert.equal(res['n'], 2, 'both recorded blocks arrived');
    assert.deepEqual(res['kinds'], ['text', 'tool_use']);
    assert.equal(res['first'], 'did the thing');
  });

  test('a company folder can simply be moved, because it never says where it is', () => {
    // The config used to carry absolute home/worldDir/ledgerPath, so a company
    // that arrived from another machine pointed at that machine's disk — and
    // won over the folder it was actually sitting in.
    const res = JSON.parse(run(`${PRELUDE}
      const { renameSync, readFileSync } = await import('node:fs');
      const { companyHome, companiesDir } = await import('${cwd}/src/core/config.ts');
      const r = new Registry(systemClock);
      const a = r.found({ name: 'Nomad', business: 'x', ceo: 'Nell', chair: 'Cali' });
      if (!a.ok) throw new Error('found failed');
      a.company.ledger.emit('nell', 'test.marker', null, {});
      const seq = a.company.ledger.latestSeq();
      await r.close('nomad');

      const stored = JSON.parse(readFileSync(companyHome('nomad') + '/config.json', 'utf8'));

      // A plain directory rename, with nothing else touched.
      renameSync(companyHome('nomad'), companiesDir() + '/wanderer');

      const r2 = new Registry(systemClock);
      const moved = r2.get('wanderer');
      console.log(JSON.stringify({
        storedKeys: Object.keys(stored).sort(),
        slugs: r2.list().map((c) => c.slug),
        home: moved.cfg.home,
        expected: companyHome('wanderer'),
        seq: moved.ledger.latestSeq(),
        name: moved.cfg.company.name,
      }));
    `)) as Record<string, unknown>;

    // Nothing on disk claims to know where the company is.
    assert.deepEqual(res['storedKeys'],
      ['board', 'ceo', 'company', 'connectors', 'policy', 'release', 'services', 'staff', 'version']);

    // So moving the folder is all it takes.
    assert.deepEqual(res['slugs'], ['wanderer']);
    assert.equal(res['home'], res['expected']);
    assert.equal(res['seq'], 2);
    assert.equal(res['name'], 'Nomad');
  });

  test('the config that arrives describes this machine, not the one it left', () => {
    const res = JSON.parse(run(`${PRELUDE}
      const r = new Registry(systemClock);
      const a = r.found({ name: 'Pathy', business: 'x', ceo: 'Pat', chair: 'Cali' });
      if (!a.ok) throw new Error('found failed');
      await r.close('pathy');
      const file = '${out}/p.tar.gz';
      T.exportCompany('pathy', file);

      // Simulate arriving somewhere else by importing under a new name.
      const landed = T.importCompany(file, { name: 'Pathy Two' });
      const { readFileSync } = await import('node:fs');
      const { companyHome } = await import('${cwd}/src/core/config.ts');
      const home = companyHome(landed.slug);
      const cfg = JSON.parse(readFileSync(home + '/config.json', 'utf8'));
      console.log(JSON.stringify({ slug: landed.slug, cfg, home }));
    `)) as Record<string, unknown>;

    const cfg = res['cfg'] as Record<string, unknown>;
    assert.equal(res['slug'], 'pathy-two');
    assert.equal((cfg['company'] as Record<string, unknown>)['name'], 'Pathy Two');
    // The paths of whichever machine wrote it do not travel at all.
    assert.equal(cfg['home'], undefined);
    assert.equal(cfg['worldDir'], undefined);
    assert.equal(cfg['ledgerPath'], undefined);
  });

  test('a session id does not travel — it means nothing on the other machine', () => {
    // The runtime keeps conversations wherever it keeps them; in the container
    // that is a tmpfs. The id lives in the ledger, on the durable volume. Ship
    // the ledger to somebody else and every agent tries to resume a transcript
    // that was never on their disk, and every shift fails on arrival.
    const res = JSON.parse(run(`${PRELUDE}
      const r = new Registry(systemClock);
      const a = r.found({ name: 'Chatty Co', business: 'x', ceo: 'Vale', chair: 'Cali' });
      if (!a.ok) throw new Error('found failed');
      a.company.ledger.setMeta('session:vale', 'a-transcript-only-this-machine-has');
      a.company.ledger.setMeta('applied:apr_x', 'keep me');
      await r.close('chatty-co');

      const file = '${out}/chatty.tar.gz';
      T.exportCompany('chatty-co', file);
      const landed = T.importCompany(file);
      const back = new Registry(systemClock).get(landed.slug);
      console.log(JSON.stringify({
        session: back.ledger.getMeta('session:vale'),
        other: back.ledger.getMeta('applied:apr_x'),
      }));
    `)) as Record<string, unknown>;
    assert.equal(res['session'], null, 'the session id must not survive the trip');
    assert.equal(res['other'], 'keep me', 'but other meta is the company\'s own state');
  });

  test('an imported company arrives paused, whatever it was doing when it left', () => {
    // Someone else's company spending your subscription the moment the copy
    // finishes is not a feature.
    const res = JSON.parse(run(`${PRELUDE}
      const r = new Registry(systemClock);
      const a = r.found({ name: 'Busy Co', business: 'x', ceo: 'Bee', chair: 'Cali' });
      if (!a.ok) throw new Error('found failed');
      await r.setRunning('busy-co', true);
      const wantedBefore = r.list().find((c) => c.slug === 'busy-co').wanted;
      await r.close('busy-co');
      const file = '${out}/b.tar.gz';
      T.exportCompany('busy-co', file);
      const landed = T.importCompany(file);
      const r2 = new Registry(systemClock);
      const ref = r2.list().find((c) => c.slug === landed.slug);
      console.log(JSON.stringify({ wantedBefore, wantedAfter: ref.wanted, running: ref.running }));
    `)) as Record<string, unknown>;
    assert.equal(res['wantedBefore'], true);
    assert.equal(res['wantedAfter'], false);
    assert.equal(res['running'], false);
  });
});

/**
 * A tar member with `..` in its path, built by hand.
 *
 * Both GNU tar and bsdtar refuse to *store* one, which is precisely why the
 * importer cannot assume its input came from tar. A ustar header is 512 bytes
 * of mostly padding; writing one is the only honest way to prove the check.
 */
const HOSTILE_TAR = `
  const header = (name, size) => {
    const h = Buffer.alloc(512);
    h.write(name, 0, 100, 'utf8');
    h.write('0000644\\0', 100, 8);            // mode
    h.write('0000000\\0', 108, 8);            // uid
    h.write('0000000\\0', 116, 8);            // gid
    h.write(size.toString(8).padStart(11, '0') + '\\0', 124, 12);
    h.write('00000000000\\0', 136, 12);       // mtime
    h.write('        ', 148, 8);              // checksum, spaces while summing
    h.write('0', 156, 1);                     // typeflag: regular file
    h.write('ustar\\0', 257, 6);
    h.write('00', 263, 2);
    let sum = 0; for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, '0') + '\\0 ', 148, 8);
    return h;
  };
  const member = (name, body) => {
    const data = Buffer.from(body);
    const pad = Buffer.alloc((512 - (data.length % 512)) % 512);
    return Buffer.concat([header(name, data.length), data, pad]);
  };
  const write = (path, members) =>
    writeFileSync(path, gzipSync(Buffer.concat([...members, Buffer.alloc(1024)])));
`;

describe('an archive from someone else is data, not a promise', () => {
  const refuses = (build: string, expect: RegExp): void => {
    const res = JSON.parse(run(`${PRELUDE}
      const { execFileSync } = await import('node:child_process');
      const { mkdirSync, writeFileSync, symlinkSync, existsSync } = await import('node:fs');
      const { gzipSync } = await import('node:zlib');
      ${HOSTILE_TAR}
      ${build}
      let error = null;
      try { T.importCompany('${out}/evil.tar.gz'); } catch (e) { error = e.message; }
      console.log(JSON.stringify({ error, escaped: existsSync('${home}/pwned') }));
    `)) as Record<string, unknown>;
    assert.match(String(res['error'] ?? ''), expect);
    assert.equal(res['escaped'], false, 'nothing may be written outside the company directory');
  };

  test('a member that climbs out of the directory is refused before extraction', () => {
    // ../../../pwned is a legal tar member. By the time you notice it in the
    // output directory it has already been written somewhere else.
    refuses(`
      write('${out}/evil.tar.gz', [
        member('riff.json', JSON.stringify({ format: 1, slug: 'e', name: 'E', business: '', exportedAt: '', counts: {} })),
        member('../../pwned', 'owned'),
      ]);
    `, /outside the company directory/);
  });

  test('an absolute member is refused too', () => {
    refuses(`
      write('${out}/evil.tar.gz', [
        member('riff.json', '{"format":1}'),
        member('${home}/pwned', 'owned'),
      ]);
    `, /outside the company directory/);
  });

  test('a symbolic link in the world is refused', () => {
    // A link inside a world escapes the path classifier, which resolves
    // lexically and never follows one.
    refuses(`
      const stage = '${home}/evil'; mkdirSync(stage + '/world', { recursive: true });
      writeFileSync(stage + '/config.json', JSON.stringify({ company: { name: 'x', business: '' } }));
      writeFileSync(stage + '/ledger.db', '');
      writeFileSync(stage + '/riff.json', JSON.stringify({ format: 1, slug: 'evil', name: 'Evil', business: '', exportedAt: '', counts: {} }));
      symlinkSync('/etc/passwd', stage + '/world/leak');
      execFileSync('tar', ['-czf', '${out}/evil.tar.gz', '-C', stage, '.']);
    `, /symbolic link/);
  });

  test('an export from a newer Riff is refused, not half-read', () => {
    refuses(`
      const stage = '${home}/evil'; mkdirSync(stage, { recursive: true });
      writeFileSync(stage + '/config.json', '{}');
      writeFileSync(stage + '/ledger.db', '');
      writeFileSync(stage + '/riff.json', JSON.stringify({ format: 99, slug: 'e', name: 'E', business: '', exportedAt: '', counts: {} }));
      execFileSync('tar', ['-czf', '${out}/evil.tar.gz', '-C', stage, '.']);
    `, /newer Riff/);
  });

  test('a tarball that is not a company is refused by name, not by stack trace', () => {
    refuses(`
      const stage = '${home}/evil'; mkdirSync(stage, { recursive: true });
      writeFileSync(stage + '/holiday.jpg', 'not a company');
      execFileSync('tar', ['-czf', '${out}/evil.tar.gz', '-C', stage, '.']);
    `, /no riff\.json/);
  });
});
