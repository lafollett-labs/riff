/**
 * The whole vocabulary. Deliberately small.
 *
 * A previous system of ours became unmanageable because agents accrete
 * structure and never remove it — manifests, validation contracts, ADRs
 * amending earlier ADRs. The counter-measure is a substrate with FEW concepts:
 * anything richer belongs in the world as data the staff write and can delete,
 * never as schema they cannot.
 *
 * If this file grows a resolver, a manifest, or a second kind of hierarchy,
 * that is the failure mode returning.
 */

export type AgentId = string;
export type TaskId = string;
export type ApprovalId = string;

/**
 * Authority, and the only thing the gate switches on. FOUR values, forever.
 *
 * Titles are data (below) because every company invents its own; authority is
 * structural because the rules have to mean something. A CEO can run the
 * company and still not sign off on its own related-party transaction — that
 * separation is the entire point, so `board` is terminal and has no override.
 */
export const TIERS = ['board', 'executive', 'lead', 'member'] as const;
export type Tier = (typeof TIERS)[number];

/** Lower binds tighter. Used to test standing, never to name a job. */
export const RANK: Record<Tier, number> = { board: 0, executive: 1, lead: 2, member: 3 };

export type AgentStatus = 'active' | 'idle' | 'departed';

export type Agent = {
  id: AgentId;
  name: string;
  /** Structural authority. */
  tier: Tier;
  /** Free text — "CEO", "Head of Research", "Chairman". The CEO invents these. */
  role: string;
  /** Free text. There is no department registry, on purpose. */
  department: string;
  reportsTo: AgentId | null;
  status: AgentStatus;
  /** What they are doing right now, in their own words. */
  activity: string;
  hiredAt: string;
  hiredBy: AgentId | null;
  /**
   * The model this seat runs on: a model id or alias, `company` to follow the
   * company default, or `human` for a board seat. See src/core/models.ts.
   */
  model: string;
  /** This seat's effort level, or `company` to follow the company default. */
  effort: string;
  /** Why this seat exists. Written by whoever created it; read by the board. */
  mandate: string;
};

// ------------------------------------------------------------------ the gate

export const CAPABILITIES = [
  'world.read',
  'world.read_other',
  'world.write',
  'world.write_other',
  'note.write',
  'task.create',
  'task.assign',
  'message',
  'hire',           // grow or reshape the company
  'project.retire', // delete a project tree — reshaping, so it signs like hire
  'spend',
  'external.read',
  'external.write', // reaches beyond the company — always a draft
  'shell',          // real tools; contained, not forbidden
] as const;
export type Capability = (typeof CAPABILITIES)[number];

export type GateRequest = {
  actor: AgentId;
  capability: Capability;
  target?: string;
  /** Integer cents. Money never touches a float. */
  amountCents?: number;
  summary: string;
  payload?: unknown;
};

export type Decision =
  | { kind: 'allow'; rule: string }
  | { kind: 'deny'; rule: string; reason: string }
  | { kind: 'escalate'; rule: string; tier: ApprovalTier; approvalId: ApprovalId; reason: string };

/** Who must sign. `board` means it waits for a human. */
export type ApprovalTier = 'executive' | 'board';
export type ApprovalState = 'pending' | 'approved' | 'rejected' | 'expired';

export type Approval = {
  id: ApprovalId;
  requestedBy: AgentId;
  capability: Capability;
  tier: ApprovalTier;
  state: ApprovalState;
  summary: string;
  target: string | null;
  amountCents: number | null;
  payloadJson: string | null;
  requestedAt: string;
  decidedBy: AgentId | null;
  decidedAt: string | null;
  decisionReason: string | null;
};

// ---------------------------------------------------------------------- work

export type TaskStatus = 'open' | 'claimed' | 'in_progress' | 'blocked' | 'done' | 'dropped';

export type Task = {
  id: TaskId;
  title: string;
  body: string;
  status: TaskStatus;
  createdBy: AgentId;
  assignedTo: AgentId | null;
  parentId: TaskId | null;
  priority: number;
  createdAt: string;
  updatedAt: string;
};

export type Message = {
  id: string;
  from: AgentId;
  /** Null on a broadcast collapsed for the whole-company view: it went to
   *  everyone, so naming one recipient would be arbitrary. */
  to: AgentId | null;
  /**
   * The rest of the recipients, when one message was addressed to several
   * people by name. Empty for ordinary mail and for a broadcast, which went
   * to everybody and names nobody.
   */
  alsoTo: AgentId[];
  /**
   * Whether this message reached the person reading it. Read state belongs to
   * a recipient, so a colleague's mail to a third party has none that means
   * anything to you — but your own does, whichever view you are looking at.
   */
  yours: boolean;
  body: string;
  broadcast: boolean;
  sentAt: string;
  readAt: string | null;
};

/** Append-only. Everything that happened, in order. */
export type Event = {
  id: string;
  seq: number;
  at: string;
  actor: AgentId;
  kind: string;
  subject: string | null;
  dataJson: string | null;
};

export type SpendRecord = {
  id: string;
  agentId: AgentId;
  amountCents: number;
  purpose: string;
  approvalId: ApprovalId | null;
  at: string;
};
