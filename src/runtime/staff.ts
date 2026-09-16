import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync, readdirSync } from 'node:fs';
import { query, type CanUseTool, type SDKMessage, type SDKRateLimitInfo, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { Agent } from '../core/types.ts';
import type { Ledger } from '../ledger/ledger.ts';
import type { Gate } from '../policy/gate.ts';
import type { World } from '../worldfs/world.ts';
import type { Clock } from '../core/clock.ts';
import { createTools, TOOL_NAMESPACE } from './tools.ts';
import { makeCanUseTool, shellIsContained } from './permissions.ts';
import { DEFAULT_POLICY, installRoot, type ServiceRoute } from '../core/config.ts';
import { mintScopedToken } from '../core/proxytoken.ts';
import type { TranscriptSink } from '../ledger/transcript.ts';
import { worstWindow, isWeekly, windowsFromUsage, limitsReadable, mergeWindow,
         isKnownLimit } from './limits.ts';
import { RULES_TEXT } from '../policy/rules.ts';

/** A path in the agent runtime's own home — caches a build needs to write. */
const home = (rel: string): string => join(homedir(), rel);

/**
 * Where the CLI keeps conversation transcripts.
 *
 * Measured against v2.1.263 rather than assumed: pointing CLAUDE_CONFIG_DIR
 * at an empty directory puts `.claude.json` and `backups/` there instead of
 * in the home directory.
 */
export const sessionStore = (env: NodeJS.ProcessEnv = process.env): string =>
  join(env['CLAUDE_CONFIG_DIR']?.trim() || home('.claude'), 'projects');

/**
 * Whether the transcript a session id names is still on disk.
 *
 * The id is written to the ledger, which is on the durable volume. The
 * transcript is written by the CLI, which in the container kept it on a
 * tmpfs — so every restart wiped the conversations while every id survived,
 * and the first leg of every first shift afterwards died on `No conversation
 * found with session ID`. On 2026-09-07 that cost Idris and Rue a shift each:
 * the cold retry meant to heal it worked for Marlow and not for them, and
 * both died on a stale session id instead.
 *
 * Asking the disk first makes the healthy path silent — no dead leg, no
 * failure event — and does not depend on matching an error string the CLI is
 * free to reword.
 *
 * The directory under `projects/` is the working directory with every `/` and
 * `.` replaced by `-`, which is the CLI's business and not ours. It scans
 * instead: one readdir over a handful of directories.
 */
export const transcriptExists = (id: string, store = sessionStore()): boolean => {
  let dirs: string[];
  try { dirs = readdirSync(store); } catch { return false; }
  return dirs.some((d) => existsSync(join(store, d, `${id}.jsonl`)));
};

/**
 * The read/write map handed to Claude Code's Bash sandbox — the kernel boundary
 * between one company and the next. Exported so a test can assert its shape
 * without a container: bubblewrap is Linux-only and cannot run in the host test
 * suite, so the guard is on the list rather than on a live read.
 *
 * Deny the whole INSTALLATION ROOT, not just companies/. bubblewrap reads are
 * allow-by-default, so anything under the root that is not denied is readable —
 * and the root holds the secrets store: master.key (wraps every company's key),
 * secrets/<slug>.vault and keyproxy.secret (mints scoped tokens), plus archive/
 * and the transfer staging dir. Denying only companies/ once left every one of
 * those a `cat /data/master.key` away, which would decrypt EVERY company's keys
 * and forge a token for any of them — the exact cross-company read the sandbox
 * exists to stop. allowRead re-admits this company's own home (under the root),
 * and more-specific-wins keeps it while the root stays closed.
 *
 * The credentials measurement that motivated the named denies: on 2026-09-07 a
 * sandboxed shift read `.credentials.json` (the live subscription token) and
 * `.claude.json`; Claude Code write-protects both but does not deny reading
 * them, and the transcript store is one company's conversations, not another's.
 *
 * allowWrite carries the build caches alongside the company dir: outside the
 * allow list is read-only inside the sandbox, and with the home directory left
 * out `npm install` and anything else keeping a cache fails EROFS (Marlow's
 * `undo.mjs` died on exactly this).
 */
export const sandboxFilesystem = (worldRoot: string, configDir?: string): {
  denyRead: string[]; allowRead: string[]; allowWrite: string[];
} => ({
  // CLAUDE_CONFIG_DIR moves the CLI's store onto the volume under the company's
  // OWN home, which allowRead re-admits — so deny that subtree straight back, or
  // a shift reads its own conversation history through Bash. This is ADDED to the
  // default $HOME denies, never traded for them: $HOME (/home/labs) is one tmpfs
  // shared by every company, reads there are allow-by-default, and anything the
  // CLI leaves in it despite the redirect would otherwise be a cross-company
  // read. Denying both stores costs nothing — the CLI writes as the unsandboxed
  // parent; only the agent's Bash is fenced. Cross-company isolation is the
  // installRoot deny; these keep a shift out of any transcript store, either place.
  denyRead: [
    installRoot(),
    sessionStore(), home('.claude/.credentials.json'), home('.claude.json'),
    ...(configDir ? [configDir] : []),
  ],
  allowRead: [dirname(worldRoot)],
  allowWrite: [dirname(worldRoot), home('.npm'), home('.cache'), home('.undo')],
});

export type TickDeps = {
  agent: Agent;
  ledger: Ledger;
  gate: Gate;
  world: World;
  clock: Clock;
  /** Hard ceiling on what one wake-up may cost, independent of the spend cap.
   *  The spend cap governs the staff's money; this governs yours. */
  maxBudgetUsd?: number;
  maxTurns?: number;
  /** Replace the conversation mid-shift at this much of the window. See
   *  CompanyPolicy.rotateAtContextPct. */
  rotateAtContextPct?: number;
  /** Somewhere with real disk for toolchain caches. See cacheEnv. */
  cacheDir?: string;
  /** The CLI's config + transcript store (CLAUDE_CONFIG_DIR), on the volume
   *  rather than the container's tmpfs HOME, so transcripts survive a restart
   *  and a shift resumes instead of starting cold. Per company, beside its
   *  ledger — never inside world/, or the end-of-turn commit would stage every
   *  transcript into the company's repo. See sessionStore and sandboxFilesystem. */
  configDir?: string;
  /** The company's own audit store. Every assistant turn, tool call, result and
   *  tool output is recorded here as the shift runs — our schema, from the SDK
   *  stream, not the CLI's private JSONL. Absent leaves a shift unrecorded. */
  transcript?: TranscriptSink;
  /** Wall clock the whole shift may take before it is stopped. See
   *  CompanyPolicy.shiftTimeoutMinutes. 0 or absent leaves it unbounded. */
  shiftTimeoutMs?: number;
  /** When this run's session cap stops the scheduler (epoch ms), or absent when
   *  the run is unbounded. Surfaced to the shift so it winds down to a
   *  checkpoint before the cap rather than being cut mid-write. See
   *  Scheduler.until / CompanyPolicy.maxSessionHours. */
  sessionEndsAt?: number;
  /** The subscription's current usage windows (utilization 0–1), the same
   *  reading the scheduler paces on, so the shift can pace with it rather than
   *  learn it only by being throttled. See Scheduler.windows. */
  usageWindows?: ReadonlyArray<{ kind: string; utilization: number | null }>;
  /** Attach a per-leg operation trace to a leg's failure events (tools-missing,
   *  stale-session), for diagnosing what a shift was doing when it stopped. Off
   *  by default. See CompanyPolicy.shiftTrace and runLeg's legTrace. */
  shiftTrace?: boolean;
  /** External MCP servers (image generation, calendar, inbox). Everything they
   *  reach still crosses the gate — canUseTool sees these calls too. */
  connectors?: Record<string, { type: 'http' | 'sse'; url: string; headers?: Record<string, string> }>;
  /** How approved work leaves when no connector is wired. See RiffConfig.release. */
  release?: 'none' | 'bundle';
  /** This shift's company, for minting the scoped proxy token. */
  companySlug?: string;
  /** External services the product may reach through the key-injecting proxy.
   *  staff mints a per-shift scoped token and injects it under each service's
   *  secret name, so the product reads its usual env var and the real key never
   *  enters this box — it lives in the proxy. See src/keyproxy and RiffConfig. */
  services?: Record<string, ServiceRoute>;
  /** Observe the shift: every tool the staff member reaches for, and why it
   *  was allowed or refused, for diagnosing a shift. */
  trace?: (line: string) => void;
  signal?: AbortSignal;
};

/**
 * A shift's consumption, split the way the subscription meter is.
 *
 * Cached input is the bulk of every leg after the first and is not priced or
 * limited like fresh input, so a single total would say a company was heavy
 * when it was mostly re-reading a system prompt it had already paid for.
 */
export type TokenCount = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

export type TickResult = {
  agentId: string;
  ok: boolean;
  summary: string;
  costUsd: number;
  turns: number;
  /** What the shift consumed, when any model reported usage. Counted because
   *  costUsd is imputed list price and tokens are the resource that runs out. */
  tokens?: TokenCount;
  /** Subscription rate-limit state, when the run reported any. On a Claude
   *  subscription this — not dollars — is what actually governs the company. */
  rateLimit?: SDKRateLimitInfo;
  /**
   * Every window the shift heard about, by kind.
   *
   * The scheduler paces off the fullest window it knows, but it only ever
   * learned the one window this result carried — so a five-hour window at 90%
   * was invisible for as long as the seven-day happened to be the one that
   * arrived last. All of them, or the pacing is guessing.
   */
  windows?: Array<[string, SDKRateLimitInfo]>;
  error?: string;
  /** The shift ended at the turn ceiling rather than because the agent
   *  chose to stop. Work happened; there was simply more of it. */
  truncated?: boolean;
  /** How many times the conversation was replaced mid-shift. */
  rotations?: number;
};

/**
 * The stable half of the context. Persona and the rules do not change between
 * ticks, so they sit in the system prompt where the cache can hold them; the
 * volatile half (mail, events, tasks) goes in the user prompt below the
 * cache boundary.
 */
/**
 * Whether anything this company writes can actually reach anyone.
 *
 * This exists because it went wrong. Two posts were approved to go out, the
 * approval was recorded, and nothing sent them anywhere — so the company
 * believed it had published, and wrote a first-contact letter telling a
 * stranger its instrument and corrections were public. They were in a private
 * repo on one machine. The board caught it at the last gate, which is one gate
 * too late: nobody in the company had any way to know.
 *
 * An approval means releasable. It does not mean released.
 */
/**
 * What the company can see out, and what it can send out. They are not the
 * same thing and conflating them cost real work.
 *
 * This said only that nothing gets OUT. A reasonable reader concluded nothing
 * gets IN either: across 423 gated actions a company of engineers never once
 * reached for WebSearch or WebFetch, and reasoned about a fast-moving field
 * entirely from training data. Reading out needs nobody's approval and never
 * did.
 */
const READING_OUT = [
  '## Looking things up',
  '',
  'You can read the outside world. WebSearch and WebFetch are yours and need',
  'no approval — this is reading, not publishing. Your training has a cutoff',
  'and this field moves faster than it, so look things up rather than',
  'reasoning from memory, and say which you did.',
  'Network access is an allowlist. A refused host is the wall doing its job,',
  'not a fault to work around — if you need one that is not open, ask.',
  '',
].join('\n');

/**
 * How much of a shift is spent producing prose nobody asked for.
 *
 * Length is not a matter of taste here, it is the budget. Everything a staff
 * member writes is read back at cost: their own words sit in their transcript
 * and are re-read on every turn after, a message body lands verbatim in every
 * recipient's next wake-up, and a shift that fills its context gets its
 * conversation replaced. A three-paragraph status note to a colleague is paid
 * for by the writer, the reader, and again by whoever they tell.
 *
 * The house style lives here rather than in an output style because Riff hands
 * the SDK a plain-string system prompt. There is no preset underneath for a
 * style to layer onto, and `managedSettings` drops non-restrictive keys like
 * `outputStyle` on the floor without saying so.
 */
const HOUSE_STYLE = [
  '## How to write',
  '',
  'Say the thing and stop. Every word you write is read again — by you next',
  'shift, and by everyone you addressed — and paid for each time.',
  '',
  '- Lead with the result. No preamble, no restating the request, no recap at',
  '  the end of what you just said above.',
  '- A message to a colleague is a few sentences. If it wants headings it is a',
  '  document: write the document and send the path.',
  '- Report what you did, not what you are about to do.',
  '- Say the caveat only when it changes what someone should do next.',
  '',
  'This is about length, never about substance. A test failure, a refusal, a',
  'security finding or a number someone will act on gets stated in full.',
  '',
].join('\n');

export const outwardState = (d: TickDeps): string => {
  const channels = Object.keys(d.connectors ?? {});
  if (channels.length) {
    return [
      READING_OUT,
      '## Sending things out',
      '',
      `Connected channels: ${channels.join(', ')}. Approved work can reach them.`,
      'Everything still lands as a draft first — approval is what releases it.',
    ].join('\n');
  }
  if (d.release === 'bundle') {
    return [
      READING_OUT,
      '## Sending things out',
      '',
      'There is no connected channel, so nothing you write reaches anyone by',
      'itself. What there is instead: the board collects releases by hand.',
      '',
      'Build the artefact locally — tagged in the world\'s git history, and',
      'bundled under `dist/` with whatever a stranger needs to use it. An',
      'approved draft plus a bundle is what the board carries out.',
      '',
      'Until the board says it went out, it has not. Do not describe our work',
      'as public, published or citable, and do not tell an outsider they can',
      'go and check something. Ask the board what was actually released.',
    ].join('\n');
  }
  return [
    READING_OUT,
    '## Sending things out',
    '',
    'There is no connected channel. Nothing this company writes reaches anyone',
    'outside it, and nothing it has written has ever been published.',
    '',
    'An approved draft is APPROVED, not SENT. It sits in your drafts folder.',
    'Do not describe any of our work as public, published, or citable, and do',
    'not promise an outsider that they can check something. They cannot.',
    'If publishing matters to what you are doing, say so — deciding where this',
    'company publishes is a decision the board has to make, and it has not.',
  ].join('\n');
};

const buildSystemPrompt = (d: TickDeps): string => {
  const { agent, world, gate, ledger } = d;
  const r = gate.constitution;
  const persona = world.readPersona(agent.id);
  const memory = world.readMemory(agent.id);

  // Hand them the roster up front. Left to work it out, a cold-started staff
  // member spends ten turns reading ten colleagues' briefs before doing
  // anything — which is exactly how the first CEO shift died at its
  // turn cap having produced nothing. Stable between ticks, so it caches.
  const roster = ledger.listAgents()
    .filter((a) => a.id !== agent.id)
    .map((a) => `- ${a.name} — ${a.role}, ${a.tier}${a.department ? ` · ${a.department}` : ''}`
      + ` (address tools to "${a.id}")`)
    .join('\n');

  return [
    `You are ${agent.name}. Your role is ${agent.role}.`,
    `Your agent id is "${agent.id}"${agent.department ? `, in ${agent.department}` : ''}. ` +
    'Ids are handles for tools. In anything a person reads — documents, ' +
    `messages, commit subjects — write people's names: you are ${agent.name}, ` +
    'and your colleagues are the names on the roster below.',
    agent.reportsTo ? `You report to ${agent.reportsTo}.` : '',
    '',
    '## Who you are',
    persona || '(No brief on file yet. Write one to your own persona.md.)',
    '',
    '## The Rules',
    RULES_TEXT(r),
    '',
    '## Who else works here',
    roster || '(You are the only one here.)',
    '',
    '## What you remember',
    memory || '(Nothing yet. As you learn things worth keeping, use `remember`.)',
    '',
    '## How to work',
    '- Your own files are staff/' + agent.id + '/. Write freely there.',
    '- commons/ is shared ground. It has no fixed format — if the company needs',
    '  something that does not exist yet, invent it there.',
    "- You may read colleagues' briefs and memory. They can see that you did.",
    '- Prefer finishing one real thing over starting three.',
    ...(shellIsContained() ? [
      '',
      '### Where your shell can write',
      '- Everything under ' + dirname(world.root) + ' — your world, your scratch.',
      '- $TMPDIR. Use it rather than /tmp, which is read-only and will refuse you.',
      "- ~/.npm, ~/.cache, ~/.undo, so builds and tools that keep a cache work.",
      '- Anywhere else is read-only and says so, EXCEPT one case worth knowing:',
      '  a write to another company\'s directory REPORTS SUCCESS AND IS DISCARDED.',
      '  The kernel hides them from you behind a scratch layer that is thrown',
      '  away when the command exits, so exit code 0 there means nothing. If you',
      '  need something to persist, write it under your own directory and check',
      '  it is there in a separate command.',
    ] : []),
    '',
    HOUSE_STYLE,
    outwardState(d),
  ].filter(Boolean).join('\n');
};

/** The volatile half — what changed since this staff member last woke. */
/** Show the engine-state note only when it should change what the shift does:
 *  within this many minutes of the session cap, or at/above this utilization
 *  (0–1). Display thresholds only — the scheduler owns the real throttle and
 *  pause; these decide when it is worth spending a tick's tokens to say so. */
const WINDDOWN_MINUTES = 25;
const NOTICE_UTILIZATION = 0.7;

export const buildTickPrompt = (d: TickDeps): string => {
  const { agent, ledger, clock, sessionEndsAt, usageWindows } = d;
  const parts: string[] = [`It is ${clock.now().toLocaleString()}. You have woken up.`];

  /**
   * A change to the founding brief, which nobody was ever told about.
   *
   * The brief is what the company is FOR, and it is editable — `company.brief`
   * records `was` and `now`. But nothing surfaced it, so an operator who
   * widened the premise 1h47m after founding changed a document that no shift
   * ever read again: by then the CEO had written the original wording into the
   * commons as the company's own charter, and a brief edit cannot reach a
   * decision the company has already made its own. It kept building inside the
   * boundary for another fortnight.
   *
   * Surfaced once, at the top, above even decisions: everything else in this
   * prompt is work inside a premise, and this is the premise changing.
   */
  const brief = ledger.lastEvent(['company.brief']);
  const briefSeen = ledger.getMeta(`brief-seen:${agent.id}`);
  if (brief && briefSeen !== brief.id) {
    // Malformed JSON here must not cost a shift its wake-up.
    let d: { was?: unknown; now?: unknown } = {};
    try { d = JSON.parse(brief.dataJson ?? '{}') as typeof d; } catch { d = {}; }
    if (typeof d.now === 'string') {
      parts.push(
        '',
        '## The brief for this company has changed',
        '',
        'This is what the company is for, and somebody has rewritten it. Read it',
        'against what you are currently doing and what the commons says the',
        'company has decided. Anything you wrote down under the old wording is',
        'now a claim to re-examine, not a settled decision — including your own',
        'charter, and including the project you are in the middle of.',
        '',
        '### It now says',
        d.now,
        ...(typeof d.was === 'string' ? ['', '### It used to say', d.was] : []),
      );
    }
    ledger.setMeta(`brief-seen:${agent.id}`, brief.id);
  }

  // Decisions come FIRST. A rejection you have to go looking for is a
  // rejection that changes nothing.
  const decisions = ledger.decisionsFor(agent.id, 3);
  if (decisions.length) {
    parts.push('', '## Decisions on your requests');
    for (const d of decisions) {
      parts.push(
        '',
        `**${d.state.toUpperCase()}** — ${d.summary}`,
        `Decided by ${d.decidedBy ?? 'unknown'}.`,
        ...(d.decisionReason ? ['', d.decisionReason] : ['', '(no reason given)']),
      );
    }
    parts.push('', 'Answer what you agree with by changing the work, and say plainly where you disagree.');
  }

  // The engine you run on, surfaced only when it should change what you do.
  //
  // Riff stops a run at its session cap and slows, then pauses, wakes as the
  // subscription's usage climbs. It is the same "wind down, do not get cut" and
  // "pace on the window" the company is building into its own product: a shift
  // that cannot see the cap coming gets cut mid-write, and one that cannot see
  // the window cannot pace. Silent until near the cap or the window is high, so
  // a quiet tick pays nothing for it.
  {
    const minutesLeft = sessionEndsAt != null
      ? Math.max(0, Math.round((sessionEndsAt - clock.now().getTime()) / 60_000))
      : null;
    const windows = (usageWindows ?? []).filter((w) => w.utilization != null);
    const worst = windows.reduce((m, w) => Math.max(m, w.utilization ?? 0), 0);
    const nearCap = minutesLeft != null && minutesLeft <= WINDDOWN_MINUTES;
    if (nearCap || worst >= NOTICE_UTILIZATION) {
      const label = (k: string): string =>
        k === 'five_hour' ? '5h' : k === 'seven_day' ? '7d' : k;
      parts.push('', '## The engine you run on');
      if (nearCap) {
        parts.push(
          '',
          `This session stops in about ${minutesLeft} min. Wind down now: finish or`,
          'safely park what you are on, commit it, and leave a note saying where to',
          'resume. Do not start what you cannot land in the time left. Being stopped',
          'is not a failure; being cut mid-write is.',
        );
      } else if (minutesLeft != null) {
        parts.push('', `This session stops in about ${minutesLeft} min.`);
      }
      if (windows.length) {
        parts.push(
          '',
          `Subscription usage now: ${windows.map(
            (w) => `${label(w.kind)} ${Math.round((w.utilization ?? 0) * 100)}%`).join(', ')}.`
          + ' This is the whole plan, not just you — as it climbs the engine first'
          + ' slows your wakes, then pauses them. Pace accordingly.',
        );
      }
    }
  }

  /**
   * What of yours the board has not answered yet.
   *
   * A tool nobody is reminded of is a tool nobody uses. withdraw_draft shipped
   * and went untouched across 139 shifts while nine drafts sat waiting, six of
   * them corrections about the other three — because nothing brought the queue
   * back into view. Decisions were surfaced at wake and pending requests were
   * not, so the only half of the loop an agent ever saw was the half somebody
   * else had already closed.
   */
  const waiting = ledger.listApprovals('pending').filter((a) => a.requestedBy === agent.id);
  if (waiting.length) {
    parts.push('', `## Your drafts still waiting on the board (${waiting.length})`);
    for (const a of waiting) parts.push(`- \`${a.id}\` — ${a.summary.split('\n')[0]!.slice(0, 140)}`);
    parts.push(
      '',
      'The board reads these in order. Anything here you already know is wrong,',
      'superseded, or answered by a later one is noise in front of the things that',
      'are not — withdraw_draft takes one back.',
    );
  }

  // Mail is marked read here: it has been handed over, and re-delivering it
  // every tick would make the staff answer the same message forever.
  const mail = ledger.inbox(agent.id, true);
  if (mail.length) {
    parts.push('', '## Messages for you', ...mail.map(
      (m) => `- **${m.from}**${m.broadcast ? ' (to everyone)' : ''}: ${m.body}`,
    ));
  }

  const mine = ledger.listTasks({ assignedTo: agent.id }).filter((t) =>
    t.status === 'claimed' || t.status === 'in_progress' || t.status === 'blocked');
  if (mine.length) {
    parts.push('', '## Your work in progress', ...mine.map((t) => `- [${t.id}] ${t.title} (${t.status})`));
  }

  const open = ledger.listTasks({ status: 'open' }).slice(0, 8);
  if (open.length) {
    parts.push('', '## Unclaimed on the board', ...open.map((t) => `- [${t.id}] ${t.title}`));
  }

  const recent = ledger.eventsSince(Math.max(0, ledger.latestSeq() - 25))
    .filter((e) => e.actor !== agent.id && !e.kind.startsWith('gate.'));
  if (recent.length) {
    parts.push('', '## Around the grounds', ...recent.slice(-12).map(
      (e) => `- ${e.actor} ${e.kind.replace(/\./g, ' ')}${e.subject ? ` (${e.subject})` : ''}`,
    ));
  }

  parts.push('', 'Do what the company needs from you now. Be concrete and finish something.');
  return parts.join('\n');
};

/**
 * Wake one staff member, let them work, and put them back to sleep.
 *
 * Isolation is the important part of the options below. The SDK loads the
 * operator's ~/.claude settings AND their CLAUDE.md by default — which would
 * give all 22 staff the same borrowed personality and leak private operator
 * instructions into every session. `settingSources: []` is the documented
 * isolation mode, and a plain-string systemPrompt (rather than the
 * `{type:'preset'}` form) keeps the Claude Code preset prompt out of a persona
 * that is supposed to be their own.
 */
/**
 * Errors that mean "the transcript you asked me to continue is gone", as
 * opposed to anything about the work. Matched on the message because the SDK
 * surfaces it as a result string rather than a typed error.
 */
const LOST_SESSION = /No conversation found with session ID|session .* not found/i;

/** The turn ceiling, which ends a shift rather than breaking one. */
const OUT_OF_TURNS = /Reached maximum number of turns/i;

/**
 * How much of the subprocess's stderr to keep for a shift that dies.
 *
 * `Claude Code process exited with code 1` is the whole of what the SDK says,
 * and the CLI's own account of why goes to a stderr nobody was reading. Two
 * shifts died that way on 2026-09-03 and the cause had to be reconstructed
 * from transcript files inside the container. A tail is enough — the end is
 * where the reason is.
 */
const STDERR_KEPT = 3_000;

/**
 * The subscription token must never reach the ledger.
 *
 * `docker/.env` holds a command that prints the token precisely so the value
 * is never written down, and the ledger is a file on disk. Anything
 * token-shaped in a crash dump is replaced rather than trusted not to be
 * there — a diagnostic is not worth a credential.
 */
export const withoutSecrets = (text: string): string => {
  let out = text;
  for (const k of ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'RIFF_TOKEN']) {
    const v = process.env[k];
    if (v && v.length > 8) out = out.split(v).join(`[${k}]`);
  }
  return out.replace(/\b(sk-[A-Za-z0-9_-]{12,}|Bearer\s+[A-Za-z0-9._-]{12,})/g, '[redacted]');
};

/**
 * Turns held back for the hand-over when a conversation is replaced.
 *
 * These are the most expensive turns of the shift — they run against the full
 * old context, which is the whole reason we are replacing it — and the ones
 * that least tolerate being cut short. Whatever does not get written down
 * here does not survive.
 */
const HANDOVER_TURNS = 6;

/**
 * Rotations allowed in one shift. Two is a bound on a pathology, not a
 * target: an agent that fills the window three times in one wake-up is
 * looping rather than working, and the next shift is a better place to
 * notice that than the middle of this one.
 */
const MAX_ROTATIONS = 2;

/**
 * A resumed session whose control stream came up dead, named at its source.
 *
 * When a resumed session brings the control stream up dead, canUseTool is never
 * reached and the SDK answers every tool call with a tool_result whose text is
 * `AbortError: Stream closed` — the transport, not a tool that ran and failed.
 * Reading that text catches it on the first result, so the stale session is
 * dropped and the leg retaken cold rather than resuming into the same dead
 * stream every tick. A shift that hangs some other way is caught by the shift
 * timeout instead; this only handles the one failure the SDK names outright.
 *
 * Matches on `is_error` AND the closed-stream text together: a tool that merely
 * printed those words would not have is_error set, and the transport failure
 * always does.
 */
const STREAM_CLOSED = /stream closed/i;
export const streamClosedResult = (m: SDKUserMessage): boolean => {
  const content = m.message?.content;
  if (!Array.isArray(content)) return false;
  return content.some((b) => {
    const block = b as { type?: string; is_error?: boolean; content?: unknown };
    if (block.type !== 'tool_result' || block.is_error !== true) return false;
    const c = block.content;
    const text = typeof c === 'string'
      ? c
      : Array.isArray(c)
        ? c.map((x) => {
          const part = x as { type?: string; text?: string };
          return part.type === 'text' ? part.text ?? '' : '';
        }).join(' ')
        : '';
    return STREAM_CLOSED.test(text);
  });
};

/** The status of the company's own server in an SDK server-status list. */
const companyServerStatus = (
  servers: readonly { name: string; status: string }[],
): string | undefined => servers.find((s) => s.name === TOOL_NAMESPACE)?.status;

/** Whether the company's own MCP server reports itself connected. */
export const toolsConnected = (
  servers: readonly { name: string; status: string }[],
): boolean => companyServerStatus(servers) === 'connected';

/**
 * Wait out the startup race before calling the company's tools dead.
 *
 * The init snapshot is one point-in-time reading, and on a resumed session it
 * can land before the in-process ('sdk') company server finishes connecting:
 * transcript-load jitter fires init early, so its `mcp_servers` shows the server
 * `pending` or omits it entirely, and a healthy resume was aborted for
 * shift.tools_missing (Rafe, 2026-09-03). The live status reaches `connected` in
 * well under a second; only a genuinely dead server runs the budget out, and the
 * one cold retry then heals that. A status call that throws is not a reading we
 * can trust either way, so it falls through to the same cold retry.
 *
 * `sleep`/`now` are injected so the poll is driven deterministically in a test
 * without real timers.
 */
export const awaitToolsConnected = async (
  q: { mcpServerStatus: () => Promise<{ name: string; status: string }[]> },
  budgetMs: number,
  stepMs: number,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => number = Date.now,
  // One status read, raced against however much of the budget is left, so a
  // mcpServerStatus() that never settles cannot outlast it. The deadline below is
  // only checked BETWEEN reads, so a hung read was never bounded: on 2026-09-16 a
  // resumed leg's status call blocked 382 seconds past a 3-second budget and the
  // shift hung instead of failing over to its one cold retry. Returns null when
  // the budget elapsed first; the timer is cleared on settle so nothing dangles.
  // Injected so the race is driven deterministically in a test.
  race: (p: Promise<{ name: string; status: string }[]>, ms: number)
    => Promise<{ name: string; status: string }[] | null> = (p, ms) =>
    new Promise((resolve, reject) => {
      const t = setTimeout(() => resolve(null), ms);
      (t as { unref?: () => void }).unref?.();
      p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
    }),
): Promise<boolean> => {
  const deadline = now() + budgetMs;
  for (;;) {
    const remaining = deadline - now();
    if (remaining <= 0) return false;
    let status: { name: string; status: string }[] | null;
    try {
      status = await race(q.mcpServerStatus(), remaining);
    } catch { return false; }
    if (status === null) return false;   // the read outran the budget — call it dead
    if (toolsConnected(status)) return true;
    if (now() >= deadline) return false;
    await sleep(stepMs);
  }
};

/**
 * Said plainly, because the SDK calls every abort "aborted by user" and an
 * operator reading that would go looking for the operator who did it.
 */
const overranBy = (ms: number): string =>
  `the shift ran past its ${Math.round(ms / 60_000)}-minute ceiling and was stopped. `
  + 'Turns, context and spend all stand still while a shift waits on something, so this is '
  + 'the only bound that catches one that is stuck rather than slow.';

/** Said plainly for the same reason: the CLI only wrote it to a debug log. */
const NO_TOOLS = "the company's own tools never connected, twice running — the shift had no "
  + 'way to write anything down, so it was stopped instead of spending its turns finding out.';

/**
 * How long a not-yet-connected company server is given before it is called dead,
 * and how often its live status is re-read while waiting. Three seconds is far
 * past the sub-second connect a resumed in-process server actually takes, so the
 * budget is only ever spent on a server that is genuinely down.
 */
const TOOLS_GRACE_MS = 3000;
const TOOLS_POLL_MS = 150;

/** Said plainly, because the SDK reports the underlying abort as "aborted by user". */
const STALE_SESSION = 'a resumed session came up dead — the control stream returned Stream closed '
  + 'and the gate was never reached. Retaken cold once; it happened again, so this is a real fault.';

/**
 * Where a toolchain is told to keep its cache.
 *
 * Every one of them defaults somewhere under $HOME, and $HOME in the container
 * is a 256M tmpfs that is *also* the CLI's session store. So the first
 * `npm install`, `go build` or `cargo fetch` of any size fills the place the
 * transcripts live, and what breaks is not the build — it is every resume
 * after it, silently. That exact failure already cost 33 shifts before anyone
 * noticed the sessions were never being written.
 *
 * The one cache that did get moved out of $HOME went to /tmp, which is a 512M
 * tmpfs. npm's cache reached 247M installing third-party servers to lint, and
 * took an unrelated `git commit` down with ENOSPC on the way out.
 *
 * There is no version of this that fits in a tmpfs. Caches go on the durable
 * volume beside the world, where there is room and where they survive a
 * restart — which is the entire point of a cache.
 *
 * The list is not exhaustive and cannot be: this company was told its language
 * is its own choice. It covers what a staff member is most likely to reach
 * for, and anything missed lands in /tmp rather than on the session store.
 */
export const cacheEnv = (dir: string): Record<string, string> => ({
  npm_config_cache: join(dir, 'npm'),
  // Honoured by Go's build cache, pip, and most things that ask politely.
  XDG_CACHE_HOME: dir,
  GOMODCACHE: join(dir, 'go-mod'),
  GOCACHE: join(dir, 'go-build'),
  CARGO_HOME: join(dir, 'cargo'),
});

/**
 * The scoped proxy tokens a shift's product carries, keyed by the env var each
 * service's secret is read from.
 *
 * One token per shift, scoped to this company and valid a little past the
 * shift's own clock, injected under every declared service's `secret` name — so
 * the product reads its ordinary env var (`OPENROUTER_API_KEY`,
 * `ANTHROPIC_AUTH_TOKEN`) and gets a capability, never the real key, which
 * stays in the proxy's container. An agent can read its own token; it cannot
 * forge one for another company (the signing secret is outside every world) and
 * it never sees the key at all.
 *
 * Two services that name the same secret share the one token, which is correct:
 * the token identifies the company, not the service, and the proxy resolves the
 * real key per route. Empty when the company declares no services.
 *
 * Extracted so the wiring can be tested against verifyScopedToken directly — the
 * child-process env is built from real query() options a unit test cannot drive.
 */
export const scopedSecretEnv = (
  companySlug: string | undefined,
  services: Record<string, ServiceRoute> | undefined,
  shiftTimeoutMs: number | undefined,
): Record<string, string> => {
  const env: Record<string, string> = {};
  if (!companySlug || !services || !Object.keys(services).length) return env;
  const ttlSeconds = Math.ceil((shiftTimeoutMs ?? 45 * 60_000) / 1000) + 300;
  const token = mintScopedToken(companySlug, ttlSeconds);
  for (const route of Object.values(services)) env[route.secret] = token;
  return env;
};

/** A tool result is a string or a list of content blocks; flatten to text. */
const toolResultText = (content: unknown): string => {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((b) =>
      b && typeof b === 'object' && 'text' in b && typeof (b as { text: unknown }).text === 'string'
        ? (b as { text: string }).text
        : JSON.stringify(b),
    ).join('\n');
  }
  return content == null ? '' : JSON.stringify(content);
};

/**
 * Record one SDK message into the company's own audit store — the assistant's
 * text and reasoning, every tool call and its result, and the final tally.
 *
 * Recorded from the stream rather than parsed back out of the CLI's transcript
 * files, so the audit is ours (stable schema) and survives whatever backend runs
 * underneath. Fail-soft is the whole contract: a shift must never die because
 * its audit could not be written, so every path is inside one try/catch and a
 * throw is swallowed. Exported so the mapping is tested without driving a shift.
 */
export const recordShiftMessage = (
  sink: TranscriptSink, sessionId: string, agentId: string, m: SDKMessage,
): void => {
  try {
    if (m.type === 'assistant') {
      const model = (m.message as { model?: string }).model;
      for (const b of m.message.content) {
        if (b.type === 'text') {
          if (b.text.trim()) sink.append({ sessionId, agentId, role: 'assistant', kind: 'text', text: b.text, meta: { model } });
        } else if (b.type === 'thinking') {
          if (b.thinking.trim()) sink.append({ sessionId, agentId, role: 'assistant', kind: 'thinking', text: b.thinking, meta: { model } });
        } else if (b.type === 'tool_use') {
          sink.append({ sessionId, agentId, role: 'assistant', kind: 'tool_use', name: b.name, text: JSON.stringify(b.input), meta: { model, id: b.id } });
        }
      }
    } else if (m.type === 'user') {
      const content = m.message.content;
      if (typeof content === 'string') {
        if (content.trim()) sink.append({ sessionId, agentId, role: 'user', kind: 'text', text: content });
      } else {
        for (const b of content) {
          if (b.type === 'text') {
            if (b.text.trim()) sink.append({ sessionId, agentId, role: 'user', kind: 'text', text: b.text });
          } else if (b.type === 'tool_result') {
            sink.append({ sessionId, agentId, role: 'user', kind: 'tool_result', name: b.tool_use_id, text: toolResultText(b.content), meta: { isError: b.is_error ?? false } });
          }
        }
      }
    } else if (m.type === 'result') {
      const text = m.subtype === 'success' && 'result' in m ? String((m as { result?: unknown }).result ?? '') : '';
      sink.append({ sessionId, agentId, role: 'result', kind: 'result', text, meta: { subtype: m.subtype, turns: m.num_turns, costUsd: m.total_cost_usd } });
    }
  } catch { /* recording must never fail a shift */ }
};

/**
 * Whether to hand this conversation over and carry on in a fresh one.
 *
 * Unknown is not "yes": with no window reported there is no denominator, and
 * rotating on a guess would throw away a conversation that might be nearly
 * empty. That is also why the threshold is a percentage — the denominator
 * belongs to whatever model the company gave this agent, not to us.
 */
export const shouldRotate = (s: {
  contextTokens: number;
  contextWindow: number;
  rotateAtPct: number;
  /** Turns still inside the shift's ceiling. */
  turnsLeft: number;
  rotations: number;
}): boolean => {
  if (s.rotateAtPct <= 0 || s.rotations >= MAX_ROTATIONS) return false;
  if (!s.contextWindow || !s.contextTokens) return false;
  if (s.contextTokens * 100 < s.rotateAtPct * s.contextWindow) return false;
  // Room to hand over AND to do something afterwards. Rotating with four turns
  // left spends them all on note-taking for a shift that then ends.
  return s.turnsLeft >= HANDOVER_TURNS * 2;
};

/**
 * What an agent is asked immediately before its conversation is thrown away.
 *
 * Rotation is only survivable because of what this produces. Everything not
 * written to memory or to a file in these turns is gone, and the agent picks
 * the work back up believing it knows where it was — so this prompt, not the
 * threshold, is what decides whether rotating costs the company anything.
 */
const HANDOVER_PROMPT = [
  'Stop what you are doing. Your context is nearly full, so this conversation',
  'is about to be replaced with an empty one.',
  '',
  'You are not going home. In a moment you carry on with the same work, in the',
  'same shift — but with no memory of anything said here. What you write down',
  'now is all you will have.',
  '',
  'Use `remember` for what outlasts today, and your own files under staff/ for',
  'working detail. Record what you are in the middle of, what you have already',
  'tried and ruled out so you do not try it again, what you decided and why,',
  'and the next concrete step.',
  '',
  'Do not summarise this conversation for a reader. Write the note you would',
  'want to find.',
].join('\n');

/** The first thing the replacement conversation is told. */
const RESUMED_PROMPT = [
  'You are part-way through a shift. The earlier half of this conversation is',
  'gone — what you wrote down before it went is what you have.',
  '',
  'Read your memory and your own files, pick the work back up where the note',
  'says you left it, and finish something.',
].join('\n');

export const tick = async (
  d: TickDeps,
  opts?: { withoutResume?: boolean },
): Promise<TickResult> => {
  const { agent, ledger, gate, world, clock } = d;
  const { server, capabilities } = createTools({
    actor: agent.id, ledger, gate, world, clock,
  });

  /** The conversation currently being continued, or null to start a fresh
   *  one. Changes twice in a shift that rotates. */
  let session = (opts?.withoutResume ? null : ledger.getMeta(`session:${agent.id}`)) || null;
  // A conversation the CLI no longer holds is not a resume, so do not spend a
  // leg discovering that. See transcriptExists. The store has to be the one the
  // shift's CLI writes to — the per-company CLAUDE_CONFIG_DIR — not the server's
  // own default HOME, or the check reads an empty directory and every resume is
  // wrongly reset to a cold start.
  const store = d.configDir ? sessionStore({ CLAUDE_CONFIG_DIR: d.configDir }) : undefined;
  if (session && !transcriptExists(session, store)) {
    ledger.setMeta(`session:${agent.id}`, '');
    ledger.emit(agent.id, 'session.reset', null, { was: session, why: 'transcript is gone' });
    session = null;
  }
  ledger.emit(agent.id, 'agent.woke', null, { resumed: Boolean(session) });

  let costUsd = 0;
  let turns = 0;
  let summary = '';
  /** The last thing the agent said out loud, whether or not it got to finish. */
  let said = '';
  /**
   * How full the context is, measured the way the statusline measures it.
   *
   * `input_tokens` alone is nearly always a handful — a probe showed 2 against
   * a 30,433-token context — because everything else sits in cache_creation on
   * the first turn and cache_read after. All three, or the number is fiction.
   */
  let contextTokens = 0;
  /**
   * The denominator, from the model's own report rather than a constant.
   * modelUsage carries an entry per model called during the query, including
   * an auxiliary Haiku with a 200K window next to a main model with 1M — key
   * on the agent's model or the percentage is against the wrong ceiling.
   */
  let contextWindow = 0;
  /**
   * What the shift cost in context, for the record. Omitted rather than
   * reported as zero when a shift died before any assistant turn — a 0% that
   * means "unknown" is worse than a gap, because it averages.
   */
  /**
   * Consumption and the subscription window, for the record.
   *
   * Both are omitted rather than zeroed when nothing reported them: a shift
   * that died before its first turn consumed nothing measurable, and a zero
   * that means "unknown" averages into every figure downstream. The
   * rate-limit reading is the last one the run saw, which is the closest
   * thing to what the operator had left when the shift ended.
   */
  const meter = (): Record<string, number | string> => {
    const binding = worstWindow(windows, isKnownLimit);
    const weekly = worstWindow(windows, isWeekly);
    // Every window by name, not just whichever one is tightest. The five-hour
    // reading used to vanish from the record whenever the week was the
    // binding one, so the only figure an operator on a subscription can act
    // on — am I about to lose my afternoon — was missing from most shifts.
    const byWindow: Record<string, number> = {};
    for (const [kind, w] of windows) {
      if (w.utilization != null) byWindow[`used_${kind}`] = w.utilization;
      if (w.resetsAt != null) byWindow[`resets_${kind}`] = w.resetsAt;
    }
    return {
      ...byWindow,
      ...(spentAny()
        ? {
            tokens: tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite,
            tokensIn: tokens.input,
            tokensOut: tokens.output,
            cacheRead: tokens.cacheRead,
            cacheWrite: tokens.cacheWrite,
          }
        : {}),
      ...(binding?.utilization != null
        ? {
            utilization: binding.utilization,
            ...(binding.rateLimitType ? { limitType: binding.rateLimitType } : {}),
          }
        : {}),
      // Recorded separately because it is the figure that governs a week's
      // planning: five hours spent by lunch is back by dinner, a week spent on
      // Tuesday is gone until Tuesday.
      ...(weekly?.utilization != null ? { weekUtilization: weekly.utilization } : {}),
      // False means the throttle has nothing to pace on, which is not the same
      // as a plan with room. Absent means nothing asked.
      ...(planVisible === false ? { planVisible: 'no' } : {}),
    };
  };

  const context = (): Record<string, number> => (contextTokens
    ? {
        contextTokens,
        ...(contextWindow
          ? { contextPct: Math.round((contextTokens / contextWindow) * 1000) / 10, contextWindow }
          : {}),
      }
    : {});
  /**
   * What the shift consumed, as opposed to what it notionally cost.
   *
   * This company runs on a subscription: `total_cost_usd` is API list price
   * imputed after the fact and nobody is billed a cent of it. Tokens and the
   * rate-limit window are the resources that actually run out, so they are
   * counted beside the money rather than left to be inferred from it.
   *
   * From `modelUsage` rather than `usage` on the SDK's own instruction: usage
   * is the main loop only, while modelUsage covers subagents, sidechains and
   * compaction — all of which spend the operator's window. It is cumulative
   * within one query() call, and each leg is one call answering with one
   * result, so legs add and turns within a leg do not.
   */
  const tokens: TokenCount = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

  /**
   * What each leg was allowed and what it came back having spent.
   *
   * Recorded because the two stopped agreeing and nothing in the shift said
   * why: juno finished a shift at 61 turns under a ceiling of 30, with no
   * rotation and no truncation, and the run's own work.started proves the
   * ceiling was 30. A single leg cannot do that — the SDK honours maxTurns
   * exactly, returning num_turns = maxTurns + 1 — so more than one leg ran and
   * the shift kept no record of it. Now it does.
   */
  const legs: Array<{ budget: number; turns: number; subtype: string }> = [];
  const spentAny = (): boolean =>
    tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite > 0;

  let rateLimit: SDKRateLimitInfo | undefined;
  /**
   * Each window's latest reading, kept apart. A subscription runs several at
   * once and the last event to arrive is not the one that matters: a five-hour
   * window fresh off a reset reads low all afternoon while the seven-day one
   * climbs all week, and the weekly is the one an operator plans around.
   */
  const windows = new Map<string, SDKRateLimitInfo>();

  /**
   * The ceiling in force, recorded alongside the count so the two can be read
   * together.
   *
   * They are not the same counter: maxTurns caps the model's turns, while the
   * num_turns we report counts the loop, so a shift can finish at 62 under a
   * ceiling of 60 and be neither truncated nor wrong. Without the ceiling
   * beside it the console reads "62 turns" against a "60 turn" limit and
   * looks broken. The fallback comes from DEFAULT_POLICY rather than a second
   * literal here — this one still said 24 long after the ceiling moved to 60.
   */
  const ceiling = d.maxTurns ?? DEFAULT_POLICY.maxTurns;

  /**
   * Every tool call crosses the gate. That is the security invariant the whole
   * runtime rests on, so a shift making tool calls that the gate never hears
   * about is not a slow shift — it is the chokepoint being gone.
   *
   * It happened three times in one day and nothing noticed, because it fails
   * safe: the permission channel died, every tool came back
   * `AbortError: Stream closed`, and the model carried on asking. Twenty-eight
   * turns, five dollars, nothing touched, and one shift only recorded because
   * the agent had the presence of mind to say so in words. The two before it
   * could not even journal it — writing is a tool.
   *
   * Failing safe is not the same as failing loudly.
   */
  let gateCalls = 0;

  // A per-leg operation trace, built only when shiftTrace is on (it rides a
  // leg's failure events — tools-missing, stale-session). It records the
  // ordering — leg start (resumed or cold), each SDK message, the tools the
  // model reached for, each gate ask, the result — with a millisecond offset,
  // so a stopped shift shows what it was doing when the lights went out. Reset
  // per leg by runLeg; `trace` is a no-op when off, so a shift that is not being
  // audited pays nothing.
  const tracing = d.shiftTrace ?? false;
  let legClock = clock.now().getTime();
  let legTrace: string[] = [];
  let legResumed = false;
  const trace = tracing
    ? (op: string): void => {
      legTrace.push(`+${clock.now().getTime() - legClock}ms ${op}`);
      if (legTrace.length > 80) legTrace.shift();
    }
    : (_op: string): void => { /* auditing off */ };

  const gate2 = makeCanUseTool({
    actor: agent.id, world, gate, toolCapabilities: capabilities,
    ...(d.trace ? { onDecision: (t, o, why) => d.trace!(`  gate  ${o.padEnd(5)} ${t} ${why}`) } : {}),
  });
  const gated: CanUseTool = (name, input, opts) => {
    gateCalls++;
    trace(`gate ask ${name}`);
    return gate2(name, input, opts);
  };

  // The diagnostic tail a stale-session or tools-missing event carries while
  // auditing: the leg's whole operation trace, whether it was resumed, whether
  // its tools came up, and the CLI's own last words. Empty when auditing is off.
  const auditTail = (): Record<string, unknown> =>
    tracing ? { resumed: legResumed, toolsUp, trace: legTrace.slice(), noise: noise.slice(-800) } : {};

  /**
   * One controller per LEG, chained to the shift's own signal.
   *
   * It used to be one for the whole shift, and two of the three ways a leg
   * ends early fire it: the stream-closed check and the missing-tools check
   * both call stop.abort() to break out of the stream. A stale session ends the
   * leg for a cold retake, and missing tools is worth one cold retry too — and
   * the retry handed the SDK the same, already-aborted controller, so it died on
   * the spot with "Operation aborted" and the shift was lost anyway.
   *
   * Rafe, 2026-09-03 23:36:26: tools_missing on a resumed session, session
   * reset two seconds later, and `agent.failed: Operation aborted` in the same
   * second. The retry the comment below promises had never once run.
   */
  let stop = new AbortController();
  const armStop = (): void => {
    stop = new AbortController();
    if (!d.signal) return;
    if (d.signal.aborted) stop.abort();
    else d.signal.addEventListener('abort', () => stop.abort(), { once: true });
  };
  let staleSession = false;
  /**
   * The clock on the whole shift, not on one leg.
   *
   * `stop` is replaced by every leg, so this reads whichever controller is
   * current at the moment it fires rather than capturing the first one — a
   * shift that rotates twice is still one shift and gets one ceiling.
   */
  let overran = false;
  const timeout = d.shiftTimeoutMs && d.shiftTimeoutMs > 0
    ? setTimeout(() => {
      overran = true;
      ledger.emit(agent.id, 'shift.overran', null, { after: d.shiftTimeoutMs });
      stop.abort();
    }, d.shiftTimeoutMs)
    : null;
  // Nothing may be held open by a shift that has already ended.
  timeout?.unref();
  /** The tail of what the CLI said on its way out, kept only for a failure. */
  let noise = '';
  /**
   * This leg has already taken every turn it was allowed.
   *
   * Reaching the ceiling normally ends the leg with a result whose subtype is
   * `error_max_turns`. Sometimes it kills the process instead, and the SDK
   * reports `Claude Code process exited with code 1` with nothing else — no
   * result, no turns, no summary, and a red failure in the console for a shift
   * that did thirty turns of work.
   *
   * Measured on 2026-09-03 from the transcripts of all three shifts that hit
   * the ceiling that hour. Every one of them ends on the same internal record,
   * `max_turns_reached {maxTurns: 30, turnCount: 31}`. What separates the two
   * that died from the one that returned cleanly is the tool call underneath:
   *
   *   rafe   died    Bash `timeout 60 node --test …`   result after  60.3s
   *   juno   died    Bash `timeout 120 npm test …`     result after 120.0s
   *   nadia  clean   an MCP message                    result after   0.02s
   *
   * Both deaths ended on a Bash command its own `timeout` had just killed,
   * landing on the last turn the shift was allowed. So the count is kept here
   * rather than inferred from a message that never arrives: a leg that has
   * spent its budget and then dies was truncated, not broken, and it gets its
   * journal and its commit like any other shift that ran out of turns.
   */
  let atCeiling = false;
  /** Did the company's own MCP server come up for this leg? */
  let toolsUp = true;
  let toolRetries = 0;
  let staleRetries = 0;
  /** Null until a usage call answers either way. See limitsReadable. */
  let planVisible: boolean | null = null;

  // The scoped proxy tokens this shift's product carries, keyed by each
  // service's secret env var. See scopedSecretEnv — extracted so the wiring is
  // tested directly. Merged into the shift's child-process env below.
  const secretEnv = scopedSecretEnv(d.companySlug, d.services, d.shiftTimeoutMs);

  /**
   * Ask what is left of the subscription, rather than waiting to be told.
   *
   * `rate_limit_event` is a push and a rare one — 0 of 14 shifts across a
   * whole night — so pacing and reporting fell back to tokens, which is not
   * what anyone on a subscription is billed against. This asks directly.
   *
   * The SDK marks the call experimental and reserves the right to move it, so
   * a failure here is a missing reading and never a failed shift: every
   * consumer already handles having no window at all.
   */
  const readUsage = async (q: {
    usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?: () => Promise<unknown>;
  }): Promise<void> => {
    try {
      const fn = q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
      if (typeof fn !== 'function') return;
      const reading = await fn.call(q) as never;
      planVisible = limitsReadable(reading);
      for (const [kind, w] of windowsFromUsage(reading)) {
        const merged = mergeWindow(windows.get(kind), w);
        windows.set(kind, merged);
        rateLimit = merged;
      }
    } catch { /* a reading we could not take is not a shift that failed */ }
  };
  const rotateAt = d.rotateAtContextPct ?? DEFAULT_POLICY.rotateAtContextPct;
  let rotations = 0;

  /**
   * One conversation's worth of the shift.
   *
   * Turns and cost accumulate across every leg; a shift that replaces its
   * conversation twice still gets one turn ceiling, not three, or rotation
   * would be a way to buy more turns than the company allowed.
   */
  const runLeg = async (prompt: string, maxTurns: number, handover = false): Promise<void> => {
    atCeiling = false;
    let toolTurns = 0;
    // A leg is one query answering with one result. Once that result is in, any
    // further init the SDK emits is a phantom re-init on the way down, not a new
    // leg — see the init handler, which must not read its (unregistered) tools as
    // a missing-tools failure.
    let sawResult = false;
    // Kept per leg, not per shift. A shift that lost its conversation and
    // retook the leg cold reported the FIRST leg's stderr on the second leg's
    // failure — which is how `No conversation found with session ID` came to
    // be attached to two shifts that had already started over without one.
    noise = '';
    // A leg that ended by aborting must not hand its dead controller to the next.
    armStop();
    // The hand-over's own context is not the shift's context — it is measured
    // against the conversation we have already decided to discard — and its
    // closing words are about note-taking rather than about the work.
    if (!handover) contextTokens = 0;

    // Start this leg's trace. resumed-vs-cold is the first correlator of a
    // stale-session failure, so it leads the record.
    legClock = clock.now().getTime();
    legTrace = [];
    legResumed = session != null;
    trace(`leg start ${legResumed ? `resumed ${(session ?? '').slice(0, 8)}` : 'cold'}${handover ? ' handover' : ''}`);

    // Hold the prompt open as a one-message stream instead of passing a string.
    //
    // A string prompt makes the SDK mark the query single-turn and close stdin
    // the instant the first result lands (0.3.243, Query.readMessages: "First
    // result received for single-turn query, closing stdin"). stdin carries the
    // canUseTool control channel, so on a RESUMED session — whose transcript
    // loads over async I/O that jitters startup ordering — the result can land
    // at or before the first tool turn, stdin closes, and every later gate call
    // comes back `Stream closed`: gateCalls stays 0 while the model keeps
    // calling tools. An async iterable is routed through streamInput, is never
    // marked single-turn, and keeps stdin (the gate) alive until the leg's own
    // result releases it below — so the dead stream streamClosedResult and
    // recoverStaleSession exist to catch no longer happens on turn one.
    let releaseInput!: () => void;
    const inputOpen = new Promise<void>((r) => { releaseInput = r; });
    async function* onePrompt(): AsyncGenerator<SDKUserMessage> {
      yield {
        type: 'user',
        parent_tool_use_id: null,
        message: { role: 'user', content: prompt },
      } as SDKUserMessage;
      // Parked so the iterable does not complete: streamInput closes stdin when
      // its input stream ends, so returning here would reintroduce the very
      // close we are avoiding. Released on the leg's result (or its exit).
      await inputOpen;
    }

    const q = query({
      prompt: onePrompt(),
      options: {
        cwd: world.root,
        model: agent.model,
        // Rebuilt per leg rather than per shift: after a hand-over this is
        // where the memory the agent just wrote itself comes back in. Build
        // it once at the top and the replacement conversation starts with a
        // stale copy of the very notes it was told to rely on.
        systemPrompt: buildSystemPrompt(d),

        // ---- isolation ----
        settingSources: [],          // no ~/.claude/settings.json, no CLAUDE.md
        strictMcpConfig: true,       // only the tools we hand them
        mcpServers: { [TOOL_NAMESPACE]: server, ...(d.connectors ?? {}) },
        canUseTool: gated,
        // Belt and braces on the host: canUseTool already refuses these, but
        // disallowedTools keeps them out of the tool list the model is shown,
        // so no turn is spent reaching for something that cannot be granted.
        // Inside the container the shell is the point, so it is offered.
        ...(shellIsContained() ? {} : { disallowedTools: ['Bash', 'BashOutput', 'KillShell'] }),

        // The kernel boundary between one company and the next.
        //
        // canUseTool confines every FILE tool to this world, and always has.
        // It cannot confine a shell: `ask('shell', cmd, null)` passes no path,
        // because a command string is not a path — `node -e`, `make`, a script
        // the agent wrote last turn are all opaque to inspection. So until now
        // `cat /data/companies/<other>/ledger.db` was allowed, and on
        // 2026-09-05 Lathe read another company's world six times.
        //
        // Claude Code's own Bash sandbox closes it: bubblewrap on Linux, and
        // the restriction is inherited by every descendant of the shell and
        // cannot be loosened from inside. Only when contained — off the
        // container there is no Bash at all, so there is nothing to sandbox
        // and failIfUnavailable would refuse a shift over an absent boundary
        // that nothing needs.
        //
        // enableWeakerNestedSandbox: inside an unprivileged container bwrap
        // cannot mount a fresh /proc, so it binds the container's. That hides
        // less process information and is the documented container setting;
        // the outer container is still the host boundary.
        ...(shellIsContained() ? { sandbox: {
          enabled: true,
          enableWeakerNestedSandbox: true,
          // Never degrade to running unsandboxed. A shift that cannot be
          // isolated must fail loudly, not quietly do the thing this exists
          // to prevent.
          failIfUnavailable: true,
          allowUnsandboxedCommands: false,
          // The wall around the network is the egress proxy, not this.
          //
          // Enabling the sandbox turned its network filter on as well, and
          // nothing chose that: `readpile https://example.com/` came back
          // `deny network-outbound example.com:443`, so both of this company's
          // fetching tools lost the only path they had and neither could be
          // tested end to end. Meanwhile the boundary that WAS chosen is still
          // there and is stronger — the factory sits on an internal network
          // with no route off the machine, and the single way out is a proxy
          // holding an anchored denylist that logs every request it passes.
          //
          // A second allowlist in front of that would have to name every host
          // a company might research before it knows it needs one, which is
          // the opposite of how this company is told to work: fetch the
          // evidence, and log the refusal in your own words when a site says
          // no. So this defers to the proxy rather than duplicating it.
          // strictAllowlist stays off with it; nothing here is an allowlist.
          network: { allowedDomains: ['*'] },
          // The kernel boundary between companies. See sandboxFilesystem: it
          // denies the whole installation root — the secrets store included —
          // and re-allows only this company's own home.
          filesystem: sandboxFilesystem(world.root, d.configDir),
        } } : {}),
        // DO NOT CHANGE THIS. 'default' is the only mode that consults
        // canUseTool, and canUseTool is the gate — the single chokepoint every
        // tool call crosses. Measured, twice each, with a handler that denies
        // everything and a model asked to write a file:
        //
        //   default  gate asked 2x, file not written
        //   auto     gate asked 0x, FILE WRITTEN
        //
        // 'auto' is not 'bypassPermissions' and does judge actions itself, but
        // it judges them INSTEAD OF the gate, not alongside it. Under it there
        // is no shell containment check, no capability routing, no drafts-only
        // rule and no spend cap — and its judgement is a model's, which is a
        // control that can be argued with in a prompt. See SECURITY.md.
        permissionMode: 'default',

        // The CLI's own account of a death. Without it the ledger records
        // `exited with code 1` and nothing else, and the reason has to be
        // reconstructed from transcript files inside the container.
        stderr: (data: string) => { noise = (noise + data).slice(-STDERR_KEPT); },

        // ---- limits ----
        maxTurns,
        ...(d.maxBudgetUsd != null ? { maxBudgetUsd: d.maxBudgetUsd } : {}),
        effort: 'medium',
        thinking: { type: 'adaptive' },

        // Spread process.env rather than replace it — omitting `env` inherits
        // it, so naming the field at all means naming everything the CLI
        // needs, the subscription token included. The toolchain cache redirect,
        // the session store on the volume, and the scoped proxy tokens are
        // added on top.
        ...(d.cacheDir || d.configDir || Object.keys(secretEnv).length
          ? { env: { ...process.env,
                     ...(d.cacheDir ? cacheEnv(d.cacheDir) : {}),
                     ...(d.configDir ? { CLAUDE_CONFIG_DIR: d.configDir } : {}),
                     ...secretEnv } }
          : {}),

        // ---- continuity ----
        ...(session ? { resume: session } : {}),
        persistSession: true,
        abortController: stop,
      },
    });

    for await (const m of q) {
      // Record to the company's own audit store first, before any of the
      // control logic that may `break` out of the loop — so a turn the ceiling
      // or a stale session cuts off is still on the record. session is set by the SDK's
      // system message before any content arrives; skip until it is known.
      if (d.transcript && session) recordShiftMessage(d.transcript, session, agent.id, m);
      if (m.type === 'assistant') {
        // Every tool-using turn, not only the gated ones — this is the count
        // the ceiling is measured against. Confirmed at 30 of 30 in both the
        // shift that died and the one that returned cleanly.
        if (m.message.content.some((b) => b.type === 'tool_use') && ++toolTurns >= maxTurns) {
          atCeiling = true;
        }
        if (tracing) {
          const toolNames: string[] = [];
          for (const b of m.message.content) if (b.type === 'tool_use') toolNames.push(b.name);
          if (toolNames.length) trace(`assistant calls [${toolNames.join(',')}]`);
        }
        if (!handover) {
          const u = m.message.usage as unknown as Record<string, number | undefined>;
          contextTokens = (u['input_tokens'] ?? 0)
            + (u['cache_read_input_tokens'] ?? 0)
            + (u['cache_creation_input_tokens'] ?? 0);
        }
        for (const b of m.message.content) {
          // Kept whether or not anyone is tracing: when a shift is cut at the
          // turn ceiling there is no result text, and this is the only record
          // of what the agent was actually doing when the lights went out.
          if (!handover && b.type === 'text' && b.text.trim()) said = b.text.trim();
          if (!d.trace) continue;
          if (b.type === 'tool_use') {
            d.trace(`  call  ${b.name} ${JSON.stringify(b.input).slice(0, 110)}`);
          } else if (b.type === 'text' && b.text.trim()) {
            d.trace(`  says  ${b.text.trim().split('\n')[0]!.slice(0, 110)}`);
          }
        }
      }
      // A resumed session whose control stream came up dead, caught at its
      // source. canUseTool is never reached (gateCalls stays 0) and every tool
      // comes back `Stream closed` on the first result. Drop the stale session
      // and retake the leg cold rather than resuming into the same dead stream
      // every tick. Only while the gate has never answered (a live channel that
      // closes mid-leg is a different fault, and clobbering it would throw away
      // real work) and only with a resume to drop — a cold leg with no session
      // to reset falls through, and a shift that hangs any other way is caught by
      // the shift timeout, not guessed at from silence.
      if (m.type === 'user' && session && gateCalls === 0 && streamClosedResult(m)) {
        staleSession = true;
        trace('resume stream-closed (gate never answered)');
        stop.abort();
        break;
      }
      if (m.type === 'system' && 'session_id' in m && typeof m.session_id === 'string') {
        session = m.session_id;
        ledger.setMeta(`session:${agent.id}`, m.session_id);
      }
      // Whether the company's own tools actually came up.
      //
      // Three shifts in one night were lost after the CLI logged `tools/list
      // failed (Stream closed)` at wake — the company server never connected,
      // so every write path was refused and the permission stream was gone with
      // it. Nothing in the ledger said so; the failure was only visible in a CLI
      // debug log inside the container.
      // A shift that starts without its tools cannot do its job, so say it
      // out loud and stop instead of spending a turn ceiling finding out.
      if (m.type === 'system' && m.subtype === 'init') {
        // The tools check belongs only to the init that OPENS the leg. On a
        // resumed session the SDK can emit a second init AFTER the leg's result —
        // a phantom re-init as the query winds down — and its in-process company
        // server is not re-registered, so it reads absent. Treating that as
        // missing tools aborted a healthy, finished leg and then hung its grace
        // poll for six minutes (Carver, 2026-09-16, seq 6286). Once the result is
        // in, ignore any init that follows it.
        if (sawResult) { trace('init after result — phantom re-init, ignored'); continue; }
        toolsUp = toolsConnected(m.mcp_servers);
        trace(`init tools=${companyServerStatus(m.mcp_servers) ?? 'absent'}`);
        // The init snapshot can precede the in-process ('sdk') company server's
        // connect on a resumed session, so a still-connecting server reads as
        // absent here. Poll the live status over a short grace window before
        // calling the channel dead, rather than aborting a healthy resume.
        if (!toolsUp) {
          toolsUp = await awaitToolsConnected(q, TOOLS_GRACE_MS, TOOLS_POLL_MS);
          trace(`init tools after ${TOOLS_GRACE_MS}ms grace=${toolsUp ? 'connected' : 'absent'}`);
        }
        if (!toolsUp) {
          ledger.emit(agent.id, 'shift.tools_missing', null, {
            status: companyServerStatus(m.mcp_servers) ?? 'absent',
            servers: m.mcp_servers,
            // legResumed, not `session != null`: this init message may have just
            // set session (line above), which would mislabel a cold start as
            // resumed. legResumed is captured at leg start, before any of that.
            resumed: legResumed,
            graceMs: TOOLS_GRACE_MS,
            ...auditTail(),
          });
          stop.abort();
          break;
        }
        void readUsage(q);
      }
      if (m.type === 'rate_limit_event') {
        const kind = m.rate_limit_info.rateLimitType ?? 'unknown';
        const merged = mergeWindow(windows.get(kind), m.rate_limit_info);
        rateLimit = merged;
        windows.set(kind, merged);
      }
      // Compaction is the backstop, not the mechanism. If it fires, our own
      // threshold was too high — and without this it happens silently and the
      // persona erodes with nobody the wiser.
      if (m.type === 'system' && m.subtype === 'compact_boundary') {
        const c = m.compact_metadata;
        ledger.emit(agent.id, 'session.compacted', null, {
          trigger: c.trigger, preTokens: c.pre_tokens,
          ...(c.post_tokens != null ? { postTokens: c.post_tokens } : {}),
        });
      }
      if (m.type === 'result') {
        // The leg has answered. Any init after this is a phantom re-init the
        // init handler must ignore (see there).
        sawResult = true;
        trace(`result ${m.subtype} turns=${m.num_turns}`);
        turns += m.num_turns;
        costUsd += m.total_cost_usd;
        legs.push({ budget: maxTurns, turns: m.num_turns, subtype: m.subtype });

        // The turn ceiling arrives as a result, not as a throw.
        //
        // OUT_OF_TURNS below watches the catch for 'Reached maximum number of
        // turns', and this SDK never throws it: a leg that exhausts its budget
        // returns subtype 'error_max_turns' with num_turns = maxTurns + 1.
        // Measured against 0.3.243 at budgets of 3 and 6, with and without
        // adaptive thinking. So every shift the ceiling cut off was journalled
        // as one that chose to stop, the agent never got its 'resumes next
        // shift' note, and vitals reported truncated: 0 for 119 shifts.
        // A hand-over is excluded: its budget is four turns by design, so
        // spending all four is the hand-over working, not the shift being cut.
        if (!handover && m.subtype === 'error_max_turns') truncated = true;

        // Counted before the hand-over guard below: a hand-over leg spends the
        // operator's window like any other, even though its context is the
        // conversation we are about to throw away.
        for (const u of Object.values(m.modelUsage ?? {})) {
          tokens.input += u.inputTokens;
          tokens.output += u.outputTokens;
          tokens.cacheRead += u.cacheReadInputTokens;
          tokens.cacheWrite += u.cacheCreationInputTokens;
        }
        if (handover) { releaseInput(); continue; }
        contextWindow = m.modelUsage?.[agent.model]?.contextWindow ?? contextWindow;
        // "ended: error_max_turns" was going into the journal and the commit
        // message — an error code standing in for the agent's own account of
        // its shift. Their last words are a truer record than the subtype.
        summary = m.subtype === 'success' ? m.result : (said || `ended: ${m.subtype}`);
        await readUsage(q);
        // The leg's one turn is done. Release the held input AFTER the usage
        // read (which needs a live stdin), so streamInput completes, closes
        // stdin, the CLI exits and this loop ends. Released here, inside the
        // loop on the result — not in a post-loop finally, which the held-open
        // stream would never reach on the happy path (deadlock).
        releaseInput();
      }
    }
    // Break paths (stale-session, tools_missing, abort) leave the loop
    // before any result; abort tears the stream down, and this releases the
    // parked generator so it cannot outlive the leg. Idempotent.
    releaseInput();
  };

  let prompt = buildTickPrompt(d);
  let truncated = false;
  let failure = '';

  /**
   * One cold retry when a resumed session's control stream came up dead.
   *
   * The SDK returns `Stream closed` for every tool because canUseTool is never
   * reached (streamClosedResult catches it). Every observed case was a RESUMED
   * session, the same shape as the tools/list that comes back `Stream closed`
   * at wake, and the same cure: drop the resume and take the leg again cold. A
   * fresh session brings up a fresh control stream, so the gate is wired again.
   *
   * Guarded on `session`: a leg with no resume to drop is a real fault in the
   * channel, not resume flakiness, and must fail loudly rather than loop. Once,
   * then stop — a second dead stream is a real fault too.
   */
  const recoverStaleSession = (): boolean => {
    if (!(session && staleRetries++ < 1)) return false;
    ledger.setMeta(`session:${agent.id}`, '');
    ledger.emit(agent.id, 'session.reset', null, { was: session, why: 'stream closed on resume' });
    session = null;
    staleSession = false;
    return true;
  };

  for (;;) {
    const left = ceiling - turns;
    if (left <= 0) { truncated = true; break; }

    try {
      await runLeg(prompt, left);

      // A leg whose tools never connected is worth exactly one cold retry.
      //
      // Every observed occurrence was on a resumed session, and the same
      // session resumed cleanly on the next attempt — so the cheap thing is
      // to drop the resume and take the leg again rather than burn a whole
      // tick. Once, then stop: a second failure is a real fault and should
      // look like one.
      if (!toolsUp) {
        if (toolRetries++ < 1) {
          ledger.setMeta(`session:${agent.id}`, '');
          ledger.emit(agent.id, 'session.reset', null, { was: session, why: 'tools did not connect' });
          session = null;
          toolsUp = true;
          continue;
        }
        failure = NO_TOOLS;
        break;
      }

      // Leaving the message loop is a normal return, so this never reaches
      // the catch below on its own.
      if (overran) { failure = overranBy(d.shiftTimeoutMs ?? 0); break; }
      if (staleSession) { if (recoverStaleSession()) continue; failure = STALE_SESSION; break; }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);

      // Checked first: everything below reads the abort this caused as its
      // own kind of failure, and `Claude Code process aborted by user` is the
      // least useful sentence any of them could put on the record.
      if (overran) { failure = overranBy(d.shiftTimeoutMs ?? 0); break; }

      // A conversation the runtime no longer has is not a failed shift.
      //
      // The session id lives in the ledger, on the durable volume. The
      // conversation lives wherever the runtime keeps it, which in the
      // container is a tmpfs — so every restart wipes the transcripts while
      // the ids survive, and every agent asks to resume something that is
      // gone. Nothing cleared the id, so it repeated forever rather than
      // healing. Forget it and take the leg again cold; the persona, memory
      // and world are the durable context, and resume was only ever an
      // optimisation on top of them.
      //
      // Checked BEFORE anything is recorded as a failure, because a shift
      // that recovers did not fail, and saying so puts a red line in the
      // console for something nobody needs to act on.
      if (session && LOST_SESSION.test(error)) {
        ledger.setMeta(`session:${agent.id}`, '');
        ledger.emit(agent.id, 'session.reset', null, { was: session });
        session = null;
        continue;
      }

      // Running out of turns is a shift ending, not a shift failing. The agent
      // worked, spent real money and usually wrote something down; it simply
      // hit the ceiling before it chose to stop. Recording that as a failure
      // made a busy company look broken and buried the errors that matter.
      if (OUT_OF_TURNS.test(error) || atCeiling) { truncated = true; break; }

      if (staleSession) { if (recoverStaleSession()) continue; failure = STALE_SESSION; break; }

      failure = error;
      break;
    }

    if (!shouldRotate({
      contextTokens, contextWindow, rotateAtPct: rotateAt,
      turnsLeft: ceiling - turns, rotations,
    })) break;

    // Captured before the hand-over runs: those turns are spent against the
    // old conversation and would report the context we are about to drop as
    // if it were the context we kept.
    const was = { was: session, ...context() };

    // The hand-over runs on the OLD conversation, while it still remembers.
    try {
      await runLeg(HANDOVER_PROMPT, Math.min(HANDOVER_TURNS, ceiling - turns), true);
    } catch (err) {
      // Failing to hand over is not worth failing the shift over — but it is
      // worth not rotating afterwards. Dropping a conversation that nobody
      // managed to write down is the one outcome rotation exists to avoid.
      ledger.emit(agent.id, 'session.rotate_failed', null, {
        error: err instanceof Error ? err.message : String(err),
      });
      break;
    }

    ledger.emit(agent.id, 'session.rotated', null, { ...was, turns });
    ledger.setMeta(`session:${agent.id}`, '');
    session = null;
    prompt = RESUMED_PROMPT;
    rotations++;
  }

  // Whatever happened, the shift is over and its clock is not.
  if (timeout) clearTimeout(timeout);

  if (failure) {
    ledger.emit(agent.id, 'agent.failed', null, {
      error: failure,
      ...(noise.trim() ? { stderr: withoutSecrets(noise).trim() } : {}),
      ...meter(),
    });
    return {
      agentId: agent.id, ok: false, summary: '', costUsd, turns, error: failure,
      ...(spentAny() ? { tokens } : {}),
      ...(rateLimit ? { rateLimit } : {}),
      ...(windows.size ? { windows: [...windows] } : {}),
    };
  }

  // Their own account of the shift, in their own hand, in the world's git log.
  const account = summary || said;
  if (account) {
    world.appendJournal(agent.id, journalEntry(account, turns, truncated));
  }
  world.git.commitAs({ id: agent.id, name: agent.name }, `${agent.id}: ${firstLine(account)}`);

  ledger.emit(agent.id, 'agent.slept', null, {
    turns, costUsd, ceiling,
    ...(truncated ? { truncated: true } : {}),
    ...(rotations ? { rotations } : {}),
    // Only when the shift did something the single number cannot explain: more
    // than one leg ran, or the total passed the ceiling. A shift that took its
    // one leg and stopped is fully described by turns and ceiling already.
    ...(legs.length > 1 || turns > ceiling ? { legs } : {}),
    ...context(),
    ...meter(),
  });
  return {
    agentId: agent.id, ok: true, summary: account, costUsd, turns,
    ...(spentAny() ? { tokens } : {}),
    ...(truncated ? { truncated: true } : {}),
    ...(rotations ? { rotations } : {}),
    ...(rateLimit ? { rateLimit } : {}),
    ...(windows.size ? { windows: [...windows] } : {}),
  };
};

const firstLine = (s: string): string =>
  (s.split('\n').find((l) => l.trim()) ?? 'worked a shift').slice(0, 72);


/**
 * The journal is the handoff: the next shift reads it instead of re-deriving.
 * A hard `slice` cut both of Fathom's first two entries mid-word — one ended
 * "`projects/sunset", the other "a command " — with nothing saying so, which
 * is the exact failure the company was founded to fix. Cut on a boundary, and
 * always admit the cut.
 */
export const JOURNAL_CHARS = 1200;

export const journalEntry = (account: string, turns: number, truncated: boolean): string => {
  const ceiling = truncated ? `\n\n_Cut at the turn ceiling (${turns}). Resumes next shift._` : '';
  if (account.length <= JOURNAL_CHARS) return account + ceiling;

  const head = account.slice(0, JOURNAL_CHARS);
  // Prefer a paragraph break, then a sentence, then a word — whichever is
  // nearest the limit without throwing away more than a quarter of the budget.
  const floor = JOURNAL_CHARS * 0.75;
  const at = [head.lastIndexOf('\n\n'), head.lastIndexOf('. '), head.lastIndexOf(' ')]
    .find((i) => i >= floor) ?? JOURNAL_CHARS;
  return `${account.slice(0, at).trimEnd()}\n\n_Cut at ${JOURNAL_CHARS} characters; `
    + `${account.length - at} more in the shift itself._${ceiling}`;
};
