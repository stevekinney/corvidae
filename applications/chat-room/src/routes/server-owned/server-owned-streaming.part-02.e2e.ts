import { expect, test } from '@playwright/test';
import {
  defined,
  gotoHydrated,
  readCreatedConversation,
  uniqueTitle,
} from './server-owned-streaming-test-helpers';

test('moving between two conversations does not carry the first transcript into the second', async ({
  page,
  request,
}) => {
  // SvelteKit REUSES a page component when only a route parameter changes, so
  // a client-side `/server-owned/A` → `/server-owned/B` updates `data` without
  // re-running the surface's one-time mirror seed. Left unfixed, the heading
  // and the transport URL name B while `<Chat>` still renders A's transcript,
  // and the next submission is persisted to B underneath A's visible history.
  //
  // LATENT rather than live today, and worth saying so plainly: nothing in the
  // app links one conversation to another, and browser back between two
  // separately-loaded documents is a real navigation rather than a routed one.
  // It becomes live the moment any detail-to-detail link exists — a "next
  // conversation" control, a sidebar, a search result. The `{#key}` makes it
  // structurally impossible rather than waiting for that link to arrive.
  const titles = [uniqueTitle('First'), uniqueTitle('Second')];
  const ids: string[] = [];
  for (const title of titles) {
    const created = await request.post('/api/server-owned/conversations', { data: { title } });
    expect(created.status()).toBe(201);
    const conversation = await readCreatedConversation(created);
    ids.push(conversation.id);
  }

  // A DISTINCT turn in each, not just the one being navigated away from. With
  // an empty destination, a broken remount that always initialised a fresh
  // empty history would satisfy "A's text is gone and no articles remain" —
  // it would be discarding B's real transcript and passing for it.
  const turns = [
    'Only the first conversation has this line',
    'Only the second conversation has this line',
  ];
  for (const [index, text] of turns.entries()) {
    const id = defined(ids[index], `conversation id ${index}`);
    const appended = await request.post(`/api/server-owned/conversations/${id}/turns`, {
      data: { text },
    });
    expect(appended.status()).toBe(201);
  }
  const firstId = defined(ids[0], 'first conversation id');
  const secondId = defined(ids[1], 'second conversation id');
  const onlyInFirst = defined(turns[0], 'first conversation turn');
  const onlyInSecond = defined(turns[1], 'second conversation turn');
  const secondTitle = defined(titles[1], 'second conversation title');

  await gotoHydrated(page, `/server-owned/${firstId}`);
  const log = page.getByRole('log', { name: 'Messages' });
  await expect(log).toContainText(onlyInFirst);

  // The anchor stands in for the link this route family does not have yet.
  // Clicking a same-origin anchor is what SvelteKit's router intercepts, so
  // this drives the real client-side path rather than simulating it — and it
  // is the path any future detail-to-detail link would take.
  await page.evaluate((href) => {
    const anchor = document.createElement('a');
    anchor.href = href;
    anchor.id = 'cross-conversation-probe';
    anchor.textContent = 'probe';
    document.body.append(anchor);
  }, `/server-owned/${secondId}`);

  // A marker that survives only if the document was NOT replaced. Without it
  // this could pass for the wrong reason: a full reload rebuilds everything,
  // so the test would go green while never exercising the component reuse the
  // bug lives in.
  await page.evaluate(() => {
    Reflect.set(window, 'sameDocument', true);
  });
  await page.locator('#cross-conversation-probe').click();

  await expect(page.getByTestId('server-owned-title')).toHaveText(secondTitle);
  expect(await page.evaluate(() => Reflect.get(window, 'sameDocument') === true)).toBe(true);

  // THREE claims, and each rules out a different wrong behaviour: the stale
  // transcript is gone (no reset), the destination's own transcript is present
  // (reset to empty rather than to B), and exactly one turn is rendered
  // (neither merged).
  await expect(log).not.toContainText(onlyInFirst);
  await expect(log).toContainText(onlyInSecond);
  await expect(log.getByRole('article')).toHaveCount(1);
});

test('a long unbroken title wraps instead of widening the page', async ({ page, request }) => {
  // 120 characters with no space in them — the longest the input accepts, and
  // nothing requires a title to contain a break opportunity. A flex item's
  // automatic minimum size is its min-content width, so without an explicit
  // `min-inline-size: 0` and a wrapping rule this pushes the row and the page
  // past the viewport, and a reader at 320px or high zoom has to scroll
  // sideways to read a list.
  const unbroken = `Unbreakable-${Date.now().toString(36)}-`.padEnd(120, 'x').slice(0, 120);
  const created = await request.post('/api/server-owned/conversations', {
    data: { title: unbroken },
  });
  expect(created.status()).toBe(201);

  // 320px is the narrowest viewport the repository's own responsive rules
  // target, and it is where this shows up first.
  await page.setViewportSize({ width: 320, height: 720 });
  await gotoHydrated(page, '/server-owned');

  const row = page
    .locator('[data-testid="server-owned-conversation"]')
    .filter({ hasText: unbroken });
  await expect(row).toHaveCount(1);

  const metrics = await page.evaluate(() => ({
    bodyScrollWidth: document.body.scrollWidth,
    documentScrollWidth: document.documentElement.scrollWidth,
    viewportWidth: window.innerWidth,
  }));

  // The page does not scroll sideways, which is the property. The title
  // wrapping is the mechanism, and asserting the mechanism directly would
  // break on any equivalent fix.
  expect(metrics.bodyScrollWidth).toBeLessThanOrEqual(metrics.viewportWidth);
  expect(metrics.documentScrollWidth).toBeLessThanOrEqual(metrics.viewportWidth);

  // And it is still readable rather than clipped to nothing: the row grew
  // taller to fit the wrapped title.
  const height = await row.evaluate((element) => element.getBoundingClientRect().height);
  expect(height).toBeGreaterThan(40);
});

test("a rejected turn shows the server's sentence, not its JSON envelope", async ({
  page,
  request,
}) => {
  // Every non-streaming failure from the stream endpoint is JSON — `{ error }`
  // for the 400s, the 404, and the 503 when the key is unset. Throwing
  // `response.text()` put the whole envelope in the banner, so a user and a
  // screen reader both got `{"error":"..."}`.
  //
  // Driven through the 404 path, which needs no configuration change: the
  // page's own fetch target is rewritten to a conversation id that does not
  // exist, so the next turn's POST is rejected before any NDJSON starts.
  //
  // Nothing is deleted. An earlier version of this comment said the session
  // was removed from under the page, which would have made this read as
  // coverage for a real load-to-submit deletion race — it is not, and
  // treating it as such would leave that race untested while looking tested.
  const created = await request.post('/api/server-owned/conversations', {
    data: { title: uniqueTitle('Envelope') },
  });
  expect(created.status()).toBe(201);
  const conversation = await readCreatedConversation(created);

  await gotoHydrated(page, `/server-owned/${conversation.id}`);

  // A conversation id that does not exist, reached by rewriting the page's own
  // fetch target — simpler than deleting a session, and it exercises the same
  // 404 branch the endpoint takes for a missing conversation.
  await page.route('**/api/server-owned/conversations/*/stream', (route) =>
    route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'No such conversation.' }),
    }),
  );

  await page.getByRole('textbox', { name: 'Message' }).fill('Anything at all');
  await page.getByRole('button', { name: 'Send message' }).click();

  const banner = page.getByTestId('server-owned-turn-failure');
  await expect(banner).toContainText('No such conversation.');

  // The sentence, and nothing of the envelope around it.
  await expect(banner).not.toContainText('{');
  await expect(banner).not.toContainText('"error"');
});

test('two conversations sharing a title are distinguishable to a screen reader', async ({
  page,
  request,
}) => {
  // The create endpoint permits duplicate titles, so two rows can carry the
  // same visible text and the same message count. Their URLs are opaque UUIDs,
  // which means a links list would offer two identically named destinations
  // and the only way to tell them apart would be to open both.
  const shared = uniqueTitle('Shared');
  for (let n = 0; n < 2; n += 1) {
    const created = await request.post('/api/server-owned/conversations', {
      data: { title: shared },
    });
    expect(created.status()).toBe(201);
  }

  await gotoHydrated(page, '/server-owned');

  const links = page
    .locator('[data-testid="server-owned-conversation"]')
    .filter({ hasText: shared })
    .locator('[data-testid="server-owned-conversation-title"]');
  await expect(links).toHaveCount(2);

  // The VISIBLE text is identical — that is the premise, not a defect.
  const visible = await links.allInnerTexts();
  expect(visible[0]).toBe(visible[1]);

  // The ACCESSIBLE names are not, which is the property. Both still open with
  // the title, so the announcement leads with what the user was looking for.
  const names = await links.evaluateAll((elements) =>
    elements.map((element) => element.getAttribute('aria-label') ?? ''),
  );
  expect(names[0]).not.toBe(names[1]);
  for (const name of names) expect(name.startsWith(shared)).toBe(true);
});
