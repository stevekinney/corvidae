/**
 * The complete Markdown template placeholder flow in MarkdownEditor: the
 * feature spec for COR-521 (source-mode completion), COR-525 (preview) and
 * COR-519 (the cross-mode acceptance matrix), run against the
 * `markdown-editor-template-placeholders` route.
 *
 * - Source mode: completion in the raw Markdown textarea, full-token
 *   replacement, its explicit undo history, and caret-anchored positioning of
 *   the top-layer listbox through wrapping, textarea scrolling and viewport
 *   resizes.
 * - Rich mode: the same completion in the ProseMirror editor, Tab in lists,
 *   the non-color invalid-token cue, and popup placement.
 * - Both modes: keyboard, pointer, touch (Chrome DevTools touch events) and
 *   IME composition (Chrome DevTools `Input.imeSetComposition`), readonly,
 *   definitions replaced while the listbox is open, and two independent
 *   editors on one page.
 * - Preview: filling in both value interpretations, live value and
 *   definition changes, the unchanged saved template, capturing a pending
 *   rich edit, history kept across a preview round trip, and preview parity.
 * - Presentation: light and dark themes at desktop and phone widths, forced
 *   colors, reduced motion, accessible names and role relationships.
 *
 * `componentPage` fails any test that logs a console error or warning, so
 * every test here also proves the flow runs without console errors. The unit
 * suites cover the same contract in happy-dom, including stale async preview
 * results; this spec proves it against real layout and real input.
 */
import type { ComponentEntry, Theme, Viewport } from '@lostgradient/testing';
import { THEMES, VIEWPORTS } from '@lostgradient/testing';
import type { CDPSession, Locator, Page } from '@playwright/test';
import { expect, test } from './component-page-fixture.ts';
import { fixtureEntry } from './editor-fixture.ts';

const entry = fixtureEntry('markdown-editor-template-placeholders');
const VIEWPORT: Viewport = { name: 'desktop', width: 1280, height: 800 };
const LISTBOX_ID = 'template-editor-placeholder-listbox-source';
const RICH_LISTBOX_ID = 'template-editor-placeholder-listbox-wysiwyg';
const SECOND_LISTBOX_ID = 'second-editor-placeholder-listbox-source';
const MARGIN = 8;
/** Every path the fixture's schema declares, in code-unit order. */
const ALL_PATHS = [
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
];

type Box = { x: number; y: number; width: number; height: number };

type ComponentPage = {
  open(args: {
    entry: ComponentEntry;
    theme: Theme;
    viewport: Viewport;
    fixtureName: string;
    onPage?: (page: Page) => void | Promise<void>;
  }): Promise<Page>;
};

type OpenOptions = {
  theme?: Theme;
  viewport?: Viewport;
  onPage?: (page: Page) => void | Promise<void>;
};

async function openFixture(componentPage: ComponentPage, options: OpenOptions = {}): Promise<Page> {
  return componentPage.open({
    entry,
    theme: options.theme ?? 'light',
    viewport: options.viewport ?? VIEWPORT,
    fixtureName: 'assertion',
    ...(options.onPage === undefined ? {} : { onPage: options.onPage }),
  });
}

function textarea(page: Page): Locator {
  return page.locator('#template-editor-mount textarea');
}

function listbox(page: Page): Locator {
  return page.locator(`#${LISTBOX_ID}`);
}

function optionPaths(page: Page, listboxId = LISTBOX_ID): Promise<string[]> {
  return page
    .locator(`[id="${listboxId}"] [role="option"] .template-completion-item-path`)
    .allTextContents();
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

function statusRegion(page: Page): Locator {
  return page.locator('#template-editor-placeholder-status');
}

function diagnosticsSummary(page: Page): Locator {
  return page.locator('#template-editor-placeholder-diagnostics');
}

function richListbox(page: Page): Locator {
  return page.locator(`#${RICH_LISTBOX_ID}`);
}

/**
 * Select a Definitions option the way a parent replaces the prop in code:
 * the radio is activated without a pointer press, so focus and an open
 * listbox stay where they are. (A real pointer press is an outside press,
 * which dismisses the listbox; one test covers that path separately.)
 */
async function replaceDefinitions(page: Page, label: string): Promise<void> {
  await page
    .getByRole('group', { name: 'Definitions' })
    .getByLabel(label, { exact: true })
    .dispatchEvent('click');
}

/** Show the rich editor and wait until Milkdown is ready for input. */
async function showRichEditor(page: Page): Promise<Locator> {
  await modeSegment(page, 'Rich editor').click();
  await expect(page.locator('#template-editor-mount .markdown-editor-wrapper')).toHaveAttribute(
    'data-ready',
    'true',
  );
  await expect(richEditor(page)).toBeVisible();
  return richEditor(page);
}

/**
 * Put the rich caret at the end of the document with a real click just past
 * the last character of the last paragraph. Keyboard shortcuts for "end of
 * document" differ by platform (Control+End does nothing on macOS), so a
 * click is the portable way to get there.
 */
async function placeRichCaretAtEnd(page: Page): Promise<void> {
  const block = richEditor(page).locator('p').last();
  await block.scrollIntoViewIfNeeded();
  const box = await block.boundingBox();
  if (box === null) throw new Error('The last paragraph must have a layout box.');
  await page.mouse.click(box.x + box.width - 1, box.y + box.height - 2);
  await expect(richEditor(page)).toBeFocused();
}

/** Load `document` through source mode, then put the rich caret at its end. */
async function editRichAtEnd(page: Page, document: string): Promise<Locator> {
  await setDocument(page, document);
  const editor = await showRichEditor(page);
  await placeRichCaretAtEnd(page);
  return editor;
}

function lastParagraph(page: Page): Locator {
  return richEditor(page).locator('p').last();
}

/** A DevTools session with touch emulation, for real touch event sequences. */
async function touchSession(page: Page): Promise<CDPSession> {
  const session = await page.context().newCDPSession(page);
  await session.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
  return session;
}

async function centerOf(locator: Locator): Promise<{ x: number; y: number }> {
  const box = await locator.boundingBox();
  if (box === null) throw new Error('The touch target must have a layout box.');
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function tap(session: CDPSession, point: { x: number; y: number }): Promise<void> {
  await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

/** Start an IME composition showing `text`, as an input method would. */
async function compose(session: CDPSession, text: string): Promise<void> {
  await session.send('Input.imeSetComposition', {
    text,
    selectionStart: text.length,
    selectionEnd: text.length,
  });
}

/**
 * Dispatch the Enter keydown an input method sends to confirm a candidate
 * (`isComposing: true`), and report whether anything prevented it.
 */
function pressComposingEnter(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const target = document.activeElement;
    if (target === null) throw new Error('Nothing is focused.');
    const event = new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
      isComposing: true,
    });
    target.dispatchEvent(event);
    return event.defaultPrevented;
  });
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
    expect(await optionPaths(page)).toEqual(ALL_PATHS);
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

  test('replacing the definitions while the listbox is open removes a withdrawn path', async ({
    componentPage,
  }) => {
    const page = await openFixture(componentPage);
    const field = textarea(page);
    await setDocument(page, 'To ');
    await page.keyboard.type('{{us');
    expect(await optionPaths(page)).toEqual(['user', 'user.name']);
    const before = await valueChangeCount(page);
    const selection = (): Promise<number[]> =>
      field.evaluate((element: HTMLTextAreaElement) => [
        element.selectionStart,
        element.selectionEnd,
      ]);
    expect(await selection()).toEqual([7, 7]);

    // A caller replaces the catalog while the popup is open. A pointer press
    // on the control would dismiss the popup as an outside press, so the
    // radio is activated without moving focus, the way a parent would swap
    // the prop programmatically.
    await page
      .getByRole('group', { name: 'Definitions' })
      .getByLabel('Reduced schema', { exact: true })
      .dispatchEvent('click');

    await expect.poll(() => optionPaths(page)).toEqual(['user']);
    await expect(listbox(page)).toBeVisible();
    await expect(page.locator('#template-editor-placeholder-status')).toHaveText(
      '1 placeholder available',
    );
    await expect(field).toBeFocused();
    expect(await readValue(page)).toBe('To {{us');
    expect(await selection()).toEqual([7, 7]);
    expect(await valueChangeCount(page)).toBe(before);
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
    const wrappedValue = await readValue(page);
    await placeCaret(page, wrappedValue.length);
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

function modeSegment(page: Page, label: 'Rich editor' | 'Raw Markdown' | 'Preview'): Locator {
  return page.locator(`#template-editor-mode-toggle button[aria-label="${label}"]`);
}

function previewRegion(page: Page): Locator {
  return page.locator('#template-editor-preview');
}

function previewContent(page: Page): Locator {
  return previewRegion(page).locator('.markdown-editor-preview-content');
}

function richEditor(page: Page): Locator {
  return page.locator('#template-editor-mount .ProseMirror');
}

function boundValue(page: Page): Promise<string> {
  return page.getByTestId('bound-value').innerText();
}

test.describe('MarkdownEditor preview', () => {
  test('fills sample values literally by default and as Markdown on request', async ({
    componentPage,
  }) => {
    const page = await openFixture(componentPage);
    await setDocument(page, 'Hello {{name}}, {{rich}} and {{count}}');
    await modeSegment(page, 'Preview').click();

    await expect(previewRegion(page)).toBeFocused();
    await expect(previewRegion(page).locator('#template-editor-preview-label')).toHaveText(
      'Preview',
    );
    await expect(previewContent(page)).toHaveText('Hello Alice, **important** and 42');
    await expect(previewContent(page).locator('strong')).toHaveCount(0);

    await page.getByLabel('Markdown', { exact: true }).check();
    await expect(previewContent(page).locator('strong')).toHaveText('important');
    await expect(previewContent(page)).toHaveText('Hello Alice, important and 42');
  });

  test('previews the unfilled template without values and keeps tokens visible with {}', async ({
    componentPage,
  }) => {
    const page = await openFixture(componentPage);
    await setDocument(page, 'Hello {{name}}');
    await modeSegment(page, 'Preview').click();

    await page.getByLabel('Not supplied', { exact: true }).check();
    await expect(previewRegion(page).locator('#template-editor-preview-label')).toHaveText(
      'Unfilled template preview',
    );
    await expect(previewContent(page)).toHaveText('Hello {{name}}');

    await page.getByLabel('Empty object', { exact: true }).check();
    await expect(previewRegion(page).locator('#template-editor-preview-label')).toHaveText(
      'Preview',
    );
    await expect(previewContent(page)).toHaveText('Hello {{name}}');
    await expect(page.locator('#template-editor-placeholder-diagnostics')).toContainText('name');
  });

  test('leaves the saved template unchanged', async ({ componentPage }) => {
    const page = await openFixture(componentPage);
    await setDocument(page, 'Dear {{user.name}}');
    const changes = await valueChangeCount(page);

    await modeSegment(page, 'Preview').click();
    await expect(previewContent(page)).toHaveText('Dear Ada');
    await page.getByLabel('Markdown', { exact: true }).check();
    await page.getByLabel('Empty object', { exact: true }).check();
    await expect(previewContent(page)).toHaveText('Dear {{user.name}}');

    expect(await boundValue(page)).toBe('Dear {{user.name}}');
    expect(await valueChangeCount(page)).toBe(changes);
    await modeSegment(page, 'Raw Markdown').click();
    await expect(textarea(page)).toBeFocused();
    expect(await readValue(page)).toBe('Dear {{user.name}}');
  });

  test('captures a pending rich edit once when entering preview', async ({ componentPage }) => {
    const page = await openFixture(componentPage);
    await setDocument(page, 'Hello {{name}}');
    await modeSegment(page, 'Rich editor').click();
    await expect(richEditor(page)).toBeVisible();
    await expect(page.getByTestId('editor-mode')).toHaveText('wysiwyg');

    // Hold every timer so the edit is still pending when preview opens, then
    // release them to prove no delayed notification follows.
    await page.clock.install();
    await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
    const changes = await valueChangeCount(page);
    await placeRichCaretAtEnd(page);
    await page.keyboard.type(' again');
    expect(await valueChangeCount(page)).toBe(changes);

    await modeSegment(page, 'Preview').click();
    await expect(previewContent(page)).toHaveText('Hello Alice again');
    expect(await valueChangeCount(page)).toBe(changes + 1);
    const capturedValue = await boundValue(page);
    expect(capturedValue.trim()).toBe('Hello {{name}} again');

    await page.clock.runFor(5000);
    expect(await valueChangeCount(page)).toBe(changes + 1);
  });

  test('keeps rich history across a preview round trip', async ({ componentPage }) => {
    const page = await openFixture(componentPage);
    await setDocument(page, 'Start');
    await modeSegment(page, 'Rich editor').click();
    await expect(richEditor(page)).toBeVisible();
    await placeRichCaretAtEnd(page);
    await page.keyboard.type(' added');
    await expect(richEditor(page)).toHaveText('Start added');

    await modeSegment(page, 'Preview').click();
    await expect(previewContent(page)).toHaveText('Start added');
    await modeSegment(page, 'Rich editor').click();
    await expect(richEditor(page)).toBeFocused();

    await page.keyboard.press('ControlOrMeta+z');
    await expect(richEditor(page)).toHaveText('Start');
  });

  test('keeps source history and selection across a preview round trip', async ({
    componentPage,
  }) => {
    const page = await openFixture(componentPage);
    await setDocument(page, 'abc');
    await page.keyboard.type('de');
    await expect.poll(() => readValue(page)).toBe('abcde');

    await modeSegment(page, 'Preview').click();
    await expect(previewContent(page)).toHaveText('abcde');
    await modeSegment(page, 'Raw Markdown').click();
    await expect(textarea(page)).toBeFocused();
    const selection = await textarea(page).evaluate((element: HTMLTextAreaElement) => [
      element.selectionStart,
      element.selectionEnd,
    ]);
    expect(selection).toEqual([5, 5]);

    await page.keyboard.press('ControlOrMeta+z');
    await expect.poll(() => readValue(page)).toBe('abcd');
  });

  test('the mode control stays available to readonly editors', async ({ componentPage }) => {
    const page = await openFixture(componentPage);
    await setDocument(page, 'Read {{name}}');
    await page.getByLabel('Readonly').check();

    await expect(page.locator('#template-editor-mode-toggle')).toHaveCount(1);
    await expect(page.locator('#template-editor-mount .editor-toolbar-wrapper')).toHaveCount(0);
    await modeSegment(page, 'Preview').focus();
    await page.keyboard.press('Enter');
    await expect(previewContent(page)).toHaveText('Read Alice');
    await expect(page.getByTestId('editor-mode')).toHaveText('preview');

    await modeSegment(page, 'Raw Markdown').click();
    await expect(textarea(page)).toHaveAttribute('readonly', '');
    expect(await readValue(page)).toBe('Read {{name}}');
  });
});

test.describe('MarkdownEditor placeholder definitions and instances', () => {
  test('a pointer press on the Definitions control dismisses the listbox; the next edit lists the reduced catalog', async ({
    componentPage,
  }) => {
    const page = await openFixture(componentPage);
    await setDocument(page, 'To ');
    await page.keyboard.type('{{us');
    await expect(listbox(page)).toBeVisible();

    await page.getByLabel('Reduced schema', { exact: true }).click();
    await expect(listbox(page)).toBeHidden();
    expect(await readValue(page)).toBe('To {{us');

    await placeCaret(page, 'To {{us'.length);
    await page.keyboard.type('e');
    await expect(listbox(page)).toBeVisible();
    expect(await optionPaths(page)).toEqual(['user']);
  });

  test('explicit candidates list the same catalog; Empty permits nothing; Disabled turns placeholders off', async ({
    componentPage,
  }) => {
    const page = await openFixture(componentPage);
    const field = textarea(page);
    await page.getByLabel('Explicit candidates', { exact: true }).check();
    await setDocument(page, 'x ');
    await page.keyboard.type('{{');
    expect(await optionPaths(page)).toEqual(ALL_PATHS);
    const nameOption = listbox(page).locator(`[id="${LISTBOX_ID}-name"]`);
    await expect(nameOption.locator('.template-completion-item-types')).toHaveText('string');
    await expect(nameOption.locator('.template-completion-item-description')).toHaveText(
      'Display name',
    );
    await expect(
      listbox(page).locator(`[id="${LISTBOX_ID}-nullable"] .template-completion-item-types`),
    ).toHaveText('string|null');
    await page.keyboard.press('Escape');

    // An empty catalog is valid and allows no paths.
    await replaceDefinitions(page, 'Empty');
    await page.keyboard.type('n');
    await expect(statusRegion(page)).toHaveText('No matching placeholders');
    await expect(listbox(page)).toBeHidden();
    await expect(field).toHaveAttribute('aria-autocomplete', 'list');
    expect(await readValue(page)).toBe('x {{n');

    // Without definitions nothing is scanned, offered or reported, not even
    // malformed braces. Sample preview data without definitions is itself a
    // configuration error, reported once; with no data there is nothing.
    await replaceDefinitions(page, 'Disabled');
    await setDocument(page, 'x {{{bad {{');
    await page.keyboard.type('n');
    await expect(listbox(page)).toBeHidden();
    await expect(field).not.toHaveAttribute('aria-autocomplete', /.*/);
    await expect(statusRegion(page)).toHaveText('');
    await expect(diagnosticsSummary(page).locator('li')).toHaveText([
      'Placeholder values require placeholder definitions.',
    ]);
    await page.getByLabel('Not supplied', { exact: true }).check();
    await expect(diagnosticsSummary(page)).toHaveCount(0);
  });

  test('two editors keep separate listboxes, status regions and catalogs', async ({
    componentPage,
  }) => {
    const page = await openFixture(componentPage);
    const second = page.locator('#second-editor-mount textarea');
    await expect(second).toHaveAccessibleName('Second editor');
    await setDocument(page, 'First ');
    await page.keyboard.type('{{');
    await expect(listbox(page)).toBeVisible();

    // A press in the other editor is an outside press for the first one.
    await second.click();
    await expect(listbox(page)).toBeHidden();
    await expect(statusRegion(page)).toHaveText('');
    await second.evaluate((element: HTMLTextAreaElement) => {
      element.setSelectionRange(element.value.length, element.value.length);
    });
    await page.keyboard.type('{{');
    const secondListbox = page.locator(`#${SECOND_LISTBOX_ID}`);
    await expect(secondListbox).toBeVisible();
    expect(await optionPaths(page, SECOND_LISTBOX_ID)).toEqual(['name', 'title']);
    await expect(second).toHaveAttribute('aria-controls', SECOND_LISTBOX_ID);
    await expect(page.locator('#second-editor-placeholder-status')).toHaveText(
      '2 placeholders available',
    );
    await page.keyboard.press('ArrowDown');
    await expect(second).toHaveAttribute('aria-activedescendant', `${SECOND_LISTBOX_ID}-title`);
    await page.keyboard.press('Enter');
    await expect.poll(() => second.inputValue()).toBe('Second {{title}}');
    expect(await readValue(page)).toBe('First {{');

    // Replacing the first editor's catalog leaves the second one alone.
    await replaceDefinitions(page, 'Empty');
    await page.keyboard.type(' {{');
    expect(await optionPaths(page, SECOND_LISTBOX_ID)).toEqual(['name', 'title']);
  });

  test('invalid tokens get a text summary associated with the textarea', async ({
    componentPage,
  }) => {
    const page = await openFixture(componentPage);
    await setDocument(page, 'Bad {{nope}} and {{name}}');
    await expect(diagnosticsSummary(page)).toContainText('Placeholder problems');
    await expect(diagnosticsSummary(page)).toContainText('nope');
    await expect(diagnosticsSummary(page)).not.toContainText('name:');
    const describedBy = (await textarea(page).getAttribute('aria-describedby')) ?? '';
    expect(describedBy.split(' ')).toEqual(
      expect.arrayContaining([
        'template-editor-placeholder-instructions',
        'template-editor-placeholder-diagnostics',
      ]),
    );
  });
});

test.describe('MarkdownEditor rich-mode placeholder completion', () => {
  test('typing {{ opens the named listbox; arrows clamp, Enter inserts one canonical token and one undo removes it', async ({
    componentPage,
  }) => {
    const page = await openFixture(componentPage);
    const editor = await editRichAtEnd(page, 'Hi');
    await page.keyboard.type(' {{');

    const list = richListbox(page);
    await expect(list).toBeVisible();
    await expect(list).toHaveAttribute('role', 'listbox');
    await expect(list).toHaveAttribute('aria-label', 'Placeholders');
    await expect(editor).toHaveAttribute('role', 'textbox');
    await expect(editor).toHaveAttribute('aria-multiline', 'true');
    await expect(editor).toHaveAttribute('aria-autocomplete', 'list');
    await expect(editor).toHaveAttribute('aria-haspopup', 'listbox');
    await expect(editor).toHaveAttribute('aria-controls', RICH_LISTBOX_ID);
    await expect(editor).not.toHaveAttribute('aria-expanded', /.*/);
    await expect.poll(() => optionPaths(page, RICH_LISTBOX_ID)).toEqual(ALL_PATHS);
    await expect(statusRegion(page)).toHaveText('13 placeholders available');

    await expect(editor).toHaveAttribute('aria-activedescendant', `${RICH_LISTBOX_ID}-count`);
    await page.keyboard.press('ArrowUp');
    await expect(editor).toHaveAttribute('aria-activedescendant', `${RICH_LISTBOX_ID}-count`);

    await page.keyboard.type('US');
    await expect.poll(() => optionPaths(page, RICH_LISTBOX_ID)).toEqual(['user', 'user.name']);
    await expect(statusRegion(page)).toHaveText('2 placeholders available');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await expect(editor).toHaveAttribute('aria-activedescendant', `${RICH_LISTBOX_ID}-user.name`);
    await expect(list.locator(`[id="${RICH_LISTBOX_ID}-user.name"]`)).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(statusRegion(page)).toHaveText('user.name, string, 2 of 2');

    await page.keyboard.press('Enter');
    await expect(lastParagraph(page)).toHaveText('Hi {{user.name}}');
    await expect(list).toBeHidden();
    await expect(editor).toBeFocused();
    await expect
      .poll(async () => {
        const saved = await boundValue(page);
        return saved.trim();
      })
      .toBe('Hi {{user.name}}');

    await page.keyboard.press('ControlOrMeta+z');
    await expect(lastParagraph(page)).toHaveText('Hi {{US');
  });

  test('clicking an option inserts it and keeps focus in the editor', async ({ componentPage }) => {
    const page = await openFixture(componentPage);
    const editor = await editRichAtEnd(page, 'Total:');
    await page.keyboard.type(' {{');
    await richListbox(page).locator(`[id="${RICH_LISTBOX_ID}-count"]`).click();
    await expect(lastParagraph(page)).toHaveText('Total: {{count}}');
    await expect(editor).toBeFocused();
    await expect(richListbox(page)).toBeHidden();
  });

  test('acceptance replaces the whole token, including text after the caret and the closing braces', async ({
    componentPage,
  }) => {
    const page = await openFixture(componentPage);
    await editRichAtEnd(page, 'A {{.na}} B');
    await page.keyboard.press('ArrowLeft', { delay: 0 });
    for (let step = 1; step < '.na}} B'.length; step += 1) {
      await page.keyboard.press('ArrowLeft');
    }
    await page.keyboard.type('user');
    await expect.poll(() => optionPaths(page, RICH_LISTBOX_ID)).toEqual(['user', 'user.name']);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(lastParagraph(page)).toHaveText('A {{user.name}} B');
  });

  test('no match announces it; Escape keeps the text; Tab dismisses without inserting', async ({
    componentPage,
  }) => {
    const page = await openFixture(componentPage);
    const editor = await editRichAtEnd(page, '- one\n- two');
    await page.keyboard.type(' {{zz');
    await expect(statusRegion(page)).toHaveText('No matching placeholders');
    await expect(richListbox(page)).toBeHidden();
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Backspace');
    await expect(richListbox(page)).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(richListbox(page)).toBeHidden();
    await expect(editor).toBeFocused();
    await expect(editor.locator('li').last()).toHaveText('two {{');

    await page.keyboard.type('c');
    await expect(richListbox(page)).toBeVisible();
    // Tab dismisses without inserting and is not consumed, so the editor's
    // own Tab binding runs next. What that binding does in a list is not
    // this feature's contract (see the Tab row in markdown-editor.a11y.md),
    // so only the placeholder behavior is asserted: no insertion, and the
    // dismissal survives whatever the key did.
    await page.keyboard.press('Tab');
    await expect(richListbox(page)).toBeHidden();
    await expect(editor.locator('li').last()).toHaveText('two {{c');
    await expect(statusRegion(page)).toHaveText('');
  });

  test('replacing the definitions while the listbox is open removes a withdrawn path', async ({
    componentPage,
  }) => {
    const page = await openFixture(componentPage);
    const editor = await editRichAtEnd(page, 'To');
    await page.keyboard.type(' {{us');
    await expect.poll(() => optionPaths(page, RICH_LISTBOX_ID)).toEqual(['user', 'user.name']);

    await replaceDefinitions(page, 'Reduced schema');
    await expect.poll(() => optionPaths(page, RICH_LISTBOX_ID)).toEqual(['user']);
    await expect(richListbox(page)).toBeVisible();
    await expect(statusRegion(page)).toHaveText('1 placeholder available');
    await expect(editor).toBeFocused();
    await expect(lastParagraph(page)).toHaveText('To {{us');

    // The editor was not recreated: its undo history still holds the typing.
    await page.keyboard.press('Escape');
    await page.keyboard.press('ControlOrMeta+z');
    await expect(lastParagraph(page)).not.toHaveText('To {{us');
  });

  test('readonly disables completion', async ({ componentPage }) => {
    const page = await openFixture(componentPage);
    const editor = await editRichAtEnd(page, 'Locked');
    await expect(editor).toHaveAttribute('aria-autocomplete', 'list');
    await page.getByLabel('Readonly').check();
    await expect(editor).toHaveAttribute('contenteditable', 'false');
    await expect(editor).toHaveAttribute('aria-readonly', 'true');
    await expect(editor).not.toHaveAttribute('aria-autocomplete', /.*/);
    await expect(richListbox(page)).toBeHidden();
  });

  test('invalid tokens get a wavy underline, a reason attribute and the text summary', async ({
    componentPage,
  }) => {
    const page = await openFixture(componentPage);
    await setDocument(page, 'Bad {{nope}} and {{name}}');
    const editor = await showRichEditor(page);
    const invalid = editor.locator('.template-placeholder-invalid');
    await expect(invalid).toHaveCount(1);
    await expect(invalid).toHaveText('{{nope}}');
    await expect(invalid).toHaveAttribute(
      'data-placeholder-validation-reason',
      'unknown_placeholder',
    );
    const decoration = await invalid.evaluate((element) => {
      const style = getComputedStyle(element);
      return { line: style.textDecorationLine, style: style.textDecorationStyle };
    });
    expect(decoration).toEqual({ line: 'underline', style: 'wavy' });
    await expect(diagnosticsSummary(page)).toContainText('nope');
    const describedBy = (await editor.getAttribute('aria-describedby')) ?? '';
    expect(describedBy.split(' ')).toContain('template-editor-placeholder-diagnostics');
  });

  test('the listbox sits under the caret on a wrapped line, through scrolling and a resize', async ({
    componentPage,
  }) => {
    const page = await openFixture(componentPage);
    const paragraphs = Array.from({ length: 12 }, (_, index) => `Paragraph ${index + 1}`);
    const wrapped = `${'wrapping words '.repeat(12)}tail`;
    await editRichAtEnd(page, `${paragraphs.join('\n\n')}\n\n${wrapped}`);
    await page.keyboard.type(' {{');
    await expect(richListbox(page)).toBeVisible();

    // The popup is laid out inside the editor's own scroll container, so
    // each read compares two boxes from the same layout pass.
    const readPlacementAtCaret = () =>
      richListbox(page).evaluate((popup) => {
        const selection = window.getSelection();
        if (selection === null || selection.rangeCount === 0) throw new Error('No caret.');
        const caret = selection.getRangeAt(0).getBoundingClientRect();
        const box = popup.getBoundingClientRect();
        const paragraphs = popup.closest('.markdown-editor')?.querySelectorAll('.ProseMirror p');
        const last = paragraphs?.[paragraphs.length - 1]?.getBoundingClientRect();
        if (last === undefined) throw new Error('No paragraph.');
        return {
          gap: box.top - caret.bottom,
          leftOffset: box.left - caret.left,
          top: box.top,
          caretLineFromParagraphTop: caret.top - last.top,
          lineHeight: Number.parseFloat(getComputedStyle(popup.ownerDocument.body).lineHeight),
        };
      });

    const opened = await readPlacementAtCaret();
    expect(opened.gap).toBeCloseTo(4, 0);
    expect(opened.leftOffset).toBeCloseTo(0, 0);
    expect(opened.caretLineFromParagraphTop).toBeGreaterThan(opened.lineHeight * 2);

    // Scroll the nearest scrolling ancestor of the popup back by up to 40 px
    // and read how far it actually moved.
    const scrolledBy = await richListbox(page).evaluate((popup) => {
      let scroller = popup.parentElement;
      while (
        scroller !== null &&
        !(scroller.scrollHeight > scroller.clientHeight && scroller.scrollTop > 0)
      ) {
        scroller = scroller.parentElement;
      }
      if (scroller === null) throw new Error('No scrolled ancestor.');
      const before = scroller.scrollTop;
      scroller.scrollTop = Math.max(0, before - 40);
      return before - scroller.scrollTop;
    });
    expect(scrolledBy).toBeGreaterThan(0);
    const scrolled = await readPlacementAtCaret();
    expect(scrolled.gap).toBeCloseTo(4, 0);
    expect(scrolled.leftOffset).toBeCloseTo(0, 0);
    expect(scrolled.top - opened.top).toBeCloseTo(scrolledBy, 0);

    await page.setViewportSize({ width: 900, height: 600 });
    const resized = await readPlacementAtCaret();
    expect(resized.gap).toBeCloseTo(4, 0);
    expect(resized.leftOffset).toBeCloseTo(0, 0);
  });
});

test.describe('MarkdownEditor placeholder completion with touch and IME', () => {
  test('source mode: a tap inserts an option; cancelled and scrolling touches insert nothing', async ({
    componentPage,
  }) => {
    const page = await openFixture(componentPage);
    await setDocument(page, 'Tap ');
    await page.keyboard.type('{{');
    await expect(listbox(page)).toBeVisible();
    const session = await touchSession(page);
    const changes = await valueChangeCount(page);

    // A touch the browser cancels never commits.
    const enabled = await centerOf(listbox(page).locator(`[id="${LISTBOX_ID}-enabled"]`));
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [enabled] });
    await session.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });

    // A touch that scrolls the results never commits.
    const items = await centerOf(listbox(page).locator(`[id="${LISTBOX_ID}-items"]`));
    // Explicit event timestamps end the drag with a long hold at its final
    // point, so the gesture has no release velocity and never flings: the
    // list's scroll position is final once the touch ends.
    const start = Date.now() / 1000;
    await session.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [items],
      timestamp: start,
    });
    for (const [step, distance] of [30, 60, 90, 120].entries()) {
      await session.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x: items.x, y: items.y - distance }],
        timestamp: start + 0.02 * (step + 1),
      });
    }
    await session.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: items.x, y: items.y - 120 }],
      timestamp: start + 1,
    });
    await session.send('Input.dispatchTouchEvent', {
      type: 'touchEnd',
      touchPoints: [],
      timestamp: start + 1.01,
    });
    await expect
      .poll(() => listbox(page).evaluate((element) => element.scrollTop))
      .toBeGreaterThan(0);

    // Both gestures left the listbox open and the text alone, so this tap
    // is the one that inserts.
    await listbox(page).evaluate((element) => {
      element.scrollTop = 0;
    });
    await expect.poll(() => listbox(page).evaluate((element) => element.scrollTop)).toBe(0);
    await tap(session, await centerOf(listbox(page).locator(`[id="${LISTBOX_ID}-count"]`)));
    await expect.poll(() => readValue(page)).toBe('Tap {{count}}');
    await expect(textarea(page)).toBeFocused();
    await expect(listbox(page)).toBeHidden();
    expect(await valueChangeCount(page)).toBe(changes + 1);
  });

  test('rich mode: a tap inserts an option and keeps focus in the editor', async ({
    componentPage,
  }) => {
    const page = await openFixture(componentPage);
    const editor = await editRichAtEnd(page, 'Tap');
    await page.keyboard.type(' {{');
    await expect(richListbox(page)).toBeVisible();
    const session = await touchSession(page);
    await tap(
      session,
      await centerOf(richListbox(page).locator(`[id="${RICH_LISTBOX_ID}-count"]`)),
    );
    await expect(lastParagraph(page)).toHaveText('Tap {{count}}');
    await expect(editor).toBeFocused();
  });

  test('source mode: composition pauses completion; the committed text filters and is one undo step', async ({
    componentPage,
  }) => {
    const page = await openFixture(componentPage);
    await setDocument(page, 'Hi ');
    await page.keyboard.type('{{');
    await expect(statusRegion(page)).toHaveText('13 placeholders available');
    const session = await page.context().newCDPSession(page);

    await compose(session, 'u');
    await expect.poll(() => readValue(page)).toBe('Hi {{u');
    // The list is not refiltered, and a confirming Enter does not accept.
    expect(await optionPaths(page)).toEqual(ALL_PATHS);
    expect(await pressComposingEnter(page)).toBe(false);
    expect(await readValue(page)).toBe('Hi {{u');

    await session.send('Input.insertText', { text: 'us' });
    await expect.poll(() => optionPaths(page)).toEqual(['user', 'user.name']);
    expect(await readValue(page)).toBe('Hi {{us');
    await page.keyboard.press('Enter');
    await expect.poll(() => readValue(page)).toBe('Hi {{user}}');

    await page.keyboard.press('ControlOrMeta+z');
    await expect.poll(() => readValue(page)).toBe('Hi {{us');
    await page.keyboard.press('ControlOrMeta+z');
    await expect.poll(() => readValue(page)).toBe('Hi {{');
  });

  test('rich mode: composition pauses completion; the committed text filters and Enter accepts', async ({
    componentPage,
  }) => {
    const page = await openFixture(componentPage);
    await editRichAtEnd(page, 'Hi');
    await page.keyboard.type(' {{');
    await expect(statusRegion(page)).toHaveText('13 placeholders available');
    const session = await page.context().newCDPSession(page);

    await compose(session, 'u');
    await expect(lastParagraph(page)).toHaveText('Hi {{u');
    await expect.poll(() => optionPaths(page, RICH_LISTBOX_ID)).toEqual(ALL_PATHS);
    expect(await pressComposingEnter(page)).toBe(false);
    await expect(lastParagraph(page)).toHaveText('Hi {{u');

    await session.send('Input.insertText', { text: 'us' });
    await expect.poll(() => optionPaths(page, RICH_LISTBOX_ID)).toEqual(['user', 'user.name']);
    await page.keyboard.press('Enter');
    await expect(lastParagraph(page)).toHaveText('Hi {{user}}');
  });
});

test.describe('MarkdownEditor preview values and parity', () => {
  test('formats every JSON kind and keeps a missing value visible with a diagnostic', async ({
    componentPage,
  }) => {
    const page = await openFixture(componentPage);
    await setDocument(
      page,
      '{{count}} {{enabled}} {{nothing}} {{items}} {{settings}} {{nullable}} {{user.name}} {{missing}}',
    );
    await modeSegment(page, 'Preview').click();
    await expect(previewContent(page)).toHaveText(
      '42 false null [1,"x",null] {"a":1,"b":2} optional Ada {{missing}}',
    );
    await expect(previewContent(page).locator('*')).toHaveCount(1);
    await expect(diagnosticsSummary(page)).toContainText('missing');
  });

  test('updates live as values, interpretation and definitions change, without touching the template', async ({
    componentPage,
  }) => {
    const page = await openFixture(componentPage);
    await setDocument(page, 'Hi {{name}} {{rich}}');
    const changes = await valueChangeCount(page);
    await modeSegment(page, 'Preview').click();
    await expect(previewContent(page)).toHaveText('Hi Alice **important**');

    await page.getByLabel('Markdown', { exact: true }).check();
    await expect(previewContent(page).locator('strong')).toHaveText('important');

    await page.getByLabel('Empty object', { exact: true }).check();
    await expect(previewContent(page)).toHaveText('Hi {{name}} {{rich}}');
    await expect(diagnosticsSummary(page)).toContainText('name');
    await expect(diagnosticsSummary(page)).toContainText('rich');

    await page.getByLabel('Sample', { exact: true }).check();
    await page.getByLabel('Explicit candidates', { exact: true }).check();
    await expect(previewContent(page)).toHaveText('Hi Alice important');

    // Values without definitions are a configuration error, not a fill: the
    // unfilled template shows with the error until the values go too.
    await page.getByLabel('Disabled', { exact: true }).check();
    await expect(previewRegion(page).locator('#template-editor-preview-label')).toHaveText(
      'Unfilled template preview',
    );
    await expect(previewContent(page)).toHaveText('Hi {{name}} {{rich}}');
    await expect(diagnosticsSummary(page)).toContainText(
      'Placeholder values require placeholder definitions.',
    );
    await page.getByLabel('Not supplied', { exact: true }).check();
    await expect(previewRegion(page).locator('#template-editor-preview-label')).toHaveText(
      'Preview',
    );
    await expect(diagnosticsSummary(page)).toHaveCount(0);

    expect(await boundValue(page)).toBe('Hi {{name}} {{rich}}');
    expect(await valueChangeCount(page)).toBe(changes);
  });

  test('renders the same preview from either editing mode, and unfilled matches plain Markdown', async ({
    componentPage,
  }) => {
    const page = await openFixture(componentPage);
    await setDocument(page, '# Title\n\nHello {{name}} and *{{rich}}*\n\n- {{count}}');
    await modeSegment(page, 'Preview').click();
    await expect(previewContent(page)).toContainText('Hello Alice');
    const fromSource = await previewContent(page).innerHTML();

    await showRichEditor(page);
    await modeSegment(page, 'Preview').click();
    await expect(previewContent(page)).toContainText('Hello Alice');
    expect(await previewContent(page).innerHTML()).toBe(fromSource);

    await page.getByLabel('Not supplied', { exact: true }).check();
    await expect(previewRegion(page).locator('#template-editor-preview-label')).toHaveText(
      'Unfilled template preview',
    );
    const unfilled = await previewContent(page).innerHTML();
    await page.getByLabel('Disabled', { exact: true }).check();
    await expect(previewRegion(page).locator('#template-editor-preview-label')).toHaveText(
      'Preview',
    );
    expect(await previewContent(page).innerHTML()).toBe(unfilled);
  });
});

const PRESENTATION_VIEWPORTS = VIEWPORTS.filter(
  (viewport) => viewport.name === 'mobile' || viewport.name === 'desktop',
);

test.describe('MarkdownEditor placeholder presentation', () => {
  for (const theme of THEMES) {
    for (const viewport of PRESENTATION_VIEWPORTS) {
      test(`names, relationships and layout: ${theme} ${viewport.name}`, async ({
        componentPage,
      }, testInfo) => {
        const page = await openFixture(componentPage, { theme, viewport });
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        expect(overflow).toBeLessThanOrEqual(0);

        const field = page.getByRole('textbox', { name: 'Template', exact: true });
        await expect(field).toHaveAttribute('aria-multiline', 'true');
        for (const name of ['Definitions', 'Value interpretation', 'Preview data']) {
          await expect(page.getByRole('group', { name, exact: true })).toBeVisible();
        }
        await expect(page.getByRole('checkbox', { name: 'Readonly' })).toBeVisible();
        await expect(modeSegment(page, 'Preview')).toHaveAccessibleName('Preview');

        await setDocument(page, 'Hi ');
        await page.keyboard.type('{{');
        const list = page.getByRole('listbox', { name: 'Placeholders' });
        await expect(list).toHaveAttribute('id', LISTBOX_ID);
        await expect(list.getByRole('option')).toHaveCount(ALL_PATHS.length);
        await page.keyboard.press('ArrowDown');
        const activeId = await field.getAttribute('aria-activedescendant');
        expect(activeId).toBe(`${LISTBOX_ID}-enabled`);
        await expect(list.locator(`[id="${activeId}"]`)).toHaveAttribute('role', 'option');
        await expect(list.locator(`[id="${activeId}"]`)).toHaveAttribute('aria-selected', 'true');

        const status = statusRegion(page);
        await expect(status).toHaveAttribute('role', 'status');
        await expect(status).toHaveAttribute('aria-live', 'polite');
        await expect(status).toHaveAttribute('aria-atomic', 'true');
        await expect(status).toHaveText('enabled, boolean, 2 of 13');
        await expect(field).toHaveAccessibleDescription(
          /Type two opening braces to insert a placeholder\. Use arrow keys and Enter to choose; Escape or Tab dismisses\./,
        );
        const placement = await settledPlacement(page);
        expectInsideViewport(placement.box, viewport);

        await page.screenshot({
          path: testInfo.outputPath(`template-placeholders-${theme}-${viewport.name}.png`),
          fullPage: true,
        });
      });
    }
  }

  test('forced colors and reduced motion keep the non-color cues', async ({
    componentPage,
  }, testInfo) => {
    const page = await openFixture(componentPage, {
      onPage: (target) => target.emulateMedia({ forcedColors: 'active', reducedMotion: 'reduce' }),
    });
    expect(
      await page.evaluate(() => [
        matchMedia('(forced-colors: active)').matches,
        matchMedia('(prefers-reduced-motion: reduce)').matches,
      ]),
    ).toEqual([true, true]);

    await setDocument(page, 'Bad {{nope}} ');
    await page.keyboard.type('{{');
    await page.keyboard.press('ArrowDown');
    const active = listbox(page).locator(`[id="${LISTBOX_ID}-enabled"]`);
    const outline = await active.evaluate((element) => {
      const style = getComputedStyle(element);
      return { style: style.outlineStyle, width: Number.parseFloat(style.outlineWidth) };
    });
    expect(outline.style).toBe('solid');
    expect(outline.width).toBeGreaterThanOrEqual(2);
    // Reduced motion collapses every transition in the listbox to an
    // effectively instant one (the design system's 0.01 ms floor).
    const longestTransition = await listbox(page).evaluate((element) =>
      Math.max(
        0,
        ...element
          .getAnimations({ subtree: true })
          .map((animation) => Number(animation.effect?.getTiming().duration ?? 0)),
      ),
    );
    expect(longestTransition).toBeLessThanOrEqual(0.01);
    await expect(diagnosticsSummary(page)).toContainText('nope');
    await page.screenshot({
      path: testInfo.outputPath('template-placeholders-forced-colors-source.png'),
    });

    await page.keyboard.press('Escape');
    const editor = await showRichEditor(page);
    // The trailing `{{` is an unclosed token, so it is decorated too.
    const invalid = editor.locator('.template-placeholder-invalid', { hasText: '{{nope}}' });
    await expect(invalid).toHaveText('{{nope}}');
    expect(await invalid.evaluate((element) => getComputedStyle(element).textDecorationStyle)).toBe(
      'wavy',
    );
    await page.screenshot({
      path: testInfo.outputPath('template-placeholders-forced-colors-rich.png'),
    });
  });
});
