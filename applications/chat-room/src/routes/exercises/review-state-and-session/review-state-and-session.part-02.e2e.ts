import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
import { gotoHydrated } from '../hydration';

const ROUTE = '/exercises/review-state-and-session';

test.describe.serial('review-state-and-session: sessionStorage persistence', () => {
  // Serial and single-page: sessionStorage is shared across the whole
  // document, so ordering is part of what is under test. Every case owns a
  // distinct document key, and the first test resets the store.
  let page: Page;
  const consoleMessages: string[] = [];

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    // Attached before navigation: `loadSession`'s three destructive paths log
    // on the way out, and the messages are gone by the time a post-load hook
    // could subscribe.
    page.on('console', (message) => consoleMessages.push(`${message.type()}: ${message.text()}`));
    await gotoHydrated(page, ROUTE);
  });

  test.afterAll(async () => {
    await page.close();
  });

  test('the storage key is the exported prefix plus the document id', async () => {
    await expect(page.getByTestId('storage-prefix')).toHaveText(
      'STORAGE_KEY_PREFIX: review-session-',
    );
    await expect(page.getByTestId('storage-key')).toHaveText(
      'getStorageKey: review-session-sess-basic',
    );
  });

  test('saving strips runtime anchor positions and omits absent optionals entirely', async () => {
    await page.getByTestId('clear-all-storage').click();
    await page.getByTestId('save-basic').click();

    await expect(page.getByTestId('save-result')).toHaveText('saveSession returned: true');

    // No `outcome`, no `submittedAt`: `toPersistedSession` copies optionals
    // only when defined, so they are absent keys rather than serialized
    // nulls — which is exactly what `validateSessionSchema` requires on the
    // way back in, since it rejects an explicit null outcome.
    await expect(page.getByTestId('stored-top-level-keys')).toHaveText(
      'stored keys: draftComments,id,startedAt,status,updatedAt',
    );
    // The draft's anchor keeps its quote context and loses its positions.
    await expect(page.getByTestId('stored-anchor-keys')).toHaveText(
      'stored anchor keys: lastKnownOffset,originalQuote,prefix,quote,status,suffix',
    );
    await expect(page.getByTestId('stored-anchor-from-to')).toHaveText(
      'from-key=false to-key=false',
    );
  });

  test('loading restores anchors at 0/0 placeholders and leaves the stored bytes in place', async () => {
    await page.getByTestId('load-basic').click();

    // `fromPersistedDraftComment` writes literal zeroes and documents them as
    // placeholders: "caller must re-anchor". Nothing in the module does it
    // for you, and nothing in `ReviewEditor` accepts a session to do it with
    // — a consumer has to call `reanchorQuote` themselves.
    await expect(page.getByTestId('loaded-anchor-from-to')).toHaveText('from=0 to=0');
    // Everything else round-trips verbatim.
    await expect(page.getByTestId('loaded-round-trip')).toHaveText(
      'id=session-basic status=drafting drafts=1 quote=Release Plan authorId=maya createdAt=2026-08-11T10:00:00.000Z',
    );
    // A successful load is non-destructive — only the three failure paths
    // below delete.
    await expect(page.getByTestId('has-after-load')).toHaveText('hasPersistedSession: true');
  });

  test('loadSession destroys the stored bytes on all three failure paths', async () => {
    // The load-bearing assertion is the destruction, not the log line: each
    // case stores something, loads null, and finds the key gone afterwards.
    await page.getByTestId('load-submitted').click();
    await expect(page.getByTestId('load-submitted-result')).toHaveText(
      'stored-before=true loaded=null stored-after=false',
    );

    await page.getByTestId('load-bad-json').click();
    await expect(page.getByTestId('load-bad-json-result')).toHaveText(
      'stored-before=true loaded=null stored-after=false',
    );

    await page.getByTestId('load-bad-shape').click();
    await expect(page.getByTestId('load-bad-shape-result')).toHaveText(
      'stored-before=true loaded=null stored-after=false',
    );

    // The three paths are distinguishable only by their console output — the
    // return value is `null` for all of them, so a consumer cannot tell "no
    // session" from "your session was just deleted". Polled rather than read
    // straight, because console events arrive on their own schedule.
    const sawMessage = (fragment: string) =>
      expect.poll(() => consoleMessages.some((entry) => entry.includes(fragment))).toBe(true);

    await sawMessage('Clearing stale submitted review session');
    await sawMessage('Failed to load review session:');
    await sawMessage('Review session schema validation failed, clearing corrupted data');
  });

  test('listPersistedSessions strips the prefix, and clearAll empties the store', async () => {
    await page.getByTestId('list-sessions').click();

    // Document identifiers, not storage keys. `sess-basic` is still listed
    // because the successful load above did not delete it; the three failure
    // keys are absent because their loads did.
    await expect(page.getByTestId('session-list')).toHaveText(
      'listPersistedSessions: sess-a,sess-b,sess-basic',
    );

    await page.getByTestId('clear-all-sessions').click();
    // Checked twice over: through the module, and by counting prefixed keys
    // straight out of sessionStorage.
    await expect(page.getByTestId('list-after-clear-all')).toHaveText('count=0 raw-keys=0');
  });

  test('the persistence module reads sessionStorage once mounted in a browser', async () => {
    // The post-hydration counterpart to the SSR assertion below: the same
    // calls that short-circuit on the server do reach storage in the browser.
    await expect(page.getByTestId('browser-storage-probe')).toHaveText(
      'saveSession=true listed=true',
    );
  });
});

test('review-state-and-session: the session modules run during SSR without throwing', async ({
  request,
}) => {
  // `review-ssr-and-a11y` owns SSR generally; this is the one assertion this
  // route needs — that importing and CALLING the persistence module on the
  // server neither throws nor 500s, and that its browser guard returns the
  // documented defaults rather than reaching for sessionStorage.
  const response = await request.get(ROUTE);
  expect(response.status()).toBe(200);
  const html = await response.text();

  expect(html).toContain(
    'threw=false loadSession=null hasPersistedSession=false listed-is-array=true',
  );

  // The pure half of the session module renders its real results server-side,
  // which is what proves the module evaluated rather than merely imported.
  expect(html).toContain('threads=1 replies=1 total=2');
  expect(html).toContain('summary=identical diff=identical comments=identical');
  expect(html).toContain('outcome-null=false');
  expect(html).toContain('review-session-sess-basic');

  // The browser-only probe renders its placeholder on the server. It is
  // deliberately deferred to a post-hydration effect rather than computed at
  // init: `saveSession` returns false on the server and true in the browser,
  // so rendering it from init would manufacture a hydration divergence on
  // this route just to assert it.
  expect(html).toContain('(not yet run)');
});
