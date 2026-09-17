import { expect, test } from '@playwright/test';
import {
  EDITOR_ID,
  announcements,
  liveRegion,
  openSidebar,
  ready,
  recordAnnouncements,
} from './review-ssr-and-a11y-test-helpers';

test.describe('review-ssr-and-a11y: what hydration adds', () => {
  test('every derived id exists once the editor mounts', async ({ page }) => {
    await ready(page);

    // The component derives its whole id namespace from the single `id` prop.
    // Pinning the shape is what lets every other assertion on this page (and
    // in the neighbouring review routes) address parts of the component by id
    // instead of by DOM position.
    await expect(page.locator(`#${EDITOR_ID}-controls`)).toBeVisible();
    await expect(page.locator(`#${EDITOR_ID}-editor-panel`)).toHaveAttribute('role', 'tabpanel');
    await expect(page.locator(`#${EDITOR_ID}-editor-panel`)).toHaveAttribute(
      'aria-label',
      'Editor view',
    );
    await expect(page.locator(`#${EDITOR_ID}-export`)).toBeAttached();

    // The bare id is the ProseMirror HOST — a non-editable wrapper that takes
    // focus itself — and the editable surface is its child.
    const host = page.locator(`#${EDITOR_ID}`);
    await expect(host).toHaveAttribute('role', 'application');
    await expect(host).toHaveAttribute('aria-label', 'Markdown editor');
    await expect(host).toHaveAttribute('tabindex', '0');

    const surface = page.locator(`#${EDITOR_ID} .ProseMirror`);
    await expect(surface).toHaveAttribute('role', 'textbox');
    await expect(surface).toHaveAttribute('contenteditable', 'true');
    await expect(surface).toHaveAttribute('aria-label', 'Markdown editor');
  });

  test('the roving tab stop appears at hydration and follows selection', async ({ page }) => {
    await ready(page);

    // Server-side all three tabs were `tabindex="-1"`. After hydration exactly
    // one is `0`, and it is the selected one.
    const tabs = page.getByRole('tab');
    await expect(tabs).toHaveCount(3);
    await expect(page.getByRole('tab', { selected: true })).toHaveAttribute('tabindex', '0');
    await expect(page.locator('[role="tab"][tabindex="0"]')).toHaveCount(1);

    await page.getByRole('tab', { name: 'Diff' }).click();
    await expect(page.getByRole('tab', { name: 'Diff' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('tab', { name: 'Diff' })).toHaveAttribute('tabindex', '0');
    await expect(page.getByRole('tab', { name: 'Editor' })).toHaveAttribute('tabindex', '-1');
    await expect(page.locator('[role="tab"][tabindex="0"]')).toHaveCount(1);
  });

  test('the editor view renders ONE control row with the formatting controls inside it', async ({
    page,
  }) => {
    await ready(page);

    // The editor view used to stack MarkdownEditor's formatting toolbar as a
    // second full-height bar under the review controls. The formatting group
    // now lives INSIDE the unified bar. Asserted structurally (containment and
    // row count) rather than by pixel height, so it survives spacing changes.
    await expect(page.locator('.review-editor-controls')).toHaveCount(1);
    await expect(page.locator('.editor-toolbar-wrapper')).toHaveCount(0);

    const bar = page.locator(`#${EDITOR_ID}-controls`);
    // The bar is `role="group"`, not `role="toolbar"`: it contains a
    // `tablist` and, in the editor view, the editor's own `toolbar`, and
    // neither is a valid child of `toolbar`. Pinned by attribute so a
    // regression to the nested-toolbar shape says so directly.
    await expect(bar).toHaveAttribute('role', 'group');
    await expect(bar).toHaveAttribute('aria-label', 'Review editor controls');

    // The nested formatting toolbar is a DESCENDANT of the unified bar, not a
    // sibling row below it, and points `aria-controls` at the editor it drives.
    const formatting = page.locator(`#${EDITOR_ID}-toolbar`);
    await expect(bar.locator('.controls-formatting')).toHaveCount(1);
    await expect(bar.locator(`#${EDITOR_ID}-toolbar`)).toHaveCount(1);
    await expect(formatting).toHaveAttribute('role', 'toolbar');
    await expect(formatting).toHaveAttribute('aria-label', 'Formatting toolbar');
    await expect(formatting).toHaveAttribute('aria-controls', EDITOR_ID);
  });

  test('data-ready correctly reflects unmount, not just first paint', async ({ page }) => {
    await ready(page);

    // Switching away from the editor view DESTROYS the MarkdownEditor: the
    // view panel is an `{#if}` chain, so the ProseMirror host is gone.
    await page.getByRole('tab', { name: 'Diff' }).click();
    await expect(page.locator(`#${EDITOR_ID}`)).toHaveCount(0);
    await expect(page.locator('.ProseMirror')).toHaveCount(0);

    // FIXED, cinder#1301: `data-ready` used to be derived from a latch
    // (`editorViewReady`) that was set once and never cleared, so it kept
    // claiming "true" while nothing was mounted. It is now derived from an
    // `$effect` that watches `editorRef` itself — Svelte's own `bind:this`
    // contract unbinds that reference back to `undefined` on teardown — so
    // the attribute correctly goes ABSENT (not `"false"`; the component
    // renders `undefined` for "not ready") the moment the inner editor
    // unmounts, covering the view-switch teardown path and, by construction,
    // any other reason the inner editor goes away.
    await expect(page.getByTestId('review-editor')).not.toHaveAttribute('data-ready');

    // …and it correctly reports "ready" again once the remount actually
    // completes, rather than just staying silent forever. This is the other
    // half of "reflects", not just "resets": a reader waiting on this
    // attribute across a view round trip sees false, then true again, in
    // step with a real editor existing or not.
    await page.getByRole('tab', { name: 'Editor' }).click();
    await expect(page.locator('.ProseMirror')).toBeVisible();
    await expect(page.getByTestId('review-editor')).toHaveAttribute('data-ready', 'true');
  });
});

test.describe('review-ssr-and-a11y: live regions', () => {
  test('one editor ships exactly three aria-live regions, and only two carry a role', async ({
    page,
  }) => {
    await ready(page);

    // Scoped to the container, which also excludes SvelteKit's own
    // `#svelte-announcer` without having to name it.
    const container = page.getByTestId('review-editor');
    await expect(container.locator('[aria-live]')).toHaveCount(3);

    const regions = await container.locator('[aria-live]').evaluateAll((elements) =>
      elements.map((element) => ({
        role: element.getAttribute('role'),
        live: element.getAttribute('aria-live'),
        className: element.className,
        parent: element.parentElement?.className ?? '',
      })),
    );

    // 1. LiveRegion — the impl's announcer, a direct child of the container.
    expect(regions[0]).toMatchObject({ role: 'status', live: 'polite' });
    expect(regions[0]?.className).toContain('cinder-sr-only');

    // 2. ExportActions' copy announcer. It is the odd one out: `aria-live`
    //    with NO `role`. That still works (aria-live alone establishes a live
    //    region) but it means a `[role="status"]` sweep — the natural way to
    //    enumerate announcers — silently misses it.
    expect(regions[1]).toMatchObject({ role: null, live: 'polite' });
    expect(regions[1]?.parent).toContain('export-actions');

    // 3. The controls bar's comment-count announcer, deliberately empty on
    //    first paint: its effect seeds a baseline on the first run and only
    //    speaks on subsequent CHANGES, so mounting does not announce "1
    //    comment" at every reader.
    expect(regions[2]).toMatchObject({ role: 'status', live: 'polite' });
    expect(regions[2]?.className).toContain('comments-count-announcer');
    await expect(container.locator('.comments-count-announcer')).toHaveText('');
  });

  test('the announcer is genuinely screen-reader-only', async ({ page }) => {
    await ready(page);

    // This announcer used to be classed with a bare `sr-only` that resolved to
    // nothing, so every announcement printed itself into the page and shoved
    // the layout down for a second. It now uses Cinder's real utility. Pinned
    // as geometry rather than as a class name so a future rename that breaks
    // the hiding is caught rather than renamed past.
    const geometry = await liveRegion(page).evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return {
        position: getComputedStyle(element).position,
        overflow: getComputedStyle(element).overflow,
        width: rect.width,
        height: rect.height,
      };
    });
    expect(geometry.position).toBe('absolute');
    expect(geometry.overflow).toBe('hidden');
    expect(Math.round(geometry.width)).toBe(1);
    expect(Math.round(geometry.height)).toBe(1);
  });

  test('every view switch is announced, and the announcement self-clears', async ({ page }) => {
    await ready(page);
    await recordAnnouncements(page);

    await page.getByRole('tab', { name: 'Diff' }).click();
    await expect.poll(() => announcements(page)).toContain('Switched to diff view');

    // LiveRegion wipes its message ~1s after setting it, so a reader that
    // arrives late is not read a stale state. This is why the tests above
    // record announcements through a MutationObserver instead of polling the
    // region's text: the text is gone by the time a naive poll could see it.
    await expect(liveRegion(page)).toHaveText('', { timeout: 5000 });

    await page.getByRole('tab', { name: 'Summary' }).click();
    await expect.poll(() => announcements(page)).toContain('Switched to summary view');

    await page.getByRole('tab', { name: 'Editor' }).click();
    await expect.poll(() => announcements(page)).toContain('Switched to editor view');
  });

  test('reverting all changes is announced', async ({ page }) => {
    await ready(page);
    await recordAnnouncements(page);

    // "Revert all changes" only renders in the diff view, and only while the
    // document actually differs from its baseline — which is why the fixture
    // seeds a `value` that differs from `original`.
    await page.getByRole('tab', { name: 'Diff' }).click();
    const revert = page.getByRole('button', { name: 'Revert all changes' });
    await expect(revert).toBeVisible();
    await revert.click();

    await expect.poll(() => announcements(page)).toContain('All changes reverted');

    // The control removes itself once there is nothing left to revert — the
    // visible confirmation that `value` was reset to `original`.
    await expect(revert).toHaveCount(0);
  });

  test('adding a document comment and clearing all comments are both announced', async ({
    page,
  }) => {
    await ready(page);
    await openSidebar(page);
    await recordAnnouncements(page);

    await page.getByRole('button', { name: 'Add document comment' }).click();
    const composer = page.locator(`#${EDITOR_ID}-sidebar-document-composer`);
    await composer.fill('A document-level note');
    await page
      .locator('.document-comment-composer')
      .getByRole('button', { name: 'Comment', exact: true })
      .click();
    await expect.poll(() => announcements(page)).toContain('Document comment added');
    // The props are notification-only: the component announces and emits, and
    // the host page owns the actual mutation. The event log is the evidence.
    await expect(page.getByTestId('event-log')).toContainText('threadcreate:steve');

    // Clearing goes through a confirmation banner inside the sidebar rather
    // than a `window.confirm`, so it is drivable without a dialog handler.
    await page.getByRole('button', { name: 'Comment actions' }).click();
    await page.getByRole('menuitem', { name: 'Clear all comments' }).click();
    await expect(page.getByRole('group', { name: 'Delete all 1 comment threads?' })).toContainText(
      'Delete all 1 comment threads?',
    );
    await page.getByRole('button', { name: 'Delete All' }).click();

    await expect.poll(() => announcements(page)).toContain('All comments cleared');
    await expect(page.getByTestId('event-log')).toContainText('threaddelete:thread-a11y-title');
  });
});
