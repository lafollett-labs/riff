import { fillSeat } from '../company/hire.ts';
import type { Ledger } from '../ledger/ledger.ts';
import type { World } from '../worldfs/world.ts';
import type { Clock } from '../core/clock.ts';

/**
 * Applies approvals that have been said yes to.
 *
 * Deliberately separate from the staff member who asked. An escalation is
 * enacted by the company, after a decision, by code that never ran inside the
 * requester's session — so "get it approved" and "do it" cannot collapse into
 * one step that an agent could drive on its own.
 *
 * Idempotent: each approval is stamped applied in the event log, and already
 * applied ones are skipped.
 */
export const applyApproved = (
  ledger: Ledger, world: World, clock: Clock, connectors: string[] = [],
  release: 'none' | 'bundle' = 'none',
  board: readonly string[] = [],
): number => {
  const approved = ledger.listApprovals('approved');
  let applied = 0;

  for (const ap of approved) {
    if (ledger.getMeta(`applied:${ap.id}`)) continue;

    try {
      switch (ap.capability) {
        case 'hire': {
          const p = JSON.parse(ap.payloadJson ?? '{}') as Record<string, string>;
          if (p['retire']) {
            const gone = ledger.getAgent(p['retire']);
            if (gone) ledger.upsertAgent({ ...gone, status: 'departed' });
            ledger.emit('company', 'role.retired', p['retire'] ?? null, { why: p['why'] });
            applied++;
            break;
          }
          const r = fillSeat(ledger, world, clock, {
            name: p['name'] ?? '', role: p['role'] ?? '',
            tier: (p['tier'] ?? 'member') as 'executive' | 'lead' | 'member',
            department: p['department'] ?? '', mandate: p['mandate'] ?? '',
            reportsTo: p['reportsTo'] ?? ap.requestedBy, proposedBy: ap.requestedBy,
          }, board);
          if (r.ok) applied++;
          else ledger.emit('company', 'approval.apply_failed', ap.id, { reason: r.reason });
          break;
        }

        case 'project.retire': {
          // A retirement the CEO signed. Without this case the approval would
          // hit the default noop below — marked applied, tree never removed —
          // so the project would survive its own sign-off, silently.
          //
          // Name-addressed, like retire_role is id-addressed: we delete whatever
          // occupies projects/<name> now, not a snapshot from sign-off time. If
          // that name were retired and a new project reused it inside the
          // approval window, this would retire the new one. Accepted as a known
          // trade-off — the window is short, the collision needs deliberate name
          // reuse, and matching retire_role keeps the two paths one shape.
          const p = JSON.parse(ap.payloadJson ?? '{}') as { project?: string; why?: string };
          const name = p.project ?? '';
          if (name && world.removeProject(name)) {
            ledger.emit('company', 'project.retired', `projects/${name}`, {
              why: p.why, requestedBy: ap.requestedBy,
            });
            applied++;
          } else {
            // Retired twice, or renamed away before the CEO answered.
            ledger.emit('company', 'approval.apply_failed', ap.id, {
              reason: name ? `no project "${name}" to retire` : 'approval carried no project name',
            });
          }
          break;
        }

        case 'external.write': {
          // Rule 3's landing point. Approval marks the draft RELEASABLE. The
          // connector that would actually send it reads from here — and when
          // none is wired, nothing sends it and the draft stays where it is.
          //
          // The event says which of those happened, because the difference is
          // invisible from inside a session and the company once wrote to a
          // stranger claiming work was public on the strength of an approval.
          const p = JSON.parse(ap.payloadJson ?? '{}') as { channel?: string; draftPath?: string };
          const wired = p.channel != null && connectors.includes(p.channel);
          ledger.emit('company', 'external.released', ap.requestedBy, {
            channel: p.channel, draftPath: p.draftPath, approvalId: ap.id,
            delivered: wired,
            ...(wired ? {} : {
              note: release === 'bundle'
                ? 'approved and releasable — waiting for the board to collect the bundle'
                : 'approved, not sent — no channel is connected',
            }),
          });
          applied++;
          break;
        }

        case 'spend': {
          // An over-cap spend the board allowed as an exception.
          if (ap.amountCents != null) {
            ledger.trySpend({
              agentId: ap.requestedBy, amountCents: ap.amountCents,
              purpose: `[approved exception] ${ap.summary}`,
              capCents: Number.MAX_SAFE_INTEGER, approvalId: ap.id,
            });
            ledger.emit('company', 'spend.exception', ap.requestedBy, {
              amountCents: ap.amountCents, approvalId: ap.id,
            });
            applied++;
          }
          break;
        }

        default:
          ledger.emit('company', 'approval.applied_noop', ap.id, { capability: ap.capability });
      }
      ledger.setMeta(`applied:${ap.id}`, clock.iso());
    } catch (err) {
      ledger.emit('company', 'approval.apply_failed', ap.id, {
        error: err instanceof Error ? err.message : String(err),
      });
      ledger.setMeta(`applied:${ap.id}`, `failed:${clock.iso()}`);
    }
  }
  return applied;
};
