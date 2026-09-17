import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';
import { gotoHydrated } from '../hydration';
import { pressNextTabStop } from '../keyboard';

export { gotoHydrated, pressNextTabStop };
export type { Page };

export // What the server renders, what hydration adds, and how the composed
// ReviewEditor surface behaves for a keyboard or screen-reader user.
//
// These belong together because they need machinery the behaviour-focused
// `review-*` routes deliberately avoid: a raw HTTP read of the server HTML, a
// `javaScriptEnabled: false` context, computed-geometry reads, and full Tab
// walks. Concentrating them here keeps the other routes free of that
// infrastructure and gives one place where PRE-hydration state is asserted at
// all — every other spec starts from `gotoHydrated`, which by definition can
// only see the world after hydration has already happened.
//
// Hydration *cleanliness* is deliberately NOT asserted here. Svelte strips
// `hydration_mismatch` from production output and this suite runs against
// `build && preview`, so any such assertion would be permanently vacuous. The
// dev-server harness in `src/routes/hydration.e2e.ts` is the only build that
// can see it. Worth recording while the reader is here: the mismatch the review
// routes emit in dev traces to `@repo/cinder/icons`, whose export
// conditions hand SSR a prebuilt server bundle and the client the raw sources —
// the same lucide components compiled twice, by two Svelte versions. That is a
// packaging artefact, not an `@repo/editor` defect.

const ROUTE = '/exercises/review-ssr-and-a11y';
export const EDITOR_ID = 'a11y-editor';

export // The seeded comment body. It appears in the page's data and NOWHERE in its own
// markup, so searching the rendered text for it is a genuine test of whether
// the component leaked review content into the pre-hydration DOM.
const SENTINEL = 'SENTINEL comment body';

/** Navigate, wait for hydration, and wait for the editor to actually mount. */
export async function ready(page: Page): Promise<void> {
  await gotoHydrated(page, ROUTE);
  // `data-ready` is the component's own mount gate — see the SSR tests below
  // for what it does and does not promise. `.ProseMirror` only exists once
  // MarkdownEditor runs inside its `{#if browser}` guard.
  await expect(page.locator(`[data-testid="review-editor"][data-ready="true"]`)).toBeVisible();
  await expect(page.locator('.ProseMirror')).toBeVisible();
}

export type ActiveDescriptor = {
  tag: string;
  role: string | null;
  label: string | null;
  id: string;
  className: string;
  text: string;
  inControls: boolean;
  inEditorMain: boolean;
  inPopover: boolean;
};

/**
 * Read `document.activeElement` as a legible record rather than asserting
 * through a `:focus` locator. A failure message that says
 * `{ tag: 'BUTTON', label: 'Copy to clipboard' }` names the element that
 * actually had focus; a failed `:focus` locator only says it found nothing.
 */
export function activeDescriptor(page: Page): Promise<ActiveDescriptor> {
  return page.evaluate(() => {
    const element = document.activeElement;
    if (!(element instanceof HTMLElement)) {
      return {
        tag: 'NONE',
        role: null,
        label: null,
        id: '',
        className: '',
        text: '',
        inControls: false,
        inEditorMain: false,
        inPopover: false,
      };
    }
    return {
      tag: element.tagName,
      role: element.getAttribute('role'),
      label: element.getAttribute('aria-label'),
      id: element.id,
      className: typeof element.className === 'string' ? element.className : '',
      text: (element.textContent ?? '').trim().slice(0, 40),
      inControls: element.closest('.review-editor-controls') !== null,
      inEditorMain: element.closest('.review-editor-main') !== null,
      inPopover: element.closest('.thread-popover') !== null,
    };
  });
}

/** Press Tab once, then poll until focus settles on something matching. */
export async function tabTo(page: Page, expected: Partial<ActiveDescriptor>): Promise<void> {
  await page.keyboard.press('Tab');
  await expect.poll(() => activeDescriptor(page)).toMatchObject(expected);
}

/**
 * Tab forward until the editable ProseMirror surface has focus.
 *
 * For tests whose subject is what happens ONCE THE CARET IS IN THE EDITOR, where
 * the stops on the way are scaffolding rather than the claim. Naming those stops
 * made such tests engine-dependent for no benefit: WebKit omits buttons from the
 * Tab order (see `../keyboard`), so a hard-coded six-press walk never arrived and
 * the test failed for a reason unrelated to what it pins.
 *
 * The stop sequence itself is still pinned, in the two tab-order tests that exist
 * to assert it. This helper deliberately does not.
 *
 * Bounded: a surface that never accepts focus fails with a named error rather
 * than looping. The cap is a loop guard, not a timing guess — every press is
 * followed by a settled read, so a slow engine takes longer rather than fewer
 * stops.
 */
export async function tabToEditableSurface(page: Page, browserName: string): Promise<void> {
  for (let press = 0; press < 12; press += 1) {
    const active = await activeDescriptor(page);
    if (active.role === 'textbox' && active.label === 'Markdown editor') return;
    await pressNextTabStop(page, browserName);
  }
  throw new Error(
    'Tabbed 12 times without reaching the editable surface (role=textbox, label="Markdown editor")',
  );
}

/**
 * Press Tab and poll until focus has actually moved off `from`, then report
 * where it landed. Used where the walk collects stops rather than asserting a
 * known sequence: reading `document.activeElement` immediately after a keypress
 * is a separate round trip and would be a race, so wait for the value to change
 * instead. Every consecutive pair of stops on this page is distinct, which is
 * what makes "changed" a usable settle condition.
 */
export async function tabAndSettle(page: Page, from: ActiveDescriptor): Promise<ActiveDescriptor> {
  const before = JSON.stringify(from);
  await page.keyboard.press('Tab');
  await expect.poll(async () => JSON.stringify(await activeDescriptor(page))).not.toBe(before);
  return activeDescriptor(page);
}

/**
 * The block element ProseMirror's caret currently sits in.
 *
 * Load-bearing for the Tab tests: what Tab does in this editor depends entirely
 * on the caret's block, because it is bound to sink-list-item, which applies
 * only inside a list. `activeDescriptor` cannot answer that — every position in
 * the document reports the same focused `.ProseMirror`.
 */
export function caretBlock(page: Page): Promise<{ tag: string; text: string }> {
  return page.evaluate(() => {
    const selection = window.getSelection();
    const node = selection?.anchorNode ?? null;
    const element =
      node instanceof Text ? node.parentElement : node instanceof Element ? node : null;
    return {
      tag: element?.tagName ?? 'NONE',
      text: (element?.textContent ?? '').trim().slice(0, 40),
    };
  });
}

/**
 * The markdown the component is exporting right now, through the hidden form
 * input the SSR tests above enumerate. Reading the document through it rather
 * than through `.ProseMirror`'s rendered text is what makes list INDENTATION
 * observable — the rendered text of an indented bullet is identical to the
 * rendered text of an unindented one.
 */
export function currentMarkdown(page: Page) {
  return page.locator('input[type="hidden"][name="review-current"]');
}

/**
 * Install a MutationObserver over the editor's announcer regions BEFORE an
 * action, so the spec can assert on messages that only exist for ~1s.
 *
 * Polling the region's text directly would be a race with its own self-clearing
 * timeout; recording every value it ever held is not. The comments-count
 * announcer is excluded because it is a different region with a different job,
 * and ExportActions' region is excluded automatically — it carries `aria-live`
 * but no `role` at all.
 */
export async function recordAnnouncements(page: Page): Promise<void> {
  await page.evaluate(() => {
    const container = document.querySelector('[data-testid="review-editor"]');
    if (!container) throw new Error('review editor container not found');
    const log: string[] = [];
    Reflect.set(window, '__announcements', log);
    const read = () => {
      const regions = container.querySelectorAll(
        '[role="status"][aria-atomic="true"], [role="alert"][aria-atomic="true"]',
      );
      for (const region of regions) {
        if (region.classList.contains('comments-count-announcer')) continue;
        const text = (region.textContent ?? '').trim();
        if (text && log[log.length - 1] !== text) log.push(text);
      }
    };
    new MutationObserver(read).observe(container, {
      subtree: true,
      childList: true,
      characterData: true,
    });
  });
}

export function announcements(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const recorded = Reflect.get(window, '__announcements');
    return Array.isArray(recorded) && recorded.every((entry) => typeof entry === 'string')
      ? recorded
      : [];
  });
}

/**
 * The impl's own announcer: the single `[role="status"][aria-atomic="true"]`
 * inside the container that is not the comments-count announcer. Both halves of
 * that filter are load-bearing — `aria-atomic` excludes the editor skeleton,
 * which is also a `role="status"` region and is present in the pre-hydration
 * DOM, and the `:not()` excludes the controls bar's own announcer.
 *
 * An ASSERTIVE announcement swaps this node for a `[role="alert"]` one —
 * LiveRegion renders one branch or the other, never both — so this locator is
 * scoped to the polite messages every test below produces.
 */
export function liveRegion(page: Page) {
  return page
    .getByTestId('review-editor')
    .locator('[role="status"][aria-atomic="true"]:not(.comments-count-announcer)');
}

/** Open the comments sidebar through its toggle. */
export async function openSidebar(page: Page): Promise<void> {
  await page.getByRole('button', { name: /Open comments sidebar/ }).click();
  await expect(page.locator(`#${EDITOR_ID}-sidebar`)).toBeVisible();
}

/**
 * Open the thread popover the keyboard-reachable way — through the sidebar
 * list — and wait for its focus trap to finish taking focus.
 *
 * That last wait is load-bearing for every caller. The popover renders before
 * it is positioned, and the trap only activates once `data-position-ready`
 * flips; its initial focus then lands on a microtask. Anything that touches
 * focus before that would be silently undone a tick later.
 */
export async function openThreadPopover(page: Page): Promise<void> {
  await openSidebar(page);
  // Located by class rather than by role+name on purpose: the thread item's
  // accessible name is its quote and preview concatenated ("Release Plan
  // SENTINEL comment body"), which is content, not a label.
  await page.locator('button.thread-item').click();
  await expect(page.locator('.thread-popover')).toBeVisible();
  await expect
    .poll(() => activeDescriptor(page))
    .toMatchObject({ label: 'Delete thread', inPopover: true });
}
