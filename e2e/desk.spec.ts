import { test, expect, type Page } from '@playwright/test';

/**
 * The Desk exists because the work was unreachable. So every assertion here
 * is about reaching something — a draft you can read in full, a document
 * under its own title, a report line, a reason that lands on the author.
 * A screenshot proves the pixels arrived; these prove the content did.
 */

// `heading` differs from the view name only for Overview, whose title is the
// company's own name — a company's front page is not called "Overview".
const go = async (page: Page, view: string, heading = view) => {
  await page.getByRole('button', { name: new RegExp(`^${view}`) }).click();
  // The view's own heading is the first one. Rendered agent prose contributes
  // headings of its own further down the page.
  await expect(page.locator('main h1').first()).toContainText(new RegExp(heading, 'i'));
};

/**
 * Select a company by name through the switcher. The console remembers the
 * last one across reloads, so tests state which company they mean rather than
 * inheriting whatever the previous test left open.
 */
const useCompany = async (page: Page, name: string) => {
  if ((await page.locator('.co').innerText()).trim() === name) return;
  // The switcher is a toggle, so clicking blind can close a menu a previous
  // step left open. Open it deliberately.
  const menu = page.locator('.menu');
  if (!(await menu.isVisible())) await page.locator('.switcher').click();
  await expect(menu).toBeVisible();
  await menu.locator('.menuitem').filter({ hasText: name }).first().click();
  await expect(page.locator('.co')).toHaveText(name);
};

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.co')).not.toBeEmpty();
  await useCompany(page, 'Testwright Co');
});

test('the rail names the company and counts what is waiting', async ({ page }) => {
  // The name, and nothing else. The line of business was rendered under it
  // while it was three words; it holds the founder's whole brief now.
  await expect(page.locator('.brand .co')).toHaveText('Testwright Co');
  await expect(page.locator('.brand')).not.toContainText('proving the console renders');
  await expect(page.locator('.navitem').filter({ hasText: 'Envelope' }).locator('.pill')).toHaveText('1');
  await expect(page.locator('.status')).toContainText('1 waiting on you');
});

test('the envelope shows the whole draft, not a summary of it', async ({ page }) => {
  const item = page.locator('.item').first();
  // The name a person is called by, not the tool handle.
  await expect(item.locator('.who')).toHaveText('Fen');
  await expect(item.locator('.cap')).toHaveText('external.write');
  // The body of the draft, not just the one-line summary the requester wrote.
  await expect(item.locator('.draft')).toContainText('We would like to run the test on you.');
  await expect(item.locator('.draft strong')).toHaveText('What it costs you.');
});

test('markup written by an agent renders as text, never as markup', async ({ page }) => {
  const draft = page.locator('.item .draft').first();
  await expect(draft).toContainText('<script>alert(1)</script>');
  await expect(draft.locator('script')).toHaveCount(0);
  expect(await page.evaluate(() => document.querySelectorAll('.draft script').length)).toBe(0);
});

test('a decision clears the queue and the reason is kept', async ({ page, request }) => {
  await page.locator('.item textarea').first().fill('Not yet — the claim is not true.');
  await page.getByRole('button', { name: 'Send back' }).click();

  await expect(page.locator('.item')).toHaveCount(0);
  await expect(page.locator('.navitem').filter({ hasText: 'Envelope' }).locator('.pill')).toHaveCount(0);
  await expect(page.locator('.status')).toContainText('0 waiting on you');

  // The reason is the whole point of the gate — a rejection that does not
  // reach the author teaches nobody anything.
  const state = await (await request.get('/api/state')).json();
  expect(state.pendingBoard).toBe(0);

  // And the queue emptying must not take the record with it. A company that
  // had published twice and refused twice showed a blank page here.
  const past = page.locator('.past').first();
  await expect(page.locator('h2')).toContainText('Already decided');
  await expect(past.locator('.verdict')).toHaveText('sent back');
  await expect(past.locator('.summary-line')).toContainText('Asking an outside org to sit a run.');
  await expect(page.locator('.empty')).toContainText('Everything proposed so far is below');

  // The reason, and the draft it was about, are both still reachable.
  await past.locator('.row.open').click();
  await expect(past.locator('.because')).toContainText('Not yet — the claim is not true.');
  await expect(past.locator('.draft')).toContainText('We would like to run the test on you.');
});

test('staff renders the report tree the CEO actually built', async ({ page }) => {
  await go(page, 'Staff');
  const names = await page.locator('.card .name').allTextContents();
  expect(names).toEqual(['Tester', 'Wren', 'Fen', 'Wick']);

  // Depth is the reporting line: chair, then CEO under them, then the lead,
  // then the clerk reporting to the lead.
  const lefts = await page.locator('.row').evaluateAll(
    (rows) => rows.map((r) => Number.parseFloat(getComputedStyle(r).marginLeft)));
  expect(lefts[0]).toBeLessThan(lefts[1]!);
  expect(lefts[1]).toBeLessThan(lefts[2]!);
  expect(lefts[2]).toBeLessThan(lefts[3]!);

  // The role must sit on one line — it wrapped into a column at this width.
  const box = await page.locator('.card .role').first().boundingBox();
  expect(box!.height).toBeLessThan(30);
});

test('opening a colleague shows the persona they were given', async ({ page }) => {
  await go(page, 'Staff');
  await page.locator('.card', { hasText: 'Wren' }).click();
  await expect(page.locator('.detail .persona')).toContainText('Testwright Co');
  await expect(page.locator('.detail .meta')).toContainText('hired');
});

test('a shift can be reviewed agent by agent, and says so honestly when empty', async ({ page }) => {
  await go(page, 'Shift', 'Review a Shift');
  // Staff are picked from a dropdown that scales past a row of buttons; board
  // members are people and run no shifts, so they are not in it.
  await expect(page.locator('#shift-agent option', { hasText: 'Wren' })).toHaveCount(1);
  await expect(page.locator('#shift-agent option', { hasText: 'Tester' })).toHaveCount(0);
  // The mount default (the CEO) has run no shift, so the audit is empty rather
  // than fabricated.
  await expect(page.locator('.feed-status')).toContainText(/No recorded shifts/);
});

test('a recorded shift reads as a timeline, with when it ran and what it ran on', async ({ page }) => {
  await go(page, 'Shift', 'Review a Shift');
  // The mount default (the CEO) has no shift; Fen ran the recorded one.
  await page.selectOption('#shift-agent', 'fen');

  // The summary names when it ran, how big it was, and the model it ran on —
  // and never a dollar figure, because the cost is imputed subscription price.
  const summary = page.locator('.summary');
  await expect(summary).toBeVisible();
  await expect(summary.locator('.facts')).toContainText('Started');
  await expect(summary.locator('.tnum:not(.errfact)')).toHaveText('8');
  await expect(summary.locator('.facts')).toContainText('claude-opus-4-8');
  await expect(summary).not.toContainText('$');

  // The timeline shows the wake prompt, a word from the agent, and the tool it
  // ran — each block stamped with a time.
  await expect(page.locator('.turn.text .prompt')).toContainText('Score the run');
  await expect(page.locator('.turn.text .say')).toContainText('Scoring the run');
  await expect(page.locator('.turn.tool_use .chip').first()).toContainText('Bash');
  await expect(page.locator('.turn .stamp').first()).toBeVisible();

  // The closing tally reports the shift's shape, never its cost.
  await expect(page.locator('.turn.result .tally')).toContainText('success');
  await expect(page.locator('.turn.result .tally')).toContainText('4 turns');
});

test('the reasoning and the tool traffic can be filtered down to the narrative', async ({ page }) => {
  await go(page, 'Shift', 'Review a Shift');
  await page.selectOption('#shift-agent', 'fen');
  await expect(page.locator('.turn.thinking')).toHaveCount(1);
  await expect(page.locator('.turn.tool_use')).toHaveCount(2);

  // Turning a facet off drops that kind of block; the spoken narrative stays.
  await page.getByRole('button', { name: 'Thinking' }).click();
  await expect(page.locator('.turn.thinking')).toHaveCount(0);
  await page.getByRole('button', { name: 'Tools' }).click();
  await expect(page.locator('.turn.tool_use')).toHaveCount(0);
  await expect(page.locator('.turn.tool_result')).toHaveCount(0);
  await expect(page.locator('.turn.text .say')).toContainText('Scoring the run');
});

test('the errors filter surfaces just what went wrong, and its count', async ({ page }) => {
  await go(page, 'Shift', 'Review a Shift');
  await page.selectOption('#shift-agent', 'fen');
  // The summary flags the count; the timeline shows the whole shift by default.
  await expect(page.locator('.summary .errfact')).toHaveText('1');
  await expect(page.locator('.turn')).toHaveCount(8);

  // Turn Errors on → only the refused call and its error result remain, and the
  // narrative/thinking is gone.
  await page.getByRole('button', { name: /^Errors/ }).click();
  await expect(page.locator('.turn')).toHaveCount(2);
  await expect(page.locator('.turn.tool_result')).toHaveCount(1);
  await expect(page.locator('.turn.text')).toHaveCount(0);
  await expect(page.locator('.turn.tool_result')).toContainText('requires board review');
});

test('a shift longer than a page loads in full, with no button to hunt for', async ({ page }) => {
  await go(page, 'Shift', 'Review a Shift');
  // Wick's shift is 510 blocks — past the 500-a-page limit, so the console must
  // drain the rest on its own. Every block lands, and the progress line clears.
  await page.selectOption('#shift-agent', 'wick');
  await expect(page.locator('.summary .tnum')).toHaveText('510');
  await expect(page.locator('.turn')).toHaveCount(510, { timeout: 15000 });
  await expect(page.locator('.feed-status')).not.toContainText('Reading the rest');
});

test('switching staff mid-drain never mixes one shift into another', async ({ page }) => {
  await go(page, 'Shift', 'Review a Shift');
  // Start Wick's long shift draining, then switch to Fen before it can finish.
  await page.selectOption('#shift-agent', 'wick');
  await page.selectOption('#shift-agent', 'fen');
  // Fen's shift is small and complete: exactly its own blocks, no Wick turns
  // stapled on, and not left truncated with the progress line stuck.
  await expect(page.locator('.summary .tnum:not(.errfact)')).toHaveText('8');
  await expect(page.locator('.turn')).toHaveCount(8);
  await expect(page.locator('.turn.text .say')).toContainText('Scoring the run');
  await expect(page.locator('.log')).not.toContainText('Reconciling ledger row');
  await expect(page.locator('.feed-status')).not.toContainText('Reading the rest');
});

test('the commons lists documents under the titles their authors chose', async ({ page }) => {
  await go(page, 'Commons');
  await expect(page.locator('.doc .t')).toHaveText(['What we are for', 'Scores, including ours']);
  await expect(page.locator('.gauge')).toContainText('2/40');
});

test('a commons document opens as prose, with no frontmatter to skim past', async ({ page }) => {
  await go(page, 'Commons');
  await page.locator('.doc', { hasText: 'What we are for' }).click();
  await expect(page.locator('.reader .title')).toHaveText('What we are for');
  await expect(page.locator('.reader .body h2').first()).toHaveText('What we are for');
  await expect(page.locator('.reader .body li')).toHaveCount(2);
  await expect(page.locator('.reader .body')).not.toContainText('author:');
  await expect(page.locator('.reader .body')).not.toContainText('---');
});

test('prose reads as paragraphs, not as one block per source line', async ({ page }) => {
  // The reader carried white-space: pre-wrap from before the markdown pass
  // existed, so the newline BETWEEN two rendered blocks survived as a real
  // blank line — every paragraph sat two lines apart and it read as broken
  // line spacing. Measured, because it looks plausible in a screenshot.
  await go(page, 'Commons');
  await page.locator('.doc', { hasText: 'What we are for' }).click();
  await expect(page.locator('.reader .body p').first()).toBeVisible();

  const metrics = await page.locator('.reader .body').evaluate((el) => {
    const line = Number.parseFloat(getComputedStyle(el).lineHeight);
    const kids = [...el.children];
    const gaps: number[] = [];
    for (let i = 1; i < kids.length; i++) {
      if (kids[i - 1]!.tagName === 'P' && kids[i]!.tagName === 'P') {
        gaps.push(kids[i]!.getBoundingClientRect().top - kids[i - 1]!.getBoundingClientRect().bottom);
      }
    }
    return { line, gaps, preWrap: getComputedStyle(el).whiteSpace };
  });

  expect(metrics.preWrap).not.toMatch(/pre/);
  // A paragraph break should be a fraction of a line, never a whole one.
  for (const gap of metrics.gaps) expect(gap).toBeLessThan(metrics.line);
});

test('a wrapped sentence is one paragraph, not one per source line', async ({ page }) => {
  await go(page, 'Commons');
  await page.locator('.doc', { hasText: 'What we are for' }).click();
  // The fixture writes this as a single line; the real documents wrap at ~80
  // columns, and the renderer must join those back before the CSS sees them.
  // toContainText auto-waits; innerText() would read the loading placeholder.
  await expect(page.locator('.reader .body p').first()).toContainText('testable');
  expect(await page.locator('.reader .body p').count()).toBeLessThan(4);
});

test('a markdown table renders as a table, not a line of pipes', async ({ page }) => {
  // The seats doctrine and every scorecard is a table. The hand-rolled
  // renderer had no table support at all and they came out as run-on prose.
  await go(page, 'Commons');
  await page.locator('.doc', { hasText: 'Scores, including ours' }).click();
  const table = page.locator('.reader .body table');
  await expect(table).toHaveCount(1);
  await expect(table.locator('th')).toHaveText(['subject', 'score']);
  await expect(table.locator('tbody tr')).toHaveCount(1);
  await expect(page.locator('.reader .body')).not.toContainText('|');

  // Wide tables scroll inside their own box; the page never scrolls sideways.
  await expect(page.locator('.reader .body .tablewrap')).toHaveCount(1);
  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test('a doubled commons prefix still resolves to one document', async ({ page }) => {
  // Written as commons/records/scores.md by an author who had already typed
  // the prefix. It must appear once, on the right shelf.
  await go(page, 'Commons');
  const shelves = await page.locator('.doc .shelf').allTextContents();
  expect(shelves).toContain('records');
  expect(shelves.some((s) => s.includes('commons'))).toBe(false);
});

test('work in flight is visible without opening a terminal', async ({ page }) => {
  // status.ts showed tasks, note counts and broken reporting lines, and the
  // console showed none of them — so the briefing had to tell the board to go
  // run a script. A console you have to leave is not finished.
  await go(page, 'Work');
  await expect(page.locator('.task')).toHaveCount(3);
  await expect(page.locator('.wrap h2')).toHaveText(['In flight', 'Dropped on purpose', 'Finished']);

  // Dropped is neither finished nor in flight — for a company whose weakest
  // seam is removal, that distinction is the whole point.
  const dropped = page.locator('.task.gone');
  await expect(dropped).toHaveCount(1);
  await expect(dropped.locator('.title')).toHaveText('Grade ourselves under v0.1 again');
  await expect(page.locator('section', { hasText: 'In flight' }).locator('.task.gone')).toHaveCount(0);

  await expect(page.locator('.tally')).toContainText('1 in flight');
  await expect(page.locator('.tally')).toContainText('1 dropped');
});

test('opening a task shows the body its author wrote', async ({ page }) => {
  await go(page, 'Work');
  await page.locator('.task', { hasText: 'Score a system we do not own' }).locator('header').click();
  await expect(page.locator('.task .detail')).toContainText('Track B, from published artifacts.');
});

test('the record reads the git log, not the event stream', async ({ page }) => {
  await go(page, 'Record');
  await expect(page.locator('.log li').first()).toBeVisible();
  await expect(page.locator('.tally')).toBeVisible();
  await page.getByRole('button', { name: 'A month' }).click();
  await expect(page.locator('.log li').first()).toBeVisible();
});

test('the feed shows what already happened, then keeps up', async ({ page }) => {
  await go(page, 'Feed');
  // The stream carries only what arrives while you watch, so the feed used to
  // open blank however busy the company had been. It seeds from history now.
  const seeded = await page.locator('.feed li').count();
  expect(seeded).toBeGreaterThan(0);
  // And it names people rather than printing their tool handles.
  await expect(page.locator('.feed .actor').first()).not.toHaveText(/^[a-z_]+$/);

  await page.evaluate(async () => {
    await fetch('/api/say', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to: 'fen', text: 'A word from the board.' }),
    });
  });

  await expect(page.locator('.feed')).toContainText('A word from the board.', { timeout: 15_000 });
  expect(await page.locator('.feed li').count()).toBeGreaterThan(seeded);
});

test('the feed shows what changed, and keeps the machinery behind a toggle', async ({ page }) => {
  // Two thirds of a working company's log is permission checks that passed and
  // staff waking up. All true, none of it ever the answer to "what happened
  // while I was out" — and it buried the handful of events that were.
  await go(page, 'Feed');
  await expect(page.locator('.feed li').first()).toBeVisible();

  const kindsOf = () => page.locator('.feed .kind').allInnerTexts();
  const quiet = await kindsOf();
  for (const machinery of ['gate.allow', 'agent.woke', 'agent.slept', 'memory.consolidated']) {
    expect(quiet).not.toContain(machinery);
  }
  expect(quiet).toContain('commons.posted');
  await expect(page.locator('.note')).toContainText('routine events hidden');

  await page.getByRole('button', { name: 'Everything' }).click();
  const loud = await kindsOf();
  expect(loud.length).toBeGreaterThan(quiet.length);
  expect(loud).toContain('gate.allow');
  expect(loud).toContain('agent.woke');
  await expect(page.locator('.note')).toHaveCount(0);

  await page.getByRole('button', { name: 'What changed' }).click();
  await expect(page.locator('.feed .kind').first()).toBeVisible();
  expect((await kindsOf()).length).toBe(quiet.length);
});

test('the commons reads in the order it was written', async ({ page }) => {
  // Listed alphabetically, forty documents give a newcomer no way in — there
  // was nothing on screen saying which came first.
  await go(page, 'Commons');
  await expect(page.locator('.doc').first()).toBeVisible();

  const numbers = await page.locator('.doc .n').allInnerTexts();
  expect(numbers.map(Number)).toEqual(numbers.map((_, i) => i + 1));
  await expect(page.locator('.doc .stamp').first()).toBeVisible();

  // Re-sorting reorders the list but not the numbering — #1 is still the
  // first thing the company wrote, wherever it now sits.
  await page.getByRole('button', { name: 'A–Z' }).click();
  const titles = await page.locator('.doc .t').allInnerTexts();
  expect(titles).toEqual([...titles].sort((a, b) => a.localeCompare(b)));
  const resorted = (await page.locator('.doc .n').allInnerTexts()).map(Number);
  expect([...resorted].sort((a, b) => a - b)).toEqual(numbers.map(Number));

  await page.getByRole('button', { name: 'Order written' }).click();
  await expect(page.locator('.doc .n').first()).toHaveText('1');
});

test('mail addressed to the board is readable, and says so before you look', async ({ page }) => {
  // Agents wrote to the chair from the first hour and the console had no
  // inbox at all — the message existed and the only way in was a SQL query.
  await expect(page).toHaveTitle(/^\(\d+\) The Desk$/);
  await expect(page.locator('.navitem').filter({ hasText: 'Inbox' }).locator('.pill')).toHaveText('19');

  await go(page, 'Inbox');
  // The pill counts unread mail addressed to you. The list is wider than that
  // — it carries what you sent as well — so the total moves with whatever an
  // earlier test wrote, and the unread figure is the one that is fixed.
  await expect(page.locator('.toolbar')).toContainText('19 unread');
  // Opened, the body renders as prose rather than raw markdown.
  await page.getByLabel('Filter messages').fill('noise floor');
  await page.locator('.msg').first().locator('.row').click();
  await expect(page.locator('.msg.open .body h2').first()).toHaveText('The noise floor is real');
});

test('every paged list sorts, and sorting sends you back to page one', async ({ page }) => {
  // Three lists had grown three different idioms, and only the commons could
  // be sorted at all. Staying on page three of a list that has just been
  // re-ordered shows you items you were never looking at.
  for (const view of ['Inbox', 'Feed']) {
    await go(page, view);
    await expect(page.locator('.toolbar .chip').first()).toBeVisible();

    // Order is a real control, not decoration.
    const chips = await page.locator('.toolbar .chip').allInnerTexts();
    expect(chips.length).toBeGreaterThan(1);
    await expect(page.locator('.toolbar .chip[aria-pressed="true"]')).toHaveCount(1);

    // Shrink the page until there is more than one — every paged list can be
    // made to page, which is what makes this assertable at all.
    // The feed hides routine events by default and the fixture's remainder is
    // small, so widen it before asking about pages.
    if (view === 'Feed') await page.getByRole('button', { name: 'Everything' }).click();

    // Shrink the page until there is more than one — every paged list can be
    // made to page, which is what makes this assertable at all.
    await page.locator('.toolbar select').selectOption({ index: 0 });
    await expect(page.locator('.pager')).toContainText('page 1 of');

    await page.getByRole('button', { name: 'Older' }).click();
    await expect(page.locator('.pager')).toContainText('page 2 of');

    // Re-order from page two: it must land back on page one.
    await page.locator('.toolbar .chip', { hasText: 'Oldest' }).click();
    await expect(page.locator('.pager')).toContainText('page 1 of');
    await expect(page.locator('.toolbar .chip[aria-pressed="true"]')).toHaveText('Oldest');

    // And changing the page size does too.
    await page.getByRole('button', { name: 'Older' }).click();
    await expect(page.locator('.pager')).toContainText('page 2 of');
    await page.locator('.toolbar select').selectOption({ index: 1 });
    await expect(page.locator('.pager')).toContainText('page 1 of');
  }
});

test('the whole company can be read, not only what reached you', async ({ page }) => {
  // Staff write to each other far more than they write to the board, and none
  // of that was visible from here.
  await go(page, 'Inbox');
  const mine = await page.locator('.toolbar .count').innerText();

  await page.getByRole('button', { name: "Everyone's" }).click();
  await expect(page.locator('.toolbar .count')).not.toHaveText(mine);

  // Mail between two colleagues appears, named for its real recipient — and
  // named explicitly, because the fixture's colleague mail is older than
  // sixteen routine reports. The only one on the first page was a message an
  // earlier test had sent, so this used to pass for the wrong reason.
  await page.getByLabel('Filter messages').fill('pricing page');
  const overheard = page.locator('.msg').filter({ has: page.locator('.addressed.other') }).first();
  await expect(overheard).toBeVisible();
  // A colleague's mail offers no read control, because you cannot read it on
  // their behalf.
  await overheard.locator('.row').click();
  await expect(overheard.getByRole('button', { name: /Mark (read|unread)/ })).toHaveCount(0);
  await page.getByLabel('Filter messages').fill('');

  // Read state belongs to a recipient. A colleague's mail to another
  // colleague has none that means anything here — but your own does, and
  // widening the view used to hide it.
  const yours = page.locator('.msg.unread');
  await expect(yours.first()).toBeVisible();
  await expect(page.locator('.toolbar .count')).toContainText('unread to you');
  // Every orange row is one addressed to you, not simply every row.
  const orange = await yours.count();
  expect(orange).toBeGreaterThan(0);
  expect(orange).toBeLessThan(await page.locator('.msg').count());

  await page.getByRole('button', { name: 'To you' }).click();
  await expect(page.locator('.toolbar .count')).toHaveText(mine);
  await expect(page.locator('.msg.unread').first()).toBeVisible();

  // And your own side of the conversation is here, not only in the wide view.
  // Filtering on the recipient alone meant a message the board had just sent
  // vanished the instant it was sent: an empty-looking inbox, no evidence the
  // send had happened, and the scope toggle that would have shown it hidden
  // by the empty list.
  await expect(page.locator('.msg .addressed.sent').first()).toBeVisible();
});

test('the inbox can put what needs you at the top', async ({ page }) => {
  await go(page, 'Inbox');
  // Addressed to you: mail you sent carries the recipient's read state, so it
  // offers no read control and is never the row this is about.
  const addressed = page.locator('.msg').filter({ has: page.locator('.addressed.you') });
  await addressed.first().locator('.row').click();
  await addressed.first().getByRole('button', { name: 'Mark read' }).click();
  await expect(page.locator('.msg.unread')).not.toHaveCount(await page.locator('.msg').count());

  await page.locator('.toolbar .chip', { hasText: 'Unread first' }).click();
  // Everything read must sink below everything unread.
  const flags = await page.locator('.msg').evaluateAll(
    (els) => els.map((e) => e.classList.contains('unread')));
  const firstRead = flags.indexOf(false);
  if (firstRead !== -1) {
    expect(flags.slice(firstRead).every((u) => !u)).toBe(true);
  }

  // Put it back: the tests after this one expect the fixture's read state.
  await page.locator('.toolbar .chip', { hasText: 'Newest' }).click();
  const read = addressed.filter({ hasNot: page.locator('.new') }).first();
  await read.locator('.row').click();
  await read.getByRole('button', { name: 'Mark unread' }).click();
  await expect(addressed.filter({ hasNot: page.locator('.new') })).toHaveCount(0);
});

test('every message says who it was written to', async ({ page }) => {
  // The inbox showed the sender and nothing else, so a note written to you and
  // a note copied to the whole company looked identical.
  await go(page, 'Inbox');
  await expect(page.locator('.msg').first()).toBeVisible();
  // Every message carries one, direct mail included — that is the point.
  const marks = await page.locator('.msg .addressed').allInnerTexts();
  expect(marks.length).toBe(await page.locator('.msg').count());
  // CSS uppercases these, and allInnerTexts returns what is rendered. Mail you
  // sent names the person you sent it to, which is neither of the other two.
  expect(marks.every((m) => ['→ you', '→ everyone', '→ fen'].includes(m.trim().toLowerCase())))
    .toBe(true);

  // And the broadcast is marked differently, so the two are told apart.
  await page.getByLabel('Filter messages').fill('whole company');
  await expect(page.locator('.msg .addressed')).toHaveText(/→ everyone/i);
});

test('a message can be put back to unread, to keep it in front of you', async ({ page }) => {
  // Reading something at a moment you cannot act on it should not lose it.
  await go(page, 'Inbox');
  const m = page.locator('.msg').filter({ has: page.locator('.addressed.you') }).first();
  await expect(m).toBeVisible();
  await m.locator('.row').click();
  await m.getByRole('button', { name: 'Mark read' }).click();
  await expect(m).not.toHaveClass(/unread/);
  await expect(m.locator('.new')).toHaveCount(0);

  await m.getByRole('button', { name: 'Mark unread' }).click();
  await expect(m).toHaveClass(/unread/);
  await expect(m.locator('.new')).toHaveText('New');
  await expect(page.locator('.navitem').filter({ hasText: 'Inbox' }).locator('.pill')).toBeVisible();
});

test('messages are collapsed by default, and page rather than pile up', async ({ page }) => {
  await go(page, 'Inbox');
  await expect(page.locator('.msg').first()).toBeVisible();

  // Collapsed: a one-line preview each, no bodies, and a page that fits.
  await expect(page.locator('.msg.open')).toHaveCount(0);
  await expect(page.locator('.msg .body')).toHaveCount(0);
  await expect(page.locator('.msg .preview').first()).toBeVisible();

  // Paged rather than endless.
  const perPage = await page.locator('.msg').count();
  expect(perPage).toBeLessThanOrEqual(15);
  await expect(page.locator('.pager')).toContainText('page 1 of 2');

  await page.getByRole('button', { name: 'Older' }).click();
  await expect(page.locator('.pager')).toContainText('page 2 of 2');
  await expect(page.locator('.msg').first()).toBeVisible();
  await page.getByRole('button', { name: 'Newer' }).click();
  await expect(page.locator('.pager')).toContainText('page 1 of 2');
});

test('opening a message shows it, and does not quietly mark it read', async ({ page }) => {
  await go(page, 'Inbox');
  const first = page.locator('.msg').first();
  await expect(first).toBeVisible();
  const unreadBefore = await page.locator('.msg.unread').count();

  await first.locator('.row').click();
  await expect(first).toHaveClass(/open/);
  await expect(first.locator('.row')).toHaveAttribute('aria-expanded', 'true');
  await expect(first.locator('.body')).toBeVisible();
  await expect(first.locator('.preview')).toHaveCount(0);

  // Reading and marking read are separate decisions — expanding must not
  // spend the one the operator controls.
  await expect(page.locator('.msg.unread')).toHaveCount(unreadBefore);

  await first.locator('.row').click();
  await expect(page.locator('.msg.open')).toHaveCount(0);
});

test('filtering narrows the list and resets to the first page', async ({ page }) => {
  await go(page, 'Inbox');
  await page.getByLabel('Filter messages').fill('noise floor');
  await expect(page.locator('.msg')).toHaveCount(1);
  await expect(page.locator('.pager')).toHaveCount(0);
  await page.getByLabel('Filter messages').fill('');
  await expect(page.locator('.pager')).toContainText('page 1 of 2');
});

test('marking read is an explicit act, and nothing else does it by accident', async ({ page }) => {
  await go(page, 'Inbox');
  // count() does not auto-wait, and the messages arrive after the heading.
  await expect(page.locator('.msg').first()).toBeVisible();
  const pill = page.locator('.navitem').filter({ hasText: 'Inbox' }).locator('.pill');
  const before = Number(await pill.innerText());
  expect(before).toBeGreaterThan(1);

  // The broadcast label looks like a chip and is not a control. Clicking it
  // used to silently mark the message read, which read as a toggle that had
  // broken — the unread bar vanished and clicking again did nothing.
  await page.getByLabel('Filter messages').fill('whole company');
  const broadcast = page.locator('.msg', { has: page.locator('.addressed.all') }).first();
  await expect(broadcast).toHaveClass(/unread/);
  await broadcast.locator('.addressed.all').click();
  // It sits inside the row, so it opens the message — which is all it does.
  await expect(broadcast).toHaveClass(/open/);
  await expect(broadcast).toHaveClass(/unread/);

  // Who it was addressed to is on the row, not inferred from its absence.
  await expect(broadcast.locator('.addressed')).toHaveText(/→ everyone/i);
  await expect(broadcast.locator('.envelope')).toContainText('everyone at');

  // Unread says so in words, not only in a coloured edge.
  await expect(broadcast.locator('.new')).toHaveText('New');

  // The explicit control is the only thing that does it.
  await broadcast.getByRole('button', { name: 'Mark read' }).click();
  await expect(broadcast).not.toHaveClass(/unread/);
  await expect(broadcast.locator('.new')).toHaveCount(0);
  await expect(pill).toHaveText(String(before - 1));

  await page.getByLabel('Filter messages').fill('');
  await page.getByRole('button', { name: /Mark all read/ }).click();
  await expect(page.locator('.msg.unread')).toHaveCount(0);
  await expect(page.locator('.navitem').filter({ hasText: 'Inbox' }).locator('.pill')).toHaveCount(0);

  // The tab counts everything outstanding, and mail is no longer part of it.
  // Approvals still are, and whether one is pending depends on which other
  // tests have run — so assert against what the status bar actually says.
  const waiting = Number(/(\d+) waiting on you/.exec(await page.locator('.status').innerText())?.[1] ?? '0');
  await expect(page).toHaveTitle(waiting ? `(${waiting}) The Desk` : 'The Desk');
});

test('a reply reaches the person who wrote to you', async ({ page }) => {
  await go(page, 'Inbox');
  const first = page.locator('.msg').first();
  await first.locator('.row').click();
  await first.getByRole('button', { name: 'Reply' }).click();
  await first.locator('textarea').fill('Understood — publish the detection floor beside it.');
  await first.getByRole('button', { name: 'Send' }).click();

  await go(page, 'Feed');
  await expect(page.locator('.feed')).toContainText('publish the detection floor');
});

test('answering mail between colleagues reaches both, not just the one who wrote', async ({ page }) => {
  // Replying to overheard mail used to go to the sender alone, and no agent
  // can read a conversation it was left out of — so the colleague it had been
  // written to never learned the founder had weighed in.
  await go(page, 'Inbox');
  await page.getByRole('button', { name: "Everyone's" }).click();

  // Twenty-two messages page at fifteen, so narrow rather than hunt.
  const search = page.getByRole('searchbox', { name: 'Filter messages' });
  await search.fill('pricing page');
  const overheard = page.locator('.msg').first();
  await expect(overheard.locator('.addressed.other')).toBeVisible();
  const wrote = (await overheard.locator('.who').innerText()).trim().toLowerCase();
  const written = (await overheard.locator('.addressed').innerText())
    .replace('\u2192', '').trim().toLowerCase();

  await overheard.locator('.row').click();
  await overheard.getByRole('button', { name: 'Reply' }).click();
  // The reply is a full Markdown editor too, not a bare box — same toolbar as
  // the composer.
  await expect(overheard.locator('.reply').getByRole('button', { name: 'Bold' })).toBeVisible();
  // The box names everyone it is about to reach, before anything is sent.
  const placeholder = (await overheard.locator('textarea').getAttribute('placeholder')) ?? '';
  expect(placeholder.toLowerCase()).toContain(`${wrote} and ${written}`);

  await overheard.locator('textarea').fill('Both of you — hold until legal answers.');
  await overheard.getByRole('button', { name: 'Send' }).click();

  // One message in the list, addressed to the two people who were in the room.
  await search.fill('hold until legal answers');
  const sent = page.locator('.msg');
  await expect(sent).toHaveCount(1);
  const to = (await sent.locator('.addressed').innerText()).toLowerCase();
  expect(to).toContain(wrote);
  expect(to).toContain(written);
});

test('a message can be started from scratch, to one person or to the company', async ({ page }) => {
  // Reply needs something to hang off. Reaching somebody who had not written
  // first meant hunting their card on the Staff page, two people at once was
  // impossible, and the founder could not address the company at all — the
  // one thing every agent could already do.
  await go(page, 'Inbox');
  await page.getByRole('button', { name: 'Compose' }).click();

  const composer = page.locator('.compose');
  const to = composer.getByRole('combobox', { name: 'Recipients' });
  await expect(composer).toBeVisible();
  await expect(to).toBeFocused();

  // Nothing is sendable before somebody is picked.
  await composer.locator('textarea').fill('Fen — the floor number, in the summary, today.');
  await expect(composer.getByRole('button', { name: 'Send' })).toBeDisabled();

  // Typing narrows the roster; the choice becomes a tag.
  await to.fill('fe');
  await expect(composer.getByRole('option')).toHaveCount(1);
  await to.press('Enter');
  await expect(composer.locator('.tag')).toHaveText(/Fen/);
  await expect(to).toHaveValue('', { timeout: 2000 });

  // A tag comes back off with backspace, the way every recipient field works.
  await to.press('Backspace');
  await expect(composer.locator('.tag')).toHaveCount(0);
  await expect(composer.getByRole('button', { name: 'Send' })).toBeDisabled();

  await to.fill('fen');
  await to.press('Enter');
  await composer.getByRole('button', { name: 'Send' }).click();
  await expect(page.locator('.compose')).toHaveCount(0);

  const search = page.getByRole('searchbox', { name: 'Filter messages' });
  await page.getByRole('button', { name: "Everyone's" }).click();
  await search.fill('the floor number');
  await expect(page.locator('.msg')).toHaveCount(1);
  await expect(page.locator('.msg .addressed')).toHaveText(/FEN/i);

  // And the whole company, which is a broadcast rather than the roster with
  // every name ticked.
  await page.getByRole('button', { name: 'Compose' }).click();
  const to2 = page.locator('.compose').getByRole('combobox', { name: 'Recipients' });
  await to2.fill('every');
  await to2.press('Enter');
  await expect(page.locator('.compose .tag.all')).toHaveText(/Everyone/);
  await page.locator('.compose textarea').fill('All hands: we publish the detection floor.');
  await page.locator('.compose').getByRole('button', { name: 'Send' }).click();

  await search.fill('All hands');
  await expect(page.locator('.msg')).toHaveCount(1);
  await expect(page.locator('.msg .addressed')).toHaveText(/EVERYONE/i);
});

test('the composer formats a selection and embeds a chosen image', async ({ page }) => {
  // The bodies render as Markdown, so the composer is a Markdown editor. The
  // toolbar wraps the selection so you need not remember the syntax, and an
  // image is uploaded into the world and referenced, not left to a broken link.
  await go(page, 'Inbox');
  await page.getByRole('button', { name: 'Compose' }).click();
  const composer = page.locator('.compose');
  const ta = composer.locator('textarea');

  // Bold wraps the selected word, and only it.
  await ta.fill('make this bold');
  await ta.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(10, 14));
  await composer.getByRole('button', { name: 'Bold' }).click();
  await expect(ta).toHaveValue('make this **bold**');

  // A chosen image uploads and lands as a world reference the renderer can
  // serve — a 1x1 PNG stands in for whatever the operator pastes or picks. The
  // reference lands at the caret, so put the caret at the end first.
  await ta.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(el.value.length, el.value.length));
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  await composer.locator('input[type=file]').setInputFiles({
    name: 'shot.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64'),
  });
  await expect(ta).toHaveValue(/make this \*\*bold\*\*!\[image\]\(attachments\/[\w-]+\.png\)/, { timeout: 5000 });

  // And a non-image upload is refused, not written under a lying name.
  await composer.locator('input[type=file]').setInputFiles({
    name: 'note.png', mimeType: 'image/png', buffer: Buffer.from('this is not a PNG'),
  });
  await expect(composer.locator('.status.err')).toBeVisible();

  // The keyboard does the same as the buttons. Italic wraps the selection...
  await ta.fill('word');
  await ta.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(0, 4));
  await ta.press('Meta+i');
  await expect(ta).toHaveValue('*word*');

  // ...and a link keeps the selection as the label, landing the caret on "url"
  // so the address types straight over it (the offset math that had no test).
  await ta.fill('see docs');
  await ta.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(4, 8));
  await ta.press('Meta+k');
  await expect(ta).toHaveValue('see [docs](url)');
  const selected = await ta.evaluate((el: HTMLTextAreaElement) =>
    el.value.slice(el.selectionStart, el.selectionEnd));
  expect(selected).toBe('url');

  // Pasting an image is the same path as choosing one — the paste handler
  // uploads it and drops the reference at the caret.
  await ta.fill('shot: ');
  await ta.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(el.value.length, el.value.length));
  await ta.evaluate((el: HTMLTextAreaElement, b64: string) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], 'paste.png', { type: 'image/png' }));
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, png);
  await expect(ta).toHaveValue(/shot: !\[image\]\(attachments\/[\w-]+\.png\)/, { timeout: 5000 });
});

test('a long roster stays a field to type in, not a wall to read', async ({ page }) => {
  // Forty toggles is not a control. The menu caps at what fits above the
  // message you came here to write, and says how much it is not showing.
  await go(page, 'Inbox');
  await page.getByRole('button', { name: 'Compose' }).click();
  const to = page.getByRole('combobox', { name: 'Recipients' });

  // Focus alone offers the roster — a small company still behaves like a list.
  await expect(page.locator('.compose .opt').first()).toBeVisible();

  // Matching is not only on the name: role and department find people too.
  await to.fill('proof');
  await expect(page.getByRole('option', { name: /Fen/ })).toBeVisible();

  await to.fill('nobody here is called this');
  await expect(page.locator('.compose .options')).toHaveCount(0);

  await to.press('Escape');
  await expect(page.locator('.compose .options')).toHaveCount(0);
});

test('the brief can be read back and revised, and the CEO is told', async ({ page }) => {
  // Editing it used to be impossible, and would have been a lie if it were:
  // the brief is copied into the constitution and the CEO's papers at
  // founding, so changing config.json changes a file nobody has open.
  await go(page, 'Overview', 'Testwright Co');
  await expect(page.locator('.brief .body')).toBeVisible();

  await page.locator('.brief').getByRole('button', { name: 'Edit' }).click();
  const editor = page.locator('.brief textarea');
  await editor.fill('Instruments for people who work on boats.\n\nNothing that needs a tutorial.');
  await page.locator('.brief').getByRole('button', { name: 'Save' }).click();

  await expect(page.locator('.brief .body')).toContainText('people who work on boats');
  await expect(page.locator('.brief textarea')).toHaveCount(0);

  // The company hears about it, rather than the change sitting in a file.
  await go(page, 'Inbox');
  await page.getByRole('button', { name: "Everyone's" }).click();
  await page.getByRole('searchbox', { name: 'Filter messages' }).fill('revised the brief');
  await expect(page.locator('.msg')).toHaveCount(1);
  await page.locator('.msg .row').first().click();
  await expect(page.locator('.msg .body')).toContainText('people who work on boats');
});

test('how hard a company works is a setting, not a constant in the source', async ({ page }) => {
  // Every company got the same hardcoded dials. A company writing documents
  // finished inside 24 turns; a company writing software hit that wall on
  // every single shift.
  await go(page, 'Overview', 'Testwright Co');
  const dials = page.locator('.dials');
  await expect(dials).toContainText('turns a shift');

  await dials.getByRole('button', { name: 'Tune' }).click();
  // Nothing to save until something changes.
  await expect(dials.getByRole('button', { name: 'Save' })).toBeDisabled();

  const turns = dials.locator('input').first();
  await turns.fill('120');
  await expect(dials.getByRole('button', { name: 'Save' })).toBeEnabled();
  await dials.getByRole('button', { name: 'Save' }).click();

  await expect(dials).toContainText('120 turns a shift');

  // Every dial must be bound to a key the company actually has. A key that is
  // not on the policy renders an empty box, saves NaN, and silently restores
  // the default — which looks exactly like the setting not sticking.
  await dials.getByRole('button', { name: 'Tune' }).click();
  for (const box of await dials.locator('input').all()) {
    await expect(box).not.toHaveValue('');
  }

  // And it survives a reload, because it is written down rather than held in
  // a component that is about to be unmounted.
  await page.reload();
  await go(page, 'Overview', 'Testwright Co');
  await expect(page.locator('.dials')).toContainText('120 turns a shift');
});

test('the console updates itself as the company works', async ({ page }) => {
  // Views used to load once on mount, so anything the company did while you
  // were looking at a page simply did not appear until you navigated away and
  // back. Nothing here reloads the page.
  const seq = () => page.locator('.status').innerText();
  const before = await seq();

  // Straight at the API, not through the console, so this proves the console
  // noticed rather than that it remembered what it just did.
  await page.evaluate(async () => {
    await fetch('/api/say', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to: 'fen', text: 'Something new happened.' }),
    });
  });

  // The status bar carries the event count, and it must move on its own.
  await expect.poll(seq, { timeout: 15_000 }).not.toEqual(before);

  // And the feed shows it without a reload.
  await go(page, 'Feed');
  await expect(page.locator('.feed')).toContainText('Something new happened.');
});

test('the sidebar can be dragged wider, and stays where you put it', async ({ page }) => {
  const rail = page.locator('.rail');
  const splitter = page.locator('.splitter').first();
  const widthOf = async () => Math.round((await rail.boundingBox())!.width);

  const before = await widthOf();
  const box = (await splitter.boundingBox())!;

  // A real drag, through the handle sitting on the border.
  await page.mouse.move(box.x + box.width / 2, box.y + 300);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 90, box.y + 300, { steps: 8 });
  await page.mouse.up();

  const after = await widthOf();
  expect(after).toBeGreaterThan(before + 60);
  await expect(splitter).toHaveAttribute('aria-valuenow', String(after));

  // Set once, stays set — including across a reload.
  await page.reload();
  await expect(page.locator('.co')).not.toBeEmpty();
  expect(await widthOf()).toBe(after);
});

test('the splitter is a real control, not just a draggable pixel', async ({ page }) => {
  const splitter = page.locator('.splitter').first();
  // A 1px border is a target nobody can hit; the grab area is wider than the
  // line it draws.
  const box = (await splitter.boundingBox())!;
  expect(box.width).toBeGreaterThanOrEqual(8);

  await expect(splitter).toHaveAttribute('role', 'separator');
  await expect(splitter).toHaveAttribute('aria-orientation', 'vertical');

  // Reachable and operable from the keyboard.
  await splitter.focus();
  const start = Number(await splitter.getAttribute('aria-valuenow'));
  await page.keyboard.press('ArrowLeft');
  await expect(splitter).toHaveAttribute('aria-valuenow', String(start - 8));
  await page.keyboard.press('Home');
  await expect(splitter).toHaveAttribute('aria-valuenow', await splitter.getAttribute('aria-valuemin') ?? '');
});

test('the console holds together on a narrow window', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 700 });
  const overflow = () => page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);

  await go(page, 'Staff');
  expect(await overflow()).toBeLessThanOrEqual(0);

  // Vitals is nine columns of figures, and a table that widens the document
  // scrolls the whole page rather than itself. It has to scroll inside its own
  // container, which is what the rest of the console already does.
  await go(page, 'Vitals');
  await expect(page.locator('.tile').first()).toBeVisible();
  expect(await overflow()).toBeLessThanOrEqual(0);
});

test.describe('many companies, one console', () => {
  // These run last and in order: each builds on the previous one's state, and
  // the console remembers which company was open, so the shared beforeEach
  // that expects Testwright does not apply here.
  test.describe.configure({ mode: 'serial' });

  test('a company can be founded from the console and becomes active', async ({ page }) => {
    await page.locator('.switcher').click();
    await page.getByRole('button', { name: 'Manage companies…' }).click();
    await expect(page.getByRole('heading', { name: 'Companies' })).toBeVisible();

    await page.getByRole('button', { name: 'Found a company' }).click();
    await page.getByLabel('Company name').fill('Kestrel Provisioning');
    // A paragraph, not a phrase: the founder's one chance to say what this is
    // for, before a CEO who has never met them decides it.
    const brief = 'Field logistics for crews who work where there is no signal, no power, '
      + 'and no patience for ceremony.\n\n'
      + 'Not a SaaS dashboard. Kit that works out of a truck.';
    const business = page.getByLabel('Line of business');
    await expect(business).toHaveRole('textbox');
    await business.fill(brief);
    await expect(business).toHaveValue(brief);   // newlines survive the field
    await page.getByLabel("CEO's name").fill('Rook');
    await page.getByLabel('Chairman').fill('Tester');
    await page.getByRole('button', { name: 'Found it' }).click();

    // The new company becomes active, and lands in the switcher — it once did
    // the first without the second, because switching unmounted the view whose
    // event refreshed the list.
    await expect(page.locator('.co')).toHaveText('Kestrel Provisioning');

    // The rail carries the name and nothing else. The brief used to be
    // rendered under it, back when it was three words; a paragraph there
    // buried the name it belongs to.
    await expect(page.locator('.brand')).not.toContainText('Field logistics');
    await expect(page.locator('.brand .biz')).toHaveCount(0);

    // It is legible in full on the company's own page instead.
    await go(page, 'Overview', 'Kestrel Provisioning');
    await expect(page.locator('.brief .body')).toContainText('Field logistics for crews');
    await expect(page.locator('.brief .body')).toContainText('works out of a truck');

    await page.locator('.switcher').click();
    await expect(page.locator('.menuitem').filter({ hasText: 'Kestrel' })).toHaveCount(1);
    await expect(page.locator('.menuitem').filter({ hasText: 'Testwright' })).toHaveCount(1);
  });

  test('a founding sets the board, the rate and the release route, not just the name', async ({ page }) => {
    // Every one of these used to be a config.json edit on a live installation.
    // Board seats especially: genesis seeds the roster once, so a name added
    // afterwards carried board standing the roster had never granted.
    await page.locator('.switcher').click();
    await page.getByRole('button', { name: 'Manage companies…' }).click();
    await page.getByRole('button', { name: 'Found a company' }).click();

    await page.getByLabel('Company name').fill('Halyard Works');
    await page.getByLabel('Line of business').fill('Rigging, and the paperwork that follows it.');
    await page.getByLabel("CEO's name").fill('Perrin');
    await page.getByLabel('Chairman').fill('Tester');
    await page.getByLabel('Other board seats').fill('Marlowe, Board');
    await page.getByLabel('How work leaves').selectOption('bundle');
    await page.getByLabel('Working at once').fill('2');
    await page.getByLabel('Minutes between shifts').fill('45');
    // Founded paused: nothing should spend the subscription window while the
    // founder is still reading it over.
    await page.getByLabel('Found it paused', { exact: false }).check();
    await page.getByRole('button', { name: 'Found it' }).click();

    await expect(page.locator('.co')).toHaveText('Halyard Works');

    // The rate is readable on the company's own page.
    await go(page, 'Overview', 'Halyard Works');
    await expect(page.locator('.dials .summary')).toContainText('2 working at once');
    await expect(page.locator('.dials .summary')).toContainText('every 45 min');

    // The board seat has to be on the roster, not merely in a config file: the
    // gate reads standing from config, so a name the roster never had was
    // hireable while still carrying board authority.
    const state = await (await page.request.get('/api/state?c=halyard-works')).json();
    expect(state.board.map((b: { id: string }) => b.id)).toEqual(['tester', 'marlowe']);
    expect(state.agents.map((a: { id: string }) => a.id)).toContain('marlowe');
    expect(state.release).toBe('bundle');

    // Founded paused: nothing spends the window while the founder reads it over.
    const listing = await (await page.request.get('/api/companies')).json();
    expect(listing.companies.find((c: { slug: string }) => c.slug === 'halyard-works').running)
      .toBe(false);

    // The suite runs in order and the archiving test counts what is left, so
    // a company founded here has to be cleared here.
    await page.request.delete('/api/companies/halyard-works');
    await page.goto('/');
  });

  test('a founded company starts with a CEO and nothing else', async ({ page }) => {
    await useCompany(page, 'Kestrel Provisioning');
    // One agent, no commons, no roster. The CEO builds the rest.
    await expect(page.locator('.status')).toContainText('1 staff');
    await expect(page.locator('.status')).toContainText('commons 0/40');
  });

  test('switching companies does not leak one world into another', async ({ page }) => {
    const read = async () => (await page.locator('.status').innerText()).replace(/\s+/g, ' ');

    await useCompany(page, 'Testwright Co');
    const testwright = await read();

    await useCompany(page, 'Kestrel Provisioning');
    const kestrel = await read();

    expect(testwright).not.toEqual(kestrel);
    // Testwright has a CEO, a lead and a clerk; a company founded a moment ago
    // has only its CEO. Board members are not counted as staff.
    expect(testwright).toContain('3 staff');
    expect(testwright).toContain('commons 2/40');
    expect(kestrel).toContain('1 staff');
    expect(kestrel).toContain('commons 0/40');

    // The commons of one must not be readable while the other is selected.
    await go(page, 'Commons');
    await expect(page.locator('.doc')).toHaveCount(0);
  });

  test('a company can be carried out as one file and back in', async ({ page }) => {
    // Sending a company to someone else was a folder-copy and a conversation
    // about which absolute paths to fix by hand.
    await page.locator('.switcher').click();
    await page.getByRole('button', { name: 'Manage companies…' }).click();
    await expect(page.getByRole('heading', { name: 'Companies' })).toBeVisible();
    const card = page.locator('.card').first();
    const name = await card.locator('.name').innerText();
    // The copy keeps its old display name, so the slug is the only thing that
    // tells the two apart on screen.
    const slug = (await card.locator('.meta').innerText()).split('·').pop()!.trim();

    const download = await Promise.all([
      page.waitForEvent('download'),
      card.getByRole('button', { name: 'Export' }).click(),
    ]).then(([d]) => d);
    expect(download.suggestedFilename()).toMatch(/\.riff\.tar\.gz$/);
    const file = await download.path();

    const before = await page.locator('.card').count();
    await page.getByLabel('Company export file').setInputFiles(file);

    // It arrives paused and beside the original, never on top of it.
    await expect(page.locator('.landed')).toContainText(name);
    await expect(page.locator('.card')).toHaveCount(before + 1);
    const arrived = page.locator('.card').filter({ hasText: `${slug}-2` });
    await expect(arrived).toHaveCount(1);
    await expect(arrived.locator('.name')).toHaveText(name);
    await expect(arrived.locator('.state')).toHaveText('paused');
  });

  test('pausing waits for the shift; killing it is a separate, named choice', async ({ page }) => {
    // Pause used to abort whoever was mid-shift, losing the work and writing
    // `Claude Code process aborted by user`. up.sh called the same endpoint
    // before a rebuild to protect those shifts, and killed them itself.
    // Shown as running rather than actually started: a company one test leaves
    // running is a company the next three find in a state they did not set.
    await page.route('**/api/companies', async (route) => {
      const res = await route.fetch();
      const body = await res.json();
      const cos = (body.companies ?? []).map((c: Record<string, unknown>, i: number) =>
        i === 0 ? { ...c, running: true, draining: false, awake: ['ceo'] } : c);
      await route.fulfill({ json: { ...body, companies: cos } });
    });
    // beforeEach already loaded the page, so the listing in the DOM predates
    // the route. Take it again under the stub.
    await page.reload();
    await expect(page.locator('.co')).not.toBeEmpty();

    await page.locator('.switcher').click();
    await page.getByRole('button', { name: 'Manage companies…' }).click();
    await expect(page.getByRole('heading', { name: 'Companies' })).toBeVisible();

    const card = page.locator('.card').first();
    const slug = (await card.locator('.meta').innerText()).split('·').pop()!.trim();
    await expect(card.getByRole('button', { name: 'Pause' })).toBeVisible();

    const [request] = await Promise.all([
      page.waitForRequest((r) => r.url().includes(`/running`) && r.method() === 'POST'),
      card.getByRole('button', { name: 'Pause' }).click(),
    ]);
    // Pause asks for nothing: draining is what stopping means now, and `hard`
    // is the only way to get the shift-killing one.
    expect(request.postDataJSON()).toEqual({ running: false });
    expect(request.url()).toContain(slug);
  });

  test('a company still finishing its last shift says so, and can be cut short', async ({ page }) => {
    // Draining is neither running nor paused, and it is the state an operator
    // waits on before a rebuild — so it must not read as either of the others.
    await page.route('**/api/companies', async (route) => {
      const res = await route.fetch();
      const body = await res.json();
      const cos = (body.companies ?? []).map((c: Record<string, unknown>, i: number) =>
        i === 0 ? { ...c, running: false, draining: true, awake: ['ceo', 'ada'] } : c);
      await route.fulfill({ json: { ...body, companies: cos } });
    });
    // beforeEach already loaded the page, so the listing in the DOM predates
    // the route. Take it again under the stub.
    await page.reload();
    await expect(page.locator('.co')).not.toBeEmpty();

    await page.locator('.switcher').click();
    await page.getByRole('button', { name: 'Manage companies…' }).click();
    await expect(page.getByRole('heading', { name: 'Companies' })).toBeVisible();

    const card = page.locator('.card').first();
    await expect(card.locator('.state')).toHaveText('finishing 2');
    await expect(card.getByRole('button', { name: 'Shut down' })).toBeVisible();
    // Neither of the two states it is not.
    await expect(card.getByRole('button', { name: 'Pause' })).toHaveCount(0);
    await expect(card.getByRole('button', { name: 'Start' })).toHaveCount(0);
    // And a run that is ending cannot be handed a deadline.
    await expect(card.getByRole('button', { name: 'Run for…' })).toHaveCount(0);

    // Shut down is the kill, and it has to say so.
    const [request] = await Promise.all([
      page.waitForRequest((r) => r.url().includes('/running') && r.method() === 'POST'),
      card.getByRole('button', { name: 'Shut down' }).click(),
    ]);
    expect(request.postDataJSON()).toEqual({ running: false, hard: true });
  });

  test('a file that is not a company is refused in words', async ({ page }) => {
    await page.locator('.switcher').click();
    await page.getByRole('button', { name: 'Manage companies…' }).click();
    await expect(page.getByRole('heading', { name: 'Companies' })).toBeVisible();
    await page.getByLabel('Company export file').setInputFiles({
      name: 'holiday.tar.gz', mimeType: 'application/gzip', buffer: Buffer.from('not a company at all'),
    });
    await expect(page.locator('.oops')).toContainText('not a Riff export');
    await expect(page.locator('.landed')).toHaveCount(0);
  });

  test('archiving asks for the name, then removes it from the list', async ({ page }) => {
    const manage = async () => {
      await page.locator('.switcher').click();
      await page.getByRole('button', { name: 'Manage companies…' }).click();
      await expect(page.getByRole('heading', { name: 'Companies' })).toBeVisible();
    };

    // The export test left a copy beside the original, under the same display
    // name. Both go — and archiving whichever one is active switches the
    // console away, so the view has to be reopened between them.
    await manage();
    const kestrels = page.locator('.card', { hasText: 'Kestrel' });
    for (let left = await kestrels.count(); left > 0; left--) {
      await kestrels.first().getByRole('button', { name: 'Archive' }).click();
      const confirm = page.getByRole('button', { name: 'Archive it' });

      // Armed only by typing the name — the same friction any tool asks for
      // before it moves a repository.
      await expect(confirm).toBeDisabled();
      await page.locator('.dialog input').fill('Wrong Name');
      await expect(confirm).toBeDisabled();
      await page.locator('.dialog input').fill('Kestrel Provisioning');
      await expect(confirm).toBeEnabled();
      await confirm.click();

      await manage();
      await expect(kestrels).toHaveCount(left - 1);
    }

    await expect(page.locator('.card')).toHaveCount(1);
    await expect(page.locator('.card')).toContainText('Testwright Co');
  });
});

test('an agent can be given a name from the console, id and all', async ({ page }) => {
  // 92 lines of foreign-key SQL used to live in a script, so a seat called
  // `ceo` could be shown by the console and renamed only from a terminal.
  await page.goto('/');
  await go(page, 'Staff');
  await page.locator('.card', { hasText: 'Fen' }).first().click();
  await page.getByRole('button', { name: 'Rename…' }).click();
  await page.getByLabel('New name').fill('Fenwick Ash');
  await page.getByRole('button', { name: 'Save' }).click();

  // The id moved with the name, not just the label.
  await expect(page.locator('.card', { hasText: 'Fenwick Ash' })).toBeVisible();
  const state = await (await page.request.get('/api/state?c=testwright-co')).json();
  const ids = state.agents.map((a: { id: string }) => a.id);
  expect(ids).toContain('fenwick-ash');
  expect(ids).not.toContain('fen');

  // And back, so the rest of the suite still finds Fen where it left her.
  await page.request.post('/api/agents/rename', {
    data: { company: 'testwright-co', who: 'fenwick-ash', name: 'Fen' },
  });
  await page.goto('/');
});

test('a dial keeps what you typed while the console refreshes under it', async ({ page }) => {
  // App.vue polls state every twenty seconds and replaces the whole object, so
  // the deep watch on policy fired on identity even when nothing had changed.
  // Whatever had been typed was reset from the server on the next poll, and
  // Save greyed out with it — a setting could only be changed by someone
  // faster than the timer.
  await page.clock.install();
  await page.goto('/');
  await go(page, 'Overview', 'Testwright Co');

  const panel = page.locator('section.dials');
  await panel.getByRole('button', { name: 'Tune' }).click();

  const turns = panel.getByRole('spinbutton').first();
  const was = await turns.inputValue();
  await turns.fill(String(Number(was) + 3));
  const save = panel.getByRole('button', { name: 'Save' });
  await expect(save).toBeEnabled();

  // Two full poll intervals, which is where the value used to disappear.
  await page.clock.fastForward('00:45');
  await expect(turns).toHaveValue(String(Number(was) + 3));
  await expect(save).toBeEnabled();

  // Done discards, so the panel still shows what the server holds rather than
  // what was typed at it — and the fixture is left as the rest found it.
  await panel.getByRole('button', { name: 'Done' }).click();
  await panel.getByRole('button', { name: 'Tune' }).click();
  await expect(panel.getByRole('spinbutton').first()).toHaveValue(was);
  await panel.getByRole('button', { name: 'Done' }).click();
});

test('a seat can be closed from the console, and never a board seat', async ({ page }) => {
  // Retiring ran CEO-proposes / board-ratifies, which has no route at all when
  // the seat to remove is the CEO's — a company finished with a line of
  // business the board had killed and a chief executive who would have had to
  // propose his own dismissal.
  await page.goto('/');
  await go(page, 'Staff');

  // The board is not removable from here, whatever the console offers.
  const chair = page.locator('.card', { hasText: 'Chairman' }).first();
  if (await chair.count()) {
    await chair.click();
    await expect(page.locator('.detail').getByRole('button', { name: 'Retire…' })).toHaveCount(0);
  }

  const wick = page.locator('.card', { hasText: 'Wick' }).first();
  await wick.click();
  await page.getByRole('button', { name: 'Retire…' }).click();

  // A reason is not optional: a removal nobody wrote a reason for is one
  // nobody can review afterwards.
  await page.getByRole('button', { name: /^Retire Wick$/ }).click();
  await expect(page.locator('.retiring .err')).toHaveText('say why');

  await page.getByLabel('Why they are leaving').fill('the seat was never filled with work');
  await page.getByRole('button', { name: /^Retire Wick$/ }).click();

  await expect(page.locator('.card', { hasText: 'Wick' })).toHaveCount(0);
  const state = await (await page.request.get('/api/state?c=testwright-co')).json();
  expect(state.agents.map((a: { id: string }) => a.id)).not.toContain('wick');

  // The reason is in the record, and says the board did it rather than a colleague.
  const log = await (await page.request.get('/api/events?c=testwright-co&limit=500')).json();
  const gone = log.events.find((e: { kind: string }) => e.kind === 'role.retired');
  expect(gone).toBeTruthy();
  expect(JSON.parse(gone.dataJson).by).toBe('board');
});

test('a seat can be redefined from the console, sending only the fields that changed', async ({ page }) => {
  // Role and persona were set at founding with no way to change them after; the
  // only levers were rename and retire. The panel diffs each field against what
  // it held when it opened, so an untouched persona is never sent — the bug that
  // would otherwise overwrite the brief (worst case, wipe it) on a role-only edit.
  await page.goto('/');
  await go(page, 'Staff');

  // The board is defined by the charter, not a persona — no Redefine here.
  const chair = page.locator('.card', { hasText: 'Chairman' }).first();
  if (await chair.count()) {
    await chair.click();
    await expect(page.locator('.detail').getByRole('button', { name: 'Redefine…' })).toHaveCount(0);
    await chair.click();
  }

  await page.locator('.card', { hasText: 'Fen' }).first().click();
  await page.getByRole('button', { name: 'Redefine…' }).click();

  // A reason is required, like retire — a change nobody wrote a reason for is
  // one nobody can review afterwards.
  await page.getByRole('button', { name: 'Save definition' }).click();
  await expect(page.locator('.redefining .err')).toHaveText('say why');

  // Change only the role; leave the persona textarea untouched.
  await page.getByLabel('Role').fill('Head of Assurance');
  await page.getByLabel('Why this change').fill('assurance is the wider remit');
  await page.getByRole('button', { name: 'Save definition' }).click();

  await expect(page.locator('.renaming .hint')).toContainText('redefined Fen: role');

  // The server applied role alone — the untouched persona was not sent.
  const log = await (await page.request.get('/api/events?c=testwright-co&limit=500')).json();
  const ev = log.events.find((e: { kind: string }) => e.kind === 'agent.redefined');
  expect(ev).toBeTruthy();
  const data = JSON.parse(ev.dataJson);
  expect(data.changed).toEqual(['role']);
  expect(data.by).toBe('board');

  const state = await (await page.request.get('/api/state?c=testwright-co')).json();
  expect(state.agents.find((a: { id: string }) => a.id === 'fen').role).toBe('Head of Assurance');

  // The brief is intact — a role-only edit did not touch the body.
  const persona = await (await page.request.get('/api/doc?c=testwright-co&path=staff%2Ffen%2Fpersona.md')).json();
  expect(persona.body).toContain('whether the thing we say happened actually happened');

  // Put Fen's role back so the rest of the suite finds her as it left her.
  await page.request.post('/api/agents/redefine', {
    data: { company: 'testwright-co', who: 'fen', why: 'restore fixture', role: 'Head of Proof' },
  });
  await page.goto('/');
});

test('the board speaks with more than one voice', async ({ page }) => {
  // /api/say sent as board[0] whatever it was handed, so a second board seat
  // existed on the roster and nowhere the company could hear it.
  await page.goto('/');
  await go(page, 'Inbox');
  await page.getByRole('button', { name: 'Compose' }).click();

  const picker = page.getByLabel('Who is speaking');
  // One seat is not a choice, so the control only appears when there is one.
  if (!(await picker.count())) {
    await expect(page.locator('.compose')).toBeVisible();
    return;
  }
  const names = await picker.locator('option').allInnerTexts();
  expect(names.length).toBeGreaterThan(1);
});

test('a run can be given a deadline from the console', async ({ page }) => {
  await page.goto('/');
  await page.locator('.switcher').click();
  await page.getByRole('button', { name: 'Manage companies…' }).click();

  const card = page.locator('.card', { hasText: 'Testwright' });
  await card.getByRole('button', { name: 'Run for…' }).click();
  await page.getByLabel('Hours').fill('2');
  await page.getByLabel('Wake-ups').fill('5');
  await page.getByRole('button', { name: 'Start it' }).click();

  await expect(card.locator('.state')).not.toContainText('paused');
  // Stop it again: a fixture left running spends a real subscription window.
  // Pause drains, so a company with shifts in flight goes to "finishing N"
  // and stays there until they land — which is the point of it, and no good
  // to a fixture. Cut them short.
  await card.getByRole('button', { name: 'Pause' }).click();
  const shutDown = card.getByRole('button', { name: 'Shut down' });
  await expect(shutDown).toBeVisible();
  await shutDown.click();
  await expect(card.locator('.state')).toContainText('paused');
});

test('the power button on the front page kills, and asks before it does', async ({ page }) => {
  // Pause drains everywhere now, which is right almost always and wrong for
  // the one case it was invented for: a run going visibly wrong that the
  // operator wants stopped without waiting out a ten-minute shift.
  await page.route('**/api/state*', async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    await route.fulfill({ json: { ...body, running: true, draining: false, awake: [body.ceo.id] } });
  });
  await page.goto('/');
  await useCompany(page, 'Testwright Co');
  await go(page, 'Overview', 'Testwright Co');

  const power = page.getByRole('button', { name: /^Shut down / });
  await expect(power).toBeVisible();

  // Arming is not firing. A misread icon must not destroy a shift.
  let posts = 0;
  page.on('request', (r) => { if (r.url().includes('/api/close')) posts += 1; });
  await power.click();
  await expect(page.getByText('mid-shift now')).toBeVisible();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByText('mid-shift now')).toHaveCount(0);
  expect(posts).toBe(0);

  await power.click();
  const [request] = await Promise.all([
    page.waitForRequest((r) => r.url().includes('/api/close') && r.method() === 'POST'),
    page.getByRole('button', { name: 'Shut down', exact: true }).click(),
  ]);
  expect(request.postDataJSON()).toEqual({ hard: true });
});

test('the release route is changeable after founding, not only at it', async ({ page }) => {
  // It was settable at founding and by PATCH, and reachable from no screen —
  // an operator could turn a company's releases on and never see that it took.
  await page.goto('/');
  await page.locator('.switcher').click();
  await page.getByRole('button', { name: 'Manage companies…' }).click();

  await page.locator('.card', { hasText: 'Testwright' }).getByRole('button', { name: 'Rename' }).click();
  await page.getByLabel('How work leaves').selectOption('bundle');
  await page.getByRole('button', { name: 'Save' }).click();

  const listing = await (await page.request.get('/api/companies')).json();
  expect(listing.companies.find((c: { slug: string }) => c.slug === 'testwright-co').release)
    .toBe('bundle');
});

test('the report gives both windows, not whichever one was tightest', async ({ page }) => {
  // The five-hour reading used to be recorded only when it was the binding
  // window, so it disappeared from the record exactly as the week filled up —
  // and it is the one that decides whether the operator can work this
  // afternoon. The front page shows live readings; the record is here.
  await page.goto('/');
  await go(page, 'Vitals');

  await expect(page.getByText('five-hour usage')).toBeVisible();
  await expect(page.getByText('seven-day usage')).toBeVisible();
  const five = page.locator('dt', { hasText: 'five-hour usage' }).locator('+ dd');
  const week = page.locator('dt', { hasText: 'seven-day usage' }).locator('+ dd');
  await expect(five).toContainText('84%');
  await expect(week).toContainText('78%');
  // Past three quarters is the operator's problem, not only the company's.
  await expect(five).toHaveClass(/hot/);
});

test('vitals reports what the week cost and what it produced', async ({ page }) => {
  await go(page, 'Vitals');

  // The headline figures, off the sleeping events — the only place a shift's
  // turns and dollars are ever written down.
  const tiles = page.locator('.tile');
  await expect(tiles.filter({ hasText: 'shifts' }).locator('.tvalue')).toHaveText('2');
  await expect(tiles.filter({ hasText: 'list price' }).locator('.tvalue')).toHaveText('$0.60');
  await expect(tiles.filter({ hasText: 'barren' }).locator('.tvalue')).toHaveText('1');

  // A finding is a sentence, not a figure. A wall of numbers is something to
  // scroll past; this is the part somebody acts on.
  await expect(page.locator('.finding').filter({ hasText: 'left nothing behind' }))
    .toContainText('1 of 2 shifts');

  // Rule 6 is the claim the whole report exists to be able to contradict.
  const rule6 = page.locator('section').filter({ hasText: 'Commons — rule 6' });
  await expect(rule6).toContainText('refused as full');
  await expect(rule6).toContainText('revised');

  // Scoped by heading, never by position. These two tables are the only ones
  // on the page, so an empty refusals section would slide a positional
  // .first() onto the people table and fail with the wrong explanation.
  const refusals = page.locator('section').filter({ hasText: 'The gate' });
  await expect(refusals.locator('.grid')).toContainText('R6.commons_full');
  const who = page.locator('section').filter({ hasText: 'Who did the work' });
  await expect(who.locator('.grid')).toContainText('Fen');
});

/**
 * Types cover which fields exist. Nothing covers what is in them.
 *
 * A dropped field is caught twice over now — the server constructs a `Vitals`,
 * and the console imports that same type rather than restating it. A dropped
 * VALUE is caught by neither: `over()` is a discipline rather than a type, so a
 * future plain `a / b` yields NaN on 0/0 and Infinity on x/0. Both are
 * `number`, both typecheck, and `usd(NaN)` renders "$NaN" at a reader who has
 * no way to know it is not a figure. Infinity is worse over the wire, where
 * `JSON.stringify` turns it into null and the render throws instead.
 *
 * So this asserts the shape of what actually arrived: no figure on the page may
 * be empty, undefined, NaN or infinite.
 */
test('no figure in the report renders as a hole where a number should be', async ({ page }) => {
  await go(page, 'Vitals');
  await expect(page.locator('.tile').first()).toBeVisible();

  // x/0 is the likelier slip of the two, so Infinity belongs here as much as NaN.
  const holes = /^(|undefined|null|NaN|\$NaN|NaN%|—%|\$undefined|Infinity|\$Infinity|Infinity%|-Infinity)$/;

  // The section that says whether the company can still do something new.
  await expect(page.locator('section').filter({ hasText: 'Is it still finding things' }))
    .toContainText('carrying');

  const tiles = await page.locator('.tile .tvalue').allInnerTexts();
  expect(tiles.length).toBe(5);
  for (const t of tiles) expect(t.trim()).not.toMatch(holes);

  // Findings are prose built from the same figures, and a division by a duty
  // cycle of zero put "wrong by Infinity×" in one — which no dd or tile shows.
  for (const f of await page.locator('.finding').allInnerTexts()) {
    expect(f).not.toMatch(/undefined|NaN|Infinity/);
  }

  // Every figure in the six definition lists, and the sub-line under each tile.
  const figures = await page.locator('.cols dd, .tile .tsub').allInnerTexts();
  expect(figures.length).toBeGreaterThan(25);
  for (const f of figures) expect(f.trim()).not.toMatch(holes);

  // Both tables, scoped by heading rather than by position, and each held to
  // its own floor — one row of either would satisfy a count across the pair.
  for (const [heading, floor] of [['The gate', 4], ['Who did the work', 9]] as const) {
    const cells = page.locator('section').filter({ hasText: heading }).locator('.grid td');
    expect(await cells.count()).toBeGreaterThanOrEqual(floor);
    for (const c of await cells.allInnerTexts()) {
      expect(c.trim()).not.toMatch(/^(undefined|null|NaN|Infinity)$/);
    }
  }
});

// The arrows were coloured by direction rather than by whether the news was
// good, so a week that cost more than the last one rendered in the success
// colour. No typechecker catches that and none ever will: mapping a direction
// to the wrong colour is well-typed and simply wrong.
test('a trend arrow says which way it moved, and whether that is good news', async ({ page }) => {
  await go(page, 'Vitals');
  const dirOf = (label: string) =>
    page.locator('.tile').filter({ hasText: label }).locator('.tsub em');

  // The fixture is the company's first window, so every figure is up on a
  // previous window of nothing.
  await expect(dirOf('shifts')).toHaveText(/▲/);
  await expect(dirOf('shifts')).toHaveClass(/good/);

  // Consuming more than the window before is the same arrow and the opposite
  // reading — this is the pair that was rendering identically. Tokens are the
  // figure that means it; the dollars beside them are a list price nobody pays.
  await expect(dirOf('tokens')).toHaveText(/▲/);
  await expect(dirOf('tokens')).toHaveClass(/bad/);
  await expect(dirOf('list price')).toHaveText(/▲/);
  await expect(dirOf('list price')).toHaveClass(/bad/);
});

test('the vitals window is a choice, and changing it re-reads the record', async ({ page }) => {
  await go(page, 'Vitals');
  await expect(page.locator('.foot')).toContainText('7.days');

  // The selected window must be readable as selected without seeing colour.
  await expect(page.getByRole('button', { name: '7 days', pressed: true })).toBeVisible();

  await page.getByRole('button', { name: '24 hours' }).click();
  await expect(page.locator('.win.on')).toHaveText('24 hours');
  await expect(page.getByRole('button', { name: '24 hours', pressed: true })).toBeVisible();
  await expect(page.locator('.foot')).toContainText('24.hours');
  // The fixture was built moments ago, so a narrower window holds the same
  // work — what must change is the window the report says it read.
  await expect(page.locator('.tile').filter({ hasText: 'shifts' }).locator('.tvalue')).toHaveText('2');
});

/**
 * The company runs on a subscription, so the dollar figures are the SDK's
 * imputed list price and no invoice will ever match them. The report has to
 * say what actually depletes — tokens, and how much of the window is gone —
 * or it reads as a bill nobody receives.
 */
test('vitals says what was consumed, not only what it would have cost', async ({ page }) => {
  await go(page, 'Vitals');

  const tiles = page.locator('.tile');
  await expect(tiles.filter({ hasText: 'tokens' }).locator('.tvalue')).toHaveText('1.2M');
  // The money tile says what it is in its label, and the section says it in
  // words — whether or not there is usage to report, because the claim is
  // needed most when there are numbers beside it to misread.
  await expect(tiles.filter({ hasText: 'list price' })).toBeVisible();
  await expect(page.locator('section').filter({ hasText: 'What it consumed' }))
    .toContainText('billed by subscription and nobody is charged them');

  // A window is wall clock; the company only exists while its scheduler is up,
  // so the header says how much of the window was actually worked.
  await expect(page.locator('.foot')).toContainText(/worked \d+\.\d+h of it/);

  const consumed = page.locator('section').filter({ hasText: 'What it consumed' });
  await expect(consumed).toContainText('900.0K');   // read from cache
  await expect(consumed).toContainText('200.0K');   // actually written
  await expect(consumed).toContainText('84%');      // the tightest window
  await expect(consumed).toContainText('78%');      // of the week, which is what is planned around

  // The ceiling that can actually stop the company gets said in words, and it
  // is the weekly one — the only window that cannot recover overnight.
  await expect(page.locator('.finding').filter({ hasText: 'weekly subscription window' }))
    .toContainText('78%');
});

/**
 * The shell is the viewport. Only the main pane scrolls.
 *
 * A grid row sized 1fr still has min-height:auto, so the longest view grew
 * the row past the window instead of scrolling inside it: the document itself
 * scrolled and carried the rail and the status bar up off the top. It looks
 * like a rendering glitch and it is a one-property CSS bug, so it is measured
 * here rather than trusted to a screenshot.
 */
test('the page itself never scrolls, however long the view is', async ({ page }) => {
  await go(page, 'Vitals');
  await expect(page.locator('.tile').first()).toBeVisible();

  // The longest view in the console, at a height that cannot contain it.
  await page.setViewportSize({ width: 1280, height: 500 });
  await expect(page.locator('.foot')).toBeAttached();

  const doc = await page.evaluate(() => ({
    scrollHeight: document.documentElement.scrollHeight,
    clientHeight: document.documentElement.clientHeight,
  }));
  expect(doc.scrollHeight).toBeLessThanOrEqual(doc.clientHeight);

  // And the pane that should scroll, does — otherwise the assertion above
  // would also pass on a view whose content had been clipped away entirely.
  const main = await page.locator('.main').evaluate((el) => ({
    scrollHeight: el.scrollHeight, clientHeight: el.clientHeight,
  }));
  expect(main.scrollHeight).toBeGreaterThan(main.clientHeight);

  // Scrolling to the bottom of it must leave the rail and status bar put.
  const railBefore = (await page.locator('.rail').boundingBox())!.y;
  await page.locator('.main').evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await expect(page.locator('.status')).toBeInViewport();
  expect((await page.locator('.rail').boundingBox())!.y).toBe(railBefore);
});

test('a secret is set by name, shown by name, and never shown by value', async ({ page }) => {
  await go(page, 'Secrets');

  await page.locator('.fld.name').fill('OPENROUTER_API_KEY');
  await page.locator('.fld.val').fill('sk-or-v1-super-secret-value');
  await page.getByRole('button', { name: 'Save' }).click();

  // It appears by name in the list for this company...
  const row = page.locator('.item').filter({ hasText: 'OPENROUTER_API_KEY' });
  await expect(row).toHaveCount(1);
  // ...the value is nowhere on the page — write-only means it never comes back...
  await expect(page.locator('main')).not.toContainText('sk-or-v1-super-secret-value');
  // ...and the field itself is cleared, not merely masked, so nothing lingers.
  await expect(page.locator('.fld.val')).toHaveValue('');
  await expect(page.locator('.fld.name')).toHaveValue('');

  // Replace prefills the name and moves focus to the value field.
  await row.getByRole('button', { name: 'Replace' }).click();
  await expect(page.locator('.fld.name')).toHaveValue('OPENROUTER_API_KEY');
  await expect(page.locator('.fld.val')).toBeFocused();

  // Remove asks before it acts, and the confirm takes focus (a keyboard user is
  // never left with focus on nothing)...
  await row.getByRole('button', { name: 'Remove' }).click();
  await expect(row.getByRole('button', { name: 'Cancel' })).toBeFocused();
  // ...then the name is gone.
  await row.getByRole('button', { name: 'Yes' }).click();
  await expect(page.locator('.item').filter({ hasText: 'OPENROUTER_API_KEY' })).toHaveCount(0);
});

test('the installation default runtime credential is write-only, and can be set and removed', async ({ page }) => {
  await page.locator('.switcher').click();
  await page.getByRole('button', { name: /Riff settings/ }).click();
  await expect(page.locator('main h1').first()).toContainText(/Riff Settings/i);

  // Install-level screen: the rail sheds the per-company chrome (section nav,
  // run/staff footer) so it does not read as "inside a company looking at its
  // settings". The rail title names the installation, not the company.
  await expect(page.locator('.rail .co')).toContainText(/Riff settings/i);
  await expect(page.locator('.rail .sub')).toContainText(/installation/i);
  await expect(page.locator('.navitem')).toHaveCount(0);
  await expect(page.locator('footer.status')).toHaveCount(0);

  const set = page.locator('.set');
  // A type alone is not a credential: Save stays inert until a token is entered,
  // so a stray click can never store a valueless default.
  await expect(set.getByRole('button', { name: 'Save' })).toBeDisabled();
  await page.locator('#rc-type').selectOption('apiKey');
  await expect(set.getByRole('button', { name: 'Save' })).toBeDisabled();

  await page.locator('#rc-value').fill('sk-ant-super-secret-default');
  await set.getByRole('button', { name: 'Save' }).click();

  // Write-only: the value is nowhere on the page and the field is cleared, not
  // masked — only the type and "a value is set" come back.
  await expect(page.locator('main')).not.toContainText('sk-ant-super-secret-default');
  await expect(page.locator('#rc-value')).toHaveValue('');
  // The durable "it is set" signal is the badge — a persistent indicator, not
  // just the transient "Saved." message (the operator could not tell the two
  // apart on reload, which is why this became a badge).
  await expect(set.locator('.badge.is-set')).toContainText(/Set/);
  await expect(set.locator('.badge.is-set')).toContainText(/API key/);

  // Remove clears both the type and the vault value, behind a confirm — the
  // badge flips back to not-set. (Left clear so the next test starts unset.)
  await set.getByRole('button', { name: 'Remove default' }).click();
  await set.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(set.locator('.badge.not-set')).toBeVisible();
  await expect(set.locator('.badge.is-set')).toHaveCount(0);
});

test('the switcher returns from an install view to the active company', async ({ page }) => {
  // Hiding the section nav on install views (so Riff settings does not read as
  // "inside a company") removed the in-view way back. The switcher is the only
  // gesture left, so re-picking the company you are already on must leave the
  // install view — not silently no-op, which stranded a single-company install.
  await page.locator('.switcher').click();
  await page.getByRole('button', { name: /Riff settings/ }).click();
  await expect(page.locator('.navitem')).toHaveCount(0);
  await expect(page.locator('footer.status')).toHaveCount(0);

  await page.locator('.switcher').click();
  await page.locator('.menuitem.on').click();
  await expect(page.locator('.navitem').first()).toBeVisible();
  await expect(page.locator('footer.status')).toBeVisible();
});

test('a company runtime-credential override is write-only, and revertible to the default', async ({ page }) => {
  // Overview's own h1 is the company name, so reach it by the rail button and its
  // section heading rather than the generic `go` helper.
  await page.getByRole('button', { name: /^Overview/ }).click();
  const rc = page.locator('.rc');
  await expect(rc.locator('h2')).toHaveText('Runtime credential');

  // A pristine, inheriting company: Save is disabled (no token), status says so.
  await expect(rc.locator('.rc-status')).toContainText(/Inheriting the installation default/);
  await expect(rc.getByRole('button', { name: 'Save' })).toBeDisabled();

  // Override it — a type picked alongside its token.
  await page.locator('#co-rc-type').selectOption('apiKey');
  await page.locator('#co-rc-value').fill('sk-ant-company-secret-value');
  await rc.getByRole('button', { name: 'Save' }).click();

  // Write-only: token gone from the page, field cleared; status flips to its own.
  await expect(page.locator('main')).not.toContainText('sk-ant-company-secret-value');
  await expect(page.locator('#co-rc-value')).toHaveValue('');
  await expect(rc.locator('.rc-status')).toContainText(/Using its own credential/);
  await expect(rc.locator('.rc-status')).toContainText(/API key/);

  // Revert to the installation default, and the panel returns to inheriting.
  await rc.getByRole('button', { name: 'Use installation default' }).click();
  await expect(rc.locator('.rc-status')).toContainText(/Inheriting the installation default/);
  await expect(rc.getByRole('button', { name: 'Save' })).toBeDisabled();
});

test('a service route is set by name, shows its upstream, and warns when its secret is unset', async ({ page }) => {
  await go(page, 'Services');

  await page.locator('.srv.name').fill('openrouter');
  await page.locator('.srv.up').fill('https://openrouter.ai/api/v1');
  await page.locator('.srv.secret').fill('OPENROUTER_API_KEY');
  // No secret of that name is set, so the form says so before the route is even
  // saved — the coupling between a route and the key it names is made visible.
  await expect(page.locator('.warn')).toContainText('OPENROUTER_API_KEY');
  await page.getByRole('button', { name: 'Add' }).click();

  // It appears as a route: the name, and the upstream it forwards to.
  const route = page.locator('.route').filter({ hasText: 'openrouter' });
  await expect(route).toHaveCount(1);
  await expect(route).toContainText('https://openrouter.ai/api/v1');
  // The route carries no value — only the secret's NAME and the header it lands on.
  await expect(route).toContainText('Authorization: Bearer <OPENROUTER_API_KEY>');
  // And the list flags that the named secret is not set yet.
  await expect(route.locator('.badge')).toHaveText('secret not set');
  // The form cleared after the write.
  await expect(page.locator('.srv.name')).toHaveValue('');

  // Edit prefills the form and locks the name (it keys the route), moving focus
  // to the upstream.
  await route.getByRole('button', { name: 'Edit' }).click();
  await expect(page.locator('.srv.name')).toHaveValue('openrouter');
  await expect(page.locator('.srv.name')).toHaveAttribute('readonly', '');
  await expect(page.locator('.srv.up')).toBeFocused();
  await page.getByRole('button', { name: 'Cancel' }).click();

  // Remove asks first, and the confirm takes focus...
  await route.getByRole('button', { name: 'Remove' }).click();
  await expect(route.getByRole('button', { name: 'Cancel' })).toBeFocused();
  // ...then the route is gone.
  await route.getByRole('button', { name: 'Yes' }).click();
  await expect(page.locator('.route').filter({ hasText: 'openrouter' })).toHaveCount(0);
});

test('a service route carries static headers, and they round-trip through edit', async ({ page }) => {
  await go(page, 'Services');

  await page.locator('.srv.name').fill('anthropic');
  await page.locator('.srv.up').fill('https://api.anthropic.com');
  await page.locator('.srv.secret').fill('ANTHROPIC_AUTH_TOKEN');

  // Static headers live behind the advanced toggle — the OAuth/subscription shape.
  await page.getByRole('button', { name: /static headers/ }).click();
  await page.getByRole('button', { name: '+ Add header' }).click();
  await page.locator('.srv.hk').fill('anthropic-beta');
  await page.locator('.srv.hv').fill('oauth-2025-04-20');
  // Exact, so 'Add' does not also match the '+ Add header' button.
  await page.getByRole('button', { name: 'Add', exact: true }).click();

  // The route lists the static header as a chip beside the credential line.
  const route = page.locator('.route').filter({ hasText: 'anthropic' });
  await expect(route).toHaveCount(1);
  await expect(route).toContainText('anthropic-beta: oauth-2025-04-20');

  // Edit prefills the header row, so a saved header round-trips rather than being
  // silently dropped the next time the route is saved.
  await route.getByRole('button', { name: 'Edit' }).click();
  await expect(page.locator('.srv.hk')).toHaveValue('anthropic-beta');
  await expect(page.locator('.srv.hv')).toHaveValue('oauth-2025-04-20');
});
