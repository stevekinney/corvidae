/**
 * Markdown template placeholders in MarkdownEditor (COR-521, extended by
 * COR-525 and COR-519).
 *
 * Source mode: completion in the raw Markdown textarea, its explicit undo
 * history, and caret-anchored positioning of the top-layer listbox through
 * wrapping, textarea scrolling and viewport resizes. The unit suite covers
 * the same contract in happy-dom; this spec proves it against real layout,
 * real keyboard input and Chromium's native textarea behavior.
 */
import type { ComponentEntry, Viewport } from '@lostgradient/testing';
import type { Locator, Page } from '@playwright/test';
import { expect, test } from './component-page-fixture.ts';
import { fixtureEntry } from './editor-fixture.ts';

const entry = fixtureEntry('markdown-editor-template-placeholders');
const VIEWPORT: Viewport = { name: 'desktop', width: 1280, height: 800 };
const LISTBOX_ID = 'template-editor-placeholder-listbox-source';
const MARGIN = 8;

type Box = { x: number; y: number; width: number; height: number };

type ComponentPage = {
  open(args: {
    entry: ComponentEntry;
    theme: 'light';
    viewport: Viewport;
    fixtureName: string;
  }): Promise<Page>;
};

async function openFixture(componentPage: ComponentPage): Promise<Page> {
  return componentPage.open({
    entry,
    theme: 'light',
    viewport: VIEWPORT,
    fixtureName: 'assertion',
  });
}

function textarea(page: Page): Locator {
  return page.locator('#template-editor-mount textarea');
}

function listbox(page: Page): Locator {
  return page.locator(`#${LISTBOX_ID}`);
}

function optionPaths(page: Page): Promise<string[]> {
  return listbox(page).locator('[role="option"] .template-completion-item-path').allTextContents();
}

async function valueChangeCount(page: Page): Promise<number> {
  return Number(await page.getByTestId('value-change-count').textContent());
}

/** Replace the document and put the caret at `caret` (default: the end). */
async function setDocument(page: Page, value: string, caret = value.length): Promise<void> {
  const field = textarea(page);
  await field.fill(value);
  await field.evaluate((element: HTMLTextAreaElement, offset) => {
    element.focus();
    element.setSelectionRange(offset, offset);
  }, caret);
}

async function placeCaret(page: Page, offset: number): Promise<void> {
  await textarea(page).evaluate((element: HTMLTextAreaElement, position) => {
    element.focus();
    element.setSelectionRange(position, position);
  }, offset);
}

async function readValue(page: Page): Promise<string> {
  return textarea(page).inputValue();
}

/** Where the listbox sits, read in one step together with the textarea it belongs to. */
type Placement = {
  /** How many computed positions the popup has applied so far. */
  generation: number;
  /** The listbox's viewport box. */
  box: Box;
  /** Listbox offsets from the textarea's top-left corner. */
  top: number;
  left: number;
  fieldWidth: number;
};

function readPlacement(page: Page): Promise<Placement> {
  return listbox(page).evaluate((popup) => {
    const field = document.querySelector('#template-editor-mount textarea');
    if (!(field instanceof HTMLTextAreaElement)) throw new Error('Missing source textarea');
    const popupRect = popup.getBoundingClientRect();
    const fieldRect = field.getBoundingClientRect();
    return {
      generation: Number(popup.dataset['placeholderPositionGeneration'] ?? 0),
      box: { x: popupRect.x, y: popupRect.y, width: popupRect.width, height: popupRect.height },
      top: popupRect.top - fieldRect.top,
      left: popupRect.left - fieldRect.left,
      fieldWidth: fieldRect.width,
    };
  });
}

/**
 * The listbox placement once a position computed after `afterGeneration` has
 * been applied and no further one is in flight.
 *
 * Positioning is asynchronous, and `autoUpdate` recomputes whenever layout
 * changes, so a single read can land before the latest computation. The
 * popup advances `data-placeholder-position-generation` for every applied
 * result; this waits for a newer generation than the caller saw before its
 * action, then for two consecutive reads with the same generation and
 * geometry. Offsets are relative to the textarea, so layout that moves the
 * whole editor on the page does not change them.
 */
async function settledPlacement(page: Page, afterGeneration = 0): Promise<Placement> {
  let previous: Placement | null = null;
  await expect
    .poll(async () => {
      const current = await readPlacement(page);
      const settled =
        previous !== null &&
        current.generation > afterGeneration &&
        current.generation === previous.generation &&
        current.top === previous.top &&
        current.left === previous.left &&
        current.box.y === previous.box.y;
      previous = current;
      return settled;
    })
    .toBe(true);
  if (previous === null) throw new Error('No listbox placement was read.');
  return previous;
}

function expectInsideViewport(box: Box, viewport: { width: number; height: number }): void {
  expect(box.x).toBeGreaterThanOrEqual(MARGIN - 1);
  expect(box.y).toBeGreaterThanOrEqual(MARGIN - 1);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width - MARGIN + 1);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height - MARGIN + 1);
}

test.describe('MarkdownEditor source-mode placeholder completion', () => {
  test('typing {{ opens the named listbox; filtering and Enter insert one canonical token', async ({
    componentPage,
  }) => {
    const page = await openFixture(componentPage);
    const field = textarea(page);
    await setDocument(page, 'Hi ');
    await field.press('End');

    await page.keyboard.type('{{');
    await expect(listbox(page)).toBeVisible();
    await expect(listbox(page)).toHaveAttribute('role', 'listbox');
    await expect(listbox(page)).toHaveAttribute('aria-label', 'Placeholders');
    await expect(field).toHaveAttribute('aria-controls', LISTBOX_ID);
    await expect(field).toHaveAttribute('aria-autocomplete', 'list');
    await expect(field).not.toHaveAttribute('aria-expanded', /.*/);
    expect(await optionPaths(page)).toEqual([
      'count',
      'enabled',
      'items',
      'missing',
      'name',
      'nothing',
      'nullable',
      'rich',
      'settings',
      'settings.a',
      'settings.b',
      'user',
      'user.name',
    ]);
    await expect(page.locator('#template-editor-placeholder-status')).toHaveText(
      '13 placeholders available',
    );

    // Eight rows are visible and every match stays reachable by scrolling.
    const rows = await listbox(page).evaluate((element) => {
      const listRect = element.getBoundingClientRect();
      const optionRects = [...element.querySelectorAll('[role="option"]')].map((option) =>
        option.getBoundingClientRect(),
      );
      return {
        visible: optionRects.filter(
          (rect) => rect.top >= listRect.top - 1 && rect.bottom <= listRect.bottom + 1,
        ).length,
        scrollable: element.scrollHeight > element.clientHeight,
      };
    });
    expect(rows).toEqual({ visible: 8, scrollable: true });

    await page.keyboard.type('US');
    expect(await optionPaths(page)).toEqual(['user', 'user.name']);
    await page.keyboard.press('ArrowDown');
    await expect(field).toHaveAttribute('aria-activedescendant', `${LISTBOX_ID}-user.name`);

    const before = await valueChangeCount(page);
    await page.keyboard.press('Enter');
    await expect.poll(() => readValue(page)).toBe('Hi {{user.name}}');
    await expect(listbox(page)).toBeHidden();
    expect(await valueChangeCount(page)).toBe(before + 1);
    expect(await field.evaluate((element: HTMLTextAreaElement) => element.selectionStart)).toBe(
      'Hi {{user.name}}'.length,
    );
  });

  test('clicking an option inserts it once and keeps focus in the textarea', async ({
    componentPage,
  }) => {
    const page = await openFixture(componentPage);
    await setDocument(page, 'Total: ');
    await page.keyboard.type('{{');
    const before = await valueChangeCount(page);

    await listbox(page).locator(`[id="${LISTBOX_ID}-count"]`).click();

    await expect.poll(() => readValue(page)).toBe('Total: {{count}}');
    expect(await valueChangeCount(page)).toBe(before + 1);
    await expect(textarea(page)).toBeFocused();
    await expect(listbox(page)).toBeHidden();
  });

  test('acceptance replaces the whole token, including text after the caret and the closing braces', async ({
    componentPage,
  }) => {
    const page = await openFixture(componentPage);
    await setDocument(page, 'A {{.na}} B', 'A {{'.length);
    await page.keyboard.type('user');
    expect(await optionPaths(page)).toEqual(['user', 'user.name']);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect.poll(() => readValue(page)).toBe('A {{user.name}} B');

    // Prose between the caret and a later closing delimiter is never swallowed.
    await setDocument(page, 'Say {{ and then }} later', 'Say {{'.length);
    await page.keyboard.type('co');
    await page.keyboard.press('Enter');
    await expect.poll(() => readValue(page)).toBe('Say {{count}} and then }} later');
  });

  test('one undo reverts an acceptance and redo restores it, each as one change', async ({
    componentPage,
  }) => {
    const page = await openFixture(componentPage);
    await setDocument(page, 'x ');
    await page.keyboard.type('{{en');
    await page.keyboard.press('Enter');
    await expect.poll(() => readValue(page)).toBe('x {{enabled}}');

    const before = await valueChangeCount(page);
    await page.keyboard.press('ControlOrMeta+z');
    await expect.poll(() => readValue(page)).toBe('x {{en');
    expect(await valueChangeCount(page)).toBe(before + 1);

    await page.keyboard.press('ControlOrMeta+Shift+z');
    await expect.poll(() => readValue(page)).toBe('x {{enabled}}');
    expect(await valueChangeCount(page)).toBe(before + 2);

    await page.keyboard.press('ControlOrMeta+z');
    await page.keyboard.press('ControlOrMeta+z');
    await expect.poll(() => readValue(page)).toBe('x {{e');
  });

  test('Escape closes only the popup; Tab dismisses without inserting and moves focus', async ({
    componentPage,
  }) => {
    const page = await openFixture(componentPage);
    await setDocument(page, 'Esc ');
    await page.keyboard.type('{{');
    await page.keyboard.press('Escape');
    await expect(listbox(page)).toBeHidden();
    await expect(textarea(page)).toBeFocused();
    expect(await readValue(page)).toBe('Esc {{');

    await page.keyboard.type('c');
    await expect(listbox(page)).toBeVisible();
    await page.keyboard.press('Tab');
    await expect(listbox(page)).toBeHidden();
    await expect(textarea(page)).not.toBeFocused();
    expect(await readValue(page)).toBe('Esc {{c');
  });

  test('readonly disables completion', async ({ componentPage }) => {
    const page = await openFixture(componentPage);
    await setDocument(page, 'Locked {{');
    await page.getByLabel('Readonly').check();
    await expect(textarea(page)).toHaveAttribute('readonly', '');
    await placeCaret(page, 'Locked {{'.length);
    await page.keyboard.press('ArrowRight');
    await expect(listbox(page)).toBeHidden();
    await expect(textarea(page)).not.toHaveAttribute('aria-autocomplete', /.*/);
  });
});

test.describe('MarkdownEditor source-mode listbox positioning', () => {
  test('follows the caret across wrapped lines without scrolling the textarea', async ({
    componentPage,
  }) => {
    const page = await openFixture(componentPage);
    const field = textarea(page);
    const lineHeight = await field.evaluate((element) =>
      Number.parseFloat(getComputedStyle(element).lineHeight),
    );

    const shortLine = 'Short';
    const wrapped = `${'wrapping words '.repeat(12)}tail`;
    await setDocument(page, `${shortLine}\n${wrapped}`, shortLine.length);
    const scrollTop = await field.evaluate((element) => element.scrollTop);
    await page.keyboard.type('{{');
    await expect(listbox(page)).toBeVisible();
    const first = await settledPlacement(page);
    expect(await field.evaluate((element) => element.scrollTop)).toBe(scrollTop);

    // The end of the wrapped paragraph sits several visual lines lower.
    await page.keyboard.press('Escape');
    await placeCaret(page, (await readValue(page)).length);
    await page.keyboard.type('{{');
    await expect(listbox(page)).toBeVisible();
    const second = await settledPlacement(page, first.generation);
    expect(second.top - first.top).toBeGreaterThan(lineHeight * 2);
    expect(second.left).toBeGreaterThanOrEqual(0);
    expect(second.left).toBeLessThan(second.fieldWidth);
    expectInsideViewport(second.box, VIEWPORT);
  });

  test('moves with the caret when the textarea scrolls', async ({ componentPage }) => {
    const page = await openFixture(componentPage);
    const field = textarea(page);
    const lines = Array.from({ length: 40 }, (_, index) => `Row ${index + 1}`);
    await setDocument(page, lines.join('\n'), 0);
    await field.evaluate((element) => {
      element.scrollTop = 0;
    });
    const caret = `${lines.slice(0, 6).join('\n')}\n`.length;
    await placeCaret(page, caret);
    await page.keyboard.type('{{');
    await expect(listbox(page)).toBeVisible();
    const opened = await settledPlacement(page);

    await field.evaluate((element) => {
      element.scrollTop += 40;
    });
    const scrolled = await field.evaluate((element) => element.scrollTop);
    expect(scrolled).toBeGreaterThan(0);
    const afterScroll = await settledPlacement(page, opened.generation);
    expect(opened.top - afterScroll.top).toBeCloseTo(scrolled, 0);

    // With the caret scrolled out of the textarea's visible box the listbox
    // hides instead of floating beside unrelated text, and it returns once
    // the caret is visible again.
    await field.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    const hidden = await settledPlacement(page, afterScroll.generation);
    await expect(listbox(page)).not.toBeVisible();
    await field.evaluate((element) => {
      element.scrollTop = 0;
    });
    const restored = await settledPlacement(page, hidden.generation);
    await expect(listbox(page)).toBeVisible();
    expect(restored.top).toBeCloseTo(opened.top, 0);
  });

  test('stays inside the viewport when the viewport shrinks', async ({ componentPage }) => {
    const page = await openFixture(componentPage);
    await setDocument(page, 'Resize ');
    await page.keyboard.type('{{');
    await expect(listbox(page)).toBeVisible();
    const opened = await settledPlacement(page);

    const fieldBox = await textarea(page).boundingBox();
    if (fieldBox === null) throw new Error('The textarea must have a layout box.');
    const small = { width: 900, height: Math.round(fieldBox.y + 120) };
    await page.setViewportSize(small);
    const resized = await settledPlacement(page, opened.generation);
    expectInsideViewport(resized.box, small);
  });
});
