import type { Locator, Page } from '@playwright/test';
import { expect } from '@playwright/test';
import { gotoHydrated } from '../hydration';

export { gotoHydrated };
export type { Locator, Page };

export // ReviewEditor's prop matrix: `mode`, `currentUserId`, `snapshotMode`,
// `placeholder`, and `class`. Every claim here is a DIFFERENCE between two
// instances that share a document, a seeded thread, an author, and everything
// else — so each assertion carries its own control, and an affordance that is
// missing for the wrong reason shows up as a failing control rather than as a
// passing test.
//
// Boundaries with the sibling routes: `review-views` owns the view tablist and
// the full Revert All gate (readonly appears here only as the third of its
// three conditions); `review-ssr-and-a11y` owns SSR, hydration, and live-region
// geometry; `review-comment-creation` owns the drag-selection path and the
// page-owned reducer that applies the notification-only events. This route
// never applies them — counting them at zero is the whole point.

/** Each instance is wrapped in `data-testid="modes-<name>-frame"` on the page. */
function frame(page: Page, name: string): Locator {
  return page.getByTestId(`${name}-frame`);
}

/**
 * The component's own container: `data-testid="review-editor"`, and no id.
 *
 * The `id` prop lands on the inner markdown-editor host (`#<id>`), NOT on the
 * container — so `#<id>` vanishes whenever an instance leaves the editor view,
 * because the diff and summary views unmount that host. Everything
 * container-scoped therefore goes through the frame, which never moves.
 */
export function surface(scope: Locator): Locator {
  return scope.getByTestId('review-editor');
}

/** All seven instances, in page order. */
export const INSTANCES = [
  'modes-edit',
  'modes-readonly',
  'modes-nouser',
  'modes-emptyuser',
  'modes-snapshot',
  'modes-plain',
  'modes-exotic',
] as const;

/**
 * `data-ready` is `editorViewReady && !pendingState`. It is the right signal
 * for the FIRST interaction and useless afterwards — it never resets, so it
 * stays `"true"` while an editor is unmounted in another view.
 */
export async function openReviewModes(page: Page, names: readonly string[]): Promise<void> {
  await gotoHydrated(page, '/exercises/review-modes');
  for (const name of names) {
    await expect(surface(frame(page, name))).toHaveAttribute('data-ready', 'true');
  }
}

/**
 * Select `needle` inside an instance's ProseMirror with a real DOM Range.
 *
 * A mouse drag is the user-facing gesture, but it is unusable here: these
 * documents carry an anchor decoration whose pointerup handler steals the drag
 * and opens the thread popover instead. A programmatic Range needs no
 * coordinates and produces the same `selectionchange` the component listens
 * for — but only if the editor is focused first, because ProseMirror's DOM
 * observer ignores selection changes on an editable view it does not hold
 * focus in.
 *
 * The scroll dance in front of that is load-bearing, not hygiene. Focusing an
 * offscreen element makes the browser scroll it into view, and this page
 * inherits `scroll-behavior: smooth`, so that scroll ANIMATES for hundreds of
 * milliseconds after the call returns. SelectionPopover dismisses itself on
 * scroll (movement dismissal — "the user moved on"), and the component only
 * mounts it 20ms after the selection settles, so the popover would mount into
 * a still-running scroll and be torn down a frame or two later. Measured: the
 * popover appeared at 31ms and was removed at 35ms by a scroll event, with the
 * selection still standing. Nothing about that is specific to the popover's
 * correctness — it is an artifact of moving focus across a seven-instance page,
 * which a real user selecting text never does. So scroll the target into view
 * FIRST, wait for the scroll to stop firing, and then take focus with
 * `preventScroll` so the gesture itself moves nothing.
 *
 * Returns what the browser actually selected, so callers assert on a real
 * reading instead of on the string they passed in. That matters most for the
 * absence assertions: "no popover appeared" proves nothing unless the selection
 * it should have reacted to demonstrably existed.
 */
export async function selectText(page: Page, editorId: string, needle: string): Promise<string> {
  return page.evaluate(
    async ({ editorId: targetEditorId, needle: targetNeedle }) => {
      const editor = document.getElementById(targetEditorId)?.querySelector('.ProseMirror');
      if (!editor) throw new Error(`no ProseMirror inside #${targetEditorId}`);
      const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
      let node: Node | null;
      while ((node = walker.nextNode())) {
        if (!(node instanceof Text)) continue;
        const offset = node.data.indexOf(targetNeedle);
        if (offset === -1) continue;
        const range = document.createRange();
        range.setStart(node, offset);
        range.setEnd(node, offset + targetNeedle.length);

        // Centre the target, then wait until the page has been quiet for
        // 100ms — `instant` overrides the inherited smooth behavior, but the
        // scroll event still lands a frame later, and a scroll landing after
        // the popover mounts is exactly what dismisses it.
        let lastScrollAt = performance.now();
        const noteScroll = () => (lastScrollAt = performance.now());
        document.addEventListener('scroll', noteScroll, true);
        window.scrollBy({
          top: range.getBoundingClientRect().top - window.innerHeight / 2,
          behavior: 'instant',
        });
        const deadline = performance.now() + 2000;
        while (performance.now() - lastScrollAt < 100 && performance.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        document.removeEventListener('scroll', noteScroll, true);

        if (!(editor instanceof HTMLElement))
          throw new Error('ProseMirror node is not an HTMLElement');
        editor.focus({ preventScroll: true });
        const selection = document.getSelection();
        if (!selection) throw new Error('no document selection');
        selection.removeAllRanges();
        selection.addRange(range);
        return selection.toString();
      }
      throw new Error(`"${targetNeedle}" not found in #${targetEditorId}`);
    },
    { editorId, needle },
  );
}

/** What the browser has selected right now, across the whole document. */
export function currentSelection(page: Page): Promise<string> {
  return page.evaluate(() => document.getSelection()?.toString() ?? '');
}

/** Drop the browser selection so the next instance starts from a clean slate. */
export async function clearSelection(page: Page): Promise<void> {
  await page.evaluate(() => document.getSelection()?.removeAllRanges());
}

export // HOW THE THREE "no popover appears" TESTS BELOW ARE TIMED, AND WHY IT IS NOT A
// POLL.
//
// They used to sleep 400ms after the gated gesture, on the grounds that the
// component debounces `selectionchange` by 20ms. Converting that to
// `expect.poll` is not possible, and the reason is worth stating rather than
// discovering: when the debounce fires and DECLINES, it writes nothing
// observable. Its callback's entire effect is assigning two private `$state`
// variables that feed `showSelectionPopover` and nothing else — no attribute, no
// class, no prop callback, no announcement. There is no condition to poll on,
// because the component's answer to "should I show this?" is only ever expressed
// by the popover existing.
//
// So the wait is a temporal CONTROL instead: perform the identical gesture on an
// UNGATED instance and wait for ITS popover with an auto-retrying matcher. That
// matcher does not resolve until the component has taken a `selectionchange`
// through the debounce and out the other side, which is the exact event the
// gated instances are being asserted not to have produced. It is a clock made of
// the mechanism under test, and it is self-calibrating: if the debounce ever
// grows, the control waits longer too, which is precisely what a fixed 400ms
// could not do.
//
// Two facts make it sound, and both are dependencies rather than decoration:
//
//   1. The gated instance has had ample opportunity to produce a popover before
//      anything is concluded from its not having done so. `selectText` burns at
//      least ~100ms of in-page time per call, in its scroll-quiescence loop (the
//      `while` above enters true and sleeps 25ms a turn until 100ms of quiet), so
//      each gated instance's own 20ms window has expired several times over by
//      the time the control gesture is even issued. Note that this is about
//      OPPORTUNITY, not about when the assertion samples: `watchForPopover` below
//      records the whole interval, so shortening that loop would not make the
//      absence assertion pass for the wrong reason — it would only narrow the
//      window in which a real popover had a chance to be recorded.
//   2. The absence is structurally gated, not merely slow: `showSelectionPopover`
//      is `$derived` with `mode === 'edit'` and `currentUserId !== undefined` in
//      it, and the readonly/exotic instances additionally never get as far as
//      scheduling the timer (the handler returns early on `mode !== 'edit'`). The
//      control proves the gesture works; the derived is why the gated instances
//      cannot produce a popover at any delay whatsoever.
//
// One thing the control DOES cost, and `watchForPopover` below is the repayment.
// Handing the clock to a second instance means the gated instance's selection has
// been replaced by the time its absence is asserted — so a bare `toHaveCount(0)`
// at the end would be satisfied by a popover that appeared and was torn down in
// between, which is precisely the failure it is supposed to catch. The old sleep
// did not have that hole (it asserted with the selection still standing) and the
// replacement must not open one. So the absence is recorded across the WHOLE
// interval rather than sampled at the end of it, which is strictly stronger than
// either shape: the sleep could only ever prove "not present at 400ms".

/**
 * Start recording whether a portaled popover is EVER inserted, from now on.
 *
 * Reads the mutation records rather than re-querying the document in the
 * callback: MutationObserver delivers at a microtask checkpoint, so a node added
 * and removed before that checkpoint is invisible to a `getElementById` inside
 * the callback and perfectly visible in `addedNodes`. A popover that flickered
 * for one task is exactly the regression worth catching.
 */
async function watchForPopover(page: Page, popoverId: string): Promise<void> {
  await page.evaluate((id) => {
    // Each observer must retain the same record across registrations. This
    // callback runs in the browser and cannot capture a test-module helper.
    const existingSeen: unknown = Reflect.get(window, '__popoverSeen');
    const seen = typeof existingSeen === 'object' && existingSeen !== null ? existingSeen : {};
    const existingWatchers = Reflect.get(window, '__popoverWatchers');
    const watchers = Array.isArray(existingWatchers) ? existingWatchers : [];
    Reflect.set(window, '__popoverSeen', seen);
    Reflect.set(window, '__popoverWatchers', watchers);
    Reflect.set(seen, id, document.getElementById(id) !== null);
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (!(node instanceof Element)) continue;
          if (node.id === id || node.querySelector(`[id="${id}"]`)) Reflect.set(seen, id, true);
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    watchers.push(observer);
  }, popoverId);
}

/** Whether `watchForPopover` has seen that popover at any point since it started. */
export function popoverEverAppeared(page: Page, popoverId: string): Promise<boolean> {
  return page.evaluate((id) => {
    const seen: unknown = Reflect.get(window, '__popoverSeen');
    return typeof seen === 'object' && seen !== null && Reflect.get(seen, id) === true;
  }, popoverId);
}

/**
 * Tear the watchers down again.
 *
 * These describe blocks share one page across their tests, and a body-wide
 * `childList` observer left running would keep firing through the typing tests
 * that come later. Resetting the record as well means the ids are reusable
 * rather than sticky, so a later test cannot inherit a `true` it did not cause.
 */
export async function stopWatchingPopovers(page: Page): Promise<void> {
  await page.evaluate(() => {
    const watchers = Reflect.get(window, '__popoverWatchers');
    if (Array.isArray(watchers)) {
      for (const observer of watchers) {
        if (observer instanceof MutationObserver) observer.disconnect();
      }
    }
    Reflect.set(window, '__popoverWatchers', []);
    Reflect.set(window, '__popoverSeen', {});
  });
}

/**
 * Record every live-region announcement inside an instance.
 *
 * LiveRegion clears its message one second after setting it, so a polled read
 * can legitimately arrive after the text is gone. Observing from before the
 * interaction turns that race into an append-only log. The regions are
 * `cinder-sr-only`, which also makes this the only honest way to read them —
 * a visible-text locator finds nothing even when the announcement fired.
 */
export async function recordAnnouncements(scope: Locator): Promise<void> {
  await scope.evaluate((element) => {
    const log: string[] = [];
    Reflect.set(window, '__announcements', log);
    new MutationObserver(() => {
      for (const region of element.querySelectorAll('[role="status"],[role="alert"]')) {
        const text = region.textContent?.trim();
        if (!text) continue;
        if (log[log.length - 1] !== text) log.push(text);
      }
    }).observe(element, { subtree: true, childList: true, characterData: true });
  });
}

export function announcements(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const log = Reflect.get(window, '__announcements');
    return Array.isArray(log) ? log.filter((item): item is string => typeof item === 'string') : [];
  });
}

/** The paragraph of body copy every instance shares, inside one instance. */
export function bodyParagraph(page: Page, editorId: string): Locator {
  return page.locator(`#${editorId} .ProseMirror p`, { hasText: 'The first release includes' });
}

/**
 * Click an instance's anchor decoration and wait for its thread popover.
 *
 * The popover mounts before Floating UI has placed it, and marks that gap with
 * `inert` plus `data-position-ready`. Waiting for the ready flag rather than
 * for mere presence keeps every subsequent click aimed at a positioned,
 * non-inert dialog.
 */
export async function openThreadPopover(page: Page, name: string): Promise<void> {
  await frame(page, name).locator('span.comment-anchor[data-thread-id]').click();
  const popover = page.locator(`#${name}-thread-popover`);
  await expect(popover).toHaveCount(1);
  await expect(popover).toHaveAttribute('data-position-ready', 'true');
}
