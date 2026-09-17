import { expect, test } from '@playwright/test';
import {
  gotoHydrated,
  readCreatedConversation,
  uniqueTitle,
} from './server-owned-streaming-test-helpers';

test('a failed create leaves focus on the button that failed', async ({ page }) => {
  // Lives in THIS spec rather than beside the other list-route tests because
  // only this one is matched by `CROSS_ENGINE`. Focus is the most
  // engine-divergent behaviour in the whole lab — macOS WebKit ships Full
  // Keyboard Access off, so what Tab reaches differs by engine — which makes
  // Chromium-only coverage of a focus regression close to worthless.
  //
  // It drives focus programmatically and presses Enter rather than tabbing,
  // so it asserts the same property on all three engines without depending on
  // the platform's keyboard-access setting.
  // A native `disabled` attribute makes an element unfocusable, so activating
  // this button from the keyboard moved focus to `<body>` — and re-enabling it
  // on the failure path left focus there. The next Tab would start from the
  // top of the page rather than at the form whose alert had just announced the
  // failure, which is the moment a keyboard user least wants to be relocated.
  //
  // Asserted through the KEYBOARD, not a click: a click leaves focus wherever
  // the pointer put it, so a mouse-driven version of this test would pass
  // against the bug.
  await page.route('**/api/server-owned/conversations', (route) =>
    route.request().method() === 'POST'
      ? route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Nope.' }),
        })
      : route.continue(),
  );

  await gotoHydrated(page, '/server-owned');

  await page.getByTestId('server-owned-new-title').fill('Focus check');
  await page.getByTestId('server-owned-create').focus();
  await page.keyboard.press('Enter');

  // The failure is announced…
  await expect(page.getByTestId('server-owned-failure')).not.toBeEmpty();

  // …and focus is still on the control that failed, so the next Tab continues
  // from the form rather than from the document.
  const focused = await page.evaluate(
    () => document.activeElement?.getAttribute('data-testid') ?? '',
  );
  expect(focused).toBe('server-owned-create');
});

test('a reloaded conversation renders its full history from the session store', async ({
  page,
  request,
}) => {
  // THE claim the whole variant exists to make: a reload renders history
  // because the server has it, not because the browser kept anything. Until
  // now that claim was made by the route's shape and by prose — the existing
  // reload spec reloads the LIST, not a conversation.
  //
  // Seeded through the API rather than by streaming turns: this is about what
  // survives a reload, so a deterministic transcript is the point and a real
  // model turn would only add nondeterminism to the thing under test.
  const title = uniqueTitle('Reload');
  const created = await request.post('/api/server-owned/conversations', { data: { title } });
  expect(created.status()).toBe(201);
  const conversation = await readCreatedConversation(created);

  // SEVERAL turns, in order. A single turn cannot distinguish "history
  // survived" from "the last turn survived", and ordering is half of what a
  // transcript is.
  const turns = [
    'First thing the user said',
    'Second thing the user said',
    'Third thing the user said',
  ];
  for (const text of turns) {
    const appended = await request.post(
      `/api/server-owned/conversations/${conversation.id}/turns`,
      { data: { text } },
    );
    expect(appended.status()).toBe(201);
  }

  await gotoHydrated(page, `/server-owned/${conversation.id}`);
  const log = page.getByRole('log', { name: 'Messages' });
  for (const text of turns) await expect(log).toContainText(text);

  // The reload. Nothing in the browser carries across it.
  await page.reload();
  await expect(page.getByRole('heading', { name: title })).toBeVisible();

  // EVERY turn, and in order. Asserting only that the text is present would
  // pass on a transcript that came back shuffled, which is a different bug
  // wearing the same symptom.
  for (const text of turns) await expect(log).toContainText(text);

  const rendered = await log.innerText();
  const positions = turns.map((text) => rendered.indexOf(text));
  expect(positions.every((at) => at >= 0)).toBe(true);
  expect([...positions].toSorted((a, b) => a - b)).toEqual(positions);

  // And it came from the SERVER, not from anything the browser replayed —
  // the navigation response already carries the turns, which is the
  // distinction from the canonical browser-owned exemplar.
  const document = await request.get(`/server-owned/${conversation.id}`);
  expect(document.status()).toBe(200);
  const html = await document.text();
  for (const text of turns) expect(html).toContain(text);
});
