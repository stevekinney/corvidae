import { expect, test } from '@playwright/test';
import {
  HUNKS_TWO,
  ROUTE,
  bodyLines,
  changeCounter,
  expectHunks,
  gotoHydrated,
  keyboardState,
  viewer,
} from './diff-viewer-test-helpers';

test.beforeEach(async ({ page }) => {
  await gotoHydrated(page, ROUTE);

  // The body diff is produced by an `$effect`, which does not run during SSR:
  // the server sends the front-matter block and ZERO body rows, and the rows
  // appear only once hydration has flushed.
  //
  // NOT gated on `.diff-viewer[data-ready]`, which looks like the intended
  // signal — the component's own comment calls it "E2E test synchronization" —
  // and is not one on this tier. It renders when `!isComputing && !isStale`,
  // and both are false before the controller has run at all, so it is present
  // in the SSR HTML of a viewer that has computed nothing. It becomes a real
  // signal only at the manual tier, where `isStale` is set, and that is the one
  // place below that waits on it.
  await expect(bodyLines(page, 'a')).toHaveCount(15);
  await expect(bodyLines(page, 'b')).toHaveCount(5);
});
test('a decoy input outside every viewer fires nothing either, for the same scoping reason', async ({
  page,
}) => {
  // `decoy-input` sits in instance B's section but OUTSIDE `viewer-b`'s own
  // DOM subtree (a sibling `<input>`, not a descendant) — so this is really
  // the same "outside every instance" case as the two tests above, not a
  // distinct input-guard case anymore. Kept as its own test because it was
  // the guard the pre-fix code relied on, and because an input element is
  // exactly the kind of target a future regression might special-case badly.
  await page.getByTestId('decoy-input').focus();
  const before = await keyboardState(page);

  await page.keyboard.press(']');
  await page.keyboard.press('Control+Shift+D');

  await page.getByTestId('read-hunks-a').click();
  await expectHunks(page, 'imperative-a', HUNKS_TWO);

  expect(await keyboardState(page)).toEqual(before);
});

test('focus inside one viewer scopes the keystroke to that viewer only', async ({ page }) => {
  // The differential that proves scoping rather than a page-wide guard: focus
  // a real, non-input control INSIDE instance A's own subtree (a toolbar
  // button), and confirm A advances while B — which never had focus inside
  // it — does not.
  await viewer(page, 'a').getByRole('button', { name: 'Next change' }).focus();

  await page.keyboard.press(']');

  await expect(changeCounter(page, 'a')).toHaveText('2 / 2');
  await expect(changeCounter(page, 'b')).toHaveText('1 / 3');
});

test('every default toolbar gets a unique per-instance id, and aria-labelledby resolves within its own instance', async ({
  page,
}) => {
  // cinder#1309's fix: `DiffToolbar` derives its `SegmentedControl` id from
  // `$props.id()` (Svelte's SSR-stable per-instance id) instead of the
  // literal `"diff-view-mode"`. The ids are now non-deterministic strings —
  // asserting an exact value would be asserting Svelte's internal counter
  // format, not the contract. What the contract actually promises is
  // uniqueness and same-instance label resolution.
  //
  // Three, not five: C and D replaced their toolbars, so only A, B and E
  // render the segmented control.
  const radiogroups = page.getByRole('radiogroup');
  await expect(radiogroups).toHaveCount(3);

  const ids = await radiogroups.evaluateAll((nodes) => nodes.map((node) => node.id));
  expect(new Set(ids).size).toBe(3);
  expect(ids.every((id) => id.length > 0)).toBe(true);

  // Each radiogroup's `aria-labelledby` must resolve, via `getElementById`,
  // to a label node inside THAT SAME instance's own subtree — not always the
  // first instance in the document, which was cinder#1309's actual defect.
  const resolutions = await radiogroups.evaluateAll((nodes) =>
    nodes.map((node) => {
      const labelledBy = node.getAttribute('aria-labelledby');
      const label = labelledBy ? document.getElementById(labelledBy) : null;
      return {
        ownTestId: node.closest('[data-testid]')?.getAttribute('data-testid') ?? null,
        labelTestId: label?.closest('[data-testid]')?.getAttribute('data-testid') ?? null,
      };
    }),
  );
  expect(resolutions).toEqual([
    { ownTestId: 'viewer-a', labelTestId: 'viewer-a' },
    { ownTestId: 'viewer-b', labelTestId: 'viewer-b' },
    { ownTestId: 'viewer-e', labelTestId: 'viewer-e' },
  ]);
});
