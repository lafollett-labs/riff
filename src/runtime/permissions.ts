import { dirname, relative, resolve, sep } from 'node:path';
import { existsSync, realpathSync } from 'node:fs';
import type { CanUseTool, PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import type { AgentId, Capability } from '../core/types.ts';
import type { Gate } from '../policy/gate.ts';
import type { World } from '../worldfs/world.ts';
import { slug } from '../core/ids.ts';
import { TOOL_PREFIX } from './tools.ts';

/**
 * The bridge between the Agent SDK and the company's rules.
 *
 * canUseTool is the single chokepoint every tool call crosses — built-ins
 * included — so wiring Gate here means there is no tool surface that
 * bypasses the rules. A staff member cannot talk its way past this; it is not
 * in the prompt.
 *
 * Posture is DEFAULT-DENY. An unrecognised tool is refused, so adding a tool
 * to the SDK later cannot silently widen what the staff can do.
 */

/**
 * Shell is the one capability decided by WHERE the runtime is, not by who is
 * asking.
 *
 * On the operator's own machine it is refused outright — autonomous agents do
 * not get a terminal on someone's Mac, and no argument from inside a session
 * can change that, because this is not in the prompt.
 *
 * Inside the container it is the entire point. Agents cannot build anything
 * worth reviewing without a compiler and a package manager, and the answer to
 * that is not a tool allowlist that shrinks forever — it is a box with no
 * route to the internet. See docker/compose.yaml.
 *
 * Both signals are required. The env var alone would let a mistyped export on
 * the host open a shell; the container marker alone would open one in any
 * container, including ones built for something else entirely. Fail closed:
 * if either is missing, there is no shell.
 */
const SHELL_TOOLS = new Set(['Bash', 'BashOutput', 'KillShell', 'KillTask']);

const containerMarked = (): boolean => existsSync('/.dockerenv') || existsSync('/run/.containerenv');

/** `marked` is the container probe, a parameter so each signal can be tested without the other. */
export const shellIsContained = (env: NodeJS.ProcessEnv = process.env, marked: () => boolean = containerMarked): boolean =>
  env['RIFF_CONTAINED'] === '1' && marked();

const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'NotebookRead']);
const WRITE_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit', 'MultiEdit']);
/**
 * Harmless scratch space and delegation. `Agent` spawns a subagent (it was
 * `Task` before CLI 2.1, and this list still said so): CLI 2.1.280 does not
 * ask about the spawn at all, measured as `gated: false` on subagent.finished,
 * and the subagent's own writes and shell each cross this gate in turn.
 */
const FREE_TOOLS = new Set(['TodoWrite', 'Agent', 'Skill', 'ExitPlanMode']);
const OUTSIDE_READ = new Set(['WebFetch', 'WebSearch']);

type Where = { kind: 'own' } | { kind: 'other'; who: string } | { kind: 'commons' } | { kind: 'outside' };

const pathFrom = (input: Record<string, unknown>): string | null => {
  for (const k of ['file_path', 'path', 'notebook_path', 'filePath']) {
    const v = input[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
};

/**
 * Where does this path sit relative to the staff member reaching for it?
 *
 * Two checks, and the second is the one that was missing. `resolve` folds
 * `..` away, so `../../other/world` is caught textually. A SYMLINK is not:
 * planted inside world/ it resolves textually clean and lands wherever it
 * points. `World.path` has refused that since it was written; this did not,
 * so one `ln -s` from a shell turned the known shell hole into a permanent
 * one — Read, Grep and Glob followed the link into another company on every
 * later shift, and the gate logged it as the actor's own file.
 *
 * The real path is also what gets classified, not the written one. A link
 * named `staff/ada/peek` that points at Bob's directory is Bob's, whatever it
 * is called from where you are standing.
 */
export const classifyPath = (world: World, actor: AgentId, raw: string): Where => {
  const abs = resolve(world.root, raw);
  const root = resolve(world.root);
  if (abs !== root && !abs.startsWith(root + sep)) return { kind: 'outside' };

  // Walk up to the deepest ancestor that EXISTS — the target may be a file
  // about to be created, and realpath throws on a missing path — but never
  // above the world root. Walking past it resolves the installation instead
  // of the company, and a world whose directory has not been made yet then
  // classifies every path in it as outside, which failed every existing test
  // in this file the first time this check was written.
  let base = root;
  let resolved = abs;
  if (existsSync(root)) {
    let probe = abs;
    while (probe !== root && !existsSync(probe)) probe = dirname(probe);
    try {
      const real = realpathSync(probe);
      base = realpathSync(root);
      if (real !== base && !real.startsWith(base + sep)) return { kind: 'outside' };
      resolved = real + abs.slice(probe.length);
    } catch {
      // A path we cannot resolve is a path we cannot vouch for.
      return { kind: 'outside' };
    }
  }

  if (resolved === base) return { kind: 'commons' };
  const rel = resolved.slice(base.length + 1);
  const parts = rel.split(sep);
  // The world's own repository is Riff's, not the company's. The gateway runs
  // git over it outside the shift sandbox, so a hook or a config line written
  // here by a file tool — which runs outside bubblewrap too — would run as the
  // gateway. It fell through to "commons" below and was writable. Compared
  // case-insensitively: the volume is a macOS bind mount, where .GIT is .git.
  if (parts[0]?.toLowerCase() === '.git') return { kind: 'outside' };
  if (parts[0] === 'commons') return { kind: 'commons' };
  if (parts[0] === 'staff' && parts[1]) {
    return parts[1] === slug(actor) ? { kind: 'own' } : { kind: 'other', who: parts[1] };
  }
  // house-rules.md and other top-level shared documents
  return { kind: 'commons' };
};

const deny = (message: string): PermissionResult => ({ behavior: 'deny', message });
const allow = (): PermissionResult => ({ behavior: 'allow' });

/** Put a request to the gate and answer the CLI in its terms. */
const askGate = (gate: Gate, actor: AgentId, capability: Capability, summary: string,
  target?: string | null): PermissionResult => {
  const d = gate.request({ actor, capability, summary, ...(target ? { target } : {}) });
  if (d.kind === 'allow') return allow();
  if (d.kind === 'deny') return deny(`Refused by the company's rules (${d.rule}): ${d.reason}`);
  // An escalation is not a failure — the work is parked, and the staff member
  // is told so plainly enough that it moves on instead of retrying in a loop.
  return deny(
    `Held for approval (${d.rule}): ${d.reason}. ` +
    `Approval ${d.approvalId} is now pending with the ${d.tier}. ` +
    `Do not retry this action — it is queued. Continue with other work.`
  );
};

export type PermissionDeps = {
  actor: AgentId;
  world: World;
  gate: Gate;
  /** Called for every decision, so a shift spent hammering a refused tool is
   *  visible instead of silent. */
  onDecision?: (toolName: string, outcome: 'allow' | 'deny', detail: string) => void;
  /** Capability declared by each in-process company tool, by bare tool name. */
  toolCapabilities: Record<string, Capability>;
  /** Overridable so the decision can be tested without being in a container. */
  contained?: boolean;
};

export const makeCanUseTool = (deps: PermissionDeps): CanUseTool => {
  const { actor, world, gate, toolCapabilities } = deps;
  const contained = deps.contained ?? shellIsContained();
  const note = (tool: string, out: 'allow' | 'deny', detail = '') =>
    deps.onDecision?.(tool, out, detail);

  const ask = (capability: Capability, summary: string, target?: string | null): PermissionResult =>
    askGate(gate, actor, capability, summary, target);

  return async (toolName, input) => {
    if (SHELL_TOOLS.has(toolName)) {
      if (!contained) {
        note(toolName, 'deny', 'no shell outside the container');
        return deny(
          `${toolName} is not available. This company is running directly on someone's ` +
          `machine, so there is no shell. Use the company tools for company work, or ` +
          `Read/Write within your own files. Running in the container gives you a shell.`
        );
      }
      const cmd = typeof input['command'] === 'string' ? String(input['command']) : toolName;
      return ask('shell', cmd.slice(0, 200), null);
    }

    if (FREE_TOOLS.has(toolName)) { note(toolName, 'allow', 'free'); return allow(); }

    if (OUTSIDE_READ.has(toolName)) {
      const t = typeof input['url'] === 'string' ? String(input['url']) : String(input['query'] ?? '');
      return ask('external.read', `${toolName}: ${t}`.slice(0, 200), t.slice(0, 200));
    }

    // In-process company tools declare their own capability at definition time.
    const bare = toolName.startsWith(TOOL_PREFIX) ? toolName.slice(TOOL_PREFIX.length) : null;
    if (bare) {
      // Object.hasOwn, not a bare lookup: a tool named `toString`/`constructor`/
      // etc. would resolve to an inherited prototype value and be allowed as
      // though it were a real, mapped tool.
      const cap = Object.hasOwn(toolCapabilities, bare) ? toolCapabilities[bare] : undefined;
      if (!cap) return deny(`Unknown company tool '${bare}'.`);
      // The tool body performs its own gate call with a real summary; this
      // pass only rejects what is categorically barred for this actor.
      return allow();
    }

    if (READ_TOOLS.has(toolName) || WRITE_TOOLS.has(toolName)) {
      const p = pathFrom(input);
      if (!p) return deny(`${toolName} needs a path.`);
      const where = classifyPath(world, actor, p);
      const writing = WRITE_TOOLS.has(toolName);

      switch (where.kind) {
        case 'outside':
          return deny(
            `${p} is outside the company. Everything you need is under world/ — ` +
            `your own files, the commons, and your colleagues' open files.`
          );
        case 'own':
          return ask(writing ? 'world.write' : 'world.read', `${toolName} ${p}`, p);
        case 'commons':
          return ask(writing ? 'world.write' : 'world.read', `${toolName} ${p}`, p);
        case 'other':
          return ask(
            writing ? 'world.write_other' : 'world.read_other',
            `${toolName} ${where.who}'s file: ${p}`,
            p
          );
      }
    }

    // Default-deny. New SDK tools do not become staff powers by accident.
    note(toolName, 'deny', 'unknown tool');
    return deny(`'${toolName}' is not one of this company's tools.`);
  };
};

/**
 * The tools the CLI can run without asking canUseTool, which the pre-check asks
 * about. Anchored: read as a substring match, `Task` would take in TaskStop and
 * TaskOutput and `Bash` BashOutput, which the gate does not know and would refuse.
 */
export const PRE_CHECKED = '^(?:Agent|Task|Read|Glob|Grep|NotebookRead|Bash)$';

/**
 * Whether a Grep or Glob stays inside your own folder or the commons. A search
 * of the world, of staff/, or with a pattern that climbs out reads colleagues'
 * files by the handful, and is recorded as one read of theirs.
 */
const searchScoped = (world: World, actor: AgentId, toolName: string, input: Record<string, unknown>): boolean => {
  const raw = typeof input['path'] === 'string' && input['path'] ? input['path'] : '.';
  // Resolved, as classifyPath resolves a Read: a link in your own folder that
  // points at a colleague's made a search of theirs read as private.
  const where = classifyPath(world, actor, raw).kind;
  if (where === 'commons') {
    // Through the deepest part that exists, as classifyPath walks: a folder not
    // made yet has no realpath, and is where it says it is.
    const real = (abs: string): string => {
      let probe = abs;
      while (!existsSync(probe) && dirname(probe) !== probe) probe = dirname(probe);
      try { return realpathSync(probe) + abs.slice(probe.length); } catch { return abs; }
    };
    const rel = relative(real(resolve(world.root)), real(resolve(world.root, raw)));
    if (rel !== 'commons' && !rel.startsWith('commons' + sep)) return false;
  } else if (where !== 'own') return false;
  const patterns = [input['glob'], toolName === 'Glob' ? input['pattern'] : undefined]
    .filter((p): p is string => typeof p === 'string');
  return !patterns.some((p) => p.includes('..') || p.startsWith('/'));
};

/**
 * The gate, asked before the CLI decides for itself.
 *
 * canUseTool is only reached for calls the CLI wants permission for. It
 * approves some itself — Read/Glob/Grep inside world/, a command it judges
 * read-only, a subagent spawn — and those never crossed the gate: a built-in
 * Read of a colleague's memory was silent despite `transparency.read_is_loud`,
 * and a spawn could ask for `isolation: "remote"` with nothing to refuse it.
 * Measured against CLI 2.1.280 on 2026-09-23.
 *
 * Run from a PreToolUse hook, which the CLI resolves before its own approval.
 * Returns the decision, or null where there is nothing to decide: reading your
 * own files or the commons is unremarkable, and logging every read would bury
 * the ledger. It adds refusals and records; a null or an allow grants nothing
 * the CLI's own flow would not.
 */
export const makePreToolCheck = (deps: PermissionDeps) => {
  const can = makeCanUseTool(deps);
  return async (toolName: string, input: Record<string, unknown>, toolUseID: string): Promise<PermissionResult | null> => {
    if (toolName === 'Agent' || toolName === 'Task') {
      // Probed: a remote spawn was accepted and ran as a background agent.
      // Whatever "remote" resolves to, a company's work stays in its container.
      if (input['isolation'] === 'remote') {
        deps.onDecision?.(toolName, 'deny', 'remote isolation');
        return deny('Subagents run inside this company\'s container; remote isolation is not available. ' +
          'Spawn it without `isolation`.');
      }
    }
    if (toolName === 'Grep' || toolName === 'Glob') {
      // No path is the working directory: world/, every colleague's files in it.
      const root = typeof input['path'] === 'string' && input['path'] ? input['path'] : deps.world.root;
      const where = classifyPath(deps.world, deps.actor, root).kind;
      if (where === 'outside') return can(toolName, { ...input, path: root }, { signal: AbortSignal.timeout(30_000), toolUseID } as never);
      if (searchScoped(deps.world, deps.actor, toolName, input)) return null;
      const across = relative(resolve(deps.world.root), resolve(deps.world.root, root)) || 'the world';
      const what = [input['pattern'], input['glob']].filter((p) => typeof p === 'string').join(' ');
      return askGate(deps.gate, deps.actor, 'world.read_other', `${toolName} ${what} across ${across}`.slice(0, 200), root);
    }
    if (READ_TOOLS.has(toolName)) {
      const p = pathFrom(input);
      if (!p) return null;
      const where = classifyPath(deps.world, deps.actor, p).kind;
      if (where === 'own' || where === 'commons') return null;
    }
    return can(toolName, input, { signal: AbortSignal.timeout(30_000), toolUseID } as never);
  };
};
