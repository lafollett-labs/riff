import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * Pausing a company killed whoever was mid-shift.
 *
 * `stop()` aborts the controller the SDK is holding, so the shift dies where
 * it stands and the ledger records `Claude Code process aborted by user` —
 * three of those in Fathom's log on 2026-09-03 are the operator pressing
 * Pause, not anything going wrong. up.sh called that same endpoint before a
 * rebuild under the comment "so its shift is not killed by the rebuild", and
 * then waited for shifts it had already killed.
 *
 * Draining is the version that waits: stop waking anybody, leave the abort
 * alone, and let the shifts in flight write their journals.
 */
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

describe('a drain waits for the shift; a pause kills it', () => {
  test('draining does not touch the abort controller the SDK is holding', () => {
    const src = read('src/runtime/scheduler.ts');
    assert.match(src, /if \(!opts\?\.drain\) this\.#abort\.abort\(\);/,
      'an unconditional abort is the shift-killing pause');
    // Both paths still wait. Returning early lets the caller close the ledger
    // under a live shift, which crashes it on its closing agent.slept.
    assert.match(src, /if \(this\.#flights\.size\) await Promise\.allSettled/);
  });

  test('a drain overtaken by Start does not announce a pause that did not happen', () => {
    // The operator waits out a long shift, changes their mind, presses Start.
    // work.paused would then land after the work.started that is now true.
    assert.match(read('src/runtime/scheduler.ts'), /if \(wasRunning && !this\.#running\)/);
  });

  test('the company reports draining, which is neither running nor paused', () => {
    assert.match(read('src/runtime/scheduler.ts'), /get draining\(\): boolean/);
    assert.match(read('src/company/registry.ts'), /draining: open\?\.scheduler\.draining \?\? false/);
    assert.match(read('src/gateway/server.ts'), /draining: scheduler\.draining/);
  });

  test('the request answers at once instead of holding open for a whole shift', () => {
    // A 30-turn shift runs for minutes. A POST held that long is a POST that
    // times out somewhere between the console and the server.
    assert.match(read('src/company/registry.ts'),
      /void c\.scheduler\.stop\(\{ drain: true \}\)/);
  });

  test('a pause drains, and killing a shift has to be asked for by name', () => {
    // The default used to be the other way round. On 2026-09-05 three Lathe
    // shifts died as `Claude Code process aborted by user` because a brief was
    // edited while the company worked — nobody had asked for that.
    const src = read('src/gateway/server.ts');
    assert.match(src, /const drain = !run && b\['hard'\] !== true;/,
      'stopping drains unless the caller says hard');
  });

  test('the footer Pause drains too, and Shutdown is the other one', () => {
    const src = read('src/gateway/server.ts');
    // /api/close is what the footer button reaches. It passed no options at
    // all, so every press of it killed whoever was mid-shift.
    assert.match(src, /const drain = b\['hard'\] !== true;\n\s*await registry\.setRunning\(co\.slug, false, undefined, \{ drain \}\);/);
    assert.match(read('desk/src/api.ts'), /shutdown: \(\) => send<\{ running: boolean \}>\('\/api\/close', 'POST', \{ hard: true \}\)/);
  });

  test('a run that ends on its own deadline lets the last shift finish', () => {
    // A bounded run ends with nobody watching, which is the worst moment to
    // throw away whatever the shift in flight had done since its last journal.
    const src = read('src/runtime/scheduler.ts');
    const loop = src.slice(src.indexOf('async #loop()'));
    assert.match(loop, /'tick ceiling reached'[\s\S]{0,120}?await this\.stop\(\{ drain: true \}\)/);
    assert.match(loop, /'deadline reached'[\s\S]{0,120}?await this\.stop\(\{ drain: true \}\)/);
  });

  test('editing a brief does not restart the company underneath the shift', () => {
    // The brief is read at wake, so a running shift would never have seen the
    // new one — the close-and-reopen cost the work and bought nothing.
    const src = read('src/company/registry.ts');
    assert.match(src,
      /const structural = wanted !== slug \|\| patch\.policy !== undefined \|\| patch\.release !== undefined;/);
    assert.match(src, /if \(structural\) await this\.close\(slug\);/);
    // And the company left open must not keep serving the brief it had before.
    assert.match(src, /this\.#open\.set\(slug, \{ \.\.\.open, cfg: next \}\)/);
  });

  test('letting go of a company for a rename waits for the shift it would move', () => {
    // A directory cannot be renamed out from under an agent still writing to
    // it, so this is the one drain that is about correctness and not kindness.
    const src = read('src/company/registry.ts');
    assert.match(src, /await c\.scheduler\.stop\(\{ drain: opts\?\.drain !== false \}\);/);
    // Archiving is the exception, and asks for the kill by name.
    assert.match(src, /await this\.close\(slug, \{ drain: false \}\);\n\s*const dir = archiveDir\(\);/);
  });

  test('up.sh asks for the drain it says it wants', () => {
    const sh = read('docker/up.sh');
    assert.match(sh, /"running":false,"drain":true/,
      'without this the rebuild guard is the thing that kills the shift');
    // And it still waits, because the endpoint now returns before the shifts do.
    assert.match(sh, /waiting for shifts to finish/);
  });

  test('the console offers both, and says which is which', () => {
    const vue = read('desk/src/views/Companies.vue');
    assert.match(vue, /@click="setRunning\(c, false\)"/, 'Pause drains');
    assert.match(vue, /Shut down/, 'and a kill is still reachable while it drains');
    assert.match(vue, /@click="setRunning\(c, false, true\)"/, 'which is the kill, not a second drain');
    assert.match(vue, /finishing \$\{c\.awake\.length\}/, 'the state says the shifts are landing');
  });

  test('the Overview power button kills, and asks before it does', () => {
    const vue = read('desk/src/views/Overview.vue');
    assert.match(vue, /class="power"/);
    assert.match(vue, /@click="killing = true"/, 'the button arms, it does not fire');
    assert.match(vue, /await api\.shutdown\(\)/, 'and only the confirmation fires it');
    assert.match(vue, /v-if="live"/, 'nothing to shut down when nothing is running');
  });

  test('a run has an end even when nobody asked for one', () => {
    // `until` was only set when a caller passed one, so Start with no
    // arguments — and resume() at boot, which passes nothing at all — was an
    // unbounded run on somebody's subscription. A rebuild resumed Lathe that
    // way at 01:58 on 2026-09-08 and it would have run until morning.
    const src = read('src/runtime/scheduler.ts');
    assert.match(src, /const cap = this\.#opts\.maxSessionMs > 0 \? Date\.now\(\) \+ this\.#opts\.maxSessionMs : null;/);
    // A caller may ask for less. Asking for more does not get it.
    assert.match(src, /: Math\.min\(asked, cap\);/);
  });

  test('and the deadline reported is the one in force, not the one requested', () => {
    // Reporting a deadline that was clipped is how an operator plans a night
    // around a stop that already happened.
    assert.match(read('src/gateway/server.ts'),
      /registry\.get\(target\)\?\.scheduler\.until \?\? null/);
    assert.match(read('src/runtime/scheduler.ts'), /get until\(\): number \| null/);
  });

  test('a company mid-drain cannot be handed a deadline for a run it is ending', () => {
    assert.match(read('desk/src/views/Companies.vue'), /v-if="!c\.running && !c\.draining"/);
  });
});
