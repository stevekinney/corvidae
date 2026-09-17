import { expect, test } from '@playwright/test';
import type { ElementHandle } from './review-comment-lifecycle-test-helpers';
import {
  ROUTE,
  gotoHydrated,
  openSidebar,
  popover,
  popoverQuoteTrace,
  rowQuoted,
  selectThread,
  sidebar,
  watchPopoverQuote,
} from './review-comment-lifecycle-test-helpers';

/**
 * Sample one DOM node's connectivity and one descendant's `.value` every
 * animation frame, for `ms` of real time — entirely inside the page, so the
 * sampling rate is a frame (~16ms at 60Hz) rather than however long a Node
 * round trip takes, and nothing can slip between two samples unnoticed.
 *
 * Pre-cinder#1320, a destroy-and-recreate round trip disconnected THIS exact
 * node and started a fresh composer at `''`. A `toBeAttached()` followed by
 * `toHaveValue()` after a fixed delay cannot pin "never happened": both
 * matchers auto-retry toward whatever is true WHEN THEY RUN, and a
 * freshly-recreated popover sharing the same id satisfies `toBeAttached()`
 * exactly as happily as the original — so the only way that shape of
 * assertion could ever have failed is landing mid-round-trip by chance.
 * Sampling the identical node handle throughout is what actually pins it.
 */
async function sampleNodeStability(
  handle: ElementHandle<Element>,
  composerId: string,
  ms: number,
): Promise<
  {
    connected: boolean;
    composerValue: string | null;
  }[]
> {
  return handle.evaluate(
    (element, { composerId: sampledComposerId, ms: sampleMilliseconds }) => {
      return new Promise<
        {
          connected: boolean;
          composerValue: string | null;
        }[]
      >((resolve) => {
        const samples: {
          connected: boolean;
          composerValue: string | null;
        }[] = [];
        const start = performance.now();
        const tick = () => {
          const composerElement = element.querySelector(`#${sampledComposerId}`);
          const composer = composerElement instanceof HTMLTextAreaElement ? composerElement : null;
          samples.push({
            connected: element.isConnected,
            composerValue: composer ? composer.value : null,
          });
          if (performance.now() - start < sampleMilliseconds) {
            requestAnimationFrame(tick);
          } else {
            resolve(samples);
          }
        };
        requestAnimationFrame(tick);
      });
    },
    { composerId, ms },
  );
}
// ROADMAP X-3: sidebar quiet-failure paths. The orphaned-thread popover
// fallback (`handleSidebarThreadSelect` opening against the editor's own box
// rather than dropping an orphan's click silently — see `anchorCoords` and its
// caller in `review-editor-impl.svelte`) was the instance already found and
// already handled; these three pin the rest of what a sidebar click can do.
// Two of the three used to be confirmed-broken races — a stale sidebar timer
// overwriting a newer anchor-selected popover (cinder#1319), and a re-click on
// the active row destroying the popover and its unsent draft (cinder#1320) —
// both fixed in `@repo/editor@0.11.0`. The third, Escape's draft loss,
// was and remains a confirmed-correct control.
test.describe('review comment lifecycle: sidebar selection is a delayed but cancellable timer', () => {
  test.beforeEach(async ({ page }) => {
    await gotoHydrated(page, ROUTE);
    await openSidebar(page);
  });
  test('a later anchor click cancels a stale sidebar-select timer, so its popover survives past the original window (cinder#1319, fixed)', async ({
    page,
  }) => {
    // `review-editor-impl.svelte` declares `selectTimeoutId` at the component
    // level with its own comment: "Stored at component level so we can cancel
    // it when switching threads." `handleAnchorClick` (a document-anchor click)
    // honours that contract — its first act is clearing the stored id. Before
    // cinder#1319, `handleSidebarThreadSelect`, the sidebar's OWN selection
    // handler, never assigned its `setTimeout(…, POSITION_DELAY_MS)` return
    // value to that variable at all, so the cancellation the comment promises
    // never reached the path most likely to need it: switching away from a
    // sidebar selection before its 350ms delay elapsed.
    //
    // Fixed: `handleSidebarThreadSelect` now stores its timer in that same
    // `selectTimeoutId`, so `handleAnchorClick`'s cancellation actually reaches
    // it. Click a sidebar row — this schedules the (now cancellable) timer —
    // then, inside that window, select a DIFFERENT thread via its document
    // anchor, which opens synchronously with no delay of its own. The popover
    // shows the anchor-selected thread at first, and — the fix — still shows
    // it ~350ms after the ORIGINAL sidebar click, with no further user action:
    // the stale timer was actually cancelled rather than merely outraced, so
    // it never fires to overwrite `popoverThreadId`/`popoverPosition` back to
    // the thread the user already left.
    await rowQuoted(page, 'Release Plan').click();
    const ghostAnchor = page.locator('span.comment-anchor[data-thread-id="t-empty"]');
    await ghostAnchor.click();
    const dialog = popover(page);
    await expect(dialog).toHaveAttribute('data-position-ready', 'true');
    // GUARD: prove the anchor click actually won the race and opened the
    // thread it targeted, so what follows is a genuine test of survival past
    // the window rather than a mis-timed test that never entered it. If THIS
    // assertion is what fails, read it as "the window was missed" (a loaded
    // machine spent too long on the two clicks) and rerun — it says nothing
    // about whether the fix holds.
    await expect(dialog.locator('.thread-popover-quote')).toHaveText('"Timeline risk"');
    await expect(rowQuoted(page, 'Timeline risk')).toHaveCount(0); // it's a ghost — no sidebar row exists to have gone active
    await expect(sidebar(page).locator('[aria-current="true"]')).toHaveCount(0);
    // A single point-in-time snapshot after a fixed delay is not enough
    // here, because broken this state SELF-HEALS. A second, independent
    // `$effect` in `review-editor-impl.svelte` watches `activeThreadId` vs
    // `popoverThreadId` and reschedules its own repositioning timer on the
    // same 350ms `POSITION_DELAY_MS` whenever they diverge, so the
    // orphaned sidebar timer's corruption gets silently repaired roughly
    // one more `POSITION_DELAY_MS` window after it happens — with no
    // further user action.
    //
    // Measured empirically, against a deliberately reverted fix
    // (`handleSidebarThreadSelect`'s `setTimeout` unassigned again), 8 runs
    // at 4-way parallel load: the wrong quote ("Release Plan") appeared at
    // t≈250-280ms after this point and the popover self-healed back to
    // "Timeline risk" at t≈600-635ms, every time. A single
    // `waitForTimeout(500)` snapshot landed inside that dead zone — after
    // the corruption, after the heal — and passed whether or not the fix
    // was present. `watchPopoverQuote` instead captures every quote the
    // popover ever shows from here on, so the corrupted state cannot hide
    // between two polls; 1200ms leaves close to double the observed
    // self-heal time as margin.
    await watchPopoverQuote(dialog);
    await page.waitForTimeout(1200);
    const trace = await popoverQuoteTrace(page);
    expect(trace).not.toContain('"Release Plan"');
    expect(trace).toContain('"Timeline risk"');
    expect(trace[trace.length - 1]).toBe('"Timeline risk"');
    await expect(sidebar(page).locator('[aria-current="true"]')).toHaveCount(0);
  });
  test('re-selecting the sidebar row that is already active leaves the open popover, and any unsent reply, untouched (cinder#1320, fixed)', async ({
    page,
  }) => {
    // `thread-popover.svelte` attaches
    // `createClickOutside({ handler: () => onclose?.() })` with that helper's
    // defaults: `eventType: 'click'`, `capture: true`, listening on
    // `document`. A capture-phase `document` listener runs before the
    // target's own bubble-phase `onclick`, so before cinder#1320 EVERY click
    // on a sidebar row — including a re-click on the row whose thread is
    // already open — first tore the popover down via `onclose`
    // (`handlePopoverClose`, which nulls `popoverThreadId`/`popoverPosition`)
    // and only then ran the row's own `onclick`, which scheduled a fresh
    // ~350ms-delayed reopen for the same thread. `CommentComposer` keeps its
    // reply draft in its own `value = $bindable('')` state, but neither
    // `ThreadPopover` nor `review-editor-impl.svelte` ever passes
    // `bind:value` through — nothing here is a controlled input a consumer
    // could rehydrate even if it wanted to — so the destroy-then-recreate
    // round trip dropped it.
    //
    // Fixed two ways, both exercised here: `review-editor-impl.svelte` now
    // passes `ignoreClickOutsideRef`, resolving the currently-active sidebar
    // row, so a click on THAT row no longer counts as "outside" the popover
    // and `onclose` never fires; and `handleSidebarThreadSelect` itself now
    // short-circuits when the clicked thread is already both
    // `activeThreadId` and `popoverThreadId`, so even the row's own
    // `onclick` schedules nothing. Re-clicking a row that is ALREADY the
    // active selection was never observably a "switch to a different
    // thread" — nothing about the gesture reads as "discard my draft",
    // unlike Escape or the close button (the control test below) — and now
    // nothing about it does.
    const dialog = await selectThread(page, rowQuoted(page, 'Release Plan'));
    const composer = dialog.locator('#lifecycle-editor-thread-popover-composer');
    const DRAFT = 'Renaming it now would break the changelog.';
    await composer.fill(DRAFT);
    // Captured as a handle, not just a locator: a locator re-resolves by
    // selector on every call, so it would read "attached" just as happily
    // against a freshly recreated element sharing the same id. The handle
    // pins THIS node — if the popover were torn down and rebuilt, this
    // specific element would report `isConnected: false` even though a
    // lookalike replaced it in the DOM.
    const dialogHandle = await dialog.elementHandle();
    if (!dialogHandle) throw new Error('popover was not attached before the re-click');
    await rowQuoted(page, 'Release Plan').click();
    // A fixed-delay-then-snapshot cannot pin "never destroyed": both
    // `toBeAttached()`-style checks and `toHaveValue()` auto-retry toward
    // whatever is true WHEN THEY RUN, and a freshly recreated popover
    // sharing the same id satisfies an attachment check exactly as happily
    // as the original — so a stale-handle `isConnected` read taken once,
    // after the fact, is the only thing standing between this test and
    // that hole, and it only catches the destroy if the sample happens to
    // land after the tear-down and before a same-shaped replacement fools
    // a locator-based check elsewhere. `sampleNodeStability` instead polls
    // this exact node and its composer's live `.value` every animation
    // frame for 600ms — comfortably past both the click-outside dispatch
    // and the ~350ms timer a genuine reselection would have scheduled —
    // so a destroy-and-recreate round trip cannot land between samples.
    const samples = await sampleNodeStability(
      dialogHandle,
      'lifecycle-editor-thread-popover-composer',
      600,
    );
    expect(samples.length).toBeGreaterThan(0);
    expect(samples.every((sample) => sample.connected)).toBe(true);
    expect(samples.every((sample) => sample.composerValue === DRAFT)).toBe(true);
    await expect(dialog).toHaveAttribute('data-position-ready', 'true');
    await expect(composer).toHaveValue(DRAFT);
  });
  test('dismissing the popover with Escape also discards an unsent reply — correctly, since no draft persistence exists to preserve it', async ({
    page,
  }) => {
    // The control for the two pinned tests above: Escape is an unambiguous,
    // universally-understood "cancel this" gesture, and `CommentComposer`'s
    // reply draft is deliberately transient state scoped to the popover's own
    // lifetime — recorded here as CORRECT rather than assumed, since silence
    // is only a non-bug when something asserts it explicitly. Losing a draft
    // on an explicit dismissal is the component doing exactly what its (lack
    // of a) draft-persistence contract promises; the bug above is that the
    // SAME loss also happens on a gesture that promises nothing of the sort.
    const dialog = await selectThread(page, rowQuoted(page, 'Release Plan'));
    const composer = dialog.locator('#lifecycle-editor-thread-popover-composer');
    await composer.fill('Renaming it now would break the changelog.');
    await page.keyboard.press('Escape');
    await expect(popover(page)).toHaveCount(0);
    const reopened = await selectThread(page, rowQuoted(page, 'Release Plan'));
    await expect(reopened.locator('#lifecycle-editor-thread-popover-composer')).toHaveValue('');
  });
});
