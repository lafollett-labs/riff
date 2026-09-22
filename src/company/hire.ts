import { slug } from '../core/ids.ts';
import type { Ledger } from '../ledger/ledger.ts';
import type { World } from '../worldfs/world.ts';
import type { Clock } from '../core/clock.ts';
import type { Tier } from '../core/types.ts';
import { INHERIT } from '../core/models.ts';

export type SeatSpec = {
  name: string;
  role: string;
  tier: Tier;
  department?: string;
  mandate?: string;
  reportsTo?: string;
  proposedBy: string;
};

export type SeatResult =
  | { ok: true; id: string; redirected: boolean }
  | { ok: false; reason: string };

/**
 * Fill a seat. THE one implementation.
 *
 * There are two paths into hiring — the CEO's own request, which the gate
 * allows outright, and everyone else's, which the executor applies after
 * approval. Previously only the second path created anything, so a seat the
 * CEO proposed was accepted, logged as allowed, and silently dropped. Two code
 * paths for one act is how that happens; this is the fix.
 */
export const fillSeat = (
  ledger: Ledger, world: World, clock: Clock, spec: SeatSpec,
  board: readonly string[] = [],
): SeatResult => {
  if (!spec.name || !spec.role) return { ok: false, reason: 'a seat needs a name and a role' };

  const id = slug(spec.name);
  if (ledger.getAgent(id)) return { ok: false, reason: `${id} already works here` };
  // A board member the roster has never seen is still a board member: the gate
  // reads standing from the constitution, not from this table. A company whose
  // board gained a name after founding had that name hired as a lead, and the
  // seat then carried board standing on every approval it touched.
  if (board.includes(id)) {
    return { ok: false, reason: `${id} is on the board — pick a name no board member answers to` };
  }

  // The board governs; it does not manage. Only the CEO reports to it, and the
  // independence a board reporting line appears to buy is already structural:
  // the commons, notes and event log are visible to the board regardless.
  const proposedBoss = spec.reportsTo ?? spec.proposedBy;
  const boss = ledger.getAgent(proposedBoss);
  const redirected = boss?.tier === 'board';
  const reportsTo = redirected ? spec.proposedBy : proposedBoss;

  ledger.upsertAgent({
    id, name: spec.name, tier: spec.tier, role: spec.role,
    department: spec.department ?? '', reportsTo, status: 'active',
    activity: 'just arrived', mandate: spec.mandate ?? '',
    hiredAt: clock.iso(), hiredBy: spec.proposedBy, model: INHERIT, effort: INHERIT,
  });
  world.ensureStaff(id);

  if (!world.exists(world.personaPath(id))) {
    world.writeDoc(world.personaPath(id), {
      data: { agent: id, tier: spec.tier, role: spec.role, hired_by: spec.proposedBy },
      body: [
        `# ${spec.name}`, '', `**${spec.role}**${spec.department ? ` · ${spec.department}` : ''}`, '',
        '## Your mandate', '', spec.mandate ?? '(none recorded — ask whoever hired you what this seat is for.)', '',
        '## How to work here', '',
        '- Your quarters are `staff/' + id + '/`. Write freely there.',
        '- `commons/` is shared ground with a hard ceiling. Adding past it means removing something.',
        '- You may read colleagues\' briefs and memory. They can see that you did.',
        '- Prefer finishing one real thing over starting three.',
      ].join('\n'),
    });
  }

  if (redirected) {
    ledger.emit('company', 'org.reporting_redirected', id, {
      proposed: proposedBoss, actual: reportsTo,
      why: 'the board governs rather than manages; only the CEO reports to it',
    });
  }
  ledger.emit('company', 'role.filled', id, {
    by: spec.proposedBy, role: spec.role, tier: spec.tier, reportsTo,
  });
  return { ok: true, id, redirected };
};
