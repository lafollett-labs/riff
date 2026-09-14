// The console's ONLY reach into the server, and it must stay type-only: this
// erases at build time, while a value import of the same path compiles, builds
// and ships a module that dies in the browser. Vite says so in a warning and
// exits 0 anyway, so scripts/check-sfc-types.mjs enforces it instead.
import type { Vitals, Trend } from '../../src/analytics/types.ts';
import type { CompanyRef as ConfigCompanyRef, CompanyPolicy, ServiceRoute } from '../../src/core/config.ts';
import type { Turn, SessionSummary } from '../../src/ledger/transcript.ts';
export type { ServiceRoute };
export type { Turn, SessionSummary };
export type { Vitals, Trend };

/** Everything the Desk knows, it knows from these. */
export type Agent = {
  id: string; name: string; tier: string; role: string;
  department: string; reportsTo: string | null; status: string;
  activity: string; mandate: string; hiredAt: string; hiredBy: string | null;
};

export type Approval = {
  id: string; requestedBy: string; capability: string; tier: string;
  state: string; summary: string; target: string | null;
  amountCents: number | null; payloadJson: string | null;
  requestedAt: string; decidedBy: string | null;
  decidedAt: string | null; decisionReason: string | null;
};

export type Task = {
  id: string; title: string; body: string; status: string;
  createdBy: string; assignedTo: string | null;
  priority: number; createdAt: string; updatedAt: string;
};

export type Message = {
  id: string; from: string; to: string; alsoTo: string[]; body: string;
  broadcast: boolean; sentAt: string; readAt: string | null;
  /** Whether it reached you. Only your own mail has read state you can act on. */
  yours: boolean;
};

export type Inbox = {
  me: string; messages: Message[]; unread: number;
  /** 'mine' is what reached you; 'all' is the whole company talking. */
  scope?: 'mine' | 'all';
};

export type Work = {
  tasks: Task[];
  notes: number;
  orphans: Array<{ id: string; name: string; reportsTo: string | null }>;
};

export type CommonsDoc = {
  path: string; title: string; author: string | null; updated: string | null;
  /** When it first landed, from the event log. Null for anything older than it. */
  created: string | null;
  /** How many times it has been posted over — 1 means written once. */
  revisions: number;
};

export type Event = {
  id: string; seq: number; at: string; actor: string;
  kind: string; subject: string | null; dataJson: string | null;
};

/**
 * The report's shape comes from the server's own declaration rather than a
 * copy of it. Ninety fields restated by hand typechecked on both sides after
 * a rename and rendered `undefined` — see src/analytics/types.ts.
 *
 * Type-only, so it is erased before the bundle: no server code is shipped.
 */
// Imported, not restated — and this is the file that proves the rule: the hand
// copy that used to live here had dropped `portfolioCeiling`, so it typechecked
// on both sides while the Tune panel could not edit the missing field. Re-export
// the server's own declaration; SFC checking is the other half of the pair.
export type { CompanyPolicy };

export type State = {
  slug: string;
  company: { name: string; business: string };
  policy: CompanyPolicy;
  board: Array<{ id: string; name: string; role: string }>;
  ceo: { id: string; name: string };
  agents: Agent[];
  headcount: number;
  pending: number;
  pendingBoard: number;
  notes: number;
  unread: number;
  commons: { held: number; ceiling: number };
  tasks: number;
  seq: number;
  running: boolean;
  awake: string[];
  /** Paused, with the last shifts still finishing on their own. */
  draining: boolean;
  dueAt: Record<string, number>;
  pausedUntil: number | null;
  ticks: number;
  rateLimit: { status?: string; utilization?: number; rateLimitType?: string } | null;
  /** Every rate-limit window by name. The five-hour one is the figure that
   *  decides whether the operator can work this afternoon; rateLimit alone is
   *  whichever reported last and is usually the other one. */
  windows: Array<{ kind: string; utilization: number | null; resetsAt: number | null;
                  readAt: number }>;
};

/**
 * A company in the listing: what config records, plus what only a live
 * registry knows.
 *
 * Restating the first half here is what let the console fall behind the server
 * — `release` was added to the config side and this copy never heard about it,
 * so the field existed on the wire and not in the type.
 */
export type CompanyRef = ConfigCompanyRef &
  { running: boolean; awake: string[]; draining: boolean };

/**
 * Which company the console is looking at.
 *
 * Every request carries it. The server refuses an unknown slug rather than
 * falling back to some other company, so a stale value here fails loudly
 * instead of quietly reading and writing the wrong world.
 */
let current = '';
export const setCompany = (slug: string): void => { current = slug; };
export const getCompany = (): string => current;

const withCompany = (path: string): string => {
  if (!current) return path;
  return path + (path.includes('?') ? '&' : '?') + 'c=' + encodeURIComponent(current);
};

/**
 * URL for a file inside the current company's world — images a document points
 * at. Callers pass a world-relative path; the server refuses anything that
 * escapes the world, and anything that is not an image.
 */
export const fileUrl = (worldPath: string): string =>
  withCompany('/api/file?path=' + encodeURIComponent(worldPath));

const get = async <T>(path: string): Promise<T> => {
  const r = await fetch(withCompany(path));
  if (!r.ok) throw new Error(`${path} → ${r.status}`);
  return r.json() as Promise<T>;
};

const send = async <T>(path: string, method: string, body?: unknown): Promise<T> => {
  const r = await fetch(withCompany(path), {
    method,
    ...(body === undefined ? {} : {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  });
  const data = await r.json().catch(() => ({})) as T & { error?: string };
  if (!r.ok) throw new Error(data.error ?? `${path} → ${r.status}`);
  return data;
};

export const api = {
  // The installation, not one company — these never carry a slug in the query.
  companies: async (): Promise<{ companies: CompanyRef[]; active: string | null }> => {
    const r = await fetch('/api/companies');
    if (!r.ok) throw new Error(`/api/companies → ${r.status}`);
    return r.json() as Promise<{ companies: CompanyRef[]; active: string | null }>;
  },
  foundCompany: (input: { name: string; business: string; ceo: string; chair: string;
                         board?: Array<{ name: string; role?: string }>;
                         policy?: Partial<CompanyPolicy>;
                         release?: 'none' | 'bundle';
                         running?: boolean }) =>
    send<{ slug: string }>('/api/companies', 'POST', input),
  /**
   * Start, pause or shut down a company.
   *
   * A pause drains: it answers at once and the company reports `draining`
   * until whoever is mid-shift has written their journal. `hard` kills them
   * instead, which is what the log's `Claude Code process aborted by user`
   * entries are, and it is never the default.
   */
  setCompanyRunning: (slug: string, running: boolean,
                      bounds?: { hours?: number; maxTicks?: number; hard?: boolean }) =>
    send<{ running: boolean; draining?: boolean; until?: string; maxTicks?: number }>(
      `/api/companies/${encodeURIComponent(slug)}/running`, 'POST', { running, ...bounds }),
  renameAgent: (company: string, who: string, name: string) =>
    send<{ from: string; to: string; name: string }>('/api/agents/rename', 'POST',
      { company, who, name }),
  retireAgent: (company: string, who: string, why: string) =>
    send<{ retired: string; name: string; finishing: boolean }>('/api/agents/retire', 'POST',
      { company, who, why }),
  renameCompany: (slug: string,
                  patch: { name?: string; business?: string; slug?: string;
                           policy?: Partial<CompanyPolicy>; release?: 'none' | 'bundle' }) =>
    send<{ slug: string }>(`/api/companies/${encodeURIComponent(slug)}`, 'PATCH', patch),
  archiveCompany: (slug: string) =>
    send<{ archived: string; at: string }>(`/api/companies/${encodeURIComponent(slug)}`, 'DELETE'),
  /**
   * The archive itself is the body. There is exactly one file, so a multipart
   * form would be ceremony around a single blob — and the browser streams it
   * rather than building one in memory.
   */
  importCompany: async (f: File, name?: string) => {
    const q = name?.trim() ? `?name=${encodeURIComponent(name.trim())}` : '';
    const r = await fetch(`/api/companies/import${q}`, {
      method: 'POST', headers: { 'content-type': 'application/gzip' }, body: f,
    });
    const data = await r.json().catch(() => ({})) as
      { slug: string; renamed: boolean; manifest: { name: string }; error?: string };
    if (!r.ok) throw new Error(data.error ?? `import → ${r.status}`);
    return data;
  },

  state: () => get<State>('/api/state'),
  approvals: () => get<Approval[]>('/api/approvals'),
  decided: () => get<{ approvals: Approval[] }>('/api/approvals/decided'),
  work: () => get<Work>('/api/work'),
  inbox: (scope: 'mine' | 'all' = 'mine') =>
    get<Inbox>(scope === 'all' ? '/api/inbox?scope=all' : '/api/inbox'),
  recent: (limit = 200) => get<{ events: Event[] }>(`/api/events?limit=${limit}`),
  markRead: (ids?: string[], read = true) =>
    send<{ marked: number; read: boolean }>('/api/inbox/read', 'POST', { ...(ids ? { ids } : {}), read }),
  start: () => send<{ running: boolean }>('/api/open', 'POST'),
  /** Stop waking anybody; whoever is mid-shift finishes and writes. */
  pause: () => send<{ running: boolean; draining?: boolean }>('/api/close', 'POST'),
  /** Kill the shifts in flight. Everything since their last journal is lost. */
  shutdown: () => send<{ running: boolean }>('/api/close', 'POST', { hard: true }),
  wake: (who?: string) => send<{ waking: string }>('/api/wake', 'POST', who ? { who } : {}),
  /**
   * A company's secrets. Names only, ever — the value cannot be read back once
   * written, the same shape as the endpoint. Every call carries the company via
   * withCompany, so a secret is set for exactly the company on screen.
   */
  secrets: () => get<{ names: string[] }>('/api/secrets'),
  putSecret: (name: string, value: string) =>
    send<{ ok: boolean; name: string }>('/api/secrets', 'PUT', { name, value }),
  deleteSecret: (name: string) =>
    send<{ deleted: boolean }>(`/api/secrets?name=${encodeURIComponent(name)}`, 'DELETE'),
  /**
   * A company's service routes — where the injecting proxy forwards a named
   * service and which vault secret it injects. These carry no value (a secret
   * NAME, a host, a header), so unlike secrets the whole map reads back. Set a
   * route with the secret name a product's `api_key_env` will point at.
   */
  services: () => get<{ services: Record<string, ServiceRoute> }>('/api/services'),
  putService: (name: string, route: ServiceRoute) =>
    send<{ ok: boolean; name: string }>('/api/services', 'PUT', { name, ...route }),
  deleteService: (name: string) =>
    send<{ deleted: boolean }>(`/api/services?name=${encodeURIComponent(name)}`, 'DELETE'),
  /**
   * Upload an image pasted or chosen while composing, and get back the
   * world-relative path to reference it by (`![image](<path>)`). The bytes are
   * the body; the server sniffs the real type and refuses anything that is not
   * a raster image, so the content-type here is only a hint.
   */
  uploadAttachment: async (blob: Blob): Promise<{ path: string }> => {
    const r = await fetch(withCompany('/api/attachment'), {
      method: 'POST',
      headers: { 'content-type': blob.type || 'application/octet-stream' },
      body: blob,
    });
    const data = await r.json().catch(() => ({})) as { path: string; error?: string };
    if (!r.ok) throw new Error(data.error ?? `attachment → ${r.status}`);
    return data;
  },
  commons: () => get<{ held: number; ceiling: number; documents: CommonsDoc[] }>('/api/commons'),
  vitals: (window = '7.days') =>
    get<Vitals>(`/api/vitals?window=${encodeURIComponent(window)}`),
  happened: (since = '3.days') =>
    get<{ commits: Array<{ sha: string; author: string; at: string; subject: string }>;
          contributions: Array<{ author: string; commits: number }> }>(
      `/api/whathappened?since=${encodeURIComponent(since)}`),
  doc: (path: string) =>
    get<{ path: string; body: string; title: string | null; author: string | null; updated: string | null }>(
      `/api/doc?path=${encodeURIComponent(path)}`),
  /**
   * Review a shift: the company's own audit of what an agent did, recorded from
   * the SDK stream. `sessions` is that agent's history for a picker; `turns` is
   * one page of the chosen session (the most recent unless one is named). Pass
   * `after` (the last seq you hold) to page through a long shift or to tail a
   * running one; `more`/`nextAfter` in the reply drive both.
   */
  transcript: (agent: string, opts: { session?: string; after?: number; limit?: number } = {}) =>
    get<{ agent: string; sessionId: string | null; sessions: SessionSummary[]; turns: Turn[];
          more: boolean; nextAfter: number }>(
      `/api/transcript?agent=${encodeURIComponent(agent)}`
      + (opts.session ? `&session=${encodeURIComponent(opts.session)}` : '')
      + (opts.after ? `&after=${opts.after}` : '')
      + (opts.limit ? `&limit=${opts.limit}` : '')),
  decide: async (id: string, approved: boolean, reason: string) => {
    const r = await fetch(withCompany(`/api/approvals/${id}`), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ approved, reason }),
    });
    return r.ok;
  },
  say: async (to: string | string[] | null, text: string, from?: string) => {
    const r = await fetch(withCompany('/api/say'), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to, text, ...(from ? { from } : {}) }),
    });
    return r.ok;
  },
};

/** Live event tail. Returns an unsubscribe. */
export const stream = (onEvents: (e: Event[]) => void): (() => void) => {
  const es = new EventSource(withCompany('/api/stream'));
  es.addEventListener('tick', (ev) => {
    try { onEvents(JSON.parse((ev as MessageEvent).data).events ?? []); } catch { /* malformed frame */ }
  });
  return () => es.close();
};
