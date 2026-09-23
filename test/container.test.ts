import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, mkdtempSync, writeFileSync, existsSync,
         copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { sandboxFilesystem } from '../src/runtime/staff.ts';
import { spawnSync, execFileSync } from 'node:child_process';

/**
 * The container's environment is a contract with src/core/config.ts, and
 * nothing was checking it.
 *
 * It had already rotted: the Dockerfile set RIFF_HOME=/world from the
 * single-company era, so under the current resolver every company would have
 * been written to the container's own filesystem instead of the mounted
 * volume — and destroyed, silently, on the next restart. These tests are the
 * cheapest thing that would have caught that.
 */
const dockerfile = readFileSync('docker/Dockerfile', 'utf8');
const compose = readFileSync('docker/compose.yaml', 'utf8');
const entrypoint = readFileSync('docker/entrypoint.sh', 'utf8');

/** Every source file, so "does anything read this?" is answered honestly. */
const allSource = ((): string => {
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [];
  });
  return walk('src').map((p) => readFileSync(p, 'utf8')).join('\n');
})();

/** The mount target the factory writes to, read from compose. */
const MOUNT = '/data';

/**
 * One service block from compose.
 *
 * Sliced to the NEXT key at service indentation, not to a named one: slicing
 * factory-to-egress silently swallowed the ingress service when it was added
 * between them, and the assertions then described the wrong container.
 * Matching on a bare name is wrong too — 'egress:' also appears inside
 * http://egress:8888.
 */
const service = (name: string): string => {
  const start = compose.indexOf(`\n  ${name}:`);
  assert.ok(start >= 0, `compose must declare a ${name} service`);
  const rest = compose.slice(start + 1);
  const next = /\n {2}[a-z][a-z0-9_-]*:\n/.exec(rest.slice(name.length + 3));
  return next ? rest.slice(0, name.length + 3 + next.index) : rest;
};

const factoryBlock = service('factory');

describe('the container writes where the volume is', () => {
  test('the installation root is set, and set to the mount', () => {
    const m = /RIFF_ROOT=(\S+)/.exec(dockerfile);
    assert.ok(m, 'the Dockerfile must set RIFF_ROOT');
    assert.ok(m[1]!.startsWith(MOUNT),
      `RIFF_ROOT is ${m[1]} — anything outside ${MOUNT} is lost on restart`);
  });

  test('compose agrees with the image about where that is', () => {
    assert.match(compose, /RIFF_ROOT:\s*\/data/);
    assert.match(compose, new RegExp(`:${MOUNT}\\b`), 'the volume must be mounted at the root');
  });

  test('the container and the host share one installation', () => {
    // Compose interpolates ${HOME} client-side, in the process that runs the
    // command — so it is the invoking user's home, never the daemon's. And it
    // points at the SAME ~/.riff the host uses: a second directory would
    // mean a company founded one way is invisible the other.
    assert.match(compose, /\$\{RIFF_DATA:-\$\{HOME\}\/\.riff\}/);
  });

  test('it checks it can write the mount before doing anything', () => {
    // Docker Desktop maps bind-mount ownership; a rootful Linux daemon does
    // not, and the container's uid then cannot create anything. Unchecked,
    // that surfaces as a confusing crash deep inside a git call.
    assert.match(entrypoint, /touch \/data/);
    assert.match(entrypoint, /Cannot write to \/data/);
    assert.match(entrypoint, /chown/, 'the failure must carry its own fix');
  });

  test('the entrypoint refuses to start if the root escapes the mount', () => {
    // Belt and braces: if someone overrides it at run time, fail loudly rather
    // than writing a whole company somewhere it will not survive.
    assert.match(entrypoint, /RIFF_ROOT/);
    assert.match(entrypoint, /exit 1/);
  });

  test('the single-company variable is gone from the image', () => {
    // RIFF_HOME means "one company lives here". Setting it installation-wide
    // is what broke this.
    assert.ok(!/ENV[\s\S]*RIFF_HOME=/.test(dockerfile), 'RIFF_HOME must not be set image-wide');
  });
});

const entrypointSrc = readFileSync(new URL('../docker/entrypoint.sh', import.meta.url), 'utf8');

describe('the container only sets variables the code reads', () => {
  test('every RIFF_* it sets is one config.ts looks up', () => {
    const set = new Set<string>();
    for (const src of [dockerfile, compose]) {
      for (const m of src.matchAll(/\b(RIFF_[A-Z_]+)\b/g)) set.add(m[1]!);
    }
    // Consumed by compose itself, before the container exists.
    const composeOnly = new Set(['RIFF_DATA']);
    // The entrypoint runs before the server and reads some of these itself,
    // so it counts as a reader. Exempting them instead would let a variable
    // nothing reads at all slip through under the same excuse.
    // The launcher and the entrypoint both run before the server and read
    // some of these themselves, so they count as readers. Exempting the names
    // instead would let a variable nothing reads at all through on the same
    // excuse.
    const shell = entrypointSrc
      + readFileSync(new URL('../docker/up.sh', import.meta.url), 'utf8');
    for (const name of set) {
      if (composeOnly.has(name)) continue;
      assert.ok(allSource.includes(`'${name}'`) || shell.includes(name),
        `${name} is named for the container but nothing under src/, the entrypoint or up.sh reads it`);
    }
  });
});

describe('the shell is only open inside the box', () => {
  test('the image declares itself contained', () => {
    assert.match(dockerfile, /RIFF_CONTAINED=1/);
  });

  test('and the runtime still demands a container marker as well', () => {
    // The variable alone must never be enough — a mistyped export on someone's
    // laptop would otherwise hand an agent a terminal.
    const perms = readFileSync('src/runtime/permissions.ts', 'utf8');
    assert.match(perms, /RIFF_CONTAINED/);
    assert.match(perms, /dockerenv|containerenv/);
  });
});

describe('what the factory can reach', () => {
  test('the console is carried out by a forwarder, not by the factory', () => {
    // A container on an internal network cannot publish a port — no gateway
    // means no ingress either, and Docker publishes nothing without saying so.
    assert.ok(!/ports:/.test(factoryBlock), 'the factory must not try to publish a port');
    const ingress = service('ingress');
    assert.match(ingress, /ports:\s*\['127\.0\.0\.1:/, 'ingress publishes on loopback only');
    assert.match(ingress, /networks:\s*\[walled, outside\]/);
    // It must stay a forwarder: no build context, no token, nothing to run.
    assert.ok(!ingress.includes('CLAUDE_CODE_OAUTH_TOKEN'), 'ingress must never see the token');
    assert.ok(!ingress.includes('build:'), 'ingress runs a stock image, not ours');
  });

  test('the key-injecting proxy holds keys but never the token, and mounts data read-only', () => {
    // keyproxy exists so a company's real keys are NOT in a box an agent can
    // reach. Its whole value is undone if it ever gains the subscription token
    // or a factory secret, or if its data mount becomes writable. This is the
    // regression guard for exactly that — the same shape as the ingress guard.
    const keyproxy = service('keyproxy');
    assert.ok(!keyproxy.includes('CLAUDE_CODE_OAUTH_TOKEN'),
      'keyproxy must never see the subscription token');
    assert.ok(!keyproxy.includes('RIFF_WAIT_FOR_CREDENTIALS') && !keyproxy.includes('RIFF_CREDENTIALS'),
      'keyproxy must carry no credentials env');
    assert.match(keyproxy, /:\/data:ro\b/, 'keyproxy mounts the installation read-only');
    // Minimal image, not the factory's: the crown-jewel container carries no
    // shell/compiler/browser to a foothold.
    assert.match(keyproxy, /target:\s*keyproxy/, 'keyproxy builds the minimal stage');
    assert.match(keyproxy, /read_only:\s*true/);
    assert.match(keyproxy, /cap_drop:\s*\[ALL\]/);
    assert.match(keyproxy, /no-new-privileges:true/);
  });

  test('the factory builds the gateway stage, not the proxy one', () => {
    // keyproxy is the LAST stage in the Dockerfile, and an untargeted build
    // resolves to the last stage — so an untargeted factory service boots the
    // proxy (`keyproxy listening on :8890`, no gateway) and never goes healthy.
    // The target must be explicit; this is the guard for that exact regression.
    assert.match(factoryBlock, /target:\s*runtime/, 'the factory must target the runtime stage');
    const dockerfile = readFileSync('docker/Dockerfile', 'utf8');
    assert.match(dockerfile, /FROM node:26-slim AS runtime\b/, 'the runtime stage must be named so it can be targeted');
    assert.match(dockerfile, /CMD \["node", "src\/gateway\/server\.ts"\]/, 'the runtime stage runs the gateway');
  });

  test('its network has no route off the machine', () => {
    assert.match(compose, /walled:\s*\n\s*internal:\s*true/);
    // The factory is on the walled network only; the proxy bridges out.
    assert.match(factoryBlock, /networks:\s*\[walled\]/);
    assert.ok(!factoryBlock.includes('outside'),
      'the factory must not be attached to the outside network');
  });

  test('every refused host is anchored, so no bystander is refused with it', () => {
    // Anchoring guarded a bypass under the allowlist. Under a denylist it
    // guards a surprise: unanchored, "paste.ee" also refuses "notpaste.ee.com".
    const compile = readFileSync('docker/proxy/compile-denylist.sh', 'utf8');
    assert.match(compile, /\^%s\$/);
  });

  test('the proxy passes what it is not told to refuse', () => {
    // Flipped 2026-09-03. A researcher made 195 allowed external.read calls
    // and fetched one host; a curated list cannot anticipate which vendor a
    // company needs to price next.
    const conf = readFileSync('docker/proxy/tinyproxy.conf', 'utf8');
    assert.match(conf, /FilterDefaultDeny\s+No/);
  });

  test('every request is logged, because that is what replaced the wall', () => {
    // The audit trail is the compensating control for opening egress, and it
    // was not working: LogLevel Notice logged no requests, and `LogFile
    // /dev/stdout` never opened at all — tinyproxy stats a path then opens it
    // and refuses when they disagree, which a symlink into /proc always does.
    const conf = readFileSync('docker/proxy/tinyproxy.conf', 'utf8');
    assert.match(conf, /LogLevel\s+Connect/, 'Connect is the level that logs a line per request');
    assert.ok(!/^\s*LogFile/m.test(conf),
      'LogFile pointing into /proc silently disables logging; no LogFile means stdout');
  });

  test('the proxy writes nothing at start, so it can run read-only', () => {
    // It used to compile its own filter on every boot, which crash-looped
    // against a read-only filesystem — eight restarts before anyone noticed,
    // and a factory with no way out at all.
    const entry = readFileSync('docker/proxy/entrypoint.sh', 'utf8');
    assert.ok(!/>\s*\/etc|>>\s*\/etc|:\s*>\s*\/etc/.test(entry),
      'the proxy entrypoint must not write into /etc at run time');
    // The filter is baked in instead.
    assert.match(readFileSync('docker/proxy/Dockerfile', 'utf8'), /RUN[\s\S]*compile-denylist\.sh/);
  });

  test('the filesystem is read-only apart from the volume and scratch', () => {
    assert.match(factoryBlock, /read_only:\s*true/);
    assert.match(factoryBlock, /cap_drop:\s*\[ALL\]/);
    assert.match(factoryBlock, /no-new-privileges:true/);
  });
});

describe('the example env file describes this container, not an imagined one', () => {
  // A .env.example naming variables nothing reads is worse than none at all:
  // someone sets one, nothing happens, and they go looking for the bug in
  // their own setup.
  const example = readFileSync('docker/.env.example', 'utf8');
  const upsh = readFileSync('docker/up.sh', 'utf8');

  test('every variable it names is one compose actually reads', () => {
    const named = [...example.matchAll(/^#?\s*([A-Z][A-Z0-9_]+)=/gm)].map((m) => m[1]!);
    assert.ok(named.length > 3, 'the example should document something');
    for (const v of named) {
      // Read by compose, or by the launcher that runs before it.
      assert.ok(compose.includes(v) || upsh.includes(v),
        `${v} is in docker/.env.example but neither compose nor up.sh reads it`);
    }
  });

  test('the runtime token is nowhere in the compose env or the example', () => {
    // It moved to the keyproxy vault, set in the console. The guard is the
    // inverse of the old "compose must require the token": it must NOT reappear
    // in either file, or the point of the cutover is quietly undone. The record
    // path is gone too — no CLAUDE_CODE_OAUTH_TOKEN, no RIFF_WAIT_FOR_CREDENTIALS.
    assert.ok(!compose.includes('CLAUDE_CODE_OAUTH_TOKEN'),
      'the runtime token must not be a factory env var');
    assert.ok(!example.includes('CLAUDE_CODE_OAUTH_TOKEN'),
      'the example must not resurrect the token variable');
    assert.ok(!compose.includes('RIFF_WAIT_FOR_CREDENTIALS'),
      'no credentials-delivery env survives on the factory');
  });

  /**
   * Run the launcher for real, with a stub docker and curl. There is no token
   * to resolve any more — the runtime credential lives in the keyproxy vault, set
   * in the console — so the stubs only record how compose and the drain were
   * called, to prove the launcher drains before a rebuild and starts nothing it
   * should not.
   */
  const launch = (args: string[] = ['up'], env: Record<string, string> = {}):
      { out: string; err: string; curl: string; argv: string } => {
    const dir = mkdtempSync(join(tmpdir(), 'riff-launch-'));
    // It answers `compose port` as a running stack would (STUB_PORT, or 4173),
    // and says nothing is published when STUB_STACK_DOWN is set.
    writeFileSync(join(dir, 'docker'),
      `#!/bin/sh\n`
      + `case "$*" in *" port ingress 4173"*)\n`
      + `  [ -n "$STUB_STACK_DOWN" ] && exit 1\n`
      + `  echo "127.0.0.1:\${STUB_PORT:-4173}"; exit 0 ;;\nesac\n`
      + `printf '%s\\n' "$*" > ${dir}/argv\n`, { mode: 0o755 });
    // A stub `curl`, because the launcher asks a running server to drain its
    // companies before recreating the container. Unstubbed, this suite would
    // reach 127.0.0.1:4173 and pause the operator's real work. It answers a
    // listing once with one company running, then with none, so the drain both
    // acts and terminates.
    writeFileSync(join(dir, 'curl'),
      `#!/bin/sh\nprintf '%s\\n' "$*" >> ${dir}/curl.log\n`
      // STUB_CURL_DOWN: no server listening, as curl -f reports it.
      + `[ -n "$STUB_CURL_DOWN" ] && exit 7\n`
      + `case "$*" in\n`
      + `  *"-X POST"*) exit 0 ;;\n`
      + `esac\n`
      // The REAL field order from registry.list(): slug and running are eight
      // fields apart. The first fixture put them side by side, which is the one
      // shape the original parser handled — it went green while the launcher
      // killed a shift on every rebuild.
      + `head='{"companies":[{"slug":"testco","name":"Test","business":"b","home":"/h",'\n`
      + `head="$head"'"ceo":"C","founded":true,"wanted":true,"release":"none",'\n`
      + `if [ -f ${dir}/asked ]; then\n`
      + `  printf '%s"running":false,"awake":[]}]}' "$head"\n`
      + `else\n`
      + `  : > ${dir}/asked\n`
      + `  printf '%s"running":true,"awake":[]}]}' "$head"\n`
      + `fi\n`, { mode: 0o755 });
    const r = spawnSync('sh', ['docker/up.sh', ...args], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${dir}:${process.env['PATH'] ?? ''}`, RIFF_ENV: '', ...env },
    });
    assert.equal(r.status, 0, `up.sh ${args.join(' ')} failed: ${r.stderr}`);
    return {
      out: r.stdout,
      err: r.stderr,
      curl: existsSync(join(dir, 'curl.log')) ? readFileSync(join(dir, 'curl.log'), 'utf8') : '',
      argv: existsSync(join(dir, 'argv')) ? readFileSync(join(dir, 'argv'), 'utf8') : '',
    };
  };

  test('a rebuild drains what is working before it recreates the container', () => {
    // Compose sends SIGTERM and waits ten seconds; a shift runs for minutes,
    // so recreating under one killed it and the ledger recorded "Claude Code
    // process aborted by user" for work that was going fine.
    //
    // Asking for the pause alone did the same damage a step earlier: it aborts
    // whoever is mid-shift, so the guard against the rebuild became the thing
    // that killed the shift, and the wait afterwards watched an empty room.
    const { curl, out } = launch(['up', '--build', '-d']);
    assert.match(curl, /-X POST[^\n]*companies\/testco\/running/,
      `the running company should have been drained first:\n${curl}`);
    assert.match(curl, /"running":false,"drain":true/,
      `without drain:true this kills the shift it is protecting:\n${curl}`);
    assert.match(out, /draining testco/);
  });

  test('reading logs does not pause anybody', () => {
    // Draining is for recreating the container. A subcommand that only reads
    // has no business stopping work.
    assert.equal(launch(['logs']).curl, '');
    assert.equal(launch(['ps']).curl, '');
  });

  test('the launcher never reaches a server on the operator\'s own port by accident', () => {
    // The drain asks compose where the stack is published, which a stub on
    // PATH answers — so this suite never reaches the operator's real server. A
    // hardcoded 4173 would bypass that and pause their real companies.
    const src = readFileSync('docker/up.sh', 'utf8');
    const drain = src.slice(src.indexOf('drain() {'), src.indexOf('run_compose "$@"'));
    assert.ok(!/127\.0\.0\.1:4173/.test(drain), 'no hardcoded port in the drain');
  });

  test('the drain asks the running stack where it is published, not the environment', () => {
    // It read $PORT from the environment alone, so a PORT set in an env file —
    // where .env.example says to set it — sent the listing to 4173, found
    // nobody, and the rebuild went ahead under whatever was working.
    const r = launch(['up'], { STUB_PORT: '5917', PORT: '4173' });
    assert.match(r.curl, /127\.0\.0\.1:5917\/api\/companies/);
    assert.match(r.out, /draining testco/);
  });

  test('no stack is nothing to drain, and a silent server is said out loud', () => {
    const down = launch(['up'], { STUB_STACK_DOWN: '1' });
    assert.equal(down.curl, '');
    assert.equal(down.err, '');
    const silent = launch(['up'], { STUB_CURL_DOWN: '1' });
    assert.match(silent.err, /stack is up on 127\.0\.0\.1:4173 but its server did not answer; nothing was drained/);
    assert.match(silent.argv, /up/, 'it still starts the stack');
  });

  test('check validates the compose wiring and starts nothing', () => {
    // `check` used to prove the token wiring; there is no token now, so it
    // validates the compose configuration — invoking docker for exactly that,
    // never a start.
    const { out, argv } = launch(['check']);
    assert.match(out, /compose configuration is valid/);
    assert.match(out, /Riff Settings/);
    assert.match(argv, /\bconfig\b/, 'check runs `docker compose config`');
    assert.ok(!/\bup\b/.test(argv), `check must not start anything: ${argv}`);
  });

  test('the launcher writes nothing to disk', () => {
    // A redirect or a tee added here later would undo the whole point of
    // resolving from a password manager, and it would still appear to work.
    const before = readdirSync('docker').sort();
    launch();
    assert.deepEqual(readdirSync('docker').sort(), before, 'up.sh created a file');
    const body = upsh.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
    assert.ok(!/\btee\b/.test(body), 'up.sh must not tee the token anywhere');
  });

  test('docker/.env itself is ignored, and stays ignored', () => {
    const ignored = readFileSync('.gitignore', 'utf8');
    assert.match(ignored, /^docker\/\.env$/m);
  });
});

describe('the egress proxy refuses the data drops and logs the rest', () => {
  const dir = new URL('../docker/proxy/', import.meta.url).pathname;
  const compile = (extra?: string): string[] => {
    const box = mkdtempSync(join(tmpdir(), 'riff-wall-'));
    const etc = join(box, 'etc', 'tinyproxy');
    mkdirSync(etc, { recursive: true });
    copyFileSync(join(dir, 'denylist.conf'), join(etc, 'denylist.conf'));
    // Deliberately no trailing newline: `while read` drops that line without
    // the `|| [ -n "$line" ]` guard, and the last host vanishes silently.
    if (extra !== undefined) writeFileSync(join(etc, 'denylist.local.conf'), extra);
    const script = readFileSync(join(dir, 'compile-denylist.sh'), 'utf8')
      .replaceAll('/etc/tinyproxy', etc);
    writeFileSync(join(box, 'c.sh'), script);
    execFileSync('sh', [join(box, 'c.sh')]);
    const out = readFileSync(join(etc, 'filter.re'), 'utf8').split('\n').filter(Boolean);
    rmSync(box, { recursive: true, force: true });
    return out;
  };

  test('every host is anchored, so no bystander is refused', () => {
    const rules = compile();
    // Unanchored, "paste.ee" would also refuse "notpaste.ee.com".
    for (const r of rules) {
      assert.match(r, /^\^.+\$$/, `${r} is not anchored`);
      assert.ok(!/(?<!\\)\./.test(r.slice(1, -1)), `${r} has an unescaped dot`);
    }
  });

  // A compiled rule is the escaped, anchored form. Comparing against the bare
  // hostname passes whatever the list says, in both directions — which is how
  // "must not be refused" would have gone green on a host that was refused.
  const rule = (host: string): string => `^${host.replaceAll('.', '\\.')}$`;

  test('research hosts are not on it, whoever the company turns out to need', () => {
    // The reason for the flip: a company asked for real prices could reach
    // none of these, and a curated list cannot know the next vendor.
    const rules = compile();
    for (const host of ['docs.anthropic.com', 'capterra.com', 'g2.com', 'www.gov.uk',
                        'stripe.com', 'en.wikipedia.org']) {
      assert.ok(!rules.includes(rule(host)), `${host} must not be refused`);
    }
  });

  test('the hosts that exist to receive a payload are refused', () => {
    // Not a wall, and the file says so. It stops drift and accident: nothing
    // a company here does needs to POST to a stranger's bucket.
    const rules = compile();
    for (const bad of ['pastebin.com', 'transfer.sh', 'webhook.site', 'requestcatcher.com',
                       'ngrok.io', 'file.io']) {
      assert.ok(rules.includes(rule(bad)), `${bad} should be refused`);
    }
  });

  test('every category of anonymous receiver is covered, not just paste sites', () => {
    // One host per shape. A payload leaves as easily through a form endpoint
    // or a tunnel as through a paste bin, and covering only the obvious one
    // reads as a control while being a gap.
    const rules = compile();
    for (const bad of ['justpaste.it', 'catbox.moe', 'postb.in', 'formspree.io', 'loca.lt']) {
      assert.ok(rules.includes(rule(bad)), `${bad} should be refused`);
    }
  });

  test('the CLI\'s own log shipping is refused, and the model API is not', () => {
    // Measured 2026-09-23: 30 connections in a half hour of ShipIt to the
    // Datadog intake, from the CLI itself. The shift env turns that off; this
    // is the net under it. The keyproxy reaches the model API the same way.
    const rules = compile();
    assert.ok(rules.includes(rule('http-intake.logs.us5.datadoghq.com')));
    assert.ok(!rules.includes(rule('api.anthropic.com')));
  });

  test('the shift env turns the CLI\'s non-essential traffic off', () => {
    assert.match(readFileSync(new URL('../src/runtime/staff.ts', import.meta.url), 'utf8'),
      /CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',\n\s*\.\.\.secretEnv,/);
  });

  test('the denylist does not claim to be a containment boundary', () => {
    // It said the proxy was what kept a readable token from being sent
    // anywhere. That was retired with the flip, and SECURITY.md has to say so
    // rather than leave the old argument standing over a new mechanism.
    const conf = readFileSync(new URL('../docker/proxy/denylist.conf', import.meta.url), 'utf8');
    assert.match(conf, /HYGIENE, not containment/);
    const sec = readFileSync(new URL('../SECURITY.md', import.meta.url), 'utf8');
    assert.match(sec, /neither is the proxy/,
      'SECURITY.md must not still promise the token cannot be sent anywhere');
  });

  test("an operator's own hosts are added without editing the repo", () => {
    const rules = compile('example.internal\nno-trailing-newline.example');
    assert.ok(rules.includes('^example\\.internal$'));
    assert.ok(rules.includes('^no-trailing-newline\\.example$'),
      'a file with no trailing newline must not lose its last host');
  });

  test('an installation that writes no local file behaves exactly as before', () => {
    assert.deepEqual(compile(), compile(''));
  });
});

describe('the session store is somewhere the factory can actually write', () => {
  const compose = readFileSync(new URL('../docker/compose.yaml', import.meta.url), 'utf8');

  test('every tmpfs is owned by the user the factory runs as', () => {
    // A tmpfs mounts root-owned. The factory runs as labs (10001), so an
    // unowned /home/labs is silently unwritable — the CLI keeps no
    // transcripts, every resume fails, and every shift starts cold. That ran
    // for 33 shifts looking healthy the whole time.
    const lines = (compose.match(/^\s+- \/[^\n]*size=\d+m[^\n]*$/gm) ?? []);
    assert.ok(lines.length >= 3, `expected the tmpfs list, found ${lines.length}`);
    for (const l of lines) {
      assert.match(l, /uid=10001/, `tmpfs mounts root-owned: ${l.trim()}`);
      assert.match(l, /gid=10001/, `tmpfs mounts root-owned: ${l.trim()}`);
    }
  });

  test("the CLI's home is one of them", () => {
    // If HOME is not a writable mount, persistSession is a no-op.
    assert.match(compose, /\/home\/labs:size=\d+m,uid=10001/);
  });

  test('transcripts persist on the volume via CLAUDE_CONFIG_DIR, not a symlink', () => {
    // Two ways were ruled out on 2026-09-08 and only one lesson survives. A
    // symlink out of $HOME still stops bubblewrap dead (`Can't mount on symlink
    // destination`) and took the shell away from a whole shift — that holds. The
    // other objection is now void: CLAUDE_CONFIG_DIR was rejected because it moved
    // the credentials lookup onto the operator's disk (`Not logged in`), but the
    // shift authenticates through the keyproxy on a scoped token — there is no
    // on-disk credential to move. So the store is set per company, on the volume,
    // in staff.ts; the entrypoint must still not symlink it.
    const staff = readFileSync(new URL('../src/runtime/staff.ts', import.meta.url), 'utf8');
    assert.doesNotMatch(entrypoint, /ln -s .*\.claude\/projects/,
      'bwrap cannot mount on a symlink, and the shell is the point of the box');
    assert.match(staff, /CLAUDE_CONFIG_DIR: d\.configDir/,
      'the store follows the per-company config dir onto the volume');
    assert.match(compose, /Can't mount on symlink destination/,
      'the next person to try a symlink should find out here, not from a dead shift');
  });

  test('a shift does not have to fail to find out the conversation is gone', () => {
    // Before this, the id was handed to the SDK, the CLI died on `No
    // conversation found with session ID`, and the runtime caught the string
    // and retook the leg cold. That healed Marlow and not Idris or Rue.
    const staff = readFileSync(new URL('../src/runtime/staff.ts', import.meta.url), 'utf8');
    assert.match(staff, /if \(session && !transcriptExists\(session, store\)\)/);
    assert.match(staff, /why: 'transcript is gone'/);
    // And it asks the disk, not the CLI's wording, which is free to change.
    assert.match(staff, /existsSync\(join\(store, d, `\$\{id\}\.jsonl`\)\)/);
  });
});

describe('a company with no runtime credential is held, not woken to fail', () => {
  const entrypoint = readFileSync(new URL('../docker/entrypoint.sh', import.meta.url), 'utf8');
  const up = readFileSync(new URL('../docker/up.sh', import.meta.url), 'utf8');

  test('nothing wakes up unable to work', () => {
    // A company restored without a resolvable runtime credential would spend a
    // whole shift failing to authenticate and writing that down. The resume is
    // per-company now: one whose credential the keyproxy cannot resolve is
    // skipped rather than woken. RIFF_HOLD_PAUSED stays as a manual global hold.
    const server = readFileSync(new URL('../src/gateway/server.ts', import.meta.url), 'utf8');
    assert.match(server, /const held = process\.env\['RIFF_HOLD_PAUSED'\] === '1';/);
    assert.match(server, /registry\.resume\(\(slug\) => runtimeCredentialHealth\(slug\)\.live\)/);
  });

  test('the entrypoint no longer waits for a credential it will never be handed', () => {
    // The runtime credential is not delivered to the container any more, so the
    // old tmpfs-record wait is gone — its absence is the point. A wait
    // reintroduced here would block boot on a file that never arrives.
    assert.doesNotMatch(entrypoint, /RIFF_WAIT_FOR_CREDENTIALS/);
    assert.doesNotMatch(entrypoint, /credentials record/);
    assert.match(entrypoint, /exec "\$@"/);
  });

  test('up starts the stack detached', () => {
    // Attached, `docker compose up` streams logs and never returns; the stack is
    // more useful detached. Watching it is `up.sh logs -f`.
    assert.match(up, /if \[ "\$subcommand" = up \]; then/);
    assert.match(up, /\[ "\$detached" = no \] && set -- "\$@" --detach/);
    // And an operator who asked for attached gets it.
    assert.match(up, /case \$a in -d\|--detach\) detached=yes ; break ;; esac/);
    assert.ok(up.indexOf('detached=no') < up.indexOf('run_compose "$@"'),
      'the flag must be added before compose runs');
  });

  test('the launcher resolves or delivers no credential', () => {
    // The whole token/record/creds machinery is retired; a stray reintroduction
    // would put a raw credential back on the factory or its tmpfs.
    assert.doesNotMatch(up, /RIFF_TOKEN_CMD|RIFF_CREDENTIALS_CMD|CLAUDE_CODE_OAUTH_TOKEN/);
    assert.doesNotMatch(up, /on_exit|deliver\(\)/);
  });
});

describe('one company cannot read another', () => {
  /**
   * The gate confines every FILE tool to the world and always has. It cannot
   * confine a shell: `ask('shell', cmd, null)` passes no path, because a
   * command string is not a path. On 2026-09-05 Lathe read another company's
   * world six times — `du`, `find`, and twice a snapshot of it into its own
   * tree — and every one was recorded as an ordinary `gate.allow`.
   *
   * Measured in the rebuilt container, from inside a real shift:
   *   ls /data/companies                          -> lathe
   *   cat /data/companies/fathom/config.json      -> No such file or directory
   *   node -e readdirSync('/data/companies')      -> [ 'lathe' ]
   *
   * The third is the one no command inspection could ever catch: there is no
   * path in the command text to inspect.
   */
  const staff = readFileSync(new URL('../src/runtime/staff.ts', import.meta.url), 'utf8');
  const compose = readFileSync(new URL('../docker/compose.yaml', import.meta.url), 'utf8');
  const dockerfile = readFileSync(new URL('../docker/Dockerfile', import.meta.url), 'utf8');

  test('every shift in a container runs its shell in a sandbox', () => {
    assert.match(staff, /shellIsContained\(\) \? \{ sandbox: \{/,
      'the sandbox is tied to the same signal that opens the shell');
    assert.match(staff, /enabled: true/);
  });

  test('a sandboxed command still asks the gate, a subagent\'s included', () => {
    // Left to its default, a general-purpose subagent's `echo hi > …` wrote
    // with no gate.allow while the main agent's shell was gated (measured
    // 2026-09-23 in a throwaway company; after this, the same call was gated).
    assert.match(staff, /autoAllowBashIfSandboxed: false/);
  });

  test('a sandbox that cannot start fails the shift instead of running anyway', () => {
    // The documented default is a warning and unsandboxed commands, which is
    // the one outcome this must never produce.
    assert.match(staff, /failIfUnavailable: true/);
    assert.match(staff, /allowUnsandboxedCommands: false/);
  });

  test('the fence is around the whole installation root, not just the companies', () => {
    // Denying only companies/ left the secrets store (master.key, the vaults,
    // keyproxy.secret) a `cat` away — CRITICAL-001. The deny is the whole root.
    assert.match(staff, /denyRead: \[\s*installRoot\(\)/,
      'deny the whole installation root, secrets store included');
    assert.match(staff, /allowRead: \[dirname\(worldRoot\)\]/,
      'then re-allow this one company; the more specific path wins');
  });

  test('and around the subscription token, which the shell could simply read', () => {
    // Measured on 2026-09-07 under the profile shipped the day before: a
    // sandboxed shift ran `cat /home/labs/.claude/.credentials.json` and got
    // it. The shell runs as the uid that owns the file, so 0600 stops nobody;
    // Claude Code write-protects it and does not deny reading it. Re-measured
    // with these two entries added: `denied`, with node, git and the shell
    // itself still working.
    assert.match(staff, /home\('\.claude\/\.credentials\.json'\)/);
    assert.match(staff, /home\('\.claude\.json'\)/);
  });

  test('and around the transcripts, which are one company talking', () => {
    // They live on the volume now, under the company's own home
    // (CLAUDE_CONFIG_DIR), so a restart no longer wipes them. That home is what
    // allowRead re-admits, so the deny names the on-volume config store back —
    // ADDED to the default $HOME denies, never traded for them: /home/labs is
    // one tmpfs shared by every company, so anything left there stays denied too.
    assert.match(staff, /sessionStore\(\), home\('\.claude\/\.credentials\.json'\), home\('\.claude\.json'\),/,
      'the shared $HOME store is always denied');
    assert.match(staff, /\.\.\.\(configDir \? \[configDir\] : \[\]\)/,
      'and the on-volume config store is denied on top when set');
  });

  test('the wall around the network is the egress proxy, not the sandbox', () => {
    // Turning the sandbox on turned its network filter on with it, and nobody
    // chose that: `readpile https://example.com/` came back `deny
    // network-outbound example.com:443`, so both of this company's fetching
    // tools lost their only path and neither could be tested end to end.
    // Measured with this line in place, from inside a sandboxed shell:
    // example.com 200, nodejs.org 200, pastebin.com FAIL — the proxy's
    // denylist still bites, which is the boundary that was actually chosen.
    assert.match(staff, /network: \{ allowedDomains: \['\*'\] \}/);
    assert.doesNotMatch(staff, /strictAllowlist: true/,
      'an allowlist here would have to name every host a company might research');
  });

  test('a sandboxed company can still build', () => {
    // Everything outside allowWrite is read-only inside the sandbox, so a
    // missing home directory turns `npm install` into EROFS. Marlow hit this
    // on the first shift under the sandbox.
    const { allowWrite } = sandboxFilesystem('/data/companies/co/world');
    for (const d of ['.npm', '.cache', '.undo']) assert.ok(allowWrite.includes(join(homedir(), d)), d);
  });

  test('the container ships what the Linux sandbox needs', () => {
    // bwrap enforces the filesystem boundary, socat relays the network.
    // Without them the CLI reports the sandbox unavailable.
    const installs = dockerfile.match(/bubblewrap socat/g) ?? [];
    assert.equal(installs.length, 2, 'both the dev and runtime stages need them');
  });

  test('and the seccomp profile that lets bubblewrap start at all', () => {
    // Docker allowlists `unshare` only alongside CAP_SYS_ADMIN, so it falls
    // through to the profile's SCMP_ACT_ERRNO. Measured four ways: a plain
    // container, cap_drop ALL, the full factory profile, and
    // seccomp=unconfined — only the last permits it. So this is not our
    // hardening being unusual; it is every container.
    assert.match(compose, /seccomp=\.\/seccomp-userns\.json/);
    const profile = JSON.parse(
      readFileSync(new URL('../docker/seccomp-userns.json', import.meta.url), 'utf8'));
    assert.equal(profile.defaultAction, 'SCMP_ACT_ERRNO',
      'still an allowlist; one group was added, the posture did not change');
    type Group = { names?: string[]; action?: string; includes?: { caps?: string[] } };
    const groups = profile.syscalls as Group[];
    const added = groups.filter((g) => (g.names ?? []).includes('unshare'));
    assert.ok(added.some((g) => g.action === 'SCMP_ACT_ALLOW' && !g.includes?.caps),
      'unshare must be allowed without CAP_SYS_ADMIN or bwrap cannot start');
  });
});

describe('a discarded write is a reporting bug, not a leak', () => {
  /**
   * Marlow, first shift under the sandbox: `touch /data/companies/probe.txt`
   * returns 0 and the file never exists. Denying read means the path cannot be
   * a bind of the real directory, so bubblewrap covers it with a scratch layer
   * that is writable and thrown away when the command exits.
   *
   * Adding `denyWrite` on the same path does not change it — measured. And the
   * alternative, binding the other companies read-only so writes fail loudly,
   * puts every company's name back in view and needs the deny list rebuilt
   * whenever one is founded. Invisibility is worth more than a loud failure on
   * a write that was already forbidden.
   */
  const staff = readFileSync(new URL('../src/runtime/staff.ts', import.meta.url), 'utf8');

  test('a contained session is told that exit 0 there means nothing', () => {
    assert.match(staff, /REPORTS SUCCESS AND IS DISCARDED/,
      'the one case where a zero exit code lies has to be stated');
    assert.match(staff, /Where your shell can write/);
  });

  test('and is pointed at the temp directory that actually works', () => {
    // /tmp is read-only under the sandbox and refuses loudly; $TMPDIR does not.
    assert.match(staff, /\$TMPDIR\. Use it rather than \/tmp/);
  });

  test('the warning is only given where there is a shell to warn about', () => {
    assert.match(staff, /\.\.\.\(shellIsContained\(\) \? \[/);
  });
});
