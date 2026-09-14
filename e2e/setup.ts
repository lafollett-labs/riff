import { COMPANY } from '../playwright.config.ts';
import { resolveConfig, scaffoldConfig, type RiffConfig } from '../src/core/config.ts';
import { found } from '../src/company/genesis.ts';
import { fillSeat } from '../src/company/hire.ts';
import { World } from '../src/worldfs/world.ts';
import { systemClock } from '../src/core/clock.ts';

/**
 * Build a company with something in every surface the Desk renders. A view
 * that is only ever tested empty passes forever and shows nothing.
 */
export default async function globalSetup(): Promise<void> {
  Object.assign(process.env, COMPANY);

  const cfg: RiffConfig = resolveConfig();
  scaffoldConfig(cfg);
  const { ledger, transcript } = found(cfg, systemClock);
  const world = new World(cfg.worldDir, systemClock);

  fillSeat(ledger, world, systemClock, {
    name: 'Fen', tier: 'lead', role: 'Head of Proof', department: 'assurance',
    reportsTo: cfg.ceo.id, proposedBy: cfg.ceo.id,
    mandate: 'Find out whether the thing we say happened actually happened.',
  });

  // A seat that exists to be closed. Retiring is destructive and irreversible
  // from the console, so the test that proves the control works cannot spend
  // Fen — every view after it still expects to find her.
  fillSeat(ledger, world, systemClock, {
    name: 'Wick', tier: 'member', role: 'Ledger clerk', department: 'assurance',
    reportsTo: 'fen', proposedBy: cfg.ceo.id,
    mandate: 'Hold a seat that a later test closes.',
  });

  world.writeCommons('doctrine/what-we-are-for.md',
    { title: 'What we are for', author: cfg.ceo.id, updated: systemClock.iso() },
    '# What we are for\n\nOne claim, **testable**, or it does not go in here.\n\n- Evidence over recollection\n- Removal is a first-class act\n');

  // The path an agent gets wrong: a prefix the tool used to prepend twice.
  world.writeCommons('commons/records/scores.md',
    { title: 'Scores, including ours', author: 'fen', updated: systemClock.iso() },
    '# Scores\n\n| subject | score |\n| - | - |\n| us | 5/24 |\n');

  // Work in three states, so the Work view is not only ever tested empty.
  const t1 = ledger.createTask({
    id: 'tsk_open', title: 'Score a system we do not own', body: 'Track B, from published artifacts.',
    status: 'open', createdBy: cfg.ceo.id, assignedTo: 'fen', parentId: null, priority: 2,
  });
  ledger.createTask({
    id: 'tsk_done', title: 'Write the removal criterion before anyone needs it',
    body: 'Done.', status: 'open', createdBy: cfg.ceo.id, assignedTo: cfg.ceo.id, parentId: null, priority: 1,
  });
  ledger.updateTaskStatus('tsk_done', 'done');
  ledger.createTask({
    id: 'tsk_gone', title: 'Grade ourselves under v0.1 again',
    body: 'Dropped: the grader would have been the author.',
    status: 'open', createdBy: cfg.ceo.id, assignedTo: null, parentId: null, priority: 0,
  });
  ledger.updateTaskStatus('tsk_gone', 'dropped');
  void t1;

  // Mail addressed to the chair. Agents write to the board constantly and
  // there was nowhere to read it, so this must never be tested empty.
  ledger.sendMessage('fen', cfg.board[0]!.id,
    '# The noise floor is real\n\nSix probes disagree with twelve on the same subject.'
    + ' I would rather you heard it from me than found it in the log.');
  ledger.sendMessage(cfg.ceo.id, cfg.board[0]!.id,
    'Second report. **Nothing needs you yet** — this is so you can see it coming.');
  // A broadcast, so the "to everyone" label exists to be mis-clicked.
  ledger.sendMessage('fen', null, 'Posted to the whole company, not only the board.');
  // Staff mail the board never sees. This is the bulk of a real company's
  // traffic, and the whole-company view was being proved against a message an
  // earlier test happened to have sent — which passes for the wrong reason.
  ledger.sendMessage(cfg.ceo.id, 'fen',
    'Between us: hold the pricing page until the floor is published.');
  // Enough to page. Real inboxes fill up fast — twenty-six messages at three
  // thousand characters each is ninety thousand characters of scroll if they
  // all render at once.
  for (let i = 1; i <= 16; i++) {
    ledger.sendMessage('fen', cfg.board[0]!.id, `Routine report ${i}.\n\nNothing needs you.`);
  }

  // The machinery, in the proportion a real company produces it: a permission
  // check for roughly every message, plus the waking heartbeat. The feed hides
  // these by default, and a fixture without them cannot show that it does.
  for (let i = 1; i <= 20; i++) {
    ledger.emit('fen', 'gate.allow', 'world.write', { summary: `check ${i}` });
  }
  // The scheduler's own lifecycle. Without a stretch of it the company reports
  // zero running hours, every per-hour rate divides by nothing, and the report
  // is proved only against a company that never worked.
  ledger.emit('company', 'work.started', null, {});
  ledger.emit('fen', 'agent.woke', null, {});
  ledger.emit('fen', 'memory.consolidated', 'fen', {});
  // The turns and the dollars of a shift are written down here and nowhere
  // else, so a fixture that sleeps with an empty payload proves the Vitals
  // view against a company that apparently costs nothing to run.
  //
  // The meter is the other half: on a subscription the dollars are imputed
  // list price and nobody is billed them, so a fixture without tokens or a
  // rate-limit reading proves the report against the one figure that is not
  // real. This shift also carries the window it ran into.
  ledger.emit('fen', 'agent.slept', null, {
    turns: 9, costUsd: 0.42, ceiling: 30,
    tokens: 1_240_000, tokensIn: 40_000, tokensOut: 200_000,
    cacheRead: 900_000, cacheWrite: 100_000,
    utilization: 0.84, limitType: 'five_hour', weekUtilization: 0.78,
    used_five_hour: 0.84, used_seven_day: 0.78,
  });
  // A shift that woke, spent and left nothing behind. Barren shifts are the
  // expensive failure the report exists to name, and one has to exist.
  ledger.emit(cfg.ceo.id, 'agent.woke', null, {});
  // It carries the window readings even though it produced nothing: spending
  // the plan and leaving nothing behind is what a barren shift IS, and the
  // console reads the last shift's meter when no scheduler is running.
  ledger.emit(cfg.ceo.id, 'agent.slept', null, {
    turns: 2, costUsd: 0.18, ceiling: 30,
    used_five_hour: 0.84, used_seven_day: 0.78,
    resets_five_hour: Math.round(Date.now() / 1000) + 45 * 60,
  });
  // A rule that bit. Without one, the table of refusals renders empty and
  // proves only that it can render nothing.
  ledger.emit('fen', 'gate.deny', 'commons/overflow.md',
    { rule: 'R6.commons_full', capability: 'world.write', reason: 'the commons is full' });
  // And one that is neither routine nor a message — the feed must keep it.
  ledger.emit('fen', 'commons.posted', 'commons/seams.md', { title: 'Where the seams are' });

  // A draft waiting on the board, so the Envelope has something to render.
  const draftPath = 'staff/fen/drafts/2026-01-01-first-contact.md';
  world.writeDoc(draftPath, {
    data: { title: 'First contact', author: 'fen', updated: systemClock.iso() },
    body: '# First contact\n\nWe would like to run the test on you.\n\n**What it costs you.** An hour.\n\n<script>alert(1)</script>\n',
  });
  ledger.createApproval({
    requestedBy: 'fen', capability: 'external.write', tier: 'board',
    summary: '[email] Asking an outside org to sit a run.',
    target: draftPath,
    payload: { channel: 'email', draftPath },
  });

  // A recorded shift, so the Shift view is proved against a real timeline and
  // summary, not only its empty state. Fen ran it; the mount default (the CEO,
  // staff[0]) has none, so the honest-when-empty test still holds. The blocks
  // are the shape the recorder writes: the wake prompt, reasoning, a word, a
  // tool call and its result, then the closing tally.
  const sid = 'fixture-shift-0001';
  transcript.append({ sessionId: sid, agentId: 'fen', role: 'user', kind: 'text',
    text: 'You have woken up. Score the run and post the floor.' });
  transcript.append({ sessionId: sid, agentId: 'fen', role: 'assistant', kind: 'thinking',
    text: 'The grader must not be the author — read the published artifacts only.', meta: { model: 'claude-opus-4-8' } });
  transcript.append({ sessionId: sid, agentId: 'fen', role: 'assistant', kind: 'text',
    text: 'Scoring the run from published artifacts now.', meta: { model: 'claude-opus-4-8' } });
  transcript.append({ sessionId: sid, agentId: 'fen', role: 'assistant', kind: 'tool_use',
    name: 'Bash', text: JSON.stringify({ command: 'ls artifacts/' }), meta: { model: 'claude-opus-4-8', id: 'tu_1' } });
  transcript.append({ sessionId: sid, agentId: 'fen', role: 'user', kind: 'tool_result',
    name: 'tu_1', text: 'run-01.json\nrun-02.json', meta: { isError: false } });
  transcript.append({ sessionId: sid, agentId: 'fen', role: 'result', kind: 'result',
    text: 'done', meta: { subtype: 'success', turns: 4, costUsd: 0.42 } });

  // A shift longer than one page (the endpoint serves 500 blocks a page), so the
  // console's auto-drain — pulling the rest with no button — is proved to land
  // the whole record, and to survive being switched away from mid-drain. Wick
  // ran it; the block count is deliberately over the page size.
  const long = 'long-shift-0001';
  for (let i = 1; i <= 510; i++) {
    transcript.append({ sessionId: long, agentId: 'wick', role: 'assistant', kind: 'text',
      text: `Reconciling ledger row ${i}.`, meta: { model: 'claude-opus-4-8' } });
  }
  transcript.close();

  ledger.close();
}
