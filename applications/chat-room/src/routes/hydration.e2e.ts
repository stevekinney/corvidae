import { expect, test } from '@playwright/test';
import { readCreatedConversation } from './server-owned/server-owned-test-helpers';

// Hydration cleanliness can only be observed in a DEV build: Svelte strips the
// `hydration_mismatch` warning from production output, and the rest of this
// suite runs against `build && preview`. That is exactly how cinder#756 went
// unnoticed here through 91 passing tests — including SSR-sensitive ones —
// while every Chat route emitted a mismatch on load.
//
// These tests drive the second `webServer` in playwright.config.ts (a dev
// server on DEV_PORT) with absolute URLs, so they are unaffected by `baseURL`.
const DEV_ORIGIN = 'http://localhost:5175';

// ROADMAP A11Y-1. This list is deliberately explicit: Playwright needs test
// names at collection time, and a missing application route should be a
// reviewable diff rather than a silent change in what runs.
//
const HYDRATING_ROUTES = ['/', '/server-owned'];

/**
 * Matches every warning Svelte emits about hydration going wrong.
 *
 * `Failed to hydrate` is a separate emission from `hydration_mismatch` — a bare
 * `console.warn('Failed to hydrate: ', error)` on the catch path, with no
 * `hydration_mismatch` token in it — and the previous predicate missed it
 * entirely, so a hydration that threw outright would have read as clean.
 */
const HYDRATION_WARNING = /hydration_mismatch|hydration failed|failed to hydrate/i;

declare global {
  interface Window {
    __hydrationWarnings?: string[];
    __hydrationErrors?: string[];
  }
}

/**
 * ROADMAP TI-1. This used to sleep 1000ms after the hydration beacon "because
 * hydration warnings can trail the beacon by a frame or two". They cannot, and
 * the mechanism settles it rather than a longer wait:
 *
 * Svelte emits `hydration_mismatch` only while its module-level `hydrating` flag
 * is true. That flag is set and cleared SYNCHRONOUSLY around the mount —
 * `set_hydrating(true)`, `_mount(...)`, `set_hydrating(false)` with no `await`
 * between them (`svelte/src/internal/client/render.js`). The beacon is set from
 * an `$effect`, which flushes on a microtask queued after that synchronous block
 * (`reactivity/batch.js`). So by the time `body[data-hydrated="true"]` is
 * observable, every hydration warning that will ever fire already has.
 *
 * (The one way back into hydration mode afterwards is Svelte's async-mode
 * `flatten` callback, which needs BOTH `experimental.async` and an `await`
 * inside a component. `experimental.async` is not enabled — nothing in
 * `vite.config.ts` or the workspace turns it on — and that leg alone settles
 * it. This note therefore rests on the flag rather than on the absence of
 * asynchronous blocks in individual components.)
 *
 * What remained was a TEST-side risk — whether a `console` event had been
 * delivered to Playwright yet — and that is removed structurally rather than
 * waited out: an init script wraps `console.warn` in the page itself before any
 * page script runs, so nothing can be missed, and reading it back is ordered
 * after the beacon in page time. The CDP `console` listener is kept as an
 * independent second collector, and both are asserted empty. If they ever
 * disagree, that disagreement is itself the finding.
 */
async function collectHydrationMismatches(
  page: import('@playwright/test').Page,
  path: string,
): Promise<{ viaConsoleEvent: string[]; viaInitScript: string[]; runtimeErrors: string[] }> {
  const viaConsoleEvent: string[] = [];
  // Attached BEFORE navigation: the warning is emitted during hydration and is
  // gone by the time any post-load hook could subscribe.
  page.on('console', (message) => {
    if (HYDRATION_WARNING.test(message.text())) viaConsoleEvent.push(message.text());
  });

  await page.addInitScript((source: string) => {
    const pattern = new RegExp(source, 'i');
    window['__hydrationWarnings'] = [];
    window['__hydrationErrors'] = [];
    window.addEventListener('error', (event) => {
      window['__hydrationErrors']?.push(event.message);
    });
    const browserConsole = globalThis.console;
    const original = browserConsole.warn.bind(browserConsole);
    browserConsole.warn = (...args: unknown[]) => {
      const text = args.map((arg) => String(arg)).join(' ');
      if (pattern.test(text)) window['__hydrationWarnings']?.push(text);
      original(...args);
    };
  }, HYDRATION_WARNING.source);

  await page.goto(`${DEV_ORIGIN}${path}`);
  await page.locator('body[data-hydrated="true"]').waitFor();

  // ResizeObserver delivery follows hydration effects. Observe a complete layout
  // delivery and the following frame so a reattached observer cannot hide an error.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  const { viaInitScript, runtimeErrors } = await page.evaluate(() => ({
    viaInitScript: window['__hydrationWarnings'] ?? [],
    runtimeErrors: window['__hydrationErrors'] ?? [],
  }));
  return { viaConsoleEvent, viaInitScript, runtimeErrors };
}

for (const route of HYDRATING_ROUTES) {
  test(`${route} hydrates without a mismatch`, async ({ page }) => {
    const { viaConsoleEvent, viaInitScript, runtimeErrors } = await collectHydrationMismatches(
      page,
      route,
    );

    expect(runtimeErrors).toEqual([]);
    expect(viaInitScript).toEqual([]);
    expect(viaConsoleEvent).toEqual([]);
    // The two collectors must agree. They observe the same emissions by
    // different routes — one in-page, one over CDP — so a divergence means one
    // of them is not seeing what it claims to, which would quietly undermine
    // every assertion in this file.
    expect(viaInitScript.length).toBe(viaConsoleEvent.length);
  });
}

// `/server-owned/[id]` cannot be a `HYDRATING_ROUTES` entry: it needs a real
// conversation id, and that list is a static inventory whose value is being
// diffable against `ls`. A parameterised route in it would either carry a
// hard-coded id that does not exist or force the list to become code.
//
// It is covered here instead, because the reason the list exists applies to it
// just as much: the detail page server-renders and hydrates interactive state
// (a Chat mount and a session controller), and that is the shape mismatches
// come from.
test('/server-owned/[id] hydrates without a mismatch', async ({ page, request }) => {
  const created = await request.post(`${DEV_ORIGIN}/api/server-owned/conversations`, {
    data: { title: `Hydration ${Date.now().toString(36)}` },
  });
  expect(created.status()).toBe(201);
  const conversation = await readCreatedConversation(created);

  // NONEMPTY, and that is the point of the test rather than a detail. An
  // empty conversation mounts an empty Chat, so the SSR-to-client
  // reconciliation of pre-rendered message rows — where a mismatch would
  // actually come from — is never exercised, and a mismatch conditional on a
  // populated `ConversationHistory` would pass. The nonempty case elsewhere
  // runs against the `preview` build, where Svelte strips the warning
  // entirely, so this dev-server test is the only place it can be seen.
  //
  // Appended through `DEV_ORIGIN`, because the two servers hold separate
  // in-memory stores and a turn written to the preview one would not exist
  // for the page this test loads.
  const turn = `Hydration probe ${Date.now().toString(36)}`;
  const appended = await request.post(
    `${DEV_ORIGIN}/api/server-owned/conversations/${conversation.id}/turns`,
    { data: { text: turn } },
  );
  expect(appended.status()).toBe(201);

  const { viaConsoleEvent, viaInitScript, runtimeErrors } = await collectHydrationMismatches(
    page,
    `/server-owned/${conversation.id}`,
  );

  // The row really was server-rendered and survived hydration — otherwise
  // this would be an empty-Chat test wearing a nonempty fixture.
  await expect(page.getByRole('log', { name: 'Messages' })).toContainText(turn);

  expect(runtimeErrors).toEqual([]);
  expect(viaInitScript).toEqual([]);
  expect(viaConsoleEvent).toEqual([]);
  expect(viaInitScript.length).toBe(viaConsoleEvent.length);
});
