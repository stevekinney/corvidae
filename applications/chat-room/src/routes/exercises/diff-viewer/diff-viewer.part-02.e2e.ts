import { expect, test } from '@playwright/test';
import {
  HUNKS_B,
  HUNKS_TWO,
  ROUTE,
  bodyLines,
  bodyLinesWithText,
  defined,
  expectHunks,
  focusDocumentBody,
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
test('revert is a request: the component reports the hunk index and changes nothing itself', async ({
  page,
}) => {
  const secondHunk = viewer(page, 'a').locator('.hunk-header').nth(1);
  await secondHunk.getByRole('button', { name: 'Revert this change' }).click();

  // The FIRST argument is the hunk's own index, not its position among the
  // rendered headers — they agree here only because nothing has been reverted
  // yet, which is why the second header is the one clicked.
  await expect(page.getByTestId('revert-log')).toHaveText('reverthunk:1');

  // The document moved because THIS PAGE moved it in the callback. `DiffViewer`
  // holds `original` and `current` as plain props and writes to neither.
  await expectHunks(page, 'hunks-a', [defined(HUNKS_TWO[0], 'second hunk after revert')]);
  await expect(viewer(page, 'a').locator('.hunk-header')).toHaveCount(1);

  await viewer(page, 'a').getByRole('button', { name: 'Revert All' }).click();
  await expect(page.getByTestId('revert-log')).toHaveText('reverthunk:1|revertall');
  await expectHunks(page, 'hunks-a', []);
  await expect(viewer(page, 'a').locator('.no-changes')).toHaveCount(1);
});

test('hunk headers render only for a viewer that supplied onreverthunk', async ({ page }) => {
  // B has a hunk and no `onreverthunk`, so it gets no header and no revert
  // affordance. Without this, the header assertions above would also pass
  // against a component that rendered headers unconditionally.
  await expectHunks(page, 'hunks-b', HUNKS_B);
  await expect(viewer(page, 'b').locator('.hunk-header')).toHaveCount(0);
  await expect(viewer(page, 'b').getByRole('button', { name: 'Revert this change' })).toHaveCount(
    0,
  );
  await expect(viewer(page, 'b').getByRole('button', { name: 'Revert All' })).toHaveCount(0);

  await expect(viewer(page, 'a').locator('.hunk-header')).toHaveCount(2);
});

// ---------------------------------------------------------------------------
// DV-2 — the slot-semantics divergence between Chat and DiffViewer
// ---------------------------------------------------------------------------

test("DiffViewer's toolbar snippet replaces the whole toolbar, taking toolbarActions with it", async ({
  page,
}) => {
  await expect(page.getByTestId('c-toolbar-replacement')).toBeVisible();

  // Everything the default toolbar owned, gone in one substitution: the view
  // mode control, the stat badges, the copy and revert actions, the change
  // navigation. The template is a hard `{#if toolbar}…{:else}<DiffToolbar/>{/if}`
  // with no seam in between.
  await expect(viewer(page, 'c').locator('.diff-toolbar')).toHaveCount(0);
  // Not `#diff-view-mode` (cinder#1309 gave every instance a unique,
  // non-deterministic id, so that literal no longer exists on ANY instance —
  // it would pass here whether or not C's override worked). The role-based
  // query is the one that actually distinguishes "no toolbar rendered" from
  // "a toolbar rendered under a different id".
  await expect(viewer(page, 'c').getByRole('radiogroup')).toHaveCount(0);
  await expect(viewer(page, 'c').getByRole('radio')).toHaveCount(0);
  await expect(viewer(page, 'c').locator('.stat-badge')).toHaveCount(0);
  await expect(viewer(page, 'c').locator('.change-counter')).toHaveCount(0);
  await expect(viewer(page, 'c').getByRole('button', { name: 'Copy unified diff' })).toHaveCount(0);

  // The sharpest part, and the one nothing warns about: `toolbarActions` — the
  // prop documented as the way to add a button WITHOUT replacing the toolbar —
  // is rendered inside the `{:else}` branch, so supplying both silently drops it.
  //
  // Asserted as a DIFFERENTIAL against instance A, which passes the identical
  // prop and no override. A bare `count 0` would be equally satisfied by a
  // `toolbarActions` that renders nowhere at all, and would make "the override
  // drops it" a claim the test never touched.
  await expect(page.getByTestId('a-toolbar-action')).toHaveCount(1);
  await expect(page.getByTestId('c-toolbar-action')).toHaveCount(0);

  // The diff content itself is untouched, which is what makes this a toolbar
  // replacement rather than a broken viewer.
  await expect(bodyLines(page, 'c')).toHaveCount(4);
  await expect(viewer(page, 'c').locator('.diff-content > .diff-line-modified')).toHaveCount(1);

  // The contrast that gives the counts above their meaning: A supplies no
  // override and has all of it.
  await expect(viewer(page, 'a').locator('.diff-toolbar')).toHaveCount(1);
  await expect(viewer(page, 'a').getByRole('radio')).toHaveCount(3);
});

test('the toolbar context carries no renderDefault, so the default cannot be re-rendered', async ({
  page,
}) => {
  // Enumerated at runtime from the object the component actually passes. This is
  // the DiffViewer half of DV-2 stated directly rather than inferred from the
  // missing button: four read-only fields, and no way back to the default.
  await expect(page.getByTestId('c-toolbar-context-keys')).toHaveText(
    'hasChanges,hunks,stats,viewMode',
  );
  await expect(page.getByTestId('c-toolbar-replacement')).toContainText('hasChanges=true');
  await expect(page.getByTestId('c-toolbar-replacement')).toContainText('hunks=1');
});

test("Chat's messagePart override receives a renderDefault and wraps the built-in rendering", async ({
  page,
}) => {
  // The other half of the divergence. Chat types its override as
  // `Snippet<[part, renderDefault]>` and passes both, so a consumer can add
  // markup AROUND the default instead of replacing it — the inversion of control
  // DiffViewer's `toolbar` does not offer.
  const wrapped = page.getByTestId('chat-wrapped-part');
  await expect(wrapped).toBeVisible();
  await expect(page.getByTestId('chat-wrapper-marker')).toHaveText('wrapped by the consumer');

  // Inside the consumer's own wrapper, which is the whole point: the default
  // rendering is nested in markup the override authored. If `renderDefault` were
  // not passed, this text would be absent (the snippet would render nothing but
  // its marker, or throw), while the marker assertion above would still pass —
  // so both assertions are needed and neither is redundant.
  await expect(wrapped).toContainText(
    'The default renderer produced this paragraph, and the override chose to keep it.',
  );
});

test('at the manual tier a toolbar override leaves the diff permanently uncomputable', async ({
  page,
}) => {
  // Over 100KB the controller sets `isStale` and returns without computing. The
  // only caller of `triggerCompute()` is the Compute Diff button, and that button
  // lives inside the default toolbar — so the override deletes the sole route to
  // a computed diff. `getHunks()` does not rescue it: it reads a result, it
  // cannot ask for one.

  // E, the control: default toolbar, so the button exists and the tier is real.
  await expect(viewer(page, 'e').locator('.diff-warning')).toContainText('manual trigger');
  await expect(viewer(page, 'e').locator('.diff-viewer[data-ready]')).toHaveCount(0);
  await expect(bodyLinesWithText(page, 'e')).toHaveCount(0);
  const compute = viewer(page, 'e').getByRole('button', { name: 'Compute Diff' });
  await expect(compute).toHaveCount(1);

  // D, the same document behind an override.
  await expect(page.getByTestId('d-toolbar-replacement')).toBeVisible();
  await expect(viewer(page, 'd').getByRole('button', { name: 'Compute Diff' })).toHaveCount(0);
  await expect(viewer(page, 'd').locator('.diff-viewer[data-ready]')).toHaveCount(0);
  await expect(bodyLinesWithText(page, 'd')).toHaveCount(0);

  await compute.click();

  // `data-ready` is a genuine signal HERE and only here: at this tier `isStale`
  // starts true, so the attribute's appearance marks the transition rather than
  // restating the initial state. The compute is deferred through
  // `requestIdleCallback` (timeout 2000), so this waits on the attribute the
  // component already renders instead of on a guessed duration.
  await expect(viewer(page, 'e').locator('.diff-viewer[data-ready]')).toHaveCount(1);
  await expect(bodyLines(page, 'e')).toHaveCount(12);
  // One modified line out of twelve, and the "Outdated" badge — which shares the
  // `.stat-badge` class — is gone now that `isStale` cleared.
  await expect(viewer(page, 'e').locator('.stat-badge')).toHaveText('~1');

  // D is still exactly where it started. Nothing a consumer can reach moves it.
  // Text-filtered for the same reason as above: the placeholder line is present
  // in every state, so counting nodes here would assert against the placeholder
  // rather than against the absence of a diff.
  await expect(viewer(page, 'd').locator('.diff-viewer[data-ready]')).toHaveCount(0);
  await expect(bodyLinesWithText(page, 'd')).toHaveCount(0);
});

// ---------------------------------------------------------------------------
// DV-3 — the window-level key bindings
//
// FIXED behavior as of `@repo/editor@0.10.0` (cinder#1310). The
// handler moved from a bare `<svelte:window onkeydown>` onto each instance's
// own root element (`<Surface onkeydown={handleKeydown}>`), relying on DOM
// event bubbling: a keydown only reaches an element listener if the focused
// element is that element or a descendant of it. Since focus is exclusive to
// one element document-wide, at most one `DiffViewer` instance's handler can
// ever fire for a given keystroke. This is a deliberate behavior change, not
// only a bug fix: focus on `<body>` (or anywhere outside every instance) now
// fires NOTHING, even with a single `DiffViewer` on the page — previously it
// fired, because the listener was global. The `input`/`textarea`/
// `[contenteditable]` guard still exists on top of this scoping; it is
// untouched by the fix and not retested exhaustively here.
// ---------------------------------------------------------------------------

test('] does nothing with focus on the document body — no viewer owns it', async ({ page }) => {
  await focusDocumentBody(page);
  const before = await keyboardState(page);

  // ONE direction only, deliberately. Pressing `]` then `[` would advance and
  // then revert, landing back on `before` whether or not either individual
  // keystroke actually fired — a round trip cannot distinguish "nothing
  // happened" from "both directions fired and cancelled out". A single press
  // is the only shape that makes the equality assertion below load-bearing.
  await page.keyboard.press(']');

  // A causal barrier, not a wait — see the comment on the equivalent
  // assertion below for why this is how "nothing happened" is proven rather
  // than assumed.
  await page.getByTestId('read-hunks-a').click();
  await expectHunks(page, 'imperative-a', HUNKS_TWO);

  expect(await keyboardState(page)).toEqual(before);
});

test('Ctrl+Shift+D does nothing with focus on the document body', async ({ page }) => {
  // Different starting modes, so if this DID fire (the old bug) the two
  // would land on different values rather than coincidentally matching.
  await page.getByTestId('set-mode-a-original').click();
  await expect(page.getByTestId('mode-a')).toHaveText('original');
  await expect(page.getByTestId('mode-b')).toHaveText('unified');

  await focusDocumentBody(page);
  await page.keyboard.press('Control+Shift+D');

  // A causal barrier: an unrelated click with its own observable effect,
  // ordered after the keystroke, so anything the keystroke scheduled would
  // already be visible by the time this assertion runs.
  await page.getByTestId('read-hunks-a').click();
  await expectHunks(page, 'imperative-a', HUNKS_TWO);

  await expect(page.getByTestId('mode-a')).toHaveText('original');
  await expect(page.getByTestId('mode-b')).toHaveText('unified');
});
