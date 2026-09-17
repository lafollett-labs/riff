/*
 * riff-mcp — a typed MCP surface over Riff's HTTP API.
 *
 * Run by stdio: `node src/mcp/server.ts`, base URL from RIFF_API (default the
 * loopback gateway). Every tool is a thin call into RiffClient, which is the
 * only thing that knows an endpoint's shape — so the API stays the single way
 * in and this cannot become a second implementation that drifts from it.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { RiffClient, normalizeBase, type RiffResponse } from './client.ts';
import { startUsagePolling } from './usagePoll.ts';

const BASE = normalizeBase(process.env['RIFF_API']);
const client = new RiffClient(BASE);

type Result = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: true;
};

const asText = (v: unknown): string => (typeof v === 'string' ? v : JSON.stringify(v, null, 2));

const present = (r: RiffResponse): Result =>
  r.status >= 400
    ? { content: [{ type: 'text', text: `HTTP ${r.status}: ${asText(r.data)}` }], isError: true }
    : { content: [{ type: 'text', text: asText(r.data) }] };

// A refused connection is the one failure worth translating: the gateway binds
// to loopback, so it means the stack is not up rather than a bug in the call.
const run = async (fn: () => Promise<RiffResponse>): Promise<Result> => {
  try {
    return present(await fn());
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    return {
      content: [{ type: 'text', text: `Riff API unreachable at ${BASE} (${m}). Is the stack up? Try: sh docker/up.sh up` }],
      isError: true,
    };
  }
};

const server = new McpServer({ name: 'riff', version: '0.1.0' });

const company = z.string().describe('company slug, e.g. "shipit"');

// ------------------------------------------------------------------- reads
server.registerTool('riff_companies', {
  title: 'Riff: list companies',
  description: 'List every company on this installation and which one is active.',
  inputSchema: {},
}, () => run(() => client.companies()));

server.registerTool('riff_usage', {
  title: 'Riff: subscription usage',
  description: 'The plan\'s own five-hour and seven-day windows (utilization and reset time), last injected from /api/oauth/usage. This is what the throttle paces on; report percentages, never dollars. Empty until the usage poller has posted a reading.',
  inputSchema: {},
}, () => run(() => client.usage()));

server.registerTool('riff_state', {
  title: 'Riff: company state',
  description: 'Live state of one company: running/awake/draining, headcount, agents, pending approvals, usage windows, next-due times.',
  inputSchema: { company },
}, ({ company: c }) => run(() => client.state(c)));

server.registerTool('riff_events', {
  title: 'Riff: recent events',
  description: 'Recent ledger events, newest last. `kinds` keeps only the named kinds (comma-separated, e.g. "agent.failed,shift.overran,agent.slept"); `dataJson` is parsed for you.',
  inputSchema: {
    company,
    limit: z.number().int().min(1).max(500).optional().describe('how many recent events to scan (default 60)'),
    kinds: z.string().optional().describe('comma-separated event kinds to keep'),
  },
}, ({ company: c, limit, kinds }) => run(() => client.events(c, {
  ...(limit !== undefined ? { limit } : {}),
  ...(kinds !== undefined ? { kinds } : {}),
})));

server.registerTool('riff_vitals', {
  title: 'Riff: vitals',
  description: 'Derived health numbers over a window (default 7.days): shift outcomes, trouble rate, contributions.',
  inputSchema: { company, window: z.string().optional().describe('e.g. "7.days", "24.hours"') },
}, ({ company: c, window }) => run(() => client.vitals(c, window)));

server.registerTool('riff_inbox', {
  title: 'Riff: board inbox',
  description: 'Mail addressed to the board chair. scope="all" shows the whole company\'s traffic, not just what reached the board.',
  inputSchema: { company, scope: z.enum(['mine', 'all']).optional() },
}, ({ company: c, scope }) => run(() => client.inbox(c, scope)));

server.registerTool('riff_approvals', {
  title: 'Riff: approvals',
  description: 'Pending board approvals, or the last decided ones with decided=true.',
  inputSchema: { company, decided: z.boolean().optional() },
}, ({ company: c, decided }) => run(() => client.approvals(c, decided)));

server.registerTool('riff_commons', {
  title: 'Riff: commons',
  description: 'The company\'s published commons documents, in the order they landed.',
  inputSchema: { company },
}, ({ company: c }) => run(() => client.commons(c)));

server.registerTool('riff_doc', {
  title: 'Riff: read a document',
  description: 'Read one document from a company\'s world by path (confined to the world root).',
  inputSchema: { company, path: z.string().describe('path within the world, e.g. "commons/thesis.md"') },
}, ({ company: c, path }) => run(() => client.doc(c, path)));

server.registerTool('riff_whathappened', {
  title: 'Riff: git activity',
  description: 'Commits and per-agent contributions in the world repo since a point (default 3.days).',
  inputSchema: { company, since: z.string().optional().describe('e.g. "3.days", "12.hours"') },
}, ({ company: c, since }) => run(() => client.whathappened(c, since)));

server.registerTool('riff_transcript', {
  title: 'Riff: review a shift transcript',
  description: 'The company\'s own audit of what a staff member did in a shift — the recorded SDK turns (thinking, tool calls, tool results, the closing result). `agent` is required; `session` picks one of that agent\'s sessions (default the most recent) and the response lists the rest. Filter entries with `kinds` (comma-separated: text,thinking,tool_use,tool_result,result) and/or `errorsOnly` (errored tool results + non-success shift results). Unfiltered returns a small recent page; filtering scans a larger page (raise `limit`, max 2000, or page with `after`=nextAfter to scan a long shift) and returns only the matches — `scanned` says how many turns were looked at, `more` whether another page waits. Turn counts and tool I/O only — never report dollars.',
  inputSchema: {
    company,
    agent: z.string().describe('agent id whose shift to read'),
    session: z.string().optional().describe('session id; defaults to the most recent'),
    kinds: z.string().optional().describe('comma-separated entry kinds to keep: text,thinking,tool_use,tool_result,result'),
    errorsOnly: z.boolean().optional().describe('keep only errored tool results and non-success shift results'),
    after: z.number().int().min(0).optional().describe('cursor: the last seq already seen (0 from the start)'),
    limit: z.number().int().min(1).max(2000).optional().describe('turns to scan per page (default 60, or 500 when filtering)'),
  },
}, ({ company: c, agent, session, kinds, errorsOnly, after, limit }) => run(() => client.transcript(c, {
  agent,
  ...(session !== undefined ? { session } : {}),
  ...(kinds !== undefined ? { kinds } : {}),
  ...(errorsOnly !== undefined ? { errorsOnly } : {}),
  ...(after !== undefined ? { after } : {}),
  ...(limit !== undefined ? { limit } : {}),
})));

// ------------------------------------------------------------- run control
server.registerTool('riff_running', {
  title: 'Riff: start or pause a company',
  description: 'Start (running=true) or pause (running=false) a company. Pause drains the current shift; hard=true kills it mid-write. hours sets a session deadline, capped by the company\'s maxSessionHours.',
  inputSchema: {
    company,
    running: z.boolean().describe('true starts, false pauses'),
    hours: z.number().positive().optional().describe('stop after this many hours'),
    maxTicks: z.number().int().positive().optional().describe('stop after this many wake cycles'),
    hard: z.boolean().optional().describe('true kills the shift instead of draining'),
  },
}, ({ company: c, running, hours, maxTicks, hard }) => run(() => client.setRunning(c, running, {
  ...(hours !== undefined ? { hours } : {}),
  ...(maxTicks !== undefined ? { maxTicks } : {}),
  ...(hard !== undefined ? { hard } : {}),
})));

server.registerTool('riff_wake', {
  title: 'Riff: wake one agent now',
  description: 'Wake one agent immediately (defaults to the CEO) and start the company if it was stopped. The way to watch a first shift without waiting out the interval.',
  inputSchema: { company, who: z.string().optional().describe('agent id; defaults to the CEO') },
}, ({ company: c, who }) => run(() => client.wake(c, who)));

// ------------------------------------------------------------------ writes
server.registerTool('riff_found', {
  title: 'Riff: found a company',
  description: 'Found a new company. `business` is the charter/brief (<=20000 chars). `chair` defaults to the host git identity — pass it explicitly. Policy fields are clamped server-side.',
  inputSchema: {
    name: z.string(),
    business: z.string(),
    ceo: z.string(),
    chair: z.string().optional(),
    board: z.array(z.object({ name: z.string(), role: z.string().optional() })).optional(),
    policy: z.record(z.string(), z.number()).optional(),
    running: z.boolean().optional().describe('start immediately (default true)'),
  },
}, ({ name, business, ceo, chair, board, policy, running }) => run(() => client.found({
  name,
  business,
  ceo,
  ...(chair !== undefined ? { chair } : {}),
  ...(board !== undefined
    ? { board: board.map((m) => ({ name: m.name, ...(m.role !== undefined ? { role: m.role } : {}) })) }
    : {}),
  ...(policy !== undefined ? { policy } : {}),
  ...(running !== undefined ? { running } : {}),
})));

server.registerTool('riff_update', {
  title: 'Riff: revise a company',
  description: 'Revise a company\'s name, brief, policy, or release. A policy change rebuilds the scheduler (re-arming session bounds); a brief change is delivered to the CEO as mail.',
  inputSchema: {
    company,
    name: z.string().optional(),
    business: z.string().optional(),
    policy: z.record(z.string(), z.number()).optional(),
    release: z.enum(['none', 'bundle']).optional(),
  },
}, ({ company: c, name, business, policy, release }) => run(() => client.update(c, {
  ...(name !== undefined ? { name } : {}),
  ...(business !== undefined ? { business } : {}),
  ...(policy !== undefined ? { policy } : {}),
  ...(release !== undefined ? { release } : {}),
})));

server.registerTool('riff_archive', {
  title: 'Riff: archive a company',
  description: 'Archive a company: move its directory to the archive area (git history and all) and drop its vault, taking it off the active list. Not a delete — the directory is kept and can be re-imported, at which point its keys are re-entered. Pause the company first; archiving a running one stops it without draining.',
  inputSchema: { company },
}, ({ company: c }) => run(() => client.archive(c)));

server.registerTool('riff_say', {
  title: 'Riff: send board mail',
  description: 'Send mail into a company as a board member (from must be a board seat; defaults to the chair). Absent `to` addresses everyone; a list reaches exactly those recipients and wakes them.',
  inputSchema: {
    company,
    text: z.string().describe('message body (<=4000 chars)'),
    to: z.array(z.string()).optional().describe('recipient agent ids; omit for everyone'),
    from: z.string().optional().describe('board seat id to speak as; defaults to the chair'),
  },
}, ({ company: c, text, to, from }) => run(() => client.say(c, text, {
  ...(to !== undefined ? { to } : {}),
  ...(from !== undefined ? { from } : {}),
})));

server.registerTool('riff_decide', {
  title: 'Riff: decide an approval',
  description: 'Approve or refuse a pending approval by id. `as` is the deciding board seat (defaults to the chair).',
  inputSchema: {
    company,
    id: z.string().describe('approval id, e.g. "apr_..."'),
    approved: z.boolean(),
    as: z.string().optional().describe('board seat id deciding; defaults to the chair'),
    reason: z.string().optional(),
  },
}, ({ company: c, id, approved, as, reason }) => run(() => client.decide(c, id, approved, {
  ...(as !== undefined ? { as } : {}),
  ...(reason !== undefined ? { reason } : {}),
})));

// The window feed. Only an interactive login can read the plan's rate-limit
// windows (a setup-token cannot), and that login is on the host — where this
// server runs. So while a session holds this MCP, keep the throttle fed with
// real windows. It is unref'd and fail-silent; `RIFF_USAGE_POLL=off` disables
// it (e.g. when the standalone daemon in usage-daemon.ts owns the feed) and
// `RIFF_USAGE_POLL_MS` tunes the cadence. See usagePoll.ts.
if (process.env['RIFF_USAGE_POLL'] !== 'off') {
  startUsagePolling(client, process.env['RIFF_USAGE_POLL_MS']
    ? { intervalMs: Number(process.env['RIFF_USAGE_POLL_MS']) } : {});
}

const transport = new StdioServerTransport();
await server.connect(transport);
