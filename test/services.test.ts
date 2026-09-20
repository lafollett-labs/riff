import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { validateServiceRoute } from '../src/core/config.ts';

/**
 * validateServiceRoute is what stands between a hand-typed route and a config
 * the proxy will act on. The one security-grade rule is https-only: the proxy
 * decrypts a real key and sends it to `upstream`, so a plaintext hop is the one
 * place this system would otherwise leak a key onto the wire. It is a pure
 * function — no disk, no env — so the test is just inputs and verdicts.
 */
describe('a service route is validated before it can reach config', () => {
  test('a well-formed route normalises to exactly its fields', () => {
    const v = validateServiceRoute('openrouter', {
      upstream: '  https://openrouter.ai/api/v1  ', secret: 'OPENROUTER_API_KEY',
    });
    assert.ok(v.ok);
    assert.deepEqual(v.route, { upstream: 'https://openrouter.ai/api/v1', secret: 'OPENROUTER_API_KEY' });
  });

  test('defaults are left unset, not written out, so config stays minimal', () => {
    const v = validateServiceRoute('svc', { upstream: 'https://a.test', secret: 'KEY' });
    assert.ok(v.ok);
    assert.equal('header' in v.route, false);
    assert.equal('scheme' in v.route, false);
  });

  test('a custom header and an empty scheme are preserved (the X-Api-Key shape)', () => {
    const v = validateServiceRoute('svc', {
      upstream: 'https://a.test', secret: 'KEY', header: 'X-Api-Key', scheme: '',
    });
    assert.ok(v.ok);
    assert.equal(v.route.header, 'X-Api-Key');
    assert.equal(v.route.scheme, '');
  });

  test('surrounding whitespace is trimmed from upstream, secret, header and scheme', () => {
    const v = validateServiceRoute('svc', {
      upstream: '  https://a.test  ', secret: '  KEY  ', header: '  X-Api-Key  ', scheme: '  Token  ',
    });
    assert.ok(v.ok);
    assert.deepEqual(v.route, { upstream: 'https://a.test', secret: 'KEY', header: 'X-Api-Key', scheme: 'Token' });
  });

  test('a non-https upstream is refused — the key must never ride a plaintext hop', () => {
    const v = validateServiceRoute('svc', { upstream: 'http://a.test', secret: 'KEY' });
    assert.equal(v.ok, false);
    assert.match((v as { reason: string }).reason, /https/);
  });

  test('an upstream with embedded credentials is refused', () => {
    const v = validateServiceRoute('svc', { upstream: 'https://u:p@a.test', secret: 'KEY' });
    assert.equal(v.ok, false);
  });

  test('a non-URL upstream is refused', () => {
    assert.equal(validateServiceRoute('svc', { upstream: 'not a url', secret: 'KEY' }).ok, false);
  });

  test('a service name that is not a single clean path segment is refused', () => {
    for (const bad of ['', 'a/b', '../x', 'a b', '-lead', 'a.b']) {
      assert.equal(validateServiceRoute(bad, { upstream: 'https://a.test', secret: 'KEY' }).ok, false, bad);
    }
    assert.ok(validateServiceRoute('open-router_2', { upstream: 'https://a.test', secret: 'KEY' }).ok);
  });

  test('a leading-underscore name is refused, so the reserved `_runtime` route cannot be shadowed', () => {
    // SERVICE_NAME_RE requires a leading alphanumeric — that is the whole
    // collision defence for the synthesized runtime route: no company can ever
    // declare a service the keyproxy would confuse with `_runtime`.
    for (const bad of ['_runtime', '_x', '_']) {
      assert.equal(validateServiceRoute(bad, { upstream: 'https://a.test', secret: 'KEY' }).ok, false, bad);
    }
  });

  test('a secret that is not an environment identifier is refused', () => {
    for (const bad of ['', '1KEY', 'a-b', 'a.b', 'a b']) {
      assert.equal(validateServiceRoute('svc', { upstream: 'https://a.test', secret: bad }).ok, false, bad);
    }
  });

  test('a malformed header name is refused', () => {
    const v = validateServiceRoute('svc', { upstream: 'https://a.test', secret: 'KEY', header: 'bad header' });
    assert.equal(v.ok, false);
  });

  test('a scheme carrying a control character cannot smuggle a second header line', () => {
    // Not just CR/LF: a tab, a DEL, and a C1 control have no business in a header
    // value, and catching them here fails at the 400 gate, not as a 500 downstream.
    for (const bad of ['Bearer\r\nX: y', 'Bea\trer', 'Bearer\x7f', 'Bearer\x9b']) {
      assert.equal(validateServiceRoute('svc', { upstream: 'https://a.test', secret: 'KEY', scheme: bad }).ok, false, JSON.stringify(bad));
    }
  });

  test('a prototype-chain name is reserved, so the proxy lookup cannot be probed through it', () => {
    for (const bad of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf', 'prototype']) {
      const v = validateServiceRoute(bad, { upstream: 'https://a.test', secret: 'KEY' });
      assert.equal(v.ok, false, bad);
      assert.match((v as { reason: string }).reason, /reserved/);
    }
    // A name that merely contains one of those words is fine — only the exact key.
    assert.ok(validateServiceRoute('constructor-2', { upstream: 'https://a.test', secret: 'KEY' }).ok);
  });

  test('non-string fields are treated as absent, never coerced', () => {
    const v = validateServiceRoute('svc', { upstream: 'https://a.test', secret: 'KEY', header: 42, scheme: 7 });
    assert.ok(v.ok);
    assert.equal('header' in v.route, false);
    assert.equal('scheme' in v.route, false);
  });
});

describe('static route headers are validated and normalised', () => {
  const base = { upstream: 'https://a.test', secret: 'KEY' };

  test('well-formed static headers are preserved with lower-cased keys (the OAuth-subscription shape)', () => {
    const v = validateServiceRoute('anthropic', {
      ...base, header: 'authorization', scheme: 'Bearer',
      headers: { 'Anthropic-Beta': 'oauth-2025-04-20', 'User-Agent': 'claude-code/1.0' },
    });
    assert.ok(v.ok);
    assert.deepEqual(v.route.headers, { 'anthropic-beta': 'oauth-2025-04-20', 'user-agent': 'claude-code/1.0' });
  });

  test('absent or empty headers are left unset, so config stays minimal', () => {
    const absent = validateServiceRoute('svc', { ...base });
    assert.ok(absent.ok);
    assert.equal('headers' in absent.route, false);
    const v = validateServiceRoute('svc', { ...base, headers: {} });
    assert.ok(v.ok);
    assert.equal('headers' in v.route, false);
  });

  test('a static header naming the default credential header is refused', () => {
    const v = validateServiceRoute('svc', { ...base, headers: { authorization: 'Bearer sneaky' } });
    assert.equal(v.ok, false);
    assert.match((v as { reason: string }).reason, /credential header/);
  });

  test('a static header naming a CUSTOM credential header is refused', () => {
    // header: x-api-key means the vault secret is injected there — a static
    // value on the same name would try to shadow it.
    const v = validateServiceRoute('svc', { ...base, header: 'X-Api-Key', headers: { 'x-api-key': 'nope' } });
    assert.equal(v.ok, false);
    assert.match((v as { reason: string }).reason, /credential header/);
  });

  test('a connection-framing header cannot be set as a static header', () => {
    for (const bad of ['host', 'content-length', 'connection', 'transfer-encoding', 'Keep-Alive']) {
      const v = validateServiceRoute('svc', { ...base, headers: { [bad]: 'x' } });
      assert.equal(v.ok, false, bad);
    }
  });

  test('a malformed static header name is refused', () => {
    assert.equal(validateServiceRoute('svc', { ...base, headers: { 'bad header': 'x' } }).ok, false);
  });

  test('a non-string value, or a value carrying a control character, is refused', () => {
    assert.equal(validateServiceRoute('svc', { ...base, headers: { 'x-a': 42 } }).ok, false);
    for (const bad of ['a\r\nX: y', 'a\tb', 'a\x7f', 'a\x9b']) {
      assert.equal(validateServiceRoute('svc', { ...base, headers: { 'x-a': bad } }).ok, false, JSON.stringify(bad));
    }
  });

  test('headers that is not a plain object is refused', () => {
    for (const bad of [['a', 'b'], 'x-a: b', 42]) {
      assert.equal(validateServiceRoute('svc', { ...base, headers: bad }).ok, false, JSON.stringify(bad));
    }
  });

  test('more static headers than the cap is refused', () => {
    const many: Record<string, string> = {};
    for (let i = 0; i < 60; i++) many[`x-h${i}`] = 'v';
    assert.equal(validateServiceRoute('svc', { ...base, headers: many }).ok, false);
  });
});
