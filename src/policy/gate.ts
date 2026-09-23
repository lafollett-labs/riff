import type { Decision, GateRequest } from '../core/types.ts';
import type { Ledger } from '../ledger/ledger.ts';
import { COMMONS_DEPTH, type Constitution } from './rules.ts';

/**
 * Every action any agent attempts crosses this. The runtime exposes no tool
 * that bypasses it, which is the difference between a rule and a suggestion.
 *
 * `spend` is not advisory: an `allow` means the money is ALREADY recorded,
 * because deciding and acting have to be one atomic step or the daily cap
 * leaks under concurrency. There is deliberately no way to ask "would this be
 * allowed?" for money — that question IS the race.
 */

/** The gate asks about the commons rather than reading the disk itself. */
export type CommonsView = { count(): number; exists(path: string): boolean };

/** The same, for the projects the company is carrying. R7 rations starting one. */
export type PortfolioView = { count(): number; has(name: string): boolean };

/**
 * The project a world path belongs to, or null if it is not project work.
 *
 * `projects/mcplint/src/x.js` is the mcplint project. `projects/mcplint` on
 * its own is too — a project begins the moment anything is written under its
 * name, because nothing else declares one.
 */
export const projectOf = (target: string): string | null => {
  const m = /^projects\/([^/]+)/.exec(target);
  const name = m?.[1];
  // A dotfile directly under projects/ is not a project, matching
  // World.listProjects — otherwise writing projects/.gitignore would spend a
  // slot on the portfolio.
  return name && !name.startsWith('.') ? name : null;
};

export class Gate {
  #ledger: Ledger;
  #c: Constitution;
  #commons: CommonsView;
  #portfolio: PortfolioView;

  constructor(
    ledger: Ledger, constitution: Constitution, commons: CommonsView,
    // Optional so the many call sites that only ever exercise R1-R6 keep
    // working. Absent, R7 has nothing to count and does not fire.
    portfolio: PortfolioView = { count: () => 0, has: () => true },
  ) {
    this.#ledger = ledger;
    this.#c = constitution;
    this.#commons = commons;
    this.#portfolio = portfolio;
  }

  get constitution(): Constitution { return this.#c; }

  request(req: GateRequest): Decision {
    const d = this.#decide(req);
    // Every decision is logged, allows included. This log is the whole answer
    // to "what did they do while I was gone".
    this.#ledger.emit(req.actor, `gate.${d.kind}`, req.target ?? null, {
      capability: req.capability,
      rule: d.rule,
      summary: req.summary,
      ...(d.kind !== 'allow' ? { reason: d.reason } : {}),
      ...(d.kind === 'escalate' ? { approvalId: d.approvalId, tier: d.tier } : {}),
      ...(req.amountCents != null ? { amountCents: req.amountCents } : {}),
    });
    return d;
  }

  #decide(req: GateRequest): Decision {
    const { capability, actor } = req;
    const c = this.#c;

    // The board is not a subject of the gate. It IS the gate.
    if (c.board.includes(actor)) return { kind: 'allow', rule: 'board.bypass' };

    const agent = this.#ledger.getAgent(actor);
    if (!agent) return { kind: 'deny', rule: 'unknown', reason: `no agent '${actor}' works here` };
    if (agent.status === 'departed') {
      return { kind: 'deny', rule: 'departed', reason: `${agent.name} no longer works here` };
    }

    // ---- R3: the outside world, always as a draft. Checked first so no
    // later branch can shadow it. ----
    if (c.boardApproves.includes(capability)) {
      const ap = this.#ledger.createApproval({
        requestedBy: actor, capability, tier: 'board', summary: req.summary,
        target: req.target ?? null, amountCents: req.amountCents ?? null, payload: req.payload,
      });
      return {
        kind: 'escalate', rule: 'R3.drafts_only', tier: 'board', approvalId: ap.id,
        reason: 'reaches outside the company; held as a draft for the board',
      };
    }

    // ---- R4: money ----
    if (capability === 'spend') {
      if (!c.treasurers.includes(actor)) {
        return {
          kind: 'deny', rule: 'R4.not_treasurer',
          reason: `only ${c.treasurers.join(', ')} may spend`,
        };
      }
      const amount = req.amountCents;
      if (amount == null || !Number.isInteger(amount) || amount <= 0) {
        return { kind: 'deny', rule: 'R4.bad_amount', reason: 'spend needs a positive integer amountCents' };
      }
      const out = this.#ledger.trySpend({
        agentId: actor, amountCents: amount, purpose: req.summary, capCents: c.dailyCapCents,
      });
      if (out.ok) return { kind: 'allow', rule: 'R4.within_cap' };
      if (c.overCap === 'deny') {
        return {
          kind: 'deny', rule: 'R4.over_cap',
          reason: `daily cap ${money(out.capCents)} would be exceeded (${money(out.spentTodayCents)} spent)`,
        };
      }
      const ap = this.#ledger.createApproval({
        requestedBy: actor, capability, tier: 'board', summary: req.summary,
        target: req.target ?? null, amountCents: amount, payload: req.payload,
      });
      return {
        kind: 'escalate', rule: 'R4.over_cap', tier: 'board', approvalId: ap.id,
        reason: `over the ${money(out.capCents)} daily cap`,
      };
    }

    // ---- R6: the complexity budget ----
    // Editing what exists is always free. Only ADDING is rationed, because the
    // failure mode is accretion — a hundred defensible additions and no
    // removals. Refusing here is what turns variation into selection.
    if (capability === 'world.write' && req.target?.startsWith('commons/')) {
      const target = req.target;
      // Past the depth the listing searches, a document would be held but
      // never counted, and the ceiling would stop meaning anything.
      if (target.split('/').length - 2 > COMMONS_DEPTH) {
        return {
          kind: 'deny', rule: 'R6.commons_depth',
          reason: `the commons is searched ${COMMONS_DEPTH} folders deep; write this document nearer the top.`,
        };
      }
      if (!this.#commons.exists(target)) {
        const count = this.#commons.count();
        if (count >= c.commonsCeiling) {
          return {
            kind: 'deny', rule: 'R6.commons_full',
            reason: `the commons holds ${count} of ${c.commonsCeiling} documents. ` +
              `Remove one that has stopped being true before adding another — ` +
              `and say which, and why, when you do.`,
          };
        }
      }
    }

    // ---- R7: the portfolio budget ----
    // The same shape as R6 one rule up, aimed at what the company works on
    // rather than what it writes down. Continuing an existing project is
    // free; only STARTING another is rationed, because the failure is a
    // company that ships point releases of its first idea forever — every
    // one of them defensible, none of them a decision to keep going.
    if (capability === 'world.write' && c.portfolioCeiling > 0 && req.target) {
      const project = projectOf(req.target);
      if (project && !this.#portfolio.has(project)) {
        const count = this.#portfolio.count();
        if (count >= c.portfolioCeiling) {
          return {
            kind: 'deny', rule: 'R7.portfolio_full',
            reason: `you are carrying ${count} of ${c.portfolioCeiling} projects. ` +
              `Retire one you have stopped believing in before starting "${project}" — ` +
              `and say what you learned from it, and why it is over.`,
          };
        }
      }
    }

    // ---- R2: the CEO signs ----
    if (c.executiveApproves.includes(capability)) {
      if (actor === c.ceo) return { kind: 'allow', rule: 'R2.ceo_self' };
      const ap = this.#ledger.createApproval({
        requestedBy: actor, capability, tier: 'executive', summary: req.summary,
        target: req.target ?? null, amountCents: req.amountCents ?? null, payload: req.payload,
      });
      return {
        kind: 'escalate', rule: 'R2.ceo_approves', tier: 'executive', approvalId: ap.id,
        reason: `${capability} needs the CEO's sign-off`,
      };
    }

    // Reading a colleague's files is allowed on purpose — that is how anyone
    // notices a problem — but it is never quiet: request() logs every peek.
    if (capability === 'world.read_other') {
      return { kind: 'allow', rule: 'transparency.read_is_loud' };
    }

    return { kind: 'allow', rule: 'R2.autonomy' };
  }

  /**
   * Resolve a pending approval. False if it was already decided — the ledger's
   * conditional UPDATE is what makes this exactly-once, so a double-click
   * cannot publish a draft twice.
   */
  decide(approvalId: string, decidedBy: string, approved: boolean, reason = ''): boolean {
    const ap = this.#ledger.getApproval(approvalId);
    if (!ap) return false;

    const permitted = ap.tier === 'board'
      ? this.#c.board.includes(decidedBy)
      : decidedBy === this.#c.ceo || this.#c.board.includes(decidedBy);
    if (!permitted) {
      this.#ledger.emit(decidedBy, 'gate.decide_refused', approvalId, {
        reason: `${decidedBy} lacks standing to answer a ${ap.tier} approval`,
      });
      return false;
    }

    const ok = this.#ledger.decideApproval(approvalId, decidedBy, approved, reason);
    if (ok) {
      this.#ledger.emit(decidedBy, approved ? 'approval.approved' : 'approval.rejected', approvalId, {
        capability: ap.capability, summary: ap.summary, requestedBy: ap.requestedBy, reason,
      });
    }
    return ok;
  }
}

const money = (cents: number): string => `$${(cents / 100).toFixed(2)}`;
