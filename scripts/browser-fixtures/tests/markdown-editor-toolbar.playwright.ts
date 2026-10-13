import { THEMES, VIEWPORTS } from '@lostgradient/testing';
import type { Locator, Page } from '@playwright/test';
import { expect, test } from './component-page-fixture.ts';
import { fixtureEntry } from './editor-fixture.ts';

const markdownEditorEntry = fixtureEntry('markdown-editor');

const testedViewports = VIEWPORTS.filter(
  (viewport) => viewport.name === 'desktop' || viewport.name === 'mobile',
);

type Box = {
  x: number;
  y: number;
  width: number;
  height: number;
};

function expectInsideContentBox(childBox: Box, contentBox: { left: number; right: number }) {
  expect(childBox.x).toBeGreaterThanOrEqual(contentBox.left - 1);
  expect(childBox.x + childBox.width).toBeLessThanOrEqual(contentBox.right + 1);
}

function requireBox(
  box: Awaited<ReturnType<import('@playwright/test').Locator['boundingBox']>>,
  label: string,
): Box {
  if (box === null) throw new Error(`${label} must have a layout box.`);
  return box;
}

for (const theme of THEMES) {
  for (const viewport of testedViewports) {
    test(`MarkdownEditor toolbar padding keeps controls inset in ${theme} ${viewport.name}`, async ({
      componentPage,
    }) => {
      const page = await componentPage.open({
        entry: markdownEditorEntry,
        theme,
        viewport,
        fixtureName: 'assertion',
      });

      // The editor id is namespaced per mount (#399), so this scopes to the
      // stable scenario container before locating the component wrapper.
      const editorWrapper = page.locator('#example-mount-basic .markdown-editor-wrapper');
      await expect(editorWrapper).toBeVisible();

      const toolbarWrapper = editorWrapper.locator('.editor-toolbar-wrapper');
      await expect(toolbarWrapper).toBeVisible();

      const toolbar = toolbarWrapper.locator('.editor-toolbar');
      await expect(toolbar).toBeVisible();

      const modeToggle = toolbarWrapper.getByRole('radiogroup', { name: 'Editor mode' });
      await expect(modeToggle).toBeVisible();

      const wrapperMetrics = await toolbarWrapper.evaluate((element) => {
        const computed = getComputedStyle(element);
        const probe = document.createElement('div');
        probe.style.padding = 'var(--cinder-space-2) var(--cinder-space-3)';
        element.append(probe);
        const probeComputed = getComputedStyle(probe);
        const rect = element.getBoundingClientRect();
        const metrics = {
          paddingBlockStart: computed.paddingBlockStart,
          paddingBlockEnd: computed.paddingBlockEnd,
          paddingInlineStart: computed.paddingInlineStart,
          paddingInlineEnd: computed.paddingInlineEnd,
          expectedPaddingBlockStart: probeComputed.paddingBlockStart,
          expectedPaddingBlockEnd: probeComputed.paddingBlockEnd,
          expectedPaddingInlineStart: probeComputed.paddingInlineStart,
          expectedPaddingInlineEnd: probeComputed.paddingInlineEnd,
          left: rect.left,
          right: rect.right,
          scrollWidth: element.scrollWidth,
          clientWidth: element.clientWidth,
        };
        probe.remove();
        return metrics;
      });

      expect(wrapperMetrics.paddingBlockStart).toBe(wrapperMetrics.expectedPaddingBlockStart);
      expect(wrapperMetrics.paddingBlockEnd).toBe(wrapperMetrics.expectedPaddingBlockEnd);
      expect(wrapperMetrics.paddingInlineStart).toBe(wrapperMetrics.expectedPaddingInlineStart);
      expect(wrapperMetrics.paddingInlineEnd).toBe(wrapperMetrics.expectedPaddingInlineEnd);

      await expect(toolbar).toHaveCSS('padding-top', '0px');
      await expect(toolbar).toHaveCSS('padding-right', '0px');
      await expect(toolbar).toHaveCSS('padding-bottom', '0px');
      await expect(toolbar).toHaveCSS('padding-left', '0px');

      const toolbarBox = await toolbar.boundingBox();
      const modeToggleBox = await modeToggle.boundingBox();
      const toolbarMetrics = requireBox(toolbarBox, 'Toolbar');
      const modeToggleMetrics = requireBox(modeToggleBox, 'Mode toggle');

      const contentBox = {
        left: wrapperMetrics.left + parseFloat(wrapperMetrics.paddingInlineStart),
        right: wrapperMetrics.right - parseFloat(wrapperMetrics.paddingInlineEnd),
      };

      expectInsideContentBox(toolbarMetrics, contentBox);
      expectInsideContentBox(modeToggleMetrics, contentBox);
      expect(wrapperMetrics.scrollWidth).toBeLessThanOrEqual(wrapperMetrics.clientWidth + 1);

      if (viewport.name === 'desktop') {
        const toolbarCenter = toolbarMetrics.y + toolbarMetrics.height / 2;
        const modeToggleCenter = modeToggleMetrics.y + modeToggleMetrics.height / 2;
        expect(Math.abs(toolbarCenter - modeToggleCenter)).toBeLessThanOrEqual(8);
      }
    });
  }
}

test('MarkdownEditor settings card keeps toolbar and raw mode usable in a constrained column', async ({
  componentPage,
}) => {
  const page = await componentPage.open({
    entry: markdownEditorEntry,
    theme: 'light',
    viewport: VIEWPORTS.find((viewport) => viewport.name === 'tablet')!,
    fixtureName: 'assertion',
  });

  const settingsCard = page.getByTestId('markdown-editor-settings-card');
  await expect(settingsCard).toBeVisible();

  const editorWrapper = settingsCard.locator('.markdown-editor-wrapper');
  await expect(editorWrapper).toBeVisible();

  const toolbarWrapper = editorWrapper.locator('.editor-toolbar-wrapper');
  const toolbar = toolbarWrapper.locator('.editor-toolbar');
  const modeToggle = toolbarWrapper.getByRole('radiogroup', { name: 'Editor mode' });
  const sourceTextarea = editorWrapper.locator('textarea.markdown-editor.source-mode');

  await expect(toolbar).toBeVisible();
  await expect(modeToggle).toBeVisible();
  await expect(sourceTextarea).toBeVisible();

  const metrics = await toolbarWrapper.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      left: rect.left,
      right: rect.right,
      width: rect.width,
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
    };
  });

  expect(metrics.width).toBeGreaterThanOrEqual(600);
  expect(metrics.width).toBeLessThanOrEqual(900);
  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth + 1);

  const toolbarBox = await toolbar.boundingBox();
  const modeToggleBox = await modeToggle.boundingBox();
  const textareaBox = await sourceTextarea.boundingBox();

  const toolbarMetrics = requireBox(toolbarBox, 'Toolbar');
  const modeToggleMetrics = requireBox(modeToggleBox, 'Mode toggle');
  const textareaMetrics = requireBox(textareaBox, 'Source textarea');

  expectInsideContentBox(toolbarMetrics, metrics);
  expectInsideContentBox(modeToggleMetrics, metrics);
  expect(modeToggleMetrics.y - (toolbarMetrics.y + toolbarMetrics.height)).toBeLessThanOrEqual(12);
  expect(textareaMetrics.height).toBeGreaterThanOrEqual(256);
});

test('MarkdownEditor names its ProseMirror textbox before accessibility checks run', async ({
  componentPage,
}) => {
  const page = await componentPage.open({
    entry: markdownEditorEntry,
    theme: 'light',
    viewport: VIEWPORTS.find((viewport) => viewport.name === 'tablet')!,
    fixtureName: 'assertion',
  });

  const editorTextbox = page.locator('.markdown-editor .ProseMirror[role="textbox"]').first();
  await expect(editorTextbox).toHaveAttribute('aria-label', /\S/);
});

for (const theme of THEMES) {
  for (const width of [320, 512, 848]) {
    test(`MarkdownEditor toolbar stays reachable at ${width}px in ${theme}`, async ({
      componentPage,
    }) => {
      const page = await componentPage.open({
        entry: markdownEditorEntry,
        theme,
        viewport: VIEWPORTS.find((viewport) => viewport.name === 'desktop')!,
        fixtureName: 'assertion',
      });
      const editorWrapper = page.locator('#example-mount-basic .markdown-editor-wrapper');
      await expect(editorWrapper).toBeVisible();
      await editorWrapper.evaluate((element, inlineSize) => {
        (element as HTMLElement).style.inlineSize = `${inlineSize}px`;
        (element as HTMLElement).style.maxInlineSize = `${inlineSize}px`;
      }, width);

      const toolbarWrapper = editorWrapper.locator('.editor-toolbar-wrapper');
      const toolbar = toolbarWrapper.locator('.editor-toolbar');
      const modeToggle = toolbarWrapper.getByRole('radiogroup', { name: 'Editor mode' });
      await expect(toolbar).toBeVisible();
      await expect(modeToggle).toBeVisible();

      const metrics = await toolbarWrapper.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return {
          left: rect.left,
          right: rect.right,
          scrollWidth: element.scrollWidth,
          clientWidth: element.clientWidth,
        };
      });
      expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth + 1);

      const toolbarBox = requireBox(await toolbar.boundingBox(), 'Toolbar');
      const modeToggleBox = requireBox(await modeToggle.boundingBox(), 'Mode toggle');
      expectInsideContentBox(toolbarBox, metrics);
      expectInsideContentBox(modeToggleBox, metrics);

      const actions = await toolbar.locator('button').evaluateAll((buttons) =>
        buttons
          .map((button) => {
            const rect = button.getBoundingClientRect();
            const styles = getComputedStyle(button);
            return {
              left: rect.left,
              right: rect.right,
              top: rect.top,
              bottom: rect.bottom,
              visible: styles.display !== 'none' && styles.visibility !== 'hidden',
            };
          })
          .filter((rect) => rect.visible && rect.right > rect.left && rect.bottom > rect.top),
      );
      for (let index = 1; index < actions.length; index += 1) {
        const previous = actions[index - 1];
        const current = actions[index];
        if (previous === undefined || current === undefined) {
          throw new Error(`Missing toolbar action at index ${index}`);
        }
        expect(
          current.left,
          `button ${index} must not overlap its predecessor`,
        ).toBeGreaterThanOrEqual(previous.right - 1);
      }
    });
  }
}

// ---------------------------------------------------------------------------
// COR-463 — LinkPopover bounds, density, focus, and reachability across the
// light/dark themes, the 320x800 and 1280x720 viewports, and the five popup
// cases named in the ticket (insert with selected text, insert without
// selection, edit an existing link, invalid URL, disabled submit with
// missing required data). Structured as one test per (theme, viewport)
// combination that walks all five cases in sequence — booting one Milkdown
// instance per combination rather than five — instead of 20 independent
// `test()` blocks.
// ---------------------------------------------------------------------------

const linkPopoverViewports = [
  { name: 'mobile' as const, width: 320, height: 800 },
  { name: 'desktop' as const, width: 1280, height: 720 },
];

const HEADER_FOOTER_MAX_HEIGHT = 41; // 40px density budget + 1px sub-pixel rounding allowance
const CONTENT_SPACING_MAX = 13; // --cinder-space-3 (12px) + 1px sub-pixel rounding allowance
const CLOSE_BUTTON_FINE_POINTER_SIZE = 28;
const TITLE_ICON_SIZE = 16;

type PopoverDensity = {
  hasFloatingSurfaceClass: boolean;
  popoverX: number;
  popoverWidth: number;
  headerHeight: number | null;
  footerHeight: number | null;
  closeWidth: number | null;
  closeHeight: number | null;
  titleIconWidth: number | null;
  contentPaddingTop: number | null;
  contentGap: number | null;
};

async function measureLinkPopoverDensity(page: Page): Promise<PopoverDensity> {
  return page.locator('.link-popover').evaluate((element) => {
    const header = element.querySelector('.link-popover-header');
    const footer = element.querySelector('.link-popover-footer');
    const content = element.querySelector('.link-popover-content');
    const close = element.querySelector('.link-popover-close');
    const titleIcon = element.querySelector('.link-popover-title svg');
    const rect = element.getBoundingClientRect();
    const contentStyle = content ? getComputedStyle(content) : null;
    return {
      hasFloatingSurfaceClass: element.classList.contains('cinder-_floating-surface'),
      popoverX: rect.x,
      popoverWidth: rect.width,
      headerHeight: header?.getBoundingClientRect().height ?? null,
      footerHeight: footer?.getBoundingClientRect().height ?? null,
      closeWidth: close?.getBoundingClientRect().width ?? null,
      closeHeight: close?.getBoundingClientRect().height ?? null,
      titleIconWidth: titleIcon?.getBoundingClientRect().width ?? null,
      contentPaddingTop: contentStyle ? parseFloat(contentStyle.paddingTop) : null,
      contentGap: contentStyle ? parseFloat(contentStyle.rowGap || contentStyle.gap) : null,
    };
  });
}

async function assertLinkPopoverBoundsAndDensity(
  page: Page,
  viewportWidth: number,
  label: string,
): Promise<void> {
  const popover = page.locator('.link-popover');
  await expect(popover, `${label}: popover visible`).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.id ?? null), {
      message: `${label}: initial focus reaches the URL input`,
    })
    .toMatch(/-url$/);

  // Floating UI's `autoUpdate` keeps recomputing position for a moment after
  // the first placement (fonts/icons settling can shift the anchor rect
  // slightly), so wait for two consecutive reads of the popover's left edge
  // to agree before measuring bounds — a fixed sleep would either flake on a
  // slow settle or waste time on a fast one.
  let previousLeft: number | null = null;
  await expect
    .poll(
      async () => {
        const currentLeft = await popover.evaluate((element) => element.getBoundingClientRect().x);
        const stable = currentLeft === previousLeft;
        previousLeft = currentLeft;
        return stable;
      },
      { message: `${label}: popover position settles` },
    )
    .toBe(true);

  const density = await measureLinkPopoverDensity(page);
  expect(density.hasFloatingSurfaceClass, `${label}: composes the shared floating-surface`).toBe(
    true,
  );
  expect(density.headerHeight, `${label}: header height measured`).not.toBeNull();
  expect(density.headerHeight!, `${label}: header <= 40px`).toBeLessThanOrEqual(
    HEADER_FOOTER_MAX_HEIGHT,
  );
  expect(density.footerHeight!, `${label}: footer <= 40px`).toBeLessThanOrEqual(
    HEADER_FOOTER_MAX_HEIGHT,
  );
  expect(density.closeWidth!, `${label}: close button width is 28px`).toBeCloseTo(
    CLOSE_BUTTON_FINE_POINTER_SIZE,
    0,
  );
  expect(density.closeHeight!, `${label}: close button height is 28px`).toBeCloseTo(
    CLOSE_BUTTON_FINE_POINTER_SIZE,
    0,
  );
  expect(density.titleIconWidth!, `${label}: title icon is 16px`).toBeCloseTo(TITLE_ICON_SIZE, 0);
  expect(density.contentPaddingTop!, `${label}: content padding <= 12px`).toBeLessThanOrEqual(
    CONTENT_SPACING_MAX,
  );
  expect(density.contentGap!, `${label}: content gap <= 12px`).toBeLessThanOrEqual(
    CONTENT_SPACING_MAX,
  );
  // No horizontal viewport overflow.
  expect(
    density.popoverX,
    `${label}: popover does not overflow the viewport's left edge`,
  ).toBeGreaterThanOrEqual(0);
  expect(
    density.popoverX + density.popoverWidth,
    `${label}: popover does not overflow the viewport's right edge`,
  ).toBeLessThanOrEqual(viewportWidth + 1);
  await expect(page.locator('.link-popover-close'), `${label}: Close is reachable`).toBeVisible();
}

// COR-1320 — the "insert WITH a selection" case builds its selection from key
// presses, and under machine load both the browser's DOM selection and the
// ProseMirror selection the toolbar reads can trail those key events. These
// readers let the case wait on each step's observed selection instead of on
// key-event timing.

type ProseMirrorSelectionReading = { from: number; to: number };

// The fixture mirrors the basic editor's `onSelectionChange` callback into
// `data-selection-from` and `data-selection-to` on `#example-mount-basic`.
// Either attribute missing means the selection is unknown, reported as `null`
// so that a wait on it keeps polling instead of matching any expected value.
async function readProseMirrorSelection(page: Page): Promise<ProseMirrorSelectionReading | null> {
  return page.locator('#example-mount-basic').evaluate((element) => {
    const from = element.getAttribute('data-selection-from');
    const to = element.getAttribute('data-selection-to');
    if (from === null || to === null) return null;
    return { from: Number(from), to: Number(to) };
  });
}

async function readProseMirrorSelectionLength(page: Page): Promise<number | null> {
  const reading = await readProseMirrorSelection(page);
  return reading === null ? null : reading.to - reading.from;
}

type DomSelectionReading = {
  text: string;
  collapsed: boolean;
  insideParagraph: boolean;
  atParagraphStart: boolean;
};

// The browser's own selection, read independently of ProseMirror: its text,
// whether it is collapsed, whether it is anchored inside `paragraph`, and
// whether its range starts at offset 0 of the paragraph's first position.
async function readDomSelection(paragraph: Locator): Promise<DomSelectionReading> {
  return paragraph.evaluate((element) => {
    const selection = window.getSelection();
    if (selection === null || selection.rangeCount === 0) {
      return { text: '', collapsed: false, insideParagraph: false, atParagraphStart: false };
    }
    const range = selection.getRangeAt(0);
    return {
      text: selection.toString(),
      collapsed: selection.isCollapsed,
      insideParagraph: selection.anchorNode !== null && element.contains(selection.anchorNode),
      atParagraphStart:
        range.startOffset === 0 &&
        (range.startContainer === element || range.startContainer === element.firstChild),
    };
  });
}

for (const theme of THEMES) {
  for (const viewport of linkPopoverViewports) {
    test(`MarkdownEditor LinkPopover bounds and density across the five popup cases in ${theme} at ${viewport.width}x${viewport.height}`, async ({
      componentPage,
    }) => {
      const page = await componentPage.open({
        entry: markdownEditorEntry,
        theme,
        viewport,
        fixtureName: 'assertion',
      });

      const editorWrapper = page.locator('#example-mount-basic .markdown-editor-wrapper');
      await expect(editorWrapper).toBeVisible();
      const paragraph = editorWrapper.locator('.ProseMirror p').first();
      await expect(paragraph).toBeVisible();
      const linkButton = editorWrapper.locator('[data-testid="toolbar-link"]');
      const urlField = page.locator('.link-popover-content input[type="url"]');
      const textField = page.locator('.link-popover-content input:not([type="url"])');

      // Case: insert WITH a selection — selects the paragraph's first word
      // ("This"), so the popover renders URL-only (no separate text field).
      // Each input is awaited on the observed DOM and ProseMirror selections
      // before the next one is sent, so a lagging selection update under load
      // cannot shorten the selection the toolbar reads when Link is clicked.
      //
      // The editor reports its initial selection (the end of the document)
      // before it is ever clicked, and when ProseMirror is first focused it
      // writes its own selection back into the DOM a moment later. If that
      // write-back runs after Home and before ProseMirror has read the click,
      // it moves the DOM caret back to the stale position. So the click lands
      // on the paragraph's first line at its left edge, and the case waits for
      // the ProseMirror reading to move off its pre-click value: any later
      // write-back then targets the paragraph start, the same place Home does.
      const selectionBeforeClick = await readProseMirrorSelection(page);
      await paragraph.click({ position: { x: 2, y: 4 } });
      await expect(
        editorWrapper.locator('.ProseMirror'),
        'insert with selection: click focuses the editor content',
      ).toBeFocused();
      await expect
        .poll(() => readDomSelection(paragraph), {
          message: 'insert with selection: click leaves a collapsed caret in the first paragraph',
        })
        .toMatchObject({ collapsed: true, insideParagraph: true });
      await expect
        .poll(() => readProseMirrorSelection(page), {
          message: 'insert with selection: ProseMirror selection reflects the click',
        })
        .not.toEqual(selectionBeforeClick);
      await expect
        .poll(() => readProseMirrorSelectionLength(page), {
          message: 'insert with selection: ProseMirror selection is collapsed after the click',
        })
        .toBe(0);

      await page.keyboard.press('Home');
      await expect
        .poll(() => readDomSelection(paragraph), {
          message: 'insert with selection: Home moves the DOM caret to the paragraph start',
        })
        .toMatchObject({ text: '', collapsed: true, atParagraphStart: true });
      await expect
        .poll(() => readProseMirrorSelectionLength(page), {
          message: 'insert with selection: ProseMirror selection is collapsed after Home',
        })
        .toBe(0);

      // Four keyboard presses select "This"; each one is confirmed in both the
      // DOM selection and the ProseMirror selection before the next press.
      let selectionAnchor: number | null = null;
      for (const [index, expectedText] of ['T', 'Th', 'Thi', 'This'].entries()) {
        const pressCount = index + 1;
        await page.keyboard.press('Shift+ArrowRight');
        await expect
          .poll(async () => (await readDomSelection(paragraph)).text, {
            message: `insert with selection: DOM selection after press ${pressCount}`,
          })
          .toBe(expectedText);
        if (selectionAnchor === null) {
          await expect
            .poll(() => readProseMirrorSelectionLength(page), {
              message: `insert with selection: ProseMirror selection length after press ${pressCount}`,
            })
            .toBe(pressCount);
          const reading = await readProseMirrorSelection(page);
          if (reading === null)
            throw new Error('ProseMirror selection must be known after press 1.');
          selectionAnchor = reading.from;
        } else {
          const anchor = selectionAnchor;
          await expect
            .poll(() => readProseMirrorSelection(page), {
              message: `insert with selection: ProseMirror selection after press ${pressCount}`,
            })
            .toEqual({ from: anchor, to: anchor + pressCount });
        }
      }

      await linkButton.click();
      await assertLinkPopoverBoundsAndDensity(page, viewport.width, 'insert with selection');
      await expect(textField, 'insert with selection: no text field').toHaveCount(0);
      await urlField.fill('example.com');
      await page
        .locator('.link-popover')
        .getByRole('button', { name: 'Insert', exact: true })
        .click();
      await expect(page.locator('.link-popover')).toBeHidden();

      // Case: insert WITHOUT a selection — caret only, at the end of the
      // paragraph. Renders both fields, and (case: disabled submit) Insert
      // stays disabled until both required fields have a value.
      await paragraph.click();
      await page.keyboard.press('End');
      await linkButton.click();
      await assertLinkPopoverBoundsAndDensity(page, viewport.width, 'insert without selection');
      await expect(urlField, 'insert without selection: URL field present').toBeVisible();
      await expect(textField, 'insert without selection: text field present').toBeVisible();
      await expect(
        page.locator('.link-popover').getByRole('button', { name: 'Insert', exact: true }),
        'disabled submit: Insert disabled with empty required fields',
      ).toBeDisabled();
      await page.keyboard.press('Escape');
      await expect(page.locator('.link-popover')).toBeHidden();

      // Case: edit an existing link — click into the "This" link created
      // above and reopen the popover from the toolbar.
      const insertedLink = editorWrapper.locator('a', { hasText: 'This' });
      await expect(insertedLink).toBeVisible();
      await insertedLink.click();
      await linkButton.click();
      await assertLinkPopoverBoundsAndDensity(page, viewport.width, 'edit existing link');
      await expect(
        page.locator('.link-popover').getByRole('button', { name: 'Update', exact: true }),
      ).toBeVisible();
      await expect(
        page.locator('.link-popover').getByRole('button', { name: 'Remove', exact: true }),
      ).toBeVisible();
      await expect(urlField).toHaveValue('https://example.com');

      // Case: invalid URL — typing a dangerous scheme into the same open
      // (edit) popover surfaces the error and disables Update.
      await urlField.fill('javascript:alert(1)');
      await expect(page.getByText('This URL scheme is not allowed')).toBeVisible();
      await expect(
        page.locator('.link-popover').getByRole('button', { name: 'Update', exact: true }),
        'invalid URL: Update disabled',
      ).toBeDisabled();
      await assertLinkPopoverBoundsAndDensity(page, viewport.width, 'invalid URL');
      await page.keyboard.press('Escape');
      await expect(page.locator('.link-popover')).toBeHidden();
    });
  }
}
