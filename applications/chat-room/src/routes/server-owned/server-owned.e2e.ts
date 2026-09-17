import { expect, test } from '@playwright/test';
import {
  defined,
  gotoHydrated,
  readConversationIds,
  readCreatedConversation,
  readErrorText,
  readMessageCount,
  readServerOwnedMessages,
  uniqueTitle,
} from './server-owned-test-helpers';

test('labels itself as the noncanonical variant', async ({ page }) => {
  await gotoHydrated(page, '/server-owned');

  const banner = page.locator('[data-testid="server-owned-banner"]');
  await expect(banner).toBeVisible();
  await expect(banner).toContainText('Noncanonical variant');

  // Points at the canonical exemplar by name, so a reader who lands here
  // first knows where the reference implementation is rather than assuming
  // this is it.
  await expect(banner.locator('a')).toHaveAttribute('href', '/');

  // Standing context, not an event: `alert` would be announced ahead of the
  // page's own heading on every visit.
  await expect(banner).toHaveAttribute('role', 'note');
});

test('server-renders the conversation list into the navigation response', async ({ request }) => {
  // The defining contract of this route family, asserted where it is actually
  // observable: in the bytes the server sends, before any script runs.
  //
  // Every other list assertion in this family runs after
  // `body[data-hydrated="true"]`, so moving the list into browser-side
  // startup would leave all of them green while deleting the one property
  // that makes this variant different from the canonical exemplar. Reading
  // the raw response is the only check that notices.
  const title = uniqueTitle('Server rendered');
  const created = await request.post('/api/server-owned/conversations', { data: { title } });
  expect(created.status()).toBe(201);

  const page = await request.get('/server-owned');
  expect(page.status()).toBe(200);
  const html = await page.text();

  // Scoped to the LIST ELEMENT, not searched across the whole document, and
  // the difference is the entire value of this test. SvelteKit serializes the
  // server `load` result into the response for hydration, so `title` appears
  // in a trailing script regardless of what the `{#each}` rendered —
  // `expect(html).toContain(title)` would pass against a list that rendered
  // nothing, which is precisely the regression this is here to catch. An
  // empty `<ul>` would likewise still supply the list marker.
  const listStart = html.indexOf('data-testid="server-owned-list"');
  expect(listStart).toBeGreaterThan(-1);
  const listEnd = html.indexOf('</ul>', listStart);
  expect(listEnd).toBeGreaterThan(listStart);
  const list = html.slice(listStart, listEnd);

  // A row, its title link, and this conversation's title — all inside that
  // slice, so all of them came from the server's own render.
  expect(list).toContain('data-testid="server-owned-conversation"');
  expect(list).toContain('data-testid="server-owned-conversation-title"');
  expect(list).toContain(title);

  // And the live region the create form announces through is in the document
  // too, rather than mounted later by the browser — the same "exists before
  // it has anything to say" rule `error-live-regions.e2e.ts` enforces, here
  // pinned one step earlier, at the server.
  expect(html).toContain('data-testid="server-owned-failure"');
});

test('rejects an empty title at the endpoint rather than storing it', async ({ request }) => {
  // "rather than storing it" is half the claim, and the status code cannot
  // speak to it: a handler that created an empty-titled session and THEN
  // returned 400 would satisfy every assertion below except the last pair,
  // while quietly polluting the list every run.
  const before = await request.get('/api/server-owned/conversations');
  expect(before.status()).toBe(200);
  const listedBefore = await readConversationIds(before);

  const response = await request.post('/api/server-owned/conversations', {
    data: { title: '   ' },
  });

  // 400, and the reason — not a 500 from something downstream discovering
  // the problem later, and not the submitted value echoed back.
  expect(response.status()).toBe(400);
  expect(await readErrorText(response)).toContain('title');

  // And nothing was written. Compared by ID rather than by count, so a
  // concurrent create from another test in the same file cannot make this
  // pass or fail for the wrong reason.
  const after = await request.get('/api/server-owned/conversations');
  const listedAfter = await readConversationIds(after);
  const added = listedAfter.filter((id) => !listedBefore.includes(id));
  expect(added).toEqual([]);
});

test('appends a turn and reports the new count', async ({ request }) => {
  const created = await request.post('/api/server-owned/conversations', {
    data: { title: uniqueTitle('Appending') },
  });
  expect(created.status()).toBe(201);
  const conversation = await readCreatedConversation(created);

  const appended = await request.post(`/api/server-owned/conversations/${conversation.id}/turns`, {
    data: { text: 'What shipped this week?' },
  });
  expect(appended.status()).toBe(201);
  expect(await readMessageCount(appended)).toBe(1);

  const loaded = await request.get(`/api/server-owned/conversations/${conversation.id}`);
  expect(loaded.status()).toBe(200);
  const messages = await readServerOwnedMessages(loaded);
  expect(messages).toHaveLength(1);
  const message = defined(messages[0], 'loaded conversation message');
  expect(message.role).toBe('user');

  // The submitted TEXT, not just a message of the right role. A handler that
  // passed a constant — or the wrong field of the request body — to
  // `appendUserTurn` satisfies the count and the role, and the service-level
  // tests call `appendUserTurn` directly, so nothing else covers the wiring
  // from this request body to that argument.
  expect(message.content).toBe('What shipped this week?');
});

test('distinguishes a missing conversation from an empty one', async ({ request }) => {
  const created = await request.post('/api/server-owned/conversations', {
    data: { title: uniqueTitle('Empty') },
  });
  const conversation = await readCreatedConversation(created);

  // Exists, no messages: 200 with an empty transcript.
  const empty = await request.get(`/api/server-owned/conversations/${conversation.id}`);
  expect(empty.status()).toBe(200);
  expect(await readServerOwnedMessages(empty)).toHaveLength(0);

  // Gone: 404 on both read and append. Collapsing these into one response
  // would leave the page unable to tell "start typing" from "this is gone".
  const missingResponse = await request.get('/api/server-owned/conversations/nope');
  expect(missingResponse.status()).toBe(404);
  const missingTurnResponse = await request.post('/api/server-owned/conversations/nope/turns', {
    data: { text: 'hi' },
  });
  expect(missingTurnResponse.status()).toBe(404);
});

test('centres its capped column instead of pinning it to the left edge', async ({ page }) => {
  // The route caps `main` at 48rem for readability. Capping WITHOUT centring
  // leaves that column against the left edge on any viewport wider than the
  // cap, with the rest of the window empty — which is how it shipped, and is
  // the one route in this lab that set a cap and not the centring.
  //
  // Asserted as symmetry rather than as a computed style: `margin-inline: auto`
  // is one way to achieve it, and this should not fail if the layout is
  // recentred by different means.
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto('/server-owned');

  const box = await page.locator('main').boundingBox();
  expect(box).not.toBeNull();
  if (box === null) return;

  const viewport = page.viewportSize();
  expect(viewport).not.toBeNull();
  if (viewport === null) return;

  // Narrower than the viewport, or the cap is not in effect and this asserts
  // nothing.
  expect(box.width).toBeLessThan(viewport.width);

  const left = box.x;
  const right = viewport.width - (box.x + box.width);
  expect(Math.abs(left - right)).toBeLessThanOrEqual(2);
});

test('reports a conversation with no in-flight run as nothing to resume', async ({ request }) => {
  // The benign branch, and the one that must NOT be confused with an orphan.
  // A fresh conversation has never had a run, so `recover()` answers `null`
  // with an empty `failures` array — which is a healthy idle session, not a
  // lost one.
  //
  // Worth pinning precisely because both branches return `null` from
  // `recover()`: if the endpoint ever stops reading the emitter, THIS test
  // keeps passing while the orphan case silently reports benign. So it is the
  // weaker half of the pair and is named as such.
  const created = await request.post('/api/server-owned/conversations', {
    data: { title: uniqueTitle('Recovery') },
  });
  expect(created.status()).toBe(201);
  const conversation = await readCreatedConversation(created);

  // POST, not GET. Asking RECONCILES a stranded run, so the question is not
  // safely repeatable — a prefetch or an infrastructure retry would spend the
  // only orphan diagnosis before anyone saw it.
  const recovery = await request.post(
    `/api/server-owned/conversations/${conversation.id}/recovery`,
  );
  expect(recovery.status()).toBe(200);
  // `durability` rides along on every outcome, because "nothing to resume" is
  // the TRUTH under in-memory storage and a bug-shaped surprise under on-disk
  // storage. The suite runs with the variable unset, so `in-memory` is the
  // expected answer here — and asserting it pins that the suite is exercising
  // the default rather than inheriting a database from someone's experiment.
  expect(await recovery.json()).toEqual({
    kind: 'nothing-to-resume',
    durability: 'in-memory',
    // EMPTY, and asserted rather than omitted: this is the signal that
    // distinguishes "no run was ever orphaned" from "one was, and you have
    // already been told". A conversation that has never had a run must report
    // the first, and an exact match is what keeps the two apart.
    previouslyOrphaned: [],
  });
});

test('distinguishes a missing conversation from one with nothing to resume', async ({
  request,
}) => {
  // A 404 rather than a cheerful `nothing-to-resume`, which is the same
  // distinction the conversation endpoint makes: "this does not exist" and
  // "this exists and is idle" are different answers, and collapsing them
  // would let a typo in an id read as a healthy session.
  const missing = await request.post(
    '/api/server-owned/conversations/does-not-exist-at-all/recovery',
  );
  expect(missing.status()).toBe(404);
  expect(await missing.json()).toEqual({ error: 'No such conversation.' });
});
