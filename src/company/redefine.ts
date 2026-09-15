/**
 * Redefine an agent after founding — role, mandate, and the persona brief.
 *
 * `mandate` is set once at genesis and `role` at hire, and nothing since could
 * change either: the only post-founding levers were rename (a name) and retire
 * (a departure). So altering what an agent *is* meant editing `persona.md` under
 * a stopped company by hand and committing it in the world repo yourself — which
 * is how Jack was redefined on 2026-09-14. This is that edit as an operation.
 *
 * The system prompt is built from `agent.role` (the ledger) and the persona body
 * (`world.readPersona`), never from `mandate` and never from the charter — so
 * role and persona are the behavioural levers, and mandate is recorded for the
 * board. The persona write is committed in the world here, because a running
 * shift's `git add -A` would otherwise sweep an operator's uncommitted edit into
 * the agent's own next commit and sign it with the agent's name.
 */
import type { Ledger } from '../ledger/ledger.ts';
import type { World } from '../worldfs/world.ts';
import { parse } from '../worldfs/frontmatter.ts';

export type RedefineChanges = { role?: string; mandate?: string; persona?: string };

export type RedefineResult =
  | { ok: true; who: string; name: string; changed: string[] }
  | { ok: false; reason: string };

const ROLE_CAP = 200;
const MANDATE_CAP = 4000;
const PERSONA_CAP = 20_000;

export const redefineAgent = (
  ledger: Ledger, world: World, companyName: string,
  who: string, changes: RedefineChanges, why: string,
): RedefineResult => {
  const reason = why.trim();
  if (!reason) return { ok: false, reason: 'say why' };

  const a = ledger.getAgent(who);
  if (!a) return { ok: false, reason: `no agent '${who}'` };
  // The board is the constitution: its members are defined by the company
  // record (the charter and the board roster in config.json), not by a persona
  // a shift reads. Change that through the company, never here.
  if (a.tier === 'board') return { ok: false, reason: 'the board is defined by the charter, not a persona' };

  const role = changes.role?.trim();
  const mandate = changes.mandate?.trim();
  const persona = changes.persona;
  if (role === undefined && mandate === undefined && persona === undefined) {
    return { ok: false, reason: 'nothing to change — give a role, mandate, or persona' };
  }
  if (role !== undefined && role.length > ROLE_CAP) return { ok: false, reason: `role over ${ROLE_CAP} chars` };
  if (mandate !== undefined && mandate.length > MANDATE_CAP) return { ok: false, reason: `mandate over ${MANDATE_CAP} chars` };
  if (persona !== undefined && persona.length > PERSONA_CAP) return { ok: false, reason: `persona over ${PERSONA_CAP} chars` };

  const roleChanged = role !== undefined && role !== a.role;
  const mandateChanged = mandate !== undefined && mandate !== a.mandate;

  const changed: string[] = [];
  // Role and mandate are ledger columns; write them in one upsert.
  if (roleChanged || mandateChanged) {
    ledger.upsertAgent({ ...a, role: role ?? a.role, mandate: mandate ?? a.mandate });
    if (roleChanged) changed.push('role');
    if (mandateChanged) changed.push('mandate');
  }

  // Persona is the file the shift actually reads. Rewrite it when a new body is
  // given, and keep its frontmatter `role` in step with a role change even when
  // the body is not — the prompt takes role from the ledger, but a file whose
  // header disagrees with the ledger only misleads the next reader.
  const path = world.personaPath(a.id);
  const prior = world.readDoc(path);
  const needWorldWrite = persona !== undefined || (roleChanged && prior !== null);
  if (needWorldWrite) {
    // The operator's body may carry its own frontmatter; prior frontmatter is
    // the default beneath it, and a role change wins over both — so `agent`/
    // `tier` are never lost and the header never drifts from the ledger.
    const incoming = persona !== undefined ? parse(persona) : { data: {}, body: prior?.body ?? '' };
    const data = { ...(prior?.data ?? { agent: a.id, tier: a.tier }), ...incoming.data,
                   ...(roleChanged ? { role: role as string } : {}) };
    const body = incoming.body.endsWith('\n') ? incoming.body : incoming.body + '\n';
    world.writeDoc(path, { data, body });
    // 'persona' means the brief itself changed, not merely that a body was
    // supplied — a role-only edit rewrites the header here but is reported as
    // 'role'. An identical body writes the same bytes, so git records nothing.
    const priorBody = prior?.body ?? '';
    if (persona !== undefined && body !== (priorBody.endsWith('\n') ? priorBody : priorBody + '\n')) {
      changed.push('persona');
    }
  }

  if (changed.length === 0) return { ok: false, reason: 'no change — the values given match what is on file' };

  ledger.emit('board', 'agent.redefined', a.id, { changed, why: reason, by: 'board' });
  world.git.commitAs({ id: 'company', name: companyName },
    `Redefine ${a.name}: ${changed.join(', ')}`);
  return { ok: true, who: a.id, name: a.name, changed };
};
