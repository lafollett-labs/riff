import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, symlinkSync, writeFileSync, readFileSync, existsSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { World, commonsPath } from '../src/worldfs/world.ts';
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
