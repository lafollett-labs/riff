import { test, describe, beforeEach, afterEach, mock } from 'node:test';
import { syncBuiltinESMExports } from 'node:module';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, symlinkSync, writeFileSync, readFileSync, existsSync, realpathSync } from 'node:fs';
import cp, { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { World, commonsPath } from '../src/worldfs/world.ts';
import { HOLD_BYTES } from '../src/worldfs/git.ts';
import { parse, stringify } from '../src/worldfs/frontmatter.ts';
import { Ledger } from '../src/ledger/ledger.ts';
import { fixedClock } from '../src/core/clock.ts';

let dir: string;
let world: World;
const clock = fixedClock('2026-08-24T14:30:00.000Z');

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'riff-'));
  world = new World(join(dir, 'world'), clock);
  world.ensure();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('path containment — staff choose these strings, so this is a trust boundary', () => {
  test('rejects ../ traversal', () => {
    assert.throws(() => world.path('../../../etc/passwd'), /escapes the world/);
  });

  test('rejects absolute paths', () => {
    assert.throws(() => world.path('/etc/passwd'), /escapes the world/);
  });

  test('rejects traversal buried mid-path', () => {
    assert.throws(() => world.path('staff/greg/../../../../tmp/pwned'), /escapes the world/);
  });

  test('rejects a symlink planted inside the world', () => {
    const outside = join(dir, 'outside');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'secret.md'), 'not yours');
    symlinkSync(outside, join(world.root, 'commons', 'escape'));
    assert.throws(() => world.path('commons/escape/secret.md'), /symlink/);
  });

  test('allows ordinary paths, including files that do not exist yet', () => {
    assert.doesNotThrow(() => world.path('staff/greg/notes/new-note.md'));
    assert.doesNotThrow(() => world.path('commons/morale.md'));
  });
});

describe('frontmatter is total — a fumbled brief must not take the company down', () => {
  test('round-trips scalars, arrays and booleans', () => {
    const doc = { data: { author: 'greg', count: 42, active: true, tags: ['etsy', 'listings'] }, body: '# Hello\n' };
    const back = parse(stringify(doc));
    assert.deepEqual(back.data, doc.data);
    assert.equal(back.body, doc.body);
  });

  test('dates and zero-padded ids stay strings', () => {
    const back = parse('---\nday: 2026-08-24\nid: 007\n---\nbody\n');
    assert.equal(back.data['day'], '2026-08-24');
    assert.equal(back.data['id'], '007');
  });

  test('malformed frontmatter degrades instead of throwing', () => {
    assert.doesNotThrow(() => parse('---\nthis line has no colon\n: nokey\nok: fine\n---\nbody'));
    const d = parse('---\nthis line has no colon\nok: fine\n---\nbody');
    assert.equal(d.data['ok'], 'fine');
  });

  test('a file with no frontmatter is all body', () => {
    const d = parse('just prose, no fence\n');
    assert.deepEqual(d.data, {});
    assert.equal(d.body, 'just prose, no fence\n');
  });
});

describe('notes — the 742-notes mechanic', () => {
  test('a note is indexed and findable by subject', () => {
    const ledger = new Ledger(':memory:', clock);
    ledger.upsertAgent({
      id: 'greg', name: 'Greg', tier: 'lead', role: 'Head of Product',
      department: 'product', reportsTo: null, status: 'active',
      activity: '', mandate: '', hiredAt: clock.iso(), hiredBy: null, model: 'claude-opus-5', effort: 'company',
    });
    world.ensureStaff('greg');
    world.writeNote('greg', 'dennis', 'Dennis carried the listings', 'He did most of the work today.');

    assert.equal(world.reindexNotes(ledger), 1);
    assert.equal(ledger.countNotes(), 1);
    const about = ledger.notesAbout('dennis');
    assert.equal(about.length, 1);
    assert.equal(about[0]!.author, 'greg');
  });

  test('two notes on the same colleague the same day append, never clobber', () => {
    world.ensureStaff('greg');
    const rel = world.writeNote('greg', 'dennis', 'first', 'Morning observation.');
    world.writeNote('greg', 'dennis', 'second', 'Afternoon revision.');
    const body = world.readDoc(rel)!.body;
    assert.match(body, /Morning observation/);
    assert.match(body, /Afternoon revision/, 'second note overwrote the first');
  });
});

describe('git — the world owns its own history', () => {
  test('a world nested inside another repo still gets its OWN repo', () => {
    // The real deployment shape: world/ lives inside the project repo.
    // `rev-parse --git-dir` walks up, so a naive "is this a repo?" check
    // answers yes and every commit silently lands in the PARENT repo.
    const outer = mkdtempSync(join(tmpdir(), 'outer-'));
    execFileSync('git', ['-C', outer, 'init', '-q', '-b', 'main']);

    const nested = new World(join(outer, 'world'));
    nested.ensure();
    assert.ok(existsSync(join(nested.root, '.git')), 'world/ must have its own .git');

    const top = execFileSync('git', ['-C', nested.root, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
    assert.equal(realpathSync(top), realpathSync(nested.root), 'commits would land in the parent repo');

    nested.ensureStaff('greg');
    nested.writeNote('greg', null, 'first', 'a note');
    nested.git.commitAs({ id: 'greg', name: 'Greg' }, 'greg writes');

    // The parent repo must be entirely untouched by world activity.
    // rev-list --count works on an empty repo; `git log` exits 128 there.
    const outerCommits = execFileSync('git', ['-C', outer, 'rev-list', '--count', '--all'], { encoding: 'utf8' }).trim();
    assert.equal(outerCommits, '0', 'world commits leaked into the parent repo');

    // ...and the world's own history holds Greg's work. Asserting on authors
    // rather than a raw count, so setup commits do not make this brittle.
    const authors = nested.git.since('1.hour').map((c) => c.author);
    assert.deepEqual(authors.filter((a) => a === 'Greg'), ['Greg']);
    rmSync(outer, { recursive: true, force: true });
  });
});

describe('git — attribution is the audit trail', () => {
  test('commits are authored as the staff member who acted', () => {
    world.ensureStaff('greg');
    world.writeNote('greg', 'dennis', 'observation', 'Something worth recording.');
    const sha = world.git.commitAs({ id: 'greg', name: 'Greg' }, 'note: dennis carried the listings');
    assert.ok(sha, 'expected a commit');

    // Absolute, from the clock that stamped it — see the note below on why
    // a git relative date cannot see a world running on a frozen clock.
    const log = world.git.since(new Date(clock.now().getTime() - 3_600_000).toISOString());
    assert.ok(sha.startsWith(log[0]!.sha), 'the newest commit should be the one just made');
    assert.equal(log[0]!.author, 'Greg', 'commit must be attributed to the staff member');
  });

  test('committing nothing is a no-op, not an error', () => {
    assert.equal(world.git.commitAs({ id: 'greg', name: 'Greg' }, 'empty'), null);
  });

  test('contributions since is the honest "who actually worked" list', () => {
    world.ensureStaff('greg'); world.ensureStaff('dennis');
    world.writeNote('greg', null, 'a', 'x');
    world.git.commitAs({ id: 'greg', name: 'Greg' }, 'greg works');
    world.writeNote('dennis', null, 'b', 'y');
    world.git.commitAs({ id: 'dennis', name: 'Dennis' }, 'dennis works');
    world.writeNote('dennis', null, 'c', 'z');
    world.git.commitAs({ id: 'dennis', name: 'Dennis' }, 'dennis works more');

    // Asked against the clock the commits were stamped with, not the
    // machine's. Git relative dates like '1.hour' resolve against real now,
    // and this world runs on a clock frozen in August — under which every
    // commit here is correctly dated and none of them is in the last hour.
    const c = world.git.contributionsSince(
      new Date(clock.now().getTime() - 3_600_000).toISOString());
    assert.equal(c[0]!.author, 'Dennis');
    assert.equal(c[0]!.commits, 2);
  });
});

describe('git — a build left behind is not committed in anyone\'s name', () => {
  const elf = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]), Buffer.alloc(64)]);
  const macho = Buffer.concat([Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 7, 0, 0, 1]), Buffer.alloc(64)]);
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);
  const tracked = () => execFileSync('git', ['-C', world.root, 'ls-files'], { encoding: 'utf8' });
  const untracked = () => execFileSync('git', ['-C', world.root, 'ls-files', '--others', '--exclude-standard'],
    { encoding: 'utf8' });

  test('a compiled program next to real work stays in the tree, untracked, and the commit carries the work', () => {
    // As on 2026-09-24: `go build` left `explain` where it ran, and the shift's
    // closing commit put 5.7 MB of it into history in its author's name.
    const said: Array<[string, unknown]> = [];
    world.git.onHeld = (actor, held) => said.push([actor, held]);
    world.ensureStaff('lynn');
    writeFileSync(world.path('staff/lynn/explain'), elf);
    writeFileSync(world.path('staff/lynn/explain-mac'), macho);
    world.writeNote('lynn', null, 'a', 'real work');
    assert.ok(world.git.commitAs({ id: 'lynn', name: 'Lynn' }, 'lynn works'));

    assert.doesNotMatch(tracked(), /explain/);
    assert.match(tracked(), /staff\/lynn\/notes\//);
    assert.match(untracked(), /staff\/lynn\/explain\n/, 'left where it was built');
    assert.deepEqual(said, [['lynn', [
      { path: 'staff/lynn/explain', why: 'executable' },
      { path: 'staff/lynn/explain-mac', why: 'executable' },
    ]]]);
  });

  test('a file over the size line is held; a picture the staff made is committed', () => {
    world.ensureStaff('lynn');
    writeFileSync(world.path('staff/lynn/dump.json'), Buffer.alloc(HOLD_BYTES + 1, 0x20));
    writeFileSync(world.path('staff/lynn/chart.png'), png);
    world.git.commitAs({ id: 'lynn', name: 'Lynn' }, 'lynn works');
    assert.doesNotMatch(tracked(), /dump\.json/);
    assert.match(tracked(), /staff\/lynn\/chart\.png/);
  });

  test('a held file is never hashed into the repository, and is told of once', () => {
    const said: unknown[] = [];
    world.git.onHeld = (_actor, held) => said.push(held.map((h) => h.path));
    world.ensureStaff('lynn');
    writeFileSync(world.path('staff/lynn/explain'), elf);
    world.writeNote('lynn', null, 'a', 'one');
    world.git.commitAs({ id: 'lynn', name: 'Lynn' }, 'lynn works');
    world.writeNote('lynn', null, 'b', 'two');
    world.git.commitAs({ id: 'dana', name: 'Dana' }, 'dana works');
    const blob = execFileSync('git', ['-C', world.root, 'hash-object', 'staff/lynn/explain'], { encoding: 'utf8' }).trim();
    assert.throws(() => execFileSync('git', ['-C', world.root, 'cat-file', '-e', blob], { stdio: 'ignore' }));
    assert.deepEqual(said, [['staff/lynn/explain']], 'once, not again on the next commit beside it');
  });

  test('a name with a tab in it holds that file, and no tracked file beside it', () => {
    // Parsed from a tab-separated listing, `tool\tchart` once read as `tool`,
    // and the tracked `tool` was dropped from the next commit.
    world.ensureStaff('lynn');
    writeFileSync(world.path('staff/lynn/tool'), 'a tracked script');
    world.git.commitAs({ id: 'lynn', name: 'Lynn' }, 'lynn writes');
    writeFileSync(world.path('staff/lynn/tool\tchart'), elf);
    writeFileSync(world.path('staff/lynn/tool'), 'a tracked script, edited');
    assert.ok(world.git.commitAs({ id: 'lynn', name: 'Lynn' }, 'lynn edits'));
    const files = tracked();
    assert.match(files, /staff\/lynn\/tool\n/);
    assert.doesNotMatch(files, /chart/);
  });

  test('a commit beside many held files hands git nothing that grows with them', () => {
    // One exclusion per held file is matched against every path in the tree:
    // 30,000 stubs beside 4,000 files made each commit take 8 s, and 140,000
    // took it past its time limit and stopped git for the company.
    world.ensureStaff('lynn');
    mkdirSync(world.path('staff/lynn/obj'));
    for (let i = 0; i < 5_000; i++) writeFileSync(world.path(`staff/lynn/obj/u${i}.o`), elf);
    world.writeNote('lynn', null, 'a', 'real work');
    let handed = 0;
    const real = cp.execFileSync;
    mock.method(cp, 'execFileSync', ((cmd: string, args: string[], opts: { input?: string }) => {
      if (cmd === 'git') handed += args.join(' ').length + (opts?.input?.length ?? 0);
      return real(cmd, args, opts);
    }) as typeof real);
    syncBuiltinESMExports();
    try {
      assert.ok(world.git.commitAs({ id: 'lynn', name: 'Lynn' }, 'lynn builds'));
    } finally { mock.restoreAll(); syncBuiltinESMExports(); }
    assert.ok(handed < 10_000, `${handed} bytes of arguments and input`);
    assert.doesNotMatch(tracked(), /\.o\n/);
  });

  test('a listed file that turns into a folder before it is staged leaves the rest to commit', () => {
    // update-index stops at the first path it cannot take and stages none; a
    // colleague's shell flipping one path failed 3 commits in 10.
    world.ensureStaff('lynn');
    world.ensureStaff('mal');
    world.writeNote('lynn', null, 'a', 'real work');
    writeFileSync(world.path('staff/mal/flip'), 'x');
    const real = cp.execFileSync;
    let flipped = false;
    mock.method(cp, 'execFileSync', ((cmd: string, args: string[], opts: object) => {
      if (cmd === 'git' && args.includes('update-index') && !flipped) {
        flipped = true;
        rmSync(world.path('staff/mal/flip'));
        mkdirSync(world.path('staff/mal/flip'));
        writeFileSync(world.path('staff/mal/flip/inside'), 'y');
      }
      return real(cmd, args, opts);
    }) as typeof real);
    syncBuiltinESMExports();
    try {
      assert.ok(world.git.commitAs({ id: 'lynn', name: 'Lynn' }, 'lynn works'));
    } finally { mock.restoreAll(); syncBuiltinESMExports(); }
    assert.ok(flipped);
    assert.match(tracked(), /staff\/lynn\/notes\//);
  });

  test('a held file that is rewritten as something staff write is committed next time', () => {
    world.ensureStaff('lynn');
    writeFileSync(world.path('staff/lynn/out'), elf);
    world.writeNote('lynn', null, 'a', 'one');
    world.git.commitAs({ id: 'lynn', name: 'Lynn' }, 'lynn builds');
    writeFileSync(world.path('staff/lynn/out'), 'now a report');
    world.git.commitAs({ id: 'lynn', name: 'Lynn' }, 'lynn writes');
    assert.match(tracked(), /staff\/lynn\/out\n/);
  });

  test('a program untracked on purpose stays out, though its bytes are in history', () => {
    world.ensureStaff('lynn');
    writeFileSync(world.path('staff/lynn/tool'), elf);
    const git = (...a: string[]) => execFileSync('git', ['-C', world.root, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a]);
    git('add', 'staff/lynn/tool');
    git('commit', '-qm', 'chosen');
    git('rm', '--cached', '-q', 'staff/lynn/tool');
    git('commit', '-qm', 'unchosen');
    world.writeNote('lynn', null, 'a', 'one');
    world.git.commitAs({ id: 'lynn', name: 'Lynn' }, 'lynn works');
    assert.doesNotMatch(tracked(), /staff\/lynn\/tool/);
  });

  test('a drop with nothing else beside it is no commit at all', () => {
    world.ensureStaff('lynn');
    world.git.commitAs({ id: 'lynn', name: 'Lynn' }, 'lynn arrives');
    writeFileSync(world.path('staff/lynn/explain'), elf);
    assert.equal(world.git.commitAs({ id: 'lynn', name: 'Lynn' }, 'lynn builds'), null);
  });

  test('a program already tracked is committed as ever: someone chose it', () => {
    world.ensureStaff('lynn');
    writeFileSync(world.path('staff/lynn/tool'), elf);
    execFileSync('git', ['-C', world.root, 'add', 'staff/lynn/tool']);
    execFileSync('git', ['-C', world.root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'chosen']);
    writeFileSync(world.path('staff/lynn/tool'), Buffer.concat([elf, Buffer.from([1])]));
    assert.ok(world.git.commitAs({ id: 'lynn', name: 'Lynn' }, 'lynn rebuilds'));
  });

  test('a tracked program moved or copied stays tracked: its bytes were chosen once', () => {
    world.ensureStaff('lynn');
    writeFileSync(world.path('staff/lynn/tool'), elf);
    execFileSync('git', ['-C', world.root, 'add', 'staff/lynn/tool']);
    execFileSync('git', ['-C', world.root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'chosen']);
    mkdirSync(world.path('staff/lynn/bin'));
    execFileSync('mv', [world.path('staff/lynn/tool'), world.path('staff/lynn/bin/tool')]);
    writeFileSync(world.path('staff/lynn/bin/tool-copy'), elf);
    writeFileSync(world.path('staff/lynn/bin/rebuilt'), Buffer.concat([elf, Buffer.from([1])]));
    world.git.commitAs({ id: 'lynn', name: 'Lynn' }, 'lynn tidies');
    const files = tracked();
    assert.match(files, /staff\/lynn\/bin\/tool\n/);
    assert.match(files, /staff\/lynn\/bin\/tool-copy\n/);
    assert.doesNotMatch(files, /rebuilt/, 'new bytes are a new build');
  });

  test('the first commit of a new repository holds a program back too', () => {
    // A world whose .gitignore was there before its repository is never given
    // the scaffold's own first commit.
    mkdirSync(join(dir, 'fresh'));
    execFileSync('git', ['-C', join(dir, 'fresh'), 'init', '-q', '-b', 'main']);
    const fresh = new World(join(dir, 'fresh'), clock);
    fresh.ensureStaff('lynn');
    writeFileSync(fresh.path('staff/lynn/explain'), elf);
    writeFileSync(fresh.path('staff/lynn/notes.md'), 'x');
    fresh.git.commitAs({ id: 'company', name: 'Co' }, 'founded');
    const files = execFileSync('git', ['-C', fresh.root, 'ls-files'], { encoding: 'utf8' });
    assert.match(files, /notes\.md/);
    assert.doesNotMatch(files, /explain/);
  });
});

describe('attachments — operator image metadata, not authored work', () => {
  // A real PNG signature plus a few bytes; writeAttachment does not parse it,
  // the endpoint does, so any bytes stand in here.
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

  test('an attachment lands under attachments/ and its bytes round-trip', () => {
    const rel = world.writeAttachment(png, 'png');
    assert.match(rel, /^attachments\/2026-08-24-[0-9a-f]{12}\.png$/);
    assert.deepEqual(readFileSync(world.path(rel)), png);
  });

  test('attachments are gitignored, so a fresh one never makes the world dirty', () => {
    world.writeAttachment(png, 'png');
    assert.equal(world.git.isDirty(), false, 'the attachment must be ignored, not left staged');
  });

  test('a staff commit does not sweep an attachment into their name or count', () => {
    world.ensureStaff('greg');
    world.writeAttachment(png, 'png');              // the operator pastes an image
    world.writeNote('greg', null, 'a', 'real work'); // then greg does actual work
    world.git.commitAs({ id: 'greg', name: 'Greg' }, 'greg works');

    // Greg's commit must hold his note and NOT the attachment — otherwise the
    // operator's paste inflates the artifacts greg is measured on, the same
    // failure the .DS_Store ignore exists to prevent.
    const files = execFileSync('git',
      ['-C', world.root, 'show', '--name-only', '--pretty=format:', 'HEAD'], { encoding: 'utf8' });
    assert.match(files, /staff\/greg\/notes\//, "greg's own work belongs in his commit");
    assert.doesNotMatch(files, /attachments\//, 'the attachment was swept into a staff commit');
  });

  test('two pastes the same day do not collide', () => {
    assert.notEqual(world.writeAttachment(png, 'png'), world.writeAttachment(png, 'png'));
  });
});

describe('documents the staff wrote themselves', () => {
  test('frontmatter in the body is absorbed, never stacked', () => {
    world.writeDoc('commons/theirs.md', {
      data: { title: 'How We Work', author: 'hollis' },
      body: '---\ntitle: How We Work\nkeeper_of_this_doc: hollis\n---\n# How We Work\n\nBody text.\n',
    });
    const raw = world.readText('commons/theirs.md')!;
    assert.equal((raw.match(/^---$/gm) ?? []).length, 2, 'exactly one frontmatter fence');

    const doc = world.readDoc('commons/theirs.md')!;
    assert.equal(doc.data['keeper_of_this_doc'], 'hollis', "their keys survive");
    assert.equal(doc.data['author'], 'hollis', 'our keys survive');
    assert.match(doc.body, /^# How We Work/);
    assert.doesNotMatch(doc.body, /---/, 'no orphan fence left in the prose');
  });

  test('our keys win on conflict', () => {
    world.writeDoc('commons/clash.md', {
      data: { author: 'the-company' },
      body: '---\nauthor: someone-else\n---\ntext\n',
    });
    assert.equal(world.readDoc('commons/clash.md')!.data['author'], 'the-company');
  });

  test('a body with no frontmatter is untouched', () => {
    world.writeDoc('commons/plain.md', { data: { a: 1 }, body: '# Plain\n' });
    assert.equal(world.readDoc('commons/plain.md')!.body, '# Plain\n');
  });
});

test('commons paths normalize whether or not the agent prefixes them', () => {
  // A doc once landed at commons/commons/instruments/… because post_to_commons
  // prepended a prefix the agent had already written.
  assert.equal(commonsPath('doctrine/seats.md'), 'commons/doctrine/seats.md');
  assert.equal(commonsPath('commons/doctrine/seats.md'), 'commons/doctrine/seats.md');
  assert.equal(commonsPath('commons/commons/doctrine/seats.md'), 'commons/doctrine/seats.md');
  assert.equal(commonsPath('/doctrine/seats.md'), 'commons/doctrine/seats.md');
});

test('a new world ignores what the operating system drops in it', () => {
  // Finder writes .DS_Store into any folder someone opens, and `git add -A`
  // picks it up — so browsing the world in a file manager silently authors
  // commits in a staff member's name and inflates the artifact count they are
  // measured on.
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'riff-ignore-'));
  try {
    const w = new World(join(dir, 'world'), fixedClock('2026-08-25T00:00:00.000Z'));
    w.ensure();
    const ignore = join(w.root, '.gitignore');
    assert.ok(existsSync(ignore), '.gitignore should exist');
    assert.match(readFileSync(ignore, 'utf8'), /^\.DS_Store$/m);

    assert.equal(w.git.isDirty(), false, 'a fresh world is clean, ignore file included');

    writeFileSync(join(w.root, '.DS_Store'), 'finder');
    assert.equal(w.git.isDirty(), false, 'a dropping must not make the world dirty');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('git works on a world the host presents under another uid', () => {
  test('every git call carries safe.directory, not a config file', () => {
    // The world is a bind mount. When the uid the host presents it under is
    // not the uid the factory runs as, git refuses the repo outright —
    // "detected dubious ownership" — and a shift dies mid-commit on a
    // directory that was fine a minute earlier. It happened once at 08:51.
    //
    // It has to be per-invocation: HOME in the container is a tmpfs, so
    // `git config --global` is erased on the next restart.
    const git = readFileSync(new URL('../src/worldfs/git.ts', import.meta.url), 'utf8');
    assert.match(git, /'-c', `safe\.directory=\$\{this\.#dir\}`/,
      'git calls must pass safe.directory for the world root');
    // The argv every call in the world is built from — direct or under bwrap.
    const call = git.split('\n').find((l) => l.includes("'-C'") && l.includes('safe.directory')) ?? '';
    assert.ok(call.indexOf('safe.directory') < call.indexOf("'-C'"),
      'safe.directory must come before -C, or git parses it as a subcommand arg');
  });
});
