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
  description: 'The plan\'s own five-hour and seven-day windows (utilization and reset time), as the keyproxy last read them off the runtime credential\'s own responses (`at` is when). This is what the throttle paces on; report percentages, never dollars. Empty until the first call on the installation\'s credential after a restart.',
  inputSchema: {},
}, () => run(() => client.usage()));

server.registerTool('riff_state', {
  title: 'Riff: company state',
  description: 'Live state of one company: running/awake/draining, headcount, agents, pending approvals, usage windows, next-due times. `lean` drops the founding charter and each agent\'s mandate prose, leaving the operational surface (run flags, counts, live activity, dueAt, windows) — all a status check or a monitor needs, without a multi-KB charter dump every call.',
  inputSchema: {
    company,
    lean: z.boolean().optional().describe('drop the charter and agent mandates; keep the operational surface'),
  },
}, ({ company: c, lean }) => run(() => client.state(c, lean !== undefined ? { lean } : {})));

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
  description: 'Mail addressed to the board chair. scope="all" shows the whole company\'s traffic, not just what reached the board. `ids` reads exactly the named messages (their full bodies) — the "open these" step; `unreadOnly` keeps only unread mail addressed to you — the "do I have unread?" answer, and it matches the reported `unread` count; `limit` keeps the most recent N. Filter a busy inbox or its full message bodies dump back through the model.',
  inputSchema: {
    company,
    scope: z.enum(['mine', 'all']).optional(),
    ids: z.array(z.string()).optional().describe('read only these message ids (full bodies)'),
    unreadOnly: z.boolean().optional().describe('keep only unread mail addressed to you'),
    limit: z.number().int().min(1).max(500).optional().describe('keep only the most recent N messages'),
  },
}, ({ company: c, scope, ids, unreadOnly, limit }) => run(() => client.inbox(c, {
  ...(scope !== undefined ? { scope } : {}),
  ...(ids !== undefined ? { ids } : {}),
  ...(unreadOnly !== undefined ? { unreadOnly } : {}),
  ...(limit !== undefined ? { limit } : {}),
})));

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

server.registerTool('riff_mark_read', {
  title: 'Riff: mark board mail read',
  description: 'Mark board mail read, or unread with read=false. `ids` names the messages to mark — omit it to mark the whole inbox at once. Returns how many changed. Typical loop: riff_inbox with unreadOnly=true, then mark exactly the ids you have handled.',
  inputSchema: {
    company,
    ids: z.array(z.string()).optional().describe('message ids to mark; omit to mark the whole inbox'),
    read: z.boolean().optional().describe('true marks read (default), false marks unread'),
  },
}, ({ company: c, ids, read }) => run(() => client.markRead(c, {
  ...(ids !== undefined ? { ids } : {}),
  ...(read !== undefined ? { read } : {}),
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

// ---------------------------------------------------------------- services
// Service routes hold NO secret values — a secret NAME, a host, headers — so the
// whole map reads back and is safe to set here. Secret VALUES are entered only
// through the Desk Secrets tab; there is deliberately no tool that takes one.
server.registerTool('riff_services', {
  title: 'Riff: list service routes',
  description: 'A company\'s service routes: which named service the injecting proxy forwards to which upstream, authenticated by which vault secret. Holds no secret values, only names/hosts/headers. A route\'s product calls http://keyproxy:8890/svc/<name>/… with its scoped token; the proxy swaps in the real secret named by `secret`.',
  inputSchema: { company },
}, ({ company: c }) => run(() => client.services(c)));

server.registerTool('riff_set_service', {
  title: 'Riff: set a service route',
  description: 'Create or update one service route (create and update are the same write). `secret` names a vault secret (set its VALUE in the Desk Secrets tab — this tool never takes a value). A value is sealed for the routes that name it when it is entered, so set the route FIRST, and enter the value again after changing a route\'s upstream, header or scheme. `header` must be a credential header (authorization, x-api-key, api-key, apikey, x-goog-api-key, x-auth-token, x-api-token). `scheme` is the credential prefix: "Bearer" (default) or "" for a raw value like x-api-key. `headers` are static, NON-secret headers injected on every request — e.g. an OAuth/subscription upstream\'s {"anthropic-beta":"oauth-2025-04-20","user-agent":"claude-code/1.x"}; a key naming the credential header or a connection header is refused.',
  inputSchema: {
    company,
    name: z.string().describe('service name — a single path segment used in /svc/<name>'),
    upstream: z.string().describe('https base URL the proxy forwards to, e.g. https://api.anthropic.com'),
    secret: z.string().describe('vault secret NAME to inject (must exist; value set via the Desk Secrets tab)'),
    header: z.string().optional().describe('header to inject the credential into (default "authorization")'),
    scheme: z.string().optional().describe('credential prefix: "Bearer" (default), or "" to inject the raw value'),
    headers: z.record(z.string(), z.string()).optional().describe('static non-secret headers to add on every request'),
  },
}, ({ company: c, name, upstream, secret, header, scheme, headers }) => run(() => client.setService(c, name, {
  upstream,
  secret,
  ...(header !== undefined ? { header } : {}),
  ...(scheme !== undefined ? { scheme } : {}),
  ...(headers !== undefined ? { headers } : {}),
})));

server.registerTool('riff_delete_service', {
  title: 'Riff: delete a service route',
  description: 'Delete one service route by name. Reports whether it existed. Does not touch the vault secret it named.',
  inputSchema: { company, name: z.string().describe('service name to delete') },
}, ({ company: c, name }) => run(() => client.deleteService(c, name)));

const transport = new StdioServerTransport();
await server.connect(transport);
