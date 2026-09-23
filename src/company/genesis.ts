import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Ledger } from '../ledger/ledger.ts';
import { TranscriptStore } from '../ledger/transcript.ts';
import { World } from '../worldfs/world.ts';
import { constitutionFor, RULES_TEXT } from '../policy/rules.ts';
import { isCompanyHome, scaffoldConfig, type RiffConfig } from '../core/config.ts';
import { shellIsContained } from '../runtime/permissions.ts';
import { cliConfinement } from '../runtime/staff.ts';
import type { Clock } from '../core/clock.ts';
import { INHERIT } from '../core/models.ts';

/**
 * Found the company.
 *
 * This creates the board and ONE agent: the CEO. There is no roster, no
 * department list, no org chart — those are the CEO's to invent from the
 * company's line of business, and they arrive as proposals the board approves.
 *
 * That is the whole bet. A cast written by me is a simulation of a company; a
 * cast the CEO argues for is the beginning of one.
 */
export const found = (cfg: RiffConfig, clock: Clock): {
  ledger: Ledger; world: World; transcript: TranscriptStore; firstRun: boolean;
} => {
  const firstRun = !existsSync(cfg.ledgerPath);
  scaffoldConfig(cfg);

  // Contained, a project is removed inside the company's own view (see
  // World.removeProject); evaluated then, when the control files exist.
  const world = new World(cfg.worldDir, clock,
    shellIsContained() && isCompanyHome(cfg.home) ? () => cliConfinement(cfg.home) : undefined);
  const ledger = new Ledger(cfg.ledgerPath, clock);
  world.git.onStall = (why) => { ledger.emit('company', 'world.git_stalled', null, { why }); };
  // Beside the ledger, its own file — see TranscriptStore for why not a table.
  const transcript = new TranscriptStore(join(cfg.home, 'transcript.db'), clock);
  world.ensure();

  // ---- the board and the CEO: written ONCE, at founding ----
  //
  // These used to be re-asserted from config.json on every open, which read as
  // self-healing and behaved as overwriting. upsertAgent's ON CONFLICT clause
  // sets activity, status, tier, role and mandate from whatever config says —
  // so a CEO a day into its work had its activity reset to "founding the
  // company" every time the company was opened, and a config whose ceo.id had
  // drifted inserted a second executive rather than correcting anything.
  //
  // The ledger is the record of who works here. config.json is the seed it was
  // grown from, and a seed does not get a vote after the fact.
  /**
   * A line of business used to be two or three words, so the mandate and the
   * CEO's brief both read it into the middle of a sentence. A founder with
   * more to say than that got "a company in We are building tooling for
   * teams who…". Anything longer than a phrase is set out on its own instead.
   */
  const business = cfg.company.business.trim();
  const isPhrase = business !== '' && business.length <= 90 && !business.includes('\n');

  if (firstRun) {
  for (const member of cfg.board) {
    ledger.upsertAgent({
      id: member.id, name: member.name, tier: 'board', role: member.role,
      department: 'board', reportsTo: null, status: 'active',
      activity: '', mandate: 'Terminal authority. Approves what leaves the company.',
      hiredAt: clock.iso(), hiredBy: null, model: 'human', effort: INHERIT,
    });
    world.ensureStaff(member.id);
  }

  // ---- the CEO: the only agent that exists before the company does ----
  const chair = cfg.board[0];
  ledger.upsertAgent({
    id: cfg.ceo.id, name: cfg.ceo.name, tier: 'executive', role: 'CEO',
    department: 'office of the CEO', reportsTo: chair?.id ?? null, status: 'active',
    activity: 'founding the company',
    mandate: `Build ${cfg.company.name} into a company that does real work in ${isPhrase ? business : 'its field'}. ` +
             `Decide what it is for, who it needs, and what it should ship. The board approves; you decide what to ask for.`,
    hiredAt: clock.iso(), hiredBy: chair?.id ?? null, model: INHERIT, effort: INHERIT,
  });
  }

  // A board member added to config after founding never reached the roster,
  // because the block above runs once. The two then disagreed about who is on
  // the board — and since the gate reads standing from config, the missing
  // name was hireable while still carrying board authority. Insert what is
  // absent; never touch a row that exists, which is what the comment above is
  // about.
  for (const member of cfg.board) {
    if (ledger.getAgent(member.id)) continue;
    ledger.upsertAgent({
      id: member.id, name: member.name, tier: 'board', role: member.role,
      department: 'board', reportsTo: null, status: 'active',
      activity: '', mandate: 'Terminal authority. Approves what leaves the company.',
      hiredAt: clock.iso(), hiredBy: null, model: 'human', effort: INHERIT,
    });
  }

  // Directories are not employment records; making one that already exists
  // costs nothing and repairs a world someone copied without it.
  for (const member of cfg.board) world.ensureStaff(member.id);
  world.ensureStaff(cfg.ceo.id);

  const c = constitutionFor({ ceo: cfg.ceo.id, board: cfg.board.map((b) => b.id) });

  if (!world.exists('constitution.md')) {
    world.writeDoc('constitution.md', {
      data: { company: cfg.company.name, enforced: 'in code, not in prose' },
      body: `# ${cfg.company.name}\n\n`
          + (business ? isPhrase
              ? `**Line of business:** ${business}\n\n`
              : `## What the founder set out\n\n${business}\n\n`
            : '')
          + `## The Rules\n\n${RULES_TEXT(c)}\n`,
    });
  }

  // The CEO's opening brief. Deliberately a QUESTION, not a specification —
  // if the founding document told them what to build, nothing would emerge.
  if (!world.exists(`staff/${cfg.ceo.id}/persona.md`)) {
    world.writeDoc(`staff/${cfg.ceo.id}/persona.md`, {
      data: { agent: cfg.ceo.id, tier: 'executive', role: 'CEO' },
      body: [
        `# ${cfg.ceo.name}`,
        '',
        `You are the CEO of **${cfg.company.name}**${isPhrase ? `, a company in ${business}` : ''}.`,
        ...(business && !isPhrase
          ? ['', '## What the founder set out', '', business]
          : []),
        '',
        'You are the only person here. There is no staff, no plan, and no product.',
        'Nobody is going to hand you any of those.',
        '',
        '## What is yours to decide',
        '',
        '- **What this company is for.** Write a vision and a mission and put them in the commons.',
        '  Make them specific enough to be wrong.',
        '- **Who it needs.** Propose roles with real mandates — what each seat owns, and what',
        '  goes undone without it. Vague seats produce vague work.',
        '- **What it should ship first.** Something real, small enough to finish.',
        '',
        '## What is not yours',
        '',
        'Hiring needs the board. Anything reaching the outside world lands as a draft.',
        'Both of those are enforced by the company itself, so do not plan around them.',
        '',
        '## How to think about growth',
        '',
        'Every seat you add is a permanent cost. Every document in the commons is one',
        'somebody must later read. Argue for what earns its place, and say plainly when',
        'something has stopped earning it.',
      ].join('\n'),
    });
  }

  if (firstRun) {
    ledger.emit('company', 'company.founded', null, {
      company: cfg.company.name, business: cfg.company.business,
      board: cfg.board.map((b) => b.id), ceo: cfg.ceo.id,
    });
    world.git.commitAs({ id: 'company', name: cfg.company.name }, `${cfg.company.name} is founded`);
  }
  return { ledger, world, transcript, firstRun };
};
