import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';
import { gotoHydrated } from '../hydration';

export { gotoHydrated };
export type { Page };

export // Where a ReviewEditor anchor actually lands, how it drifts under editing, and
// when it is silently lost or silently moved.
//
// Two things make this route different from the other `review-*` exercises.
//
// First, positions. `anchor.from`/`anchor.to` are PROSEMIRROR POSITIONS while
// `lastKnownOffset` is a `doc.textBetween()` offset — two coordinate systems in
// one object, neither labelled. Every number asserted below was read off the
// live document, not guessed from the markdown source.
//
// Second, timing. The plugin's re-anchoring pass is DEFERRED: it runs 300ms
// after the last document change. Half the behaviours here are only visible on
// one side of that debounce, so the page exposes buttons that drive precise
// ProseMirror transactions rather than typing — a keyboard-driven repro cannot
// land two edits inside 300ms on purpose, and cannot land them 450ms apart on
// purpose either.
//
// That debounce used to be waited out with fixed sleeps — 900ms four times over
// and 1400ms once. Every one of them is gone, and not because the numbers were
// too small. A sleep can only ever say "nothing had happened yet by the time I
// looked", which is the weakest possible reading of "nothing happens": it
// passes for a regression that schedules a re-anchoring pass 901ms out, and it
// says nothing at all about the case the two edge-insertion tests actually care
// about, where no pass is ever scheduled in the first place. The plugin's own
// `needsReanchor` flag is the variable that decides that, so the page publishes
// it (see `anchorState` below) and the tests assert on it directly. Where a
// pass IS expected, the auto-retrying matcher that observes its result is the
// wait, and no separate sleep is needed to license the assertions after it.

const ROUTE = '/exercises/review-anchoring';

/** The page mounts five ReviewEditors. */
export const INSTANCE_COUNT = 5;

/** What `window['__anchorState'](name)` reports; built by the page. */
export type AnchorProbe = { needsReanchor: boolean; statuses: Record<string, string> };

/**
 * The anchor plugin's live state for one instance, read off the page.
 *
 * `needsReanchor` is the whole point. `anchor-decorations.js`'s plugin view
 * returns from `update` before it touches `setTimeout` unless the flag is set,
 * so `needsReanchor: false` is not "the deferred pass has finished" — it is "no
 * deferred pass was ever scheduled", which is a claim no wait can make. It also
 * fails LOUDLY in the direction that matters: a regression that starts
 * scheduling a pass flips the flag on the first read instead of hiding behind a
 * longer sleep.
 *
 * The flag returns to false after a pass completes, including for an anchor the
 * pass has just orphaned (the sync handler deliberately declines to re-raise it
 * for an already-orphaned anchor, which would otherwise loop forever on an idle
 * document). So it is a complete, non-repeating settled signal in both
 * directions, and `statuses` is carried alongside it because "no pass is
 * pending" and "the anchor is placed" are separate claims — an anchor that
 * failed to re-anchor also reports `needsReanchor: false`, just with a status of
 * `orphaned`.
 */
export async function anchorState(
  page: Page,
  instance: 'drift' | 'offbyone',
): Promise<AnchorProbe | null> {
  return page.evaluate((name) => {
    const state = Reflect.get(window, '__anchorState');
    if (typeof state !== 'function') throw new Error('Expected anchor state probe.');
    const result = state(name);
    if (result !== null && (typeof result !== 'object' || Array.isArray(result))) {
      throw new Error('Expected anchor probe result to be an object or null.');
    }
    return result;
  }, instance);
}

/** The drift instance's anchor exactly as the page seeds it. */
export const SEEDED_DRIFT_ANCHOR = {
  from: 44,
  to: 53,
  quote: 'dashboard',
  prefix: 'The first release includes a ',
  suffix: ' and export actions.',
  status: 'anchored',
  originalQuote: 'dashboard',
  lastKnownOffset: 42,
};

export async function ready(page: Page) {
  await gotoHydrated(page, ROUTE);
  // `data-ready` goes up once a ReviewEditor's ProseMirror view exists and no
  // deferred state is pending. Waiting for all five keeps a test from
  // measuring decorations before the plugin has been handed its threads.
  await expect(page.locator(`[data-testid="review-editor"][data-ready="true"]`)).toHaveCount(
    INSTANCE_COUNT,
  );
  // The page publishes its plugin probe from an effect, so it exists a
  // microtask after hydration rather than in the SSR markup. Gating here means
  // every later `anchorState` call can read a plain value: a `null` from the
  // probe then means "no view", which is a real failure, and never "the page
  // had not got round to installing it yet".
  await page.waitForFunction(() => typeof Reflect.get(window, '__anchorState') === 'function');
}

/** Read one of the page's rendered anchor JSON panels. */
export async function anchorJson(page: Page, testId: string) {
  const text = await page.getByTestId(testId).textContent();
  const parsed: unknown = JSON.parse(text ?? 'null');
  if (parsed !== null && (typeof parsed !== 'object' || Array.isArray(parsed))) {
    throw new Error('Expected anchor JSON to be an object or null.');
  }
  return parsed;
}
