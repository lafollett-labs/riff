import type { AgentId, Capability } from '../core/types.ts';

/**
 * How many folders below commons/ a document may sit. ShipIt's deepest after
 * three weeks is one. The listing stops here, so a shift cannot make it — and
 * every count taken from it — as expensive as it likes; the gate refuses a
 * write past it, so what the tools write and what the ceiling counts agree.
 */
export const COMMONS_DEPTH = 8;

/**
 * The company's constitution.
 *
 * Seven rules — R7 only when a portfolio ceiling is set. The enforced ones
 * (R2, R3, R4, R6, and R7 when on) live here and in the gate; R1 and R5 are
 * deliberately not, because they are dispositions rather than permissions and
 * pretending otherwise would be theatre.
 */
export type Constitution = {
  /** R4: the only seats that may touch money. Everyone else is refused. */
  treasurers: AgentId[];
  /** R4: per-treasurer, per-day ceiling, integer cents. */
  dailyCapCents: number;
  /** R4: past the ceiling — ask the board, or refuse outright. */
  overCap: 'escalate' | 'deny';

  /** R2: what a lead may not self-authorise. The executive tier signs. */
  executiveApproves: Capability[];
  /** R3: what nobody but the board may authorise. No override exists. */
  boardApproves: Capability[];

  /** The primary agent. Receives R2 escalations, runs the company. */
  ceo: AgentId;
  /** Humans. Terminal authority; they bypass the gate because they ARE it. */
  board: AgentId[];

  /**
   * R6 — the complexity budget.
   *
   * The commons may hold this many documents. Past it, adding one requires
   * removing one.
   *
   * This is the load-bearing rule and the reason it exists is empirical: a
   * previous system of ours became unmanageable because agents accrete
   * structure and never remove any. Each addition is individually defensible;
   * together they are sediment. A human team simplifies because complexity
   * hurts them daily — agents feel nothing, so the pressure has to be
   * structural. Variation without selection is not emergence, it is a pile.
   */
  commonsCeiling: number;

  /**
   * R7 — the portfolio budget.
   *
   * The company may carry this many projects. Past it, starting one requires
   * retiring one. 0 disables the rule.
   *
   * R6 rations what the company writes down and nothing rationed what it
   * works on, which is the accretion that actually costs: a company shipped
   * sixteen point releases of the first idea it had, because continuing is
   * always cheaper than starting and no shift was ever given a reason to ask
   * whether the project should still exist. Variation without selection is a
   * pile — and R6 was selecting on the wrong thing.
   */
  portfolioCeiling: number;
};

export const constitutionFor = (opts: {
  ceo: AgentId;
  board: AgentId[];
  treasurers?: AgentId[];
  dailyCapCents?: number;
  commonsCeiling?: number;
  portfolioCeiling?: number;
}): Constitution => ({
  ceo: opts.ceo,
  board: opts.board,
  treasurers: opts.treasurers ?? [opts.ceo],
  dailyCapCents: opts.dailyCapCents ?? 500,
  overCap: 'escalate',
  // Retiring a project deletes its whole tree and frees an R7 slot. It is as
  // consequential as retiring a seat, so it signs the same way — retire_role
  // already routes through 'hire'; retire_project routes through this.
  executiveApproves: ['hire', 'project.retire', 'world.write_other'],
  // R3 has exactly one member and no configuration to loosen it. The moment
  // there is a bypass, something will eventually find a reason to use it.
  boardApproves: ['external.write'],
  commonsCeiling: opts.commonsCeiling ?? 40,
  portfolioCeiling: opts.portfolioCeiling ?? 3,
});

/** Rendered into every agent's prompt, so the rules are stated once. */
export const RULES_TEXT = (c: Constitution): string => [
  '1. Work well together.',
  '2. Work however you see fit inside your mandate — the CEO approves what needs approving.',
  '3. You may take work all the way to the outside world, but it always lands as a draft.',
  '   Nothing leaves this company without the board.',
  `4. Only ${c.treasurers.join(', ')} may spend, up to $${(c.dailyCapCents / 100).toFixed(2)} a day.`,
  '5. If the board is not around, do not stop.',
  `6. The commons holds ${c.commonsCeiling} documents. To add one past that, remove one.`,
  '   Decide what stops being true, not just what starts being true.',
  ...(c.portfolioCeiling > 0 ? [
    `7. You may carry ${c.portfolioCeiling} project${c.portfolioCeiling === 1 ? '' : 's'} at once. ` +
      'To start another, retire one.',
    '   Retiring is a decision, not a defeat. Something you have stopped',
    '   believing in is costing you the thing you would rather be doing.',
  ] : []),
  '',
  `Rules 2, 3, 4${c.portfolioCeiling > 0 ? ', 6 and 7' : ' and 6'} are enforced by the company itself, ` +
    'not by your good intentions.',
  'Rules 1 and 5 are yours to keep. Nothing checks them but each other.',
].join('\n');
