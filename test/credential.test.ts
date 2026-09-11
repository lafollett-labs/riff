import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { credentialHealth, startCredentialHealth } from '../src/runtime/credential.ts';

const HOUR = 3_600_000;
const now = 1_700_000_000_000;

test('a bare token is taken on faith — there is no expiry in it to read', () => {
  assert.deepEqual(credentialHealth('sk-ant-oat-whatever', null, now), { live: true });
});

test('no record and no token is dead, and names the delivery that fixes it', () => {
  const h = credentialHealth(undefined, null, now);
  assert.equal(h.live, false);
  assert.equal((h as { live: false; fix: string }).fix, 'docker/up.sh creds');
});

test('a record whose token fields were nulled by a failed refresh is dead', () => {
  // The 02:54 failure on 2026-09-11: the file was present, so the entrypoint's
  // -s test passed, but the refresh had failed and cleared the token to null.
  const h = credentialHealth(undefined, { claudeAiOauth: { accessToken: null } }, now);
  assert.equal(h.live, false);
  assert.match((h as { why: string }).why, /no token/);
});

test('an empty claudeAiOauth object is dead — no token means no auth', () => {
  assert.equal(credentialHealth(undefined, { claudeAiOauth: {} }, now).live, false);
});

test('an EXPIRED access token is NOT fatal — the SDK renews it from the refresh token', () => {
  // Refusing here would reject a credential working exactly as designed: the
  // access token is short-lived on purpose. Only an unrenewable one is dead.
  const rec = { claudeAiOauth: { accessToken: 'a', refreshTokenExpiresAt: now + 30 * 24 * HOUR } };
  assert.deepEqual(credentialHealth(undefined, rec, now), { live: true });
});

test('an expired REFRESH token is fatal — the access token can no longer be renewed', () => {
  const rec = { claudeAiOauth: { accessToken: 'a', refreshTokenExpiresAt: now - HOUR } };
  const h = credentialHealth(undefined, rec, now);
  assert.equal(h.live, false);
  assert.match((h as { why: string }).why, /refresh token has expired/);
});

test('a live token with a future refresh expiry is live', () => {
  const rec = { claudeAiOauth: { accessToken: 'a', refreshTokenExpiresAt: now + HOUR } };
  assert.deepEqual(credentialHealth(undefined, rec, now), { live: true });
});

test('a record without a refreshTokenExpiresAt field is never refused on a guess', () => {
  // Not every record carries the field; absence must not read as expiry.
  assert.deepEqual(credentialHealth(undefined, { claudeAiOauth: { accessToken: 'a' } }, now),
    { live: true });
});

test('outside the container the check is a no-op — it never reads the operator’s own login', () => {
  // On a developer host ~/.claude/.credentials.json is their personal Claude
  // credential; gating a start on it would be wrong and would read a real
  // secret in the test suite. Uncontained always answers live.
  assert.deepEqual(startCredentialHealth({ HOME: '/nonexistent' }, false), { live: true });
});

test('contained with a delivered record, RIFF_WAIT_FOR_CREDENTIALS decides the record path', () => {
  const home = mkdtempSync(join(tmpdir(), 'riff-cred-'));
  try {
    mkdirSync(join(home, '.claude'));
    // startCredentialHealth reads the wall clock, so the expiry must be a real
    // future instant, not the fixed epoch the pure-function tests use.
    writeFileSync(join(home, '.claude', '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: 'a', refreshTokenExpiresAt: Date.now() + 30 * 24 * HOUR } }));
    const h = startCredentialHealth({ HOME: home, RIFF_WAIT_FOR_CREDENTIALS: '1' }, true);
    assert.deepEqual(h, { live: true });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('contained with the record path and a missing file is dead', () => {
  const home = mkdtempSync(join(tmpdir(), 'riff-cred-'));
  try {
    const h = startCredentialHealth({ HOME: home, RIFF_WAIT_FOR_CREDENTIALS: '1' }, true);
    assert.equal(h.live, false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('contained with the record path and a nulled token is dead', () => {
  const home = mkdtempSync(join(tmpdir(), 'riff-cred-'));
  try {
    mkdirSync(join(home, '.claude'));
    writeFileSync(join(home, '.claude', '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: null } }));
    assert.equal(startCredentialHealth({ HOME: home, RIFF_WAIT_FOR_CREDENTIALS: '1' }, true).live,
      false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('contained with the bare-token path (no RIFF_WAIT_FOR_CREDENTIALS) judges the env token', () => {
  assert.deepEqual(
    startCredentialHealth({ HOME: '/nonexistent', CLAUDE_CODE_OAUTH_TOKEN: 'oat-x' }, true),
    { live: true });
  assert.equal(
    startCredentialHealth({ HOME: '/nonexistent', CLAUDE_CODE_OAUTH_TOKEN: '' }, true).live,
    false);
});

test('contained, record path ignores a stray bare token — the file is the credential', () => {
  // In the record mode CLAUDE_CODE_OAUTH_TOKEN is a compose placeholder, not a
  // usable credential; a missing record must not be masked by it.
  const home = mkdtempSync(join(tmpdir(), 'riff-cred-'));
  try {
    assert.equal(
      startCredentialHealth(
        { HOME: home, RIFF_WAIT_FOR_CREDENTIALS: '1', CLAUDE_CODE_OAUTH_TOKEN: 'placeholder' },
        true,
      ).live,
      false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a malformed credentials file reads as absent, not as live', () => {
  const home = mkdtempSync(join(tmpdir(), 'riff-cred-'));
  try {
    mkdirSync(join(home, '.claude'));
    writeFileSync(join(home, '.claude', '.credentials.json'), '{ not json');
    assert.equal(startCredentialHealth({ HOME: home, RIFF_WAIT_FOR_CREDENTIALS: '1' }, true).live,
      false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
