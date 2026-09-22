import { homedir } from 'node:os';
import { join, resolve, isAbsolute, sep } from 'node:path';
import { existsSync, readFileSync, mkdirSync, readdirSync, renameSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { userInfo } from 'node:os';
import { atomicWriteFileSync } from './atomicwrite.ts';
import { DEFAULT_STAFF, readStaffDefaults, type StaffDefaults } from './models.ts';

/**
 * Where the company lives.
 *
 * Nothing here is baked into source. The location is RESOLVED at runtime and
 * SCAFFOLDED on init, because a living company is data — it outlives any one
 * checkout, and it must survive the project folder being moved or renamed.
 *
 * One installation holds MANY companies, each self-contained under
 * ~/.riff/companies/<slug>/ with its own world, ledger and config. A
 * company is a directory you can copy, archive, or delete whole — nothing
 * about one reaches into another.
 *
 * Resolution order, first match wins:
 *   1. RIFF_WORLD / RIFF_LEDGER   move one piece
 *   2. RIFF_HOME                      point at one company directly
 *   3. RIFF_COMPANY_ID                pick a company by slug
 *   4. ./riff.config.json             project-local, for development
 *   5. the only company that exists       the common case
 *   6. built-in defaults                  only ever used to WRITE a new one
 *
 * Identity — RIFF_COMPANY, RIFF_BUSINESS, RIFF_CHAIR, RIFF_CEO — SEEDS a
 * company that does not exist yet; stored config always wins on a read. These
 * used to override every read, until the container's placeholder values renamed
 * every real company inside it — the resolver below folds stored over env over
 * built-in, in that order.
 */

/**
 * The dials a company is run on.
 *
 * Every company used to get identical hardcoded policy, which was fine while
 * they all did the same kind of work. A company writing documents and a
 * company writing software do not want the same turn ceiling: the first
 * finished inside 24 turns and the second hit the wall on every single shift.
 *
 * Usage, not money, is the budget worth governing here. On a subscription a
 * dollar figure means nothing — what runs out is the rate-limit window, and
 * exhausting it at 3am means the operator cannot work in the morning. So the
 * ceilings are stated as utilization of that window. `dailyCapCents` is a
 * different thing entirely and stays: it is the company spending real money
 * on the outside world, which has nothing to do with what the model costs.
 */
export type CompanyPolicy = {
  /** Model responses in one shift. A tool call and its result is one. */
  maxTurns: number;
  /** How many staff may be awake at once. */
  concurrency: number;
  /**
   * How often the COMPANY starts a round of shifts. Every interval, up to
   * `concurrency` staff wake; nobody wakes in between. Throttling stretches it.
   *
   * It used to be per agent, which meant a roster of four never rested — the
   * gap applied to each person while the others were already due. Rank still
   * decides who comes due first; this decides how often anyone does.
   */
  baseIntervalMinutes: number;
  /** Stretch the intervals once the window is this far spent (0–1). */
  throttleAboveUtilization: number;
  /**
   * Stop the company outright at this much of the window (0–1), so the
   * operator keeps headroom to do their own work. 1 disables it.
   */
  pauseAboveUtilization: number;
  /**
   * Replace an agent's conversation once it is this much of the model's
   * context window full (0–100), handing over to itself first. 0 never
   * rotates and leaves it to the runtime's own compaction.
   *
   * A percentage rather than a token count because the denominator is not
   * ours to assume: staff run whatever model the company gave them, and a
   * flat 500,000 is half a window on one model and unreachable on another —
   * which would not fail, it would silently never rotate.
   */
  rotateAtContextPct: number;
  /**
   * A conversation is also retired once it has run this many turns, across every
   * resume of it, whatever its context reads. 0 turns it off.
   *
   * rotateAtContextPct cannot catch a long conversation on a large window: the
   * runtime compacts context back below any percentage, so one ran to 4367 turns
   * without ever tripping 50% of a 1M window and its canUseTool control stream
   * died mid-shift. Turn count is the denominator-free bound. Mid-leg
   * stream-death recovery handles the acute failure, so this is a hygiene
   * ceiling rather than an aggressive trigger — keep it well above a normal work
   * span.
   */
  rotateAtSessionTurns: number;
  /** R6: how many documents the commons may hold. */
  commonsCeiling: number;
  /**
   * R7: how many projects the company may carry at once.
   *
   * Rule 6 rations documents and nothing rationed the work itself, so a
   * company kept shipping point releases of the first thing it thought of:
   * continuing is always locally cheaper than starting, and no shift ever had
   * a reason to ask whether the project should still exist. 0 turns the rule
   * off, for a company that genuinely wants to accrete.
   */
  portfolioCeiling: number;
  /** R4: per-treasurer, per-day ceiling on real money, in whole cents. */
  dailyCapCents: number;
  /**
   * Wall clock a single shift may take before it is stopped, in minutes.
   *
   * Every other bound on a shift counts something the model does — turns,
   * context, money. None of them advance while a shift is stuck, so a shift
   * waiting on something that never answers is unbounded, and it holds one of
   * `concurrency` slots for as long as it waits. Two of those and the company
   * is stopped without a single event saying so.
   *
   * That is not hypothetical: a shell command left holding stdin ran for
   * three days in this repo before a person noticed and killed it by hand.
   *
   * 45 rather than a guess. Across 499 recorded shifts the median is 3.3
   * minutes, p99 is 16.1, and the longest that ever finished is 27.7 — so
   * this is 1.6x the worst real shift and cannot cut off work that is
   * happening. 0 disables it.
   */
  shiftTimeoutMinutes: number;
  /**
   * Hours a run may last from the moment the company is started, before it
   * drain-stops itself. 0 is no limit.
   *
   * The bound existed and nothing supplied it: `until` was only ever set when
   * a caller passed one, so Start with no arguments — and a resume at boot,
   * which passes nothing at all — was an unbounded run on somebody's
   * subscription. Lathe was resumed that way by a rebuild at 01:58 on
   * 2026-09-08 and would still have been running in the morning.
   *
   * A ceiling rather than a default, because "max" is what it is called and
   * a longer run asked for explicitly should not quietly outlive it. The
   * deadline comes back on the response, so a clipped request is visible
   * rather than silent, and an operator who wants longer raises this.
   */
  maxSessionHours: number;
  /**
   * Attach a per-leg operation trace to a leg's failure events (tools-missing,
   * stale-session): the ordering of SDK messages, the tools the model reached
   * for, the gate asks and the CLI's own stderr in the run-up to the failure.
   * Off by default — it is an audit tool for reading what a shift was doing when
   * it stopped, and it carries a payload every time one fires. See runLeg's
   * legTrace.
   */
  shiftTrace: boolean;
};

/**
 * Room to do a piece of software, and a window that survives the day.
 *
 * 24 turns was the old ceiling and every shift of a coding company hit it —
 * read a file, edit, run the tests, read the failure, fix it is five turns
 * before anything works.
 */
export const DEFAULT_POLICY: CompanyPolicy = {
  maxTurns: 60,
  concurrency: 3,
  baseIntervalMinutes: 5,
  throttleAboveUtilization: 0.7,
  pauseAboveUtilization: 0.92,
  // Half a window. Cost per turn on a resumed session was measured at 0.074,
  // 0.292 and 0.457 as it aged — the same shift six times the price for
  // being further down a transcript. Past roughly half, accuracy starts
  // paying for it too.
  rotateAtContextPct: 50,
  // Well above a normal work span, well below where a control stream was seen to
  // die (4367). A hygiene ceiling; mid-leg recovery catches the acute failure.
  rotateAtSessionTurns: 600,
  commonsCeiling: 40,
  // Small on purpose. The rule does nothing until it bites, and a ceiling a
  // company never reaches is a ceiling that never made it choose.
  portfolioCeiling: 3,
  dailyCapCents: 500,
  shiftTimeoutMinutes: 45,
  // Long enough to be a real run, short enough that forgetting to stop it is
  // not a night's worth of somebody's window.
  maxSessionHours: 2,
  // Off until someone is diagnosing a stopped shift: the trace is diagnostic
  // weight, not steady-state record.
  shiftTrace: false,
};

/** Clamp anything a config file or an API caller offers into a workable range. */
export const readPolicy = (raw: unknown): CompanyPolicy => {
  const o = (raw ?? {}) as Partial<Record<keyof CompanyPolicy, unknown>>;
  // Only the numeric dials; shiftTrace is a flag and is read separately below.
  type NumericKey = { [K in keyof CompanyPolicy]: CompanyPolicy[K] extends number ? K : never }[keyof CompanyPolicy];
  const num = (k: NumericKey, lo: number, hi: number): number => {
    const raw = o[k];
    // Absent is not zero, and Number() disagrees: null, '' and [] all coerce
    // to a finite 0, which clamps to the minimum instead of falling back. A
    // missing concurrency would have meant one agent, not three.
    if (typeof raw !== 'number' && typeof raw !== 'string') return DEFAULT_POLICY[k];
    if (raw === '') return DEFAULT_POLICY[k];
    const v = Number(raw);
    return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : DEFAULT_POLICY[k];
  };
  return {
    maxTurns: Math.round(num('maxTurns', 1, 400)),
    concurrency: Math.round(num('concurrency', 1, 16)),
    baseIntervalMinutes: num('baseIntervalMinutes', 0.5, 720),
    throttleAboveUtilization: num('throttleAboveUtilization', 0, 1),
    // Throttling after the stop would never happen; keep the pair ordered.
    pauseAboveUtilization: Math.max(
      num('pauseAboveUtilization', 0.05, 1),
      num('throttleAboveUtilization', 0, 1),
    ),
    // Capped below the runtime's own compaction point on purpose: rotation
    // that fires after compaction has already run is rotation that never
    // fires, because compaction is what it exists to pre-empt.
    rotateAtContextPct: Math.round(num('rotateAtContextPct', 0, 90)),
    // 0 is a real setting: turn-count rotation off, leaving context % and the
    // mid-leg stream-death recovery.
    rotateAtSessionTurns: Math.round(num('rotateAtSessionTurns', 0, 100_000)),
    commonsCeiling: Math.round(num('commonsCeiling', 1, 500)),
    // 0 is a real setting here, unlike the commons: it means "no ceiling".
    portfolioCeiling: Math.round(num('portfolioCeiling', 0, 200)),
    dailyCapCents: Math.round(num('dailyCapCents', 0, 100_000_00)),
    // 0 is a real setting: no clock on a shift at all.
    shiftTimeoutMinutes: num('shiftTimeoutMinutes', 0, 1440),
    // 0 likewise: a run with no end, for someone who means it.
    maxSessionHours: num('maxSessionHours', 0, 720),
    // A plain flag, not a clamped number: anything but a real true is off.
    shiftTrace: typeof o.shiftTrace === 'boolean' ? o.shiftTrace : DEFAULT_POLICY.shiftTrace,
  };
};

/**
 * One entry in a company's `services` allowlist: where a named service's calls
 * are forwarded, and which vault secret authenticates them. Never a value.
 */
export type ServiceRoute = {
  /** Upstream base URL the proxy forwards to, e.g. https://openrouter.ai/api/v1 */
  upstream: string;
  /** The vault secret name to inject. Resolved by the proxy, never by the app. */
  secret: string;
  /** Header to inject the credential into. Default 'authorization'. */
  header?: string;
  /** Scheme prefix on the value. Default 'Bearer'; '' injects the raw secret. */
  scheme?: string;
  /**
   * Static, NON-secret headers injected on every forwarded request — e.g. the
   * `anthropic-beta` flag and a `user-agent` an OAuth/subscription upstream
   * requires. Values are literals; the credential still travels ONLY on
   * `header`/`scheme`, never here. Keys are stored lower-cased. A key naming the
   * credential header or a connection-framing header is refused by the
   * validator, and the credential is injected last so it always wins.
   */
  headers?: Record<string, string>;
};

/**
 * A service name becomes a path segment at the proxy — `/svc/<name>/…` — so it
 * is letters, digits, dash and underscore, nothing that needs escaping or could
 * climb the path.
 */
export const SERVICE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
// The regex admits names like `constructor` and `toString`. The proxy looks a
// route up as `services[name]`, which for an undeclared service of one of these
// names returns an inherited Object.prototype member — truthy — and so answers
// a probe differently from a genuinely-unknown service, leaking that the name is
// special. The proxy also guards with Object.hasOwn; rejecting the names here is
// the matching half, so such a route can never be stored in the first place.
const RESERVED_SERVICE_NAMES = new Set([
  '__proto__', 'prototype', 'constructor', 'hasOwnProperty', 'isPrototypeOf',
  'propertyIsEnumerable', 'toLocaleString', 'toString', 'valueOf',
]);
// RFC 7230 header-name tokens, and the environment-identifier rule secrets.ts
// enforces on the secret this route names.
const HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
// C0 controls, DEL, and C1 controls — none belong in a header value, and
// rejecting them here fails the route at the 400 gate rather than as a 500 when
// undici refuses the header downstream. CR/LF are the injection bytes; the rest
// are caught for the same reason the header name is held to a strict token set.
const CONTROL_CHARS_RE = /[\x00-\x1f\x7f-\x9f]/;

// Headers a static route header may NOT set: connection framing (the proxy
// reframes its own hop) and `authorization` (the default credential header).
// Mirrors keyproxy's HOP_BY_HOP — the proxy also skips these when applying a
// route's static headers, so a hand-edited config cannot slip one past either.
// A route with a CUSTOM credential header (e.g. x-api-key) refuses that name too,
// dynamically, in the validator.
const FORBIDDEN_STATIC_HEADERS = new Set([
  'host', 'authorization', 'connection', 'keep-alive', 'proxy-authorization',
  'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'content-length',
]);
// A blunt cap on operator input that rides every forwarded request. No real
// upstream needs more than a handful of static headers.
const MAX_STATIC_HEADERS = 50;

/**
 * Validate and normalise a service route before it is written to a company's
 * config. The credential this route names is decrypted in the proxy and sent to
 * `upstream` over the open internet, so the one hard line is that upstream must
 * be https — this is the single place the system would otherwise hand a real key
 * to a plaintext hop. A bad route is the operator's error (400), never a 500.
 */
export const validateServiceRoute = (
  name: string,
  route: { upstream?: unknown; secret?: unknown; header?: unknown; scheme?: unknown; headers?: unknown },
): { ok: true; route: ServiceRoute } | { ok: false; reason: string } => {
  if (!SERVICE_NAME_RE.test(name)) {
    return { ok: false, reason: `service name ${JSON.stringify(name)} must be a single path segment: letters, digits, dash or underscore` };
  }
  if (RESERVED_SERVICE_NAMES.has(name)) {
    return { ok: false, reason: `service name ${JSON.stringify(name)} is reserved` };
  }
  const upstream = typeof route.upstream === 'string' ? route.upstream.trim() : '';
  let u: URL;
  try { u = new URL(upstream); }
  catch { return { ok: false, reason: 'upstream must be an absolute URL, e.g. https://openrouter.ai/api/v1' }; }
  if (u.protocol !== 'https:') {
    return { ok: false, reason: 'upstream must be https — the proxy injects a real key and will not send it over a plaintext hop' };
  }
  if (u.username || u.password) {
    return { ok: false, reason: 'upstream must not embed credentials; the key comes from the vault, named by `secret`' };
  }
  const secret = typeof route.secret === 'string' ? route.secret.trim() : '';
  if (!ENV_NAME_RE.test(secret)) {
    return { ok: false, reason: 'secret must name a vault secret: a valid environment identifier (letter or underscore, then letters, digits, underscores)' };
  }
  const header = typeof route.header === 'string' ? route.header.trim() : '';
  if (header && !HEADER_NAME_RE.test(header)) {
    return { ok: false, reason: `header ${JSON.stringify(header)} is not a valid HTTP header name` };
  }
  // scheme '' is a deliberate choice (inject the raw value), so only a non-string
  // is "absent"; a control char in it would break out of the header line.
  const schemeGiven = typeof route.scheme === 'string';
  // Trim like upstream/secret/header; '' (raw injection) stays '' after trimming.
  const scheme = schemeGiven ? (route.scheme as string).trim() : '';
  if (schemeGiven && CONTROL_CHARS_RE.test(scheme)) {
    return { ok: false, reason: 'scheme must not contain control characters' };
  }
  // Static, non-secret headers injected alongside the credential (e.g. the
  // `anthropic-beta` flag and `user-agent` an OAuth upstream requires). Literals
  // only — the credential still travels solely on `header`/`scheme`. A key that
  // names the credential header (so it cannot shadow the injected key) or a
  // connection-framing header (which the proxy owns) is refused; keys are stored
  // lower-cased, matching how the proxy applies them.
  let headers: Record<string, string> | undefined;
  if (route.headers != null) {
    if (typeof route.headers !== 'object' || Array.isArray(route.headers)) {
      return { ok: false, reason: 'headers must be an object mapping header names to string values' };
    }
    const entries = Object.entries(route.headers as Record<string, unknown>);
    if (entries.length > MAX_STATIC_HEADERS) {
      return { ok: false, reason: `at most ${MAX_STATIC_HEADERS} static headers` };
    }
    const credHeader = (header || 'authorization').toLowerCase();
    const built: Record<string, string> = {};
    for (const [k, v] of entries) {
      const key = k.trim();
      if (!HEADER_NAME_RE.test(key)) {
        return { ok: false, reason: `header ${JSON.stringify(k)} is not a valid HTTP header name` };
      }
      const lk = key.toLowerCase();
      if (lk === credHeader) {
        return { ok: false, reason: `header ${JSON.stringify(key)} is the credential header; the vault secret is injected there, not a static value` };
      }
      if (FORBIDDEN_STATIC_HEADERS.has(lk)) {
        return { ok: false, reason: `header ${JSON.stringify(key)} is a connection header the proxy manages and cannot be set as a static header` };
      }
      if (typeof v !== 'string') {
        return { ok: false, reason: `header ${JSON.stringify(key)} must have a string value` };
      }
      if (CONTROL_CHARS_RE.test(v)) {
        return { ok: false, reason: `header ${JSON.stringify(key)} value must not contain control characters` };
      }
      built[lk] = v;
    }
    if (entries.length) headers = built;
  }
  const out: ServiceRoute = { upstream, secret };
  if (header) out.header = header;
  if (schemeGiven) out.scheme = scheme;
  if (headers) out.headers = headers;
  return { ok: true, route: out };
};

/**
 * How a company (or the installation, as a default) authenticates the agents'
 * OWN Claude inference. `subscription` is a long-lived setup-token injected as
 * `Authorization: Bearer`; `apiKey` is an Anthropic API key injected as
 * `x-api-key`. The keyproxy synthesises the upstream shape from this; the token
 * VALUE never lives here — it is in the vault under `RUNTIME_SECRET_NAME`.
 */
export type RuntimeCredentialType = 'subscription' | 'apiKey';
export type RuntimeCredential = { type: RuntimeCredentialType };

/**
 * The vault name the runtime token is stored under — per company and, as the
 * fallback, at the install level. It is Riff's, not a normal secret: the generic
 * `/api/secrets` endpoints refuse it and never list it, so it cannot be read,
 * shadowed or deleted as an ordinary product secret.
 */
export const RUNTIME_SECRET_NAME = 'RIFF_RUNTIME_TOKEN';
/**
 * The keyproxy route the agents' SDK reaches (`/svc/_runtime`). The leading
 * underscore is the whole collision defence: `SERVICE_NAME_RE` requires a
 * leading alphanumeric, so no company can ever declare a service of this name.
 */
export const RUNTIME_SERVICE_NAME = '_runtime';

/** Read a stored runtime-credential setting, or undefined if unset/malformed —
 *  which means "fall back to the install-level default". */
export const readRuntimeCredential = (raw: unknown): RuntimeCredential | undefined => {
  if (!raw || typeof raw !== 'object') return undefined;
  const type = (raw as { type?: unknown }).type;
  return type === 'apiKey' || type === 'subscription' ? { type } : undefined;
};

/**
 * The synthesized `_runtime` route the keyproxy builds from a company's (or the
 * install default's) credential TYPE. The upstream is always Anthropic; the shape
 * differs by type. A subscription (OAuth) token authenticates as a Bearer and the
 * upstream requires the beta flag + a claude-code user-agent (the pair the Agent
 * SDK adds, and what the usage poller already sends successfully); an API key
 * authenticates as `x-api-key`. Both carry `anthropic-version`, which every
 * `/v1/messages` request requires: injecting it here rather than trusting the
 * caller means a subscription shift is not one dropped SDK header from a silent
 * 400 (a hand-rolled verify curl hit exactly that). Kept here so the keyproxy and
 * its tests build the exact same route.
 */
export const RUNTIME_UPSTREAM = 'https://api.anthropic.com';
export const CLAUDE_CODE_UA = 'claude-code/2.1.280';
export const ANTHROPIC_VERSION = '2023-06-01';
/**
 * Where a shift's Agent SDK is pointed (`ANTHROPIC_BASE_URL`): the keyproxy's
 * reserved runtime route. The SDK appends `/v1/messages`; the keyproxy forwards
 * to Anthropic with the real credential injected. The port is the keyproxy's
 * fixed default (`KEYPROXY_PORT`), matching the product `/svc/<name>` convention.
 */
export const RUNTIME_BASE_URL = 'http://keyproxy:8890/svc/_runtime';
export const runtimeRouteHeaders = (type: RuntimeCredentialType): Record<string, string> =>
  type === 'apiKey'
    ? { 'anthropic-version': ANTHROPIC_VERSION }
    : { 'anthropic-version': ANTHROPIC_VERSION, 'anthropic-beta': 'oauth-2025-04-20', 'user-agent': CLAUDE_CODE_UA };
export const runtimeRouteShape = (type: RuntimeCredentialType): { header: string; scheme: string } =>
  type === 'apiKey' ? { header: 'x-api-key', scheme: '' } : { header: 'authorization', scheme: 'Bearer' };

export type RiffConfig = {
  version: 1;
  /**
   * Where the company is, and where its two halves sit inside it.
   *
   * DERIVED, never persisted. A company is identified by the directory it is
   * in, so a config that also states its own location is stating something the
   * filesystem already knows — and the two can disagree. They did: an exported
   * company carried the absolute paths of the machine it left, and those won
   * over the folder it had actually arrived in. `persisted()` strips them on
   * the way out, and `resolveConfig` computes them on the way in.
   */
  home: string;
  worldDir: string;
  ledgerPath: string;
  /**
   * Whose company this is. Every install has a different human at the top, so
   * the chair is configuration, never a name in the source.
   */
  company: { name: string; business: string };
  /** Humans. Terminal authority. */
  board: Array<{ id: string; name: string; role: string }>;
  /** The primary agent. Builds the company. */
  ceo: { id: string; name: string };
  /**
   * External MCP servers handed to every staff session — an image generator,
   * a calendar, an inbox. Riff knows nothing about any specific provider;
   * plugging one in is a config change, not a code change.
   *
   * Credentials belong in headers here, and this file is gitignored. Anything
   * these tools reach still crosses the gate: touching the outside world is
   * `external.write`, which always lands as a draft.
   */
  connectors: Record<string, { type: 'http' | 'sse'; url: string; headers?: Record<string, string> }>;
  /**
   * External services the company's product may call through the key-injecting
   * proxy. Names and upstream hosts ONLY — never a secret value. The proxy maps
   * a request for <name> onto <upstream>, injecting the vault secret <secret>
   * (see `src/core/secrets.ts` and `/api/secrets`) so the real key reaches the
   * call without ever entering the factory. `header`/`scheme` default to
   * `Authorization: Bearer <value>`; a service wanting `X-Api-Key: <value>`
   * raw sets header and an empty scheme.
   */
  services: Record<string, ServiceRoute>;
  /**
   * How approved work physically leaves, when no connector is wired.
   *
   * 'none' means it does not: an approved draft sits in the drafts folder and
   * the company must not describe anything as published. 'bundle' means the
   * board collects it by hand — the company builds a release under `dist/` in
   * its world and the board carries it out. The difference matters to what
   * staff may honestly claim, which is why it is configuration and not a
   * sentence in a brief that a session can talk itself out of.
   */
  release: 'none' | 'bundle';
  /** How hard this company works, and what it may authorise. See CompanyPolicy. */
  policy: CompanyPolicy;
  /**
   * The model and effort every seat runs on unless the board gave it its own.
   * Not in `policy` on purpose: a policy change rebuilds the scheduler, which
   * aborts whoever is mid-shift, and this is read per wake — so changing it
   * never has to cost a shift. See src/core/models.ts.
   */
  staff: StaffDefaults;
  /**
   * Whether this company should be working.
   *
   * Persisted because a scheduler lives in a process and the operator's
   * intent does not. Restarting the server used to silently pause every
   * company that was running, with the console cheerfully reporting idle.
   */
  running?: boolean;
  /**
   * This company's OWN Claude runtime credential, overriding the install-level
   * default. Absent means "use the installation default". The TYPE is here; the
   * token value is in the vault under RUNTIME_SECRET_NAME, never in config.
   */
  runtimeCredential?: RuntimeCredential;
};

/** Best guess at who is running this, for the first-run prompt to confirm. */
export const guessKeeperName = (): string => {
  const fromEnv = process.env['RIFF_CHAIR'];
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  try {
    const g = execFileSync('git', ['config', '--get', 'user.name'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (g) return g.split(/\s+/)[0] ?? g;
  } catch { /* no git identity configured */ }
  const u = userInfo().username;
  return u ? u.charAt(0).toUpperCase() + u.slice(1) : 'Keeper';
};

/** Filesystem- and id-safe handle derived from a display name. */
export const slugId = (name: string): string =>
  name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'keeper';

const PROJECT_CONFIG = 'riff.config.json';
const CONFIG_NAME = 'config.json';

/**
 * An error the operator can act on, as opposed to a defect. Scripts print the
 * message and stop; a stack trace here would bury the one line that helps.
 */
const OPERATOR_ERROR = Symbol.for('riff.operatorError');
export const operatorError = (message: string): Error =>
  Object.assign(new Error(message), { [OPERATOR_ERROR]: true });
export const isOperatorError = (e: unknown): boolean =>
  e instanceof Error && (e as unknown as Record<symbol, unknown>)[OPERATOR_ERROR] === true;

const readConfigFile = (path: string): Partial<RiffConfig> | null => {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf8')) as Partial<RiffConfig>; }
  catch { return null; }
};

/**
 * The installation root — read at CALL time, never frozen at import.
 *
 * These were module constants derived from homedir(), which meant the e2e
 * suite listed and could open the operator's real companies even though its
 * config set a throwaway home. A containment boundary that only holds until
 * someone imports the module early is not a boundary.
 */
export const installRoot = (env = process.env): string =>
  env['RIFF_ROOT']?.trim() || join(homedir(), '.riff');


export const companiesDir = (env = process.env): string => join(installRoot(env), 'companies');

/**
 * Where removed companies go.
 *
 * A company is a git repository with real history in it. Nothing here deletes
 * one — removing it moves it aside, stamped, and the operator can throw it
 * away themselves once they are sure. Making removal cheap is the point;
 * making it irreversible is not.
 */
export const archiveDir = (env = process.env): string => join(installRoot(env), 'archive');

/** Where one company lives. Self-contained: world, ledger, config. */
export const companyHome = (slug: string): string => join(companiesDir(), slug);

export type CompanyRef = {
  slug: string;
  name: string;
  business: string;
  home: string;
  ceo: string;
  founded: boolean;
  /** What the operator last asked for, which a restart must honour. */
  wanted: boolean;
  /** The route work leaves by. In the listing so the console can offer to
   *  change it without opening the company first. */
  release: 'none' | 'bundle';
};

const readRef = (slug: string): CompanyRef | null => {
  const home = companyHome(slug);
  const cfg = readConfigFile(join(home, CONFIG_NAME));
  if (!cfg) return null;
  return {
    slug,
    name: cfg.company?.name ?? slug,
    business: cfg.company?.business ?? '',
    home,
    ceo: cfg.ceo?.name ?? 'CEO',
    founded: existsSync(join(home, 'ledger.db')),
    wanted: cfg.running === true,
    release: cfg.release === 'bundle' ? 'bundle' : 'none',
  };
};

/** Every company on this machine, newest activity first. */
export const listCompanies = (): CompanyRef[] => {
  const dir = companiesDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((d) => { try { return statSync(join(dir, d)).isDirectory(); } catch { return false; } })
    .map(readRef)
    .filter((r): r is CompanyRef => r !== null)
    .sort((a, b) => {
      const at = (p: string) => { try { return statSync(join(p, 'ledger.db')).mtimeMs; } catch { return 0; } };
      return at(b.home) - at(a.home);
    });
};

/**
 * The first layout put a single company flat in ~/.riff. Anyone who ran
 * Riff before companies existed has a live world there, with its own git
 * history, so this moves it rather than leaving it stranded. Idempotent, and
 * it never overwrites an existing company directory.
 */
export const migrateLegacyLayout = (): { moved: string } | null => {
  const root = installRoot();
  const legacyCfg = join(root, CONFIG_NAME);
  if (!existsSync(legacyCfg) || !existsSync(join(root, 'world'))) return null;

  const cfg = readConfigFile(legacyCfg);
  const slug = slugId(cfg?.company?.name ?? 'company');
  const target = companyHome(slug);
  if (existsSync(target)) return null;

  mkdirSync(companiesDir(), { recursive: true });
  mkdirSync(target, { recursive: true });
  // Move rather than copy: the world is a git repository and the ledger has
  // sidecar -wal/-shm files. Renaming the whole set keeps them consistent.
  for (const entry of ['world', 'ledger.db', 'ledger.db-wal', 'ledger.db-shm', CONFIG_NAME]) {
    const from = join(root, entry);
    if (existsSync(from)) renameSync(from, join(target, entry));
  }
  // The stored config records absolute paths from the old location.
  const moved = readConfigFile(join(target, CONFIG_NAME));
  if (moved) {
    atomicWriteFileSync(join(target, CONFIG_NAME), JSON.stringify({
      ...moved, home: target, worldDir: join(target, 'world'), ledgerPath: join(target, 'ledger.db'),
    }, null, 2) + '\n');
  }
  return { moved: slug };
};

const abs = (base: string, p: string): string => (isAbsolute(p) ? p : resolve(base, p));

/**
 * A stored path is honoured only if it lands inside the company it was read
 * from. An absolute one pointing anywhere else is a leftover from another
 * machine, not an instruction — RIFF_WORLD and RIFF_LEDGER are how
 * you deliberately put a world somewhere unusual.
 */
const within = (base: string, p: string | undefined, fallback: string): string => {
  const here = resolve(base);
  const candidate = p ? abs(here, p) : join(here, fallback);
  return candidate === here || candidate.startsWith(here + sep)
    ? candidate : join(here, fallback);
};

/**
 * The config as it goes to disk: everything except where it is.
 *
 * Kept as an explicit pick rather than a delete, so a field added to the type
 * later is written by default instead of silently dropped.
 */
export const persisted = (cfg: RiffConfig & { running?: boolean }): Record<string, unknown> => {
  const { home: _h, worldDir: _w, ledgerPath: _l, ...rest } = cfg;
  return rest;
};

const fromHome = (home: string): RiffConfig => {
  const name = guessKeeperName();
  return {
    version: 1,
    home,
    worldDir: join(home, 'world'),
    ledgerPath: join(home, 'ledger.db'),
    company: { name: 'Untitled Company', business: '' },
    board: [{ id: slugId(name), name, role: 'Chairman' }],
    ceo: { id: 'ceo', name: 'CEO' },
    connectors: {},
    services: {},
    release: 'none',
    policy: DEFAULT_POLICY,
    staff: DEFAULT_STAFF,
  };
};

/** Resolve without touching disk beyond reading. Never creates anything. */
/**
 * Which company a bare invocation means.
 *
 * An explicit slug always wins. Otherwise: if exactly one company exists, that
 * is unambiguously the one — and if several do, refusing to guess is better
 * than picking one and writing to it. The caller names it.
 */
export const resolveSlug = (env = process.env): string | null => {
  const explicit = env['RIFF_COMPANY_ID']?.trim();
  if (explicit) return slugId(explicit);
  const all = listCompanies();
  return all.length === 1 ? all[0]!.slug : null;
};

export const resolveConfig = (cwd = process.cwd(), slug?: string): RiffConfig => {
  const env = process.env;
  const pick = slug ?? resolveSlug(env);
  const explicitHome = env['RIFF_HOME'] ? abs(cwd, env['RIFF_HOME']) : null;

  // Several companies exist and nobody said which. Falling through here would
  // scaffold a brand new world at the INSTALL ROOT, next to the companies
  // directory rather than inside it — a silent third company nobody asked for.
  // Refusing is the only safe answer, and the message names the way out.
  if (!explicitHome && !pick && !readConfigFile(join(cwd, PROJECT_CONFIG))) {
    const all = listCompanies();
    if (all.length > 1) {
      throw operatorError(
        `This installation holds ${all.length} companies and none was named.\n` +
        `  Pass --company <slug>, or set RIFF_COMPANY_ID.\n` +
        // Sorted, not by recency: a list you read to pick a name should be in
        // the same order every time, whatever you ran last.
        `  Known: ${all.map((c) => c.slug).sort().join(', ')}`,
      );
    }
  }

  const home = explicitHome ?? (pick ? companyHome(pick) : null);

  const projectCfg = readConfigFile(join(cwd, PROJECT_CONFIG));
  const homeCfg = readConfigFile(join(home ?? installRoot(), CONFIG_NAME));

  const base = home
    ?? (projectCfg?.home ? abs(cwd, projectCfg.home) : null)
    ?? (homeCfg?.home ? abs(cwd, homeCfg.home) : null)
    ?? installRoot();

  const merged = { ...fromHome(base), ...homeCfg, ...projectCfg, home: base };

  // What is actually written down, as opposed to what fromHome() invented as a
  // default. Identity has three tiers and they are not interchangeable:
  // stored beats environment beats built-in. Folding the defaults in first
  // makes "is this stored?" unanswerable, which is how a container's
  // placeholder came to outrank a real company's name.
  const stored = { ...homeCfg, ...projectCfg };

  // Identity from the environment SEEDS a company that does not exist yet. It
  // must never override one that does.
  //
  // These used to win on every read, from when an installation held exactly
  // one company and "reproducible from environment alone" was coherent. With
  // many companies it is not: the container sets RIFF_COMPANY and RIFF_CEO to
  // placeholder defaults, so every company opened inside it was renamed
  // "Untitled Company" and had its CEO reported as `ceo`. That id is not
  // cosmetic — constitutionFor() makes it the executive AND the sole
  // treasurer, and genesis hires whoever it names. Two real companies each
  // gained a phantom executive that way.
  const chairName = stored.board?.[0]?.name || env['RIFF_CHAIR']?.trim() || guessKeeperName();
  const board = merged.board?.length
    ? merged.board
    : [{ id: slugId(chairName), name: chairName, role: 'Chairman' }];

  // Absent when unset, so "is this company on its own credential?" stays
  // answerable — the keyproxy reads this to decide whether to fall back to the
  // install-level default.
  const runtimeCredential = readRuntimeCredential(stored.runtimeCredential);

  return {
    version: 1,
    home: base,
    worldDir: env['RIFF_WORLD'] ? abs(cwd, env['RIFF_WORLD']) : within(base, merged.worldDir, 'world'),
    ledgerPath: env['RIFF_LEDGER'] ? abs(cwd, env['RIFF_LEDGER']) : within(base, merged.ledgerPath, 'ledger.db'),
    company: {
      name: stored.company?.name || env['RIFF_COMPANY']?.trim() || 'Untitled Company',
      business: stored.company?.business || env['RIFF_BUSINESS']?.trim() || '',
    },
    board,
    ceo: stored.ceo
      ?? (env['RIFF_CEO']?.trim()
        ? { id: slugId(env['RIFF_CEO'].trim()), name: env['RIFF_CEO'].trim() }
        : { id: 'ceo', name: 'CEO' }),
    connectors: merged.connectors ?? {},
    services: merged.services ?? {},
    release: merged.release === 'bundle' ? 'bundle' : 'none',
    // Companies founded before policy existed have none written down, and
    // read back at the defaults rather than at zero.
    policy: readPolicy(stored.policy),
    staff: readStaffDefaults(stored.staff),
    ...(runtimeCredential ? { runtimeCredential } : {}),
  };
};

/** Record whether a company should be working, for the next process to honour. */
export const setRunningFlag = (home: string, running: boolean): void => {
  const path = join(home, CONFIG_NAME);
  const cfg = readConfigFile(path);
  if (!cfg) return;
  const { home: _h, worldDir: _w, ledgerPath: _l, ...rest } = cfg;
  atomicWriteFileSync(path, JSON.stringify({ ...rest, running }, null, 2) + '\n');
};

/** Create the company's home and write the config. Idempotent. */
export const scaffoldConfig = (cfg: RiffConfig): { created: boolean; path: string } => {
  mkdirSync(cfg.home, { recursive: true });
  mkdirSync(cfg.worldDir, { recursive: true });
  mkdirSync(resolve(cfg.ledgerPath, '..'), { recursive: true });

  const path = join(cfg.home, CONFIG_NAME);
  if (existsSync(path)) return { created: false, path };

  atomicWriteFileSync(path, JSON.stringify(persisted(cfg), null, 2) + '\n');
  return { created: true, path };
};

export const isInitialised = (cfg: RiffConfig): boolean =>
  existsSync(join(cfg.home, CONFIG_NAME)) && existsSync(cfg.ledgerPath);
