import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { shouldRotate, cacheEnv, sessionStore,
         transcriptExists } from '../src/runtime/staff.ts';
import { readPolicy, DEFAULT_POLICY } from '../src/core/config.ts';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Half of a one-million window, which is where the default fires. */
const AT_HALF = {
  contextTokens: 500_000,
  contextWindow: 1_000_000,
  rotateAtPct: 50,
  sessionTurns: 0,
  turnsLeft: 40,
  rotations: 0,
};

describe('deciding to replace a conversation mid-shift', () => {
  test('a conversation past the threshold is handed over', () => {
    assert.equal(shouldRotate(AT_HALF), true);
  });

  test('a conversation short of the threshold is left alone', () => {
    assert.equal(shouldRotate({ ...AT_HALF, contextTokens: 499_999 }), false);
  });

  /**
   * The reason the dial is a percentage. Staff run whatever model the company
   * gave them, and the same token count is half a window on one and three
   * times the whole of another.
   */
  test('the same token count rotates on a small window and not on a large one', () => {
    const tokens = 150_000;
    assert.equal(shouldRotate({ ...AT_HALF, contextTokens: tokens, contextWindow: 200_000 }), true);
    assert.equal(shouldRotate({ ...AT_HALF, contextTokens: tokens, contextWindow: 1_000_000 }), false);
  });

  /**
   * A shift that reports no window has no denominator. Rotating on that guess
   * would throw away a conversation that might be nearly empty — the one thing
   * rotation must never do.
   */
  test('an unreported window never rotates', () => {
    assert.equal(shouldRotate({ ...AT_HALF, contextWindow: 0 }), false);
  });

  test('a shift that produced no assistant turn never rotates', () => {
    assert.equal(shouldRotate({ ...AT_HALF, contextTokens: 0 }), false);
  });

  test('zero turns it off outright, however full the conversation is', () => {
    assert.equal(shouldRotate({ ...AT_HALF, contextTokens: 999_999, rotateAtPct: 0 }), false);
  });

  /**
   * Rotating on the last few turns spends them all writing a note for a shift
   * that then ends — the cost of the hand-over with none of the benefit.
   */
  test('there must be room to hand over and still do something afterwards', () => {
    assert.equal(shouldRotate({ ...AT_HALF, turnsLeft: 12 }), true);
    assert.equal(shouldRotate({ ...AT_HALF, turnsLeft: 11 }), false);
  });

  test('a shift stops rotating after the second time', () => {
    assert.equal(shouldRotate({ ...AT_HALF, rotations: 1 }), true);
    assert.equal(shouldRotate({ ...AT_HALF, rotations: 2 }), false);
  });

  /**
   * The turn trigger, and why it exists. On a 1M-token window the runtime
   * compacts context back below any percentage, so a conversation resumed shift
   * after shift never trips the percentage gate — it just ages until its control
   * stream dies. Turn count catches it with no denominator at all.
   */
  test('a long conversation is retired on turn count with the context nearly empty', () => {
    assert.equal(shouldRotate({ ...AT_HALF, contextTokens: 0, sessionTurns: 500 }), true);
  });

  test('a conversation short of the turn count and the percentage is left alone', () => {
    assert.equal(shouldRotate({ ...AT_HALF, contextTokens: 1_000, sessionTurns: 299 }), false);
  });

  test('the turn trigger still respects the room to hand over', () => {
    assert.equal(shouldRotate({ ...AT_HALF, contextTokens: 0, sessionTurns: 999, turnsLeft: 11 }), false);
  });

  test('the turn trigger still stops after the rotation cap', () => {
    assert.equal(shouldRotate({ ...AT_HALF, contextTokens: 0, sessionTurns: 999, rotations: 2 }), false);
  });
});

describe('configuring the threshold', () => {
  test('an absent setting means the default, not never', () => {
    assert.equal(readPolicy({}).rotateAtContextPct, DEFAULT_POLICY.rotateAtContextPct);
    assert.ok(DEFAULT_POLICY.rotateAtContextPct > 0);
  });

  test('zero is honoured — it is the way to turn rotation off', () => {
    assert.equal(readPolicy({ rotateAtContextPct: 0 }).rotateAtContextPct, 0);
  });

  /**
   * Above the runtime's own compaction point the threshold can never be
   * reached, because compaction is what it exists to pre-empt.
   */
  test('a threshold too high to ever fire is clamped to one that can', () => {
    assert.equal(readPolicy({ rotateAtContextPct: 99 }).rotateAtContextPct, 90);
  });
});

describe('where a toolchain is told to put its cache', () => {
  /**
   * $HOME in the container is a 256M tmpfs that is also the CLI's session
   * store. A cache left on its default fills it, and what breaks is not the
   * build — it is every resume after it, silently.
   */
  test('nothing is left pointing at $HOME', () => {
    const env = cacheEnv('/data/companies/acme/scratch/cache');
    assert.ok(Object.values(env).length > 0);
    for (const [k, v] of Object.entries(env)) {
      assert.ok(v.startsWith('/data/companies/acme/scratch/cache'), `${k} escaped: ${v}`);
    }
  });

  test('the languages this company was told it may choose are covered', () => {
    // The charter says language is their call, so npm alone is not an answer.
    const env = cacheEnv('/cache');
    for (const k of ['npm_config_cache', 'GOMODCACHE', 'GOCACHE', 'CARGO_HOME', 'XDG_CACHE_HOME']) {
      assert.ok(k in env, `nothing set for ${k}`);
    }
  });

  test('caches are per company, like everything else a company touches', () => {
    assert.notEqual(cacheEnv('/a/scratch/cache')['npm_config_cache'],
                    cacheEnv('/b/scratch/cache')['npm_config_cache']);
  });
});

/**
 * Resuming a conversation the CLI no longer has.
 *
 * The id is in the ledger, on the durable volume. The transcript was on a
 * tmpfs until 2026-09-07, so every restart desynchronised the two: each agent
 * woke asking to continue something that had been wiped, the CLI died on `No
 * conversation found with session ID`, and the runtime learned that only by
 * matching the wording. Idris and Rue each lost a shift to it that night.
 */
describe('a session id outliving its transcript', () => {
  const store = (): string => {
    const dir = join(mkdtempSync(join(tmpdir(), 'riff-sessions-')), 'projects');
    mkdirSync(join(dir, '-data-companies-lathe-world'), { recursive: true });
    return dir;
  };

  test('a transcript that is there is found', () => {
    const s = store();
    writeFileSync(join(s, '-data-companies-lathe-world', 'abc-123.jsonl'), '{}\n');
    assert.equal(transcriptExists('abc-123', s), true);
  });

  test('an id with nothing behind it is not', () => {
    assert.equal(transcriptExists('abc-123', store()), false);
  });

  test('a store that does not exist at all answers no, rather than throwing', () => {
    // The first start of a fresh installation, and the shift must not die on it.
    assert.equal(transcriptExists('abc-123', join(tmpdir(), 'riff-no-such-store')), false);
  });

  test('the working directory it was recorded under does not have to be guessed', () => {
    // The CLI names that directory after the cwd with every / and . turned
    // into -, which is its rule to change. Scanning does not depend on it.
    const s = store();
    mkdirSync(join(s, '-somewhere-else-entirely'));
    writeFileSync(join(s, '-somewhere-else-entirely', 'abc-123.jsonl'), '{}\n');
    assert.equal(transcriptExists('abc-123', s), true);
  });

  test('the store follows CLAUDE_CONFIG_DIR, which is where the CLI keeps it', () => {
    // Measured against v2.1.263: pointed at an empty directory, the CLI wrote
    // .claude.json and backups/ there instead of into the home directory.
    assert.equal(sessionStore({ CLAUDE_CONFIG_DIR: '/data/cfg' }), '/data/cfg/projects');
    assert.match(sessionStore({}), /\.claude\/projects$/);
  });

  test('the resume check reads the per-company store, not the server HOME', () => {
    // The shift's CLI writes transcripts under the per-company CLAUDE_CONFIG_DIR
    // on the volume; the server process has no such env. If tick() checked its
    // own default store it would read an empty directory and reset every resume
    // to a cold start — persistence built and then never used. So the store
    // handed to transcriptExists must be derived from d.configDir.
    const src = readFileSync(new URL('../src/runtime/staff.ts', import.meta.url), 'utf8');
    assert.match(src, /const store = d\.configDir \? sessionStore\(\{ CLAUDE_CONFIG_DIR: d\.configDir \}\) : undefined;/);
    assert.match(src, /transcriptExists\(session, store\)/);
  });
});

/**
 * The turn trigger is only real if tick() feeds it the running count and carries
 * that count across resumes. A pure shouldRotate unit test cannot see the wiring
 * that makes it fire on the session that actually grew (the 4367-turn one), so
 * these lock the two ends the same way the resume check above does.
 */
describe('the turn count reaches the rotation decision and survives a resume', () => {
  const src = (): string =>
    readFileSync(new URL('../src/runtime/staff.ts', import.meta.url), 'utf8');

  test('the running session-turn count is passed to shouldRotate', () => {
    assert.match(src(), /sessionTurns: sessionTurns\(\)/);
  });

  test('the count is loaded on resume and written back at shift end', () => {
    const s = src();
    assert.match(s, /Number\(ledger\.getMeta\(`session-turns:\$\{agent\.id\}`\)\)/);
    assert.match(s, /setMeta\(`session-turns:\$\{agent\.id\}`, session \? String\(sessionTurns\(\)\) : '0'\)/);
  });

  test('a control stream that dies mid-leg retires the session', () => {
    // gateCalls > 0 is the mid-leg case the resume-death guard deliberately does
    // not catch; without this the session is resumed dead every following leg.
    assert.match(src(), /gateCalls > 0 && !permissionStreamDead && streamClosedResult\(m\)/);
  });
});
