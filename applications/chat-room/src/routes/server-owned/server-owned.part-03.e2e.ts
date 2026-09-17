import { expect, test } from '@playwright/test';
import {
  APPROVAL_FOLLOW_UP_TEXT,
  APPROVAL_NOTE_TEXT,
  fixtureMarker,
  gotoHydrated,
  newFixtureMarker,
  readCreatedConversation,
  uniqueTitle,
} from './server-owned-test-helpers';

test('a person approves the note in the browser and the turn completes', async ({ page }) => {
  // The whole point of the elicitation path, driven the way a person drives
  // it. The request-fixture specs above prove the endpoints; this proves there
  // is a way to reach them without one — which is what makes the feature
  // operable rather than merely present.
  await gotoHydrated(page, '/server-owned');
  const title = uniqueTitle('Browser approval');
  await page.locator('[data-testid="server-owned-new-title"]').fill(title);
  await page.locator('[data-testid="server-owned-create"]').click();

  // Creating ADDS TO THE LIST; it does not navigate. Following the new
  // conversation's own link is how a person reaches the detail route, and
  // asserting on that link by title is what keeps this test independent of
  // every other conversation the suite leaves behind in the shared process.
  await page.getByRole('link', { name: new RegExp(title) }).click();
  await page.waitForSelector('body[data-hydrated="true"]');

  const question = page.locator('[data-testid="approval-question"]');

  // Mounted and empty before anything asks — the same live-region rule every
  // announcing region in this lab follows.
  await expect(question).toHaveCount(1);
  await expect(question).toBeEmpty();
  await expect(page.locator('[data-testid="approval-approve"]')).toHaveCount(0);

  const marker = newFixtureMarker();
  const composer = page.getByRole('textbox');
  await composer.fill(fixtureMarker('approval', marker));
  await composer.press('Enter');

  await expect(question).toContainText('Save this note?');
  await expect(question).toContainText('remember_note');

  // The MODEL'S own argument, so the person approves a specific note — in its
  // own disclosure rather than inside the announcement. A note has no length
  // limit, and rendering it inline took the transcript's space on a short
  // viewport; `<summary>` also gives the keyboard path for free, which a
  // bounded scroll box could not without a dead tab stop.
  const proposed = page.locator('[data-testid="approval-arguments"]');
  await expect(proposed).toContainText('remember_note');
  await proposed.getByRole('group').or(proposed.locator('summary')).first().click();
  await expect(proposed).toContainText(APPROVAL_NOTE_TEXT);

  await page.locator('[data-testid="approval-approve"]').click();

  // SETTLED FIRST, then judged. The ordering is the whole difference between
  // this test and the hollow version it replaces: `toBeEmpty()` on the failure
  // banner passes the instant it is called, so checking it before the turn
  // finished passed even with the continuation bug deliberately restored.
  // `data-streaming` only flips false after the controller's continuation loop
  // has run to its end, which is where that failure lands.
  await expect(page.locator('[data-testid="server-owned-chat"]')).toHaveAttribute(
    'data-streaming',
    'false',
  );

  // The assistant's REPLY arrived, which is what "the turn completed" means.
  // The approved tool alone proves only that the side effect ran; the follow-up
  // is what the run produced after it, in the same response.
  await expect(page.locator('[data-testid="server-owned-chat"]')).toContainText(
    APPROVAL_FOLLOW_UP_TEXT,
  );

  // And no failure. This is the regression that made the browser path
  // unusable: the tool succeeded server-side, the session controller asked for
  // a continuation, and the transport threw — marking the turn failed right
  // after its side effect had landed.
  await expect(page.locator('[data-testid="server-owned-turn-failure"]')).toBeEmpty();

  // And the controls are gone, because a question that is answered is not a
  // control anyone should be able to press again.
  await expect(page.locator('[data-testid="approval-approve"]')).toHaveCount(0);
  await expect(question).toBeEmpty();

  // THE PERSISTED ORDER IS THE CORRECT ONE, and it is what this pins.
  //
  // Live, the two model steps of one response land in a single assistant row
  // and the follow-up text renders ABOVE the tool disclosure it is replying
  // about — the session controller inserts one assistant placeholder before
  // reading any frames, so the second step's text goes back into a row that
  // already precedes the tool activity. Measured:
  //
  //   live:   You … | Assistant "Saved that note." Called 1 tool … Succeeded
  //   reload: You … | Assistant Called 1 tool … Succeeded | Assistant "Saved that note."
  //
  // Delineating assistant steps belongs to the wire and the controller in
  // `@repo/chat`, which this issue's delivery boundary excludes —
  // CIN-615 carries it with these measurements. What is asserted here is the
  // half that IS this route's to keep true: the server's own history, which a
  // reload renders, puts the tool before the reply.
  await page.reload();
  await page.waitForSelector('body[data-hydrated="true"]');

  const persisted = await page
    .locator('[data-testid="server-owned-chat"]')
    .evaluate((root) => (root.textContent ?? '').replace(/\s+/g, ' ').trim());

  const toolAt = persisted.indexOf('remember_note');
  const replyAt = persisted.indexOf(APPROVAL_FOLLOW_UP_TEXT);
  expect(toolAt).toBeGreaterThan(-1);
  expect(replyAt).toBeGreaterThan(-1);
  expect(toolAt).toBeLessThan(replyAt);
});

test('the transcript survives a short viewport instead of collapsing to nothing', async ({
  page,
  request,
}) => {
  // A REGRESSION TEST for a measured collapse, not a precaution. The detail
  // route is a fixed-height flex column, and adding the approval region and
  // the recovery panel to it gave the non-flexible children more than the
  // viewport: at 844x390 the transcript and composer resolved to exactly 0px,
  // leaving a page nobody could read or type into.
  //
  // The assertion is on the RENDERED HEIGHT rather than on the CSS, because
  // the CSS that produced the collapse was individually reasonable — a fixed
  // `100dvh` column and a `min-block-size: 0` flex child — and only the
  // combination was wrong. A rule-shaped assertion would have passed.
  const created = await request.post('/api/server-owned/conversations', {
    data: { title: uniqueTitle('Short viewport') },
  });
  const conversation = await readCreatedConversation(created);

  // Phone landscape, the shape this was measured collapsing at.
  await page.setViewportSize({ width: 844, height: 390 });
  await gotoHydrated(page, `/server-owned/${conversation.id}`);

  // Measured with the recovery panel CLOSED, which is how it loads. That is
  // the fix: expanded it consumed 200-285px of a fixed-height column whose
  // only flexible child is the transcript.

  const height = await page
    .locator('[data-testid="server-owned-chat"]')
    .evaluate((element) => Math.round(element.getBoundingClientRect().height));

  // A floor, not an exact number: the point is that the transcript is usable,
  // and pinning the precise height would fail on every future change to the
  // panel's copy.
  expect(height).toBeGreaterThan(100);

  // And the composer is reachable, which is the other half of usable — a
  // transcript with a floor still fails the user if the page cannot scroll to
  // what sits below it.
  await expect(page.getByRole('textbox')).toBeVisible();
});

test('a denied note leaves no tool row pending in the browser', async ({ page }) => {
  // The BROWSER half of the denial. The endpoint spec above reads the wire;
  // this reads what a person is left looking at, which is where the defect
  // actually showed: the client renders a pending row from `tool_call` and
  // settles it on a result, so a denial that produced no result left that row
  // pending until another turn or a reload cleared it.
  await gotoHydrated(page, '/server-owned');
  const title = uniqueTitle('Browser denial');
  await page.locator('[data-testid="server-owned-new-title"]').fill(title);
  await page.locator('[data-testid="server-owned-create"]').click();
  await page.getByRole('link', { name: new RegExp(title) }).click();
  await page.waitForSelector('body[data-hydrated="true"]');

  const marker = newFixtureMarker();
  const composer = page.getByRole('textbox');
  await composer.fill(fixtureMarker('approval', marker));
  await composer.press('Enter');

  await expect(page.locator('[data-testid="approval-question"]')).toContainText('Save this note?');
  await page.locator('[data-testid="approval-deny"]').click();

  await expect(page.locator('[data-testid="server-owned-chat"]')).toHaveAttribute(
    'data-streaming',
    'false',
  );

  // SETTLED, and settled as a refusal. The row reads `remember_note Failed`
  // rather than staying pending — which is the whole finding: the client
  // renders a pending row from the `tool_call` frame and resolves it on a
  // result, and a denial used to produce no result at all.
  //
  // `Failed` is the rendered state; the message itself sits inside the row's
  // Result disclosure, so asserting the status is asserting what a reader
  // actually sees without opening anything.
  const chat = page.locator('[data-testid="server-owned-chat"]');
  await expect(chat).toContainText('remember_note');
  await expect(chat).toContainText('Failed');

  // The turn itself did not fail — a denial is a decision, not an error.
  await expect(page.locator('[data-testid="server-owned-turn-failure"]')).toBeEmpty();
});

test('a long approval question leaves the transcript its space', async ({ page }) => {
  // The gap the idle viewport test leaves: it measures before anything is
  // pending, and the approval question is the one region that appears MID-TURN
  // and renders content whose length the model chooses. The tool's schema puts
  // no limit on `text`, so an unbounded prompt grows with whatever was written
  // — inside a fixed-viewport-height column whose only flexible child is the
  // transcript.
  //
  // The `approval-long` fixture scenario proposes a note long enough to show
  // it. A short note could not: the defect is proportional to the argument.
  await page.setViewportSize({ width: 844, height: 390 });
  await gotoHydrated(page, '/server-owned');
  const title = uniqueTitle('Long approval');
  await page.locator('[data-testid="server-owned-new-title"]').fill(title);
  await page.locator('[data-testid="server-owned-create"]').click();
  await page.getByRole('link', { name: new RegExp(title) }).click();
  await page.waitForSelector('body[data-hydrated="true"]');

  const chat = page.locator('[data-testid="server-owned-chat"]');
  const idleHeight = await chat.evaluate((element) =>
    Math.round(element.getBoundingClientRect().height),
  );

  const marker = newFixtureMarker();
  const composer = page.getByRole('textbox');
  await composer.fill(fixtureMarker('approval-long', marker));
  await composer.press('Enter');

  const question = page.locator('[data-testid="approval-question"]');
  await expect(question).toContainText('Save this note?');

  // MEASURED WHILE THE QUESTION IS UP, which is the whole point — the idle
  // measurement in the sibling test cannot see a region that only exists
  // mid-turn and whose size the model chooses.
  const metrics = await page.evaluate(() => {
    const chatElement = document.querySelector('[data-testid="server-owned-chat"]');
    const proposed = document.querySelector('[data-testid="approval-arguments"]');
    return {
      chat: chatElement ? Math.round(chatElement.getBoundingClientRect().height) : -1,
      proposed: proposed ? Math.round(proposed.getBoundingClientRect().height) : -1,
      // Closed on arrival, which is what keeps it to one line.
      open: proposed instanceof HTMLDetailsElement ? proposed.open : true,
    };
  });

  // The transcript is still usable. A floor rather than an exact number: the
  // claim is that a long note cannot consume the transcript, not that the
  // layout never changes.
  expect(metrics.chat).toBeGreaterThan(100);
  // And the note costs one line until someone asks for it, however long it is.
  expect(metrics.open).toBe(false);
  expect(metrics.proposed).toBeLessThan(idleHeight);

  // Answer it, so the turn does not stay parked for the next test in this file.
  await page.locator('[data-testid="approval-deny"]').click();
  await expect(chat).toHaveAttribute('data-streaming', 'false');
});
