/**
 * Rename an agent, id and all.
 *
 * The id is a foreign key in six tables, and the world keys folders by it, so
 * the two have to move together or neither does. Agents change names — a seat
 * founded as `ceo` becomes a person — and doing it by hand leaves an id nobody
 * answers to scattered through the ledger.
 */
import { renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Ledger } from '../ledger/ledger.ts';
import type { World } from '../worldfs/world.ts';
import { slugId } from '../core/config.ts';

export type RenameResult =
  | { ok: true; from: string; to: string; name: string }
  | { ok: false; reason: string };

export const renameAgent = (
  ledger: Ledger, world: World, companyName: string, oldId: string, newName: string,
): RenameResult => {
  const name = newName.trim();
  if (!oldId.trim()) return { ok: false, reason: 'no agent named' };
  if (!name) return { ok: false, reason: 'a person needs a name' };

  const newId = slugId(name);
  if (!newId) return { ok: false, reason: `'${name}' does not reduce to an id` };

  const agent = ledger.getAgent(oldId);
  if (!agent) return { ok: false, reason: `no agent '${oldId}'` };
  if (oldId !== newId && ledger.getAgent(newId)) return { ok: false, reason: `'${newId}' already exists` };

  const db = ledger.db;
  db.exec('BEGIN IMMEDIATE');
  try {
    // Order matters: insert the new row before repointing anything at it, and
    // drop the old one only once nothing references it.
    db.prepare(
      `INSERT INTO agents(id,name,tier,role,department,reports_to,status,activity,mandate,hired_at,hired_by,model,effort)
       SELECT ?,?,tier,role,department,reports_to,status,activity,mandate,hired_at,hired_by,model,effort
       FROM agents WHERE id=?`
    ).run(newId, name, oldId);

    for (const [table, col] of [
      ['agents', 'reports_to'], ['agents', 'hired_by'],
      ['tasks', 'created_by'], ['tasks', 'assigned_to'],
      ['approvals', 'requested_by'], ['approvals', 'decided_by'],
      ['spend', 'agent_id'], ['messages', 'from_agent'], ['messages', 'to_agent'],
      ['notes_index', 'author'], ['notes_index', 'subject'],
    ] as const) {
      db.prepare(`UPDATE ${table} SET ${col}=? WHERE ${col}=?`).run(newId, oldId);
    }
    // events has no FK, but the log should still read truthfully.
    db.prepare('UPDATE events SET actor=? WHERE actor=?').run(newId, oldId);
    db.prepare('UPDATE events SET subject=? WHERE subject=?').run(newId, oldId);

    // Foreign keys are only half of it. The world keys folders by agent id, so
    // every PATH holding `staff/<id>/` — inside approval payloads, targets, note
    // index rows and event data — points at a folder that no longer exists once
    // the directory moves. These live inside JSON blobs and free-text columns
    // where no constraint can catch them, which is exactly why they rot quietly:
    // an approval whose draftPath is stale looks fine until someone opens it.
    if (oldId !== newId) {
      const from = `staff/${oldId}/`, to = `staff/${newId}/`;
      for (const [table, col] of [
        ['approvals', 'payload_json'], ['approvals', 'target'],
        ['events', 'data_json'], ['events', 'subject'],
        ['notes_index', 'path'],
      ] as const) {
        db.prepare(
          `UPDATE ${table} SET ${col} = replace(${col}, ?, ?) WHERE ${col} LIKE ?`
        ).run(from, to, `%${from}%`);
      }
    }

    if (oldId !== newId) db.prepare('DELETE FROM agents WHERE id=?').run(oldId);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  if (oldId !== newId) {
    const from = join(world.root, 'staff', oldId);
    const to = join(world.root, 'staff', newId);
    if (existsSync(from) && !existsSync(to)) renameSync(from, to);
  }

  ledger.emit('company', 'agent.renamed', newId, { from: oldId, to: newId, name });
  world.git.commitAs({ id: 'company', name: companyName }, `${oldId} is now ${name}`);
  return { ok: true, from: oldId, to: newId, name };
};
