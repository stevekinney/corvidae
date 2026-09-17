import { expect, test } from '@playwright/test';
import {
  ROUTE,
  TALL_ORPHAN_ID,
  defined,
  editorIdentity,
  gotoHydrated,
  pressControl,
  scrollReport,
  seedTall,
  tallAnchors,
  threadCount,
} from './review-imperative-test-helpers';

test.beforeEach(async ({ page }) => {
  await gotoHydrated(page, ROUTE);
  // Matching the `ready()` gate every other review-* spec uses. Without it this
  // file failed 3 of 8 repeats with `Cannot read properties of null` on the
  // selection readout, and 7 of 55 across the suite — a racy setup that reads as
  // a component bug. All FOUR editors must be up — the two RE-1 instances plus
  // the RE-3 and RE-4 ones — so the count is 4.
  await expect(page.locator('[data-testid="review-editor"][data-ready="true"]')).toHaveCount(4);
  await expect(page.locator('#imperative-editor .ProseMirror')).toBeVisible();
  await expect(page.locator('#imperative-readonly .ProseMirror')).toBeVisible();
  await expect(page.locator('#imperative-content .ProseMirror')).toBeVisible();
  await expect(page.locator('#imperative-tall .ProseMirror')).toBeVisible();
  await expect(threadCount(page)).toHaveText('threads: 0');
});
test.describe('review-imperative: scroll and editor handle (RE-4)', () => {
  // `getScrollBehavior()` returns 'instant' under reduced motion and 'smooth'
  // otherwise. Nothing below currently scrolls, so this changes no result today
  // — it is here so that a FIXED `scrollToThread` reddens these tests cleanly
  // instead of racing a 350ms animation into intermittence.
  //
  // Through `contextOptions` rather than a bare `reducedMotion` key: Playwright
  // 1.61 exposes `reducedMotion` on `BrowserContextOptions` but not as a
  // top-level test option, so the shorter spelling is a type error here. Setting
  // it on the context also means it is in force before the first navigation,
  // which `page.emulateMedia` after `goto` would not guarantee for a component
  // that reads the query once.
  test.use({ contextOptions: { reducedMotion: 'reduce' } });

  test('scrollToThread brings an off-screen thread into view, the same way the control does (cinder#1316)', async ({
    page,
  }) => {
    const anchoredId = await seedTall(page);

    // Back to the top first: creating that thread needed a real selection, and
    // focusing a ProseMirror view scrolls the caret into view.
    await page.evaluate(() => window.scrollTo(0, 0));
    await pressControl(page, 'scroll-to-thread');

    // PRECONDITION, asserted rather than assumed. If the page ever stops
    // putting this anchor below the fold, every assertion under it becomes
    // vacuous, and this is the line that says so instead of going quietly
    // green.
    const before = await scrollReport(page);
    expect(before.threadId).toBe(anchoredId);
    expect(before.before.anchorTop).not.toBeNull();
    expect(before.before.anchorTop!).toBeGreaterThan(before.before.viewportHeight);
    expect(before.threw).toBeNull();

    // FIXED (cinder#1316): `scrollToThread` now delegates to
    // `scrollAnchorIntoView`, the same `anchorElement.scrollIntoView(...)`
    // mechanism `scroll-into-view-control` below already used successfully —
    // so it no longer calls `view.dom.scrollTo` at all (that call is gone
    // from the implementation entirely, not merely a guard that now passes),
    // which is why this asserts the observable RESULT — something scrolled,
    // and the anchor lands in view — rather than which private method got
    // called. Polled rather than read once: `getScrollBehavior()` still
    // returns 'instant' under this describe block's `reducedMotion: 'reduce'`
    // context option, so this should already be true on the first read, but
    // polling costs nothing and removes any cross-engine timing assumption.
    await expect
      .poll(async () => {
        const report = await scrollReport(page);
        return report.moved;
      })
      .toBe(true);
    const after = await scrollReport(page);
    expect(after.after.anchorTop).not.toBeNull();
    expect(after.after.anchorTop!).toBeGreaterThan(0);
    expect(after.after.anchorTop!).toBeLessThan(after.after.viewportHeight);

    // Focus does not move. RE-4 asks for it to land "somewhere sensible and
    // assertable"; it lands nowhere, and the trigger keeps it — unchanged by
    // the fix, and not one of the two things cinder#1316/#1317 were about.
    expect(after.before.active).toBe('scroll-to-thread');
    expect(after.after.active).toBe('scroll-to-thread');

    // The CONTROL, and the reason none of the above is a fixture artefact: the
    // same anchor, scrolled by the exact same `scrollIntoView` mechanism,
    // lands in the same place `scrollToThread` now reaches on its own. With
    // the fix, the two converge instead of only the control succeeding.
    await page.getByTestId('scroll-into-view-control').click();
    const control = await scrollReport(page);
    expect(control.moved).toBe(true);
    expect(control.after.anchorTop!).toBeGreaterThan(0);
    expect(control.after.anchorTop!).toBeLessThan(control.after.viewportHeight);
  });

  test('scrollToThread on an orphaned thread issues no scroll at all, rather than scrolling to position 0', async ({
    page,
  }) => {
    await seedTall(page);

    // The seeded orphan sits at from/to 0/0 — a VALID ProseMirror position,
    // which is exactly why this needs a status guard and not a bounds check.
    // Without one, `coordsAtPos(0)` answers with coordinates at the top of the
    // document and the component scrolls there as if it had found the thread.
    const rows = await tallAnchors(page);
    const orphan = defined(
      rows.find((row) => row.id === TALL_ORPHAN_ID),
      'tall orphan row',
    );
    expect(orphan).toBeDefined();
    expect(orphan.status).toBe('orphaned');
    expect(orphan.from).toBe(0);
    expect(orphan.to).toBe(0);

    await pressControl(page, 'scroll-to-orphan');

    const report = await scrollReport(page);
    expect(report.threw).toBeNull();
    // ZERO calls, not "a call that did nothing". `anchorCoords` returns null
    // for an orphaned anchor before it computes anything, and `scrollToThread`
    // scrolls only when coords come back — so whether `view.dom.scrollTo` was
    // reached at all is the one observable that distinguishes the guard being
    // present from the guard being deleted.
    expect(report.calls).toBe(0);
    expect(report.moved).toBe(false);
  });

  test('scrollToThread with an unknown id throws, rather than failing invisibly (cinder#1317)', async ({
    page,
  }) => {
    const anchoredId = await seedTall(page);

    await pressControl(page, 'scroll-to-thread');
    const succeeded = await scrollReport(page);
    expect(succeeded.threadId).toBe(anchoredId);
    expect(succeeded.threw).toBeNull();

    await pressControl(page, 'scroll-to-unknown');
    const failed = await scrollReport(page);
    expect(failed.threadId).toBe('no-such-thread');

    // FIXED (cinder#1317): a known id and an unknown one are no longer
    // indistinguishable from outside. `scrollToThread` now throws
    // `ReviewEditor.scrollToThread: no thread with id "..."` for an unknown
    // id, and the page's `runScroll` wrapper (which calls the method inside a
    // try/catch, per its own comment above `scrollReport`) surfaces that as
    // `threw` rather than swallowing it — so the thrown error is observable
    // through the same wrapper a consumer's own error boundary would see.
    expect(failed.threw).not.toBeNull();
    expect(failed.threw).toContain('no thread with id "no-such-thread"');
    expect(failed.returned).toBe('(threw)');
    // And the known-id call above is unaffected: it still throws nothing and
    // still resolves to `undefined`, the same as before the fix.
    expect(succeeded.returned).toBe('undefined');
  });

  test("getEditor hands back this instance's own live Milkdown editor", async ({ page }) => {
    await page.getByTestId('read-editor-identity').click();
    const identity = await editorIdentity(page);

    expect(identity.present).toBe(true);
    expect(identity.actionThrew).toBeNull();
    // From Milkdown's own `EditorStatus` enum. A stub, a plain object, or a
    // half-torn-down editor all report something else here.
    expect(identity.status).toBe('Created');
    expect(identity.stableAcrossCalls).toBe(true);
    // `action` runs its callback against the editor's own `Ctx` and hands back
    // the result, so this is an identity check rather than a liveness guess —
    // and it needs no ctx slice key imported into the page to make it.
    expect(identity.actionCtxIsEditorCtx).toBe(true);
    // PER INSTANCE, which a non-null assertion cannot tell from a module-level
    // singleton: the two ReviewEditors that expose this readout hand back two
    // different editors, addressing two documents of different sizes.
    expect(identity.distinctFromOtherInstance).toBe(true);
    expect(identity.viewDocSize).not.toBe(identity.otherViewDocSize);
  });
});
