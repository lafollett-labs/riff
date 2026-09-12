import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { RiffClient, normalizeBase, shapeEvents } from '../src/mcp/client.ts';

interface Recorded { method: string; url: string; body: unknown; }

/**
 * A stub gateway that records what the client sent and replies with whatever
 * the test queued. The point of the client is that it speaks the API's real
 * shapes; the only way to hold it to that is to watch the bytes it puts on the
 * wire.
 */
const stub = async (): Promise<{
  base: string;
  calls: Recorded[];
  reply: (body: unknown, status?: number) => void;
  close: () => Promise<void>;
}> => {
  const calls: Recorded[] = [];
  let next: { body: unknown; status: number } = { body: {}, status: 200 };
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += String(d); });
    req.on('end', () => {
      let body: unknown = null;
      if (raw.length > 0) { try { body = JSON.parse(raw); } catch { body = raw; } }
      calls.push({ method: req.method ?? '', url: req.url ?? '', body });
      res.writeHead(next.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(next.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address();
  const port = addr !== null && typeof addr === 'object' ? addr.port : 0;
  return {
    base: `http://127.0.0.1:${port}`,
    calls,
    reply: (body, status = 200) => { next = { body, status }; },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
};

const last = (calls: Recorded[]): Recorded => {
  const c = calls.at(-1);
  assert.ok(c, 'expected a recorded request');
  return c;
};
const bodyOf = (c: Recorded): Record<string, unknown> => c.body as Record<string, unknown>;

test('normalizeBase strips trailing slashes and falls back to loopback', () => {
  assert.equal(normalizeBase('http://x:4173/'), 'http://x:4173');
  assert.equal(normalizeBase('http://x:4173///'), 'http://x:4173');
  assert.equal(normalizeBase('  '), 'http://localhost:4173');
  assert.equal(normalizeBase(undefined), 'http://localhost:4173');
});

test('shapeEvents parses dataJson and filters by kind', () => {
  const raw = {
    events: [
      { seq: 1, at: 't1', actor: 'jack', kind: 'agent.woke', dataJson: '{"resumed":true}' },
      { seq: 2, at: 't2', actor: 'jack', kind: 'agent.failed', dataJson: '{"error":"boom"}' },
      { seq: 3, at: 't3', actor: 'jack', kind: 'agent.slept', dataJson: 'not json' },
    ],
  };
  const all = shapeEvents(raw);
  assert.equal(all.count, 3);
  assert.deepEqual(all.events[0]?.data, { resumed: true });
  assert.equal(all.events[2]?.data, 'not json', 'bad json is passed through, not thrown');

  const failed = shapeEvents(raw, 'agent.failed,shift.blind');
  assert.equal(failed.count, 1);
  assert.equal(failed.events[0]?.kind, 'agent.failed');
  assert.deepEqual(failed.events[0]?.data, { error: 'boom' });

  assert.equal(shapeEvents(null).count, 0, 'garbage in, empty out');
});

test('setRunning sends {running}, never {run} — the field that silently pauses', async () => {
  const s = await stub();
  try {
    const client = new RiffClient(s.base);
    await client.setRunning('shipit', true);
    const c = last(s.calls);
    assert.equal(c.method, 'POST');
    assert.equal(c.url, '/api/companies/shipit/running');
    const b = bodyOf(c);
    assert.equal(b['running'], true);
    assert.equal('run' in b, false, 'a stray `run` key is the bug this client exists to prevent');
  } finally {
    await s.close();
  }
});

test('setRunning carries drain/hard and bounds only when given', async () => {
  const s = await stub();
  try {
    const client = new RiffClient(s.base);
    await client.setRunning('shipit', false, { hard: true });
    assert.deepEqual(bodyOf(last(s.calls)), { running: false, hard: true });

    await client.setRunning('shipit', true, { hours: 4 });
    assert.deepEqual(bodyOf(last(s.calls)), { running: true, hours: 4 });

    await client.setRunning('shipit', true);
    assert.deepEqual(bodyOf(last(s.calls)), { running: true }, 'no undefined bound keys leak onto the wire');
  } finally {
    await s.close();
  }
});

test('reads hit the right method and path', async () => {
  const s = await stub();
  try {
    const client = new RiffClient(s.base);

    await client.companies();
    assert.deepEqual([last(s.calls).method, last(s.calls).url], ['GET', '/api/companies']);

    await client.usage();
    assert.deepEqual([last(s.calls).method, last(s.calls).url], ['GET', '/api/usage']);

    await client.state('shipit');
    assert.equal(last(s.calls).url, '/api/state?c=shipit');

    await client.vitals('shipit', '24.hours');
    assert.equal(last(s.calls).url, '/api/vitals?c=shipit&window=24.hours');

    await client.inbox('shipit', 'all');
    assert.equal(last(s.calls).url, '/api/inbox?c=shipit&scope=all');

    await client.approvals('shipit', true);
    assert.equal(last(s.calls).url, '/api/approvals/decided?c=shipit');

    await client.doc('shipit', 'commons/thesis.md');
    assert.equal(last(s.calls).url, '/api/doc?c=shipit&path=commons%2Fthesis.md');
  } finally {
    await s.close();
  }
});

test('events requests a limit and shapes the reply', async () => {
  const s = await stub();
  try {
    const client = new RiffClient(s.base);
    s.reply({ events: [{ seq: 9, at: 't', actor: 'jack', kind: 'agent.failed', dataJson: '{"error":"x"}' }] });
    const r = await client.events('shipit', { limit: 25, kinds: 'agent.failed' });
    assert.equal(last(s.calls).url, '/api/events?c=shipit&limit=25');
    const data = r.data as { count: number; events: Array<Record<string, unknown>> };
    assert.equal(data.count, 1);
    assert.deepEqual(data.events[0]?.data, { error: 'x' });
  } finally {
    await s.close();
  }
});

test('writes carry their required fields and omit absent optionals', async () => {
  const s = await stub();
  try {
    const client = new RiffClient(s.base);

    await client.found({ name: 'ShipIt', business: 'charter', ceo: 'Jack', chair: 'Cali' });
    let c = last(s.calls);
    assert.deepEqual([c.method, c.url], ['POST', '/api/companies']);
    assert.deepEqual(bodyOf(c), { name: 'ShipIt', business: 'charter', ceo: 'Jack', chair: 'Cali' });

    await client.say('shipit', 'hello', { from: 'marvin' });
    c = last(s.calls);
    assert.equal(c.url, '/api/say?c=shipit');
    assert.deepEqual(bodyOf(c), { text: 'hello', from: 'marvin' });

    await client.decide('shipit', 'apr_123', true, { as: 'marvin', reason: 'ok' });
    c = last(s.calls);
    assert.equal(c.url, '/api/approvals/apr_123?c=shipit');
    assert.deepEqual(bodyOf(c), { approved: true, as: 'marvin', reason: 'ok' });

    await client.update('shipit', { policy: { maxSessionHours: 4 } });
    c = last(s.calls);
    assert.equal(c.method, 'PATCH');
    assert.deepEqual(bodyOf(c), { policy: { maxSessionHours: 4 } });
  } finally {
    await s.close();
  }
});

test('an HTTP error status is reported, not swallowed', async () => {
  const s = await stub();
  try {
    const client = new RiffClient(s.base);
    s.reply({ error: 'nope' }, 409);
    const r = await client.setRunning('shipit', true);
    assert.equal(r.status, 409);
    assert.deepEqual(r.data, { error: 'nope' });
  } finally {
    await s.close();
  }
});
