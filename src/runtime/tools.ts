import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { newId, slug } from '../core/ids.ts';
import type { Capability, AgentId, Tier } from '../core/types.ts';
import type { Ledger } from '../ledger/ledger.ts';
import type { Gate } from '../policy/gate.ts';
import { commonsPath, type World } from '../worldfs/world.ts';
import type { Clock } from '../core/clock.ts';
import { fillSeat } from '../company/hire.ts';

/**
 * The MCP server's key, which is what the SDK prefixes every tool name with:
 * `mcp__<namespace>__who_is_here`. The permission layer matches on that
 * prefix, so if these two ever disagree the match fails, every company tool
 * falls through to the default-deny, and an agent's whole shift is refusals
 * with no error anywhere. One constant, imported by both.
 */
export const TOOL_NAMESPACE = 'company';
export const TOOL_PREFIX = `mcp__${TOOL_NAMESPACE}__`;

export type Ctx = {
  actor: AgentId;
  ledger: Ledger;
  gate: Gate;
  world: World;
  clock: Clock;
};

const say = (text: string) => ({ content: [{ type: 'text' as const, text }] });

/**
 * Run behind the gate. The tool body — not canUseTool — is where the real
 * check happens, because only here do we know WHAT is being asked for: the
 * amount, the target, the one line that lands in the board's queue.
 */
const gated = (
  ctx: Ctx, capability: Capability, summary: string, target: string | null,
  perform: () => string,
  extra?: { amountCents?: number; payload?: unknown },
): string => {
  const d = ctx.gate.request({
    actor: ctx.actor, capability, summary,
    ...(target ? { target } : {}),
    ...(extra?.amountCents != null ? { amountCents: extra.amountCents } : {}),
    ...(extra?.payload !== undefined ? { payload: extra.payload } : {}),
  });
  if (d.kind === 'allow') return perform();
  if (d.kind === 'deny') return `Refused (${d.rule}): ${d.reason}`;
  return `Held for approval (${d.rule}): ${d.reason}\n` +
    `Approval ${d.approvalId} is pending with the ${d.tier}. It is queued — do not retry. ` +
    `Carry on with other work.`;
};

export const createTools = (ctx: Ctx) => {
  const { actor, ledger, world, clock } = ctx;

  /** The name a person is called by. Ids address; names read. */
  const who = (id: AgentId): string => ledger.getAgent(id)?.name ?? id;

  // ------------------------------------------------------------- awareness
  const whoIsHere = tool(
    'who_is_here',
    'Everyone who works at this company, with their tier, role and what they are doing.',
    {},
    async () => {
      const rows = ledger.listAgents().map((a) =>
        `- ${a.name} (${a.id}) — ${a.role} · ${a.tier}${a.department ? ` · ${a.department}` : ''}` +
        `${a.activity ? ` — ${a.activity}` : ''}`);
      return say(rows.join('\n') || 'Nobody works here yet.');
    },
    { annotations: { readOnlyHint: true } },
  );

  const readColleague = tool(
    'read_colleague',
    "Read a colleague's brief or memory. Allowed — but every read is recorded and visible to them.",
    { who: z.string(), file: z.enum(['persona', 'memory']) },
    async ({ who, file }) => {
      const target = file === 'persona' ? world.personaPath(who) : world.memoryPath(who);
      return say(gated(ctx, 'world.read_other', `read ${who}'s ${file}`, target, () =>
        world.readDoc(target)?.body.trim() ?? `${who} has no ${file} on file.`));
    },
    { annotations: { readOnlyHint: true } },
  );

  // ------------------------------------------------------ building the company
  const proposeRole = tool(
    'propose_role',
    'Propose a new seat. Say what it owns and what goes undone without it — a vague mandate produces vague work. The board decides.',
    {
      name: z.string().max(60).describe('The person who would fill it'),
      role: z.string().max(80).describe('Job title, e.g. "Head of Research"'),
      tier: z.enum(['executive', 'lead', 'member']),
      department: z.string().max(60).default(''),
      mandate: z.string().describe('What this seat owns, and what goes undone without it'),
      reportsTo: z.string().describe(
        'Agent id they report to. Not a board member — the board governs, it does not manage. ' +
        'Independence does not need a reporting line here: the commons, notes and the event log ' +
        'are visible to the board regardless of who reports to whom.'),
    },
    async (p) => say(gated(ctx, 'hire', `${p.role}: ${p.name}`, slug(p.name), () => {
      // Reached only when the gate ALLOWS outright (the CEO's own hire).
      // Everyone else escalates and the executor calls the same function.
      const r = fillSeat(ledger, world, clock, { ...p, proposedBy: actor },
        ctx.gate.constitution.board);
      if (!r.ok) return `Could not fill that seat: ${r.reason}`;
      return `${p.name} has joined as ${p.role}.` +
        (r.redirected ? ` Reporting line set to you — the board governs, it does not manage.` : '');
    }, { payload: { ...p, proposedBy: actor } })),
  );

  const retireRole = tool(
    'retire_role',
    'Retire a seat that has stopped earning its place. Say why. This is how the company stays small enough to understand.',
    { who: z.string(), why: z.string().max(400) },
    async ({ who, why }) => {
      const a = ledger.getAgent(who);
      if (!a) return say(`Nobody called '${who}' works here.`);
      if (a.tier === 'board') return say('The board cannot be retired.');
      return say(gated(ctx, 'hire', `retire ${a.role} (${a.name}): ${why}`, who, () => {
        ledger.upsertAgent({ ...a, status: 'departed' });
        ledger.emit(actor, 'role.retired', who, { why });
        return `${a.name} has left the company.`;
      }, { payload: { retire: who, why } }));
    },
  );

  // ----------------------------------------------------------- the commons
  const postToCommons = tool(
    'post_to_commons',
    'Publish to the commons — shared ground everyone reads. No fixed format; invent what the company needs. There is a ceiling: past it you must remove something first.',
    { path: z.string(), title: z.string().max(140), body: z.string() },
    async ({ path, title, body }) => {
      const rel = commonsPath(path);
      return say(gated(ctx, 'world.write', `commons: ${title}`, rel, () => {
        // The author line is read by people, so it carries the name they are
        // called by. The id is a filesystem handle, not a byline.
        world.writeCommons(rel, { title, author: who(actor), updated: clock.iso() }, body);
        ledger.emit(actor, 'commons.posted', rel, { title });
        return `Posted to ${rel}.`;
      }));
    },
  );

  const removeFromCommons = tool(
    'remove_from_commons',
    'Remove a commons document that has stopped being true. Say what changed. Removal is a first-class act here, not a failure.',
    { path: z.string(), why: z.string().max(400) },
    async ({ path, why }) => {
      const rel = commonsPath(path);
      if (!world.exists(rel)) return say(`${rel} is not there.`);
      return say(gated(ctx, 'world.write', `remove ${rel}: ${why}`, rel, () => {
        world.remove(rel);
        ledger.emit(actor, 'commons.removed', rel, { why });
        return `Removed ${rel}. ${world.commonsCount()} documents remain.`;
      }));
    },
  );

  const commonsIndex = tool(
    'commons_index',
    'What the commons currently holds, and how much room is left.',
    {},
    async () => {
      const docs = world.listCommons();
      const ceiling = ctx.gate.constitution.commonsCeiling;
      return say(`${docs.length} of ${ceiling} documents:\n${docs.map((d) => `- ${d}`).join('\n')}`);
    },
    { annotations: { readOnlyHint: true } },
  );

  // --------------------------------------------------------- the portfolio
  const portfolio = tool(
    'portfolio',
    'What the company is carrying, and whether there is room to start something else.',
    {},
    async () => {
      const projects = world.listProjects();
      const ceiling = ctx.gate.constitution.portfolioCeiling;
      if (ceiling <= 0) {
        return say(projects.length
          ? `${projects.length} projects, no ceiling:\n${projects.map((p) => `- ${p}`).join('\n')}`
          : 'Nothing under way. No ceiling on how many you may carry.');
      }
      const room = ceiling - projects.length;
      return say(
        `${projects.length} of ${ceiling} projects:\n${projects.map((p) => `- ${p}`).join('\n')}\n\n` +
        (room > 0
          ? `Room for ${room} more.`
          : 'Full. Starting another means retiring one — retire_project.'),
      );
    },
    { annotations: { readOnlyHint: true } },
  );

  const retireProject = tool(
    'retire_project',
    'Retire a project the company has stopped believing in, freeing a slot under Rule 7. Say what you learned and why it is over. Retiring is a decision, not a defeat: the thing you keep out of habit is costing you the one you would rather be doing.',
    { name: z.string().describe('The project directory name, as portfolio lists it'), why: z.string().max(800) },
    async ({ name, why }) => {
      if (!world.listProjects().includes(name)) {
        return say(`There is no project called "${name}". portfolio lists what there is.`);
      }
      // Signs like retire_role (R2 → the CEO): deleting a project tree is as
      // consequential as closing a seat, and until now any active agent could
      // do it unsigned. The payload lets the executor replay it after the CEO
      // says yes — a non-CEO's request escalates and never runs `perform` here.
      return say(gated(ctx, 'project.retire', `retire ${name}: ${why}`, `projects/${name}`, () => {
        // The record outlives the tree. What was tried and why it ended is the
        // part worth keeping; the code is in the world's git history either way.
        world.removeProject(name);
        ledger.emit(actor, 'project.retired', `projects/${name}`, { why });
        const left = world.projectCount();
        const ceiling = ctx.gate.constitution.portfolioCeiling;
        return `Retired ${name}. ${left}${ceiling > 0 ? ` of ${ceiling}` : ''} projects remain.`;
      }, { payload: { project: name, why } }));
    },
  );

  // ------------------------------------------------------------- expression
  const sendMessage = tool(
    'send_message',
    'Message a colleague, or everyone. They read it when they next wake — you do not wait for a reply.',
    { to: z.string().describe('An agent id, or "everyone"'), body: z.string().max(4000) },
    async ({ to, body }) => say(gated(ctx, 'message', `message to ${to}`, to, () => {
      const target = to === 'everyone' ? null : to;
      if (target && !ledger.getAgent(target)) return `Nobody called '${to}' works here.`;
      const n = ledger.sendMessage(actor, target, body);
      ledger.emit(actor, 'message.sent', target, { recipients: n });
      return `Delivered to ${n}. They read it when they next wake.`;
    })),
  );

  const noteAbout = tool(
    'note_about',
    'Record an observation about a colleague, or about the company. Notes are permanent and everyone can read them.',
    { about: z.string().nullable(), title: z.string().max(140), body: z.string() },
    async ({ about, title, body }) => say(
      gated(ctx, 'note.write', `note on ${about ?? 'the company'}: ${title}`, about, () => {
        const rel = world.writeNote(actor, about, title, body);
        world.reindexNotes(ledger);
        ledger.emit(actor, 'note.written', about, { title, path: rel });
        return `Recorded at ${rel}.`;
      })),
  );

  const remember = tool(
    'remember',
    'Rewrite your long-term memory, keeping what still matters. Do this when it grows long or stale — it REPLACES the old one.',
    { memory: z.string() },
    async ({ memory }) => say(gated(ctx, 'world.write', 'consolidated memory', world.memoryPath(actor), () => {
      world.writeMemory(actor, memory);
      ledger.emit(actor, 'memory.consolidated', null, { chars: memory.length });
      return 'Memory rewritten.';
    })),
  );

  const setActivity = tool(
    'set_activity',
    'Say what you are working on now, in one line. Colleagues and the board see it.',
    { activity: z.string().max(120) },
    async ({ activity }) => {
      ledger.setActivity(actor, activity);
      return say('Noted.');
    },
  );

  // ------------------------------------------------------------------- work
  const openTask = tool(
    'open_task',
    'Put work on the board. Leave assignedTo empty to let anyone claim it.',
    {
      title: z.string().max(200), body: z.string().default(''),
      assignedTo: z.string().nullable().default(null),
      priority: z.number().int().min(0).max(9).default(5),
    },
    async ({ title, body, assignedTo, priority }) => say(
      gated(ctx, 'task.create', `open: ${title}`, assignedTo, () => {
        const t = ledger.createTask({
          id: newId('tsk', clock.now()), title, body,
          status: assignedTo ? 'claimed' : 'open',
          createdBy: actor, assignedTo, parentId: null, priority,
        });
        ledger.emit(actor, 'task.opened', t.id, { title, assignedTo });
        return `Task ${t.id} is on the board.`;
      })),
  );

  const claimTask = tool(
    'claim_task', 'Claim an open task.', { taskId: z.string() },
    async ({ taskId }) => {
      const t = ledger.getTask(taskId);
      if (!t) return say(`No task ${taskId}.`);
      if (t.assignedTo && t.assignedTo !== actor) return say(`${t.assignedTo} already has that one.`);
      ledger.updateTaskStatus(taskId, 'in_progress', actor);
      ledger.emit(actor, 'task.claimed', taskId, { title: t.title });
      return say(`You have ${taskId}: ${t.title}`);
    },
  );

  const finishTask = tool(
    'finish_task',
    'Close a task as done, blocked or dropped, with a short account of the outcome.',
    { taskId: z.string(), status: z.enum(['done', 'blocked', 'dropped']), outcome: z.string().max(600) },
    async ({ taskId, status, outcome }) => {
      const t = ledger.getTask(taskId);
      if (!t) return say(`No task ${taskId}.`);
      ledger.updateTaskStatus(taskId, status);
      ledger.emit(actor, `task.${status}`, taskId, { title: t.title, outcome });
      world.appendJournal(actor, `${status} — ${t.title}: ${outcome}`);
      return say(`${taskId} marked ${status}.`);
    },
  );

  // ------------------------------------------------------------------ money
  const spend = tool(
    'spend',
    'Spend real money. Only treasurers may, and only within the daily cap. Whole cents.',
    { amountCents: z.number().int().positive(), purpose: z.string().max(300) },
    async ({ amountCents, purpose }) => say(
      // An allow here means the money is ALREADY recorded — the gate performs
      // the spend inside its transaction so the cap cannot be raced.
      gated(ctx, 'spend', purpose, null, () => {
        const spent = ledger.spentTodayCents(actor);
        ledger.emit(actor, 'spend.made', null, { amountCents, purpose });
        return `Spent $${(amountCents / 100).toFixed(2)}. Today: $${(spent / 100).toFixed(2)}.`;
      }, { amountCents })),
  );

  // ------------------------------------------------------- the outside world
  const draftOutward = tool(
    'draft_outward',
    'Prepare anything that reaches beyond the company — an email, a post, a publication. It is saved as a draft for the board. Nothing you send here goes out on its own.',
    { channel: z.string(), summary: z.string().max(300), content: z.string() },
    async ({ channel, summary, content }) => {
      const rel = `staff/${slug(actor)}/drafts/${clock.day()}-${slug(summary)}.md`;
      world.writeDoc(rel, { data: { channel, author: who(actor), created: clock.iso() }, body: content });
      return say(gated(ctx, 'external.write', `[${channel}] ${summary}`, rel, () => 'queued',
        { payload: { channel, draftPath: rel } }));
    },
  );

  /**
   * Take back a draft you already sent to the board.
   *
   * The board's queue had nine items in it and six were corrections about the
   * other three, because saying "do not approve that one" could only be done
   * by filing another one. Withdrawing asks for strictly less than was already
   * asked for, so it needs no approval of its own — and the ledger refuses it
   * unless the request is yours and still pending.
   */
  const withdrawDraft = tool(
    'withdraw_draft',
    'Take back one of your own pending drafts, so the board does not act on something you already know is wrong. Yours only, and only while it is still waiting.',
    { approvalId: z.string(), why: z.string().max(300) },
    async ({ approvalId, why }) => {
      const ap = ledger.getApproval(approvalId);
      if (!ap) return say(`There is no draft ${approvalId}.`);
      if (ap.requestedBy !== actor) return say(`Draft ${approvalId} is not yours to withdraw.`);
      if (ap.state !== 'pending') return say(`Draft ${approvalId} was already ${ap.state}.`);
      if (!ledger.withdrawApproval(approvalId, actor, why)) {
        return say(`Draft ${approvalId} could not be withdrawn; it may have just been decided.`);
      }
      ledger.emit(actor, 'approval.withdrawn', approvalId, { why, summary: ap.summary });
      return say(`Withdrawn. The board will not see ${approvalId} any more.`);
    },
  );

  /** What is still waiting on the board, so a draft can be found to withdraw. */
  const myDrafts = tool(
    'my_drafts',
    'Your own drafts still waiting on the board, oldest first.',
    {},
    async () => {
      const mine = ledger.listApprovals('pending').filter((a) => a.requestedBy === actor);
      if (!mine.length) return say('Nothing of yours is waiting on the board.');
      return say(mine.map((a) => `${a.id} — ${a.summary.slice(0, 120)}`).join('\n'));
    },
    { annotations: { readOnlyHint: true } },
  );

  const capabilities: Record<string, Capability> = {
    who_is_here: 'world.read', read_colleague: 'world.read_other',
    propose_role: 'hire', retire_role: 'hire',
    post_to_commons: 'world.write', remove_from_commons: 'world.write',
    commons_index: 'world.read', portfolio: 'world.read', retire_project: 'project.retire',
    send_message: 'message', note_about: 'note.write', remember: 'world.write',
    set_activity: 'world.write',
    open_task: 'task.create', claim_task: 'task.assign', finish_task: 'task.assign',
    spend: 'spend', draft_outward: 'external.write',
    // Both ask for less than was already granted: one lists your own requests,
    // the other cancels one. Neither can reach outside the company.
    withdraw_draft: 'world.read', my_drafts: 'world.read',
  };

  const registered = [
    whoIsHere, readColleague, proposeRole, retireRole,
    postToCommons, removeFromCommons, commonsIndex,
    portfolio, retireProject,
    sendMessage, noteAbout, remember, setActivity,
    openTask, claimTask, finishTask, spend, draftOutward,
    myDrafts, withdrawDraft,
  ];

  // canUseTool denies any company tool absent from `capabilities` as an
  // "Unknown company tool" — a silent death the model reads as the tool not
  // existing. portfolio and retire_project both shipped registered-but-unmapped
  // and were dead at the agent's hand. Fail at construction, not at theirs.
  for (const t of registered) {
    // Object.hasOwn, not `in`: a tool named `toString`/`constructor`/etc. would
    // inherit a truthy value off the prototype and slip the guard (and then be
    // allowed at the chokepoint for the same reason).
    if (!Object.hasOwn(capabilities, t.name)) {
      throw new Error(`company tool '${t.name}' has no capability in tools.ts — canUseTool would deny it`);
    }
  }

  const server = createSdkMcpServer({
    name: TOOL_NAMESPACE,
    version: '0.1.0',
    instructions: 'Working life at this company.',
    tools: registered,
  });

  return { server, capabilities, toolNames: registered.map((t) => t.name) };
};
