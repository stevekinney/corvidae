/// <reference lib="dom" />
/**
 * JsonEditor layout, measured in a browser because happy-dom performs no layout.
 *
 * Gutter: CodeMirror does not measure an editor wholly outside the window, so one that mounted
 * below the fold drew its line numbers from a 14px estimate with no top padding, drifting further
 * from their lines down the document until it scrolled into view (and forever in a capture beyond
 * the viewport). The `long-document` fixture is opened in a window too short to show the editor,
 * and every drawn number must sit on its line without the page scrolling. In the built fixture
 * host the stylesheet that sets the editor's font size can land after the editor mounts, so this
 * also covers metrics that change while the editor is off-window.
 */

import { resolvedTokenColor, THEME_STORAGE_KEY } from '@lostgradient/testing';
import { fixtureRoute } from '@lostgradient/testing/playwright/overlay-fixture';
import { expect, test, type Browser, type Page } from '@playwright/test';

const TOLERANCE = 0.5;

async function openFixture(
  browser: Browser,
  options: { fixtureName: string; theme?: 'light' | 'dark'; width: number; height: number },
): Promise<Page> {
  const theme = options.theme ?? 'light';
  const context = await browser.newContext({
    colorScheme: theme,
    reducedMotion: 'reduce',
    viewport: { width: options.width, height: options.height },
  });
  await context.addInitScript(([key, value]) => localStorage.setItem(key, value), [
    THEME_STORAGE_KEY,
    theme,
  ] as const);
  const page = await context.newPage();
  await page.goto(fixtureRoute('json-editor', { fixtureName: options.fixtureName }), {
    waitUntil: 'load',
  });
  await page.locator('.cinder-json-editor .cm-editor .cm-line').first().waitFor({
    state: 'attached',
  });
  return page;
}

type GutterGeometry = {
  lines: number;
  numbers: number;
  worstOffset: number;
  /** The first few number and line heights and tops, so a failure says what it saw. */
  sample: string;
};

function aligned(geometry: GutterGeometry): boolean {
  return geometry.numbers === geometry.lines && geometry.worstOffset <= TOLERANCE;
}

/** Pair each drawn line number with its text line and report the worst vertical offset. */
async function gutterGeometry(page: Page): Promise<GutterGeometry> {
  return await page.evaluate(() => {
    const lines = [...document.querySelectorAll('.cinder-json-editor .cm-content > .cm-line')];
    const numbers = [
      ...document.querySelectorAll('.cinder-json-editor .cm-lineNumbers .cm-gutterElement'),
    ].filter((element) => element.textContent !== '' && element.getBoundingClientRect().height > 0);
    let worstOffset = 0;
    for (const [index, number] of numbers.entries()) {
      const line = lines[index];
      if (!line) continue;
      const offset = Math.abs(
        number.getBoundingClientRect().top - line.getBoundingClientRect().top,
      );
      worstOffset = Math.max(worstOffset, offset);
    }
    const sample = numbers
      .slice(0, 3)
      .map((number, index) => {
        const numberBox = number.getBoundingClientRect();
        const lineBox = lines[index]?.getBoundingClientRect();
        return `${number.textContent}: number ${numberBox.top}+${numberBox.height}, line ${lineBox?.top}+${lineBox?.height}`;
      })
      .join('; ');
    return { lines: lines.length, numbers: numbers.length, worstOffset, sample };
  });
}

for (const width of [1280, 390]) {
  test(`JsonEditor gutter sits on its lines when the editor mounts below the fold, at ${width}`, async ({
    browser,
  }) => {
    const page = await openFixture(browser, { fixtureName: 'long-document', width, height: 16 });
    try {
      const editorTop = await page
        .locator('.cinder-json-editor .cm-editor')
        .evaluate((element) => element.getBoundingClientRect().top);
      expect(editorTop, 'the editor starts below the window').toBeGreaterThan(16);

      await expect
        .poll(async () => {
          // A capture beyond the viewport is where the drift showed, and it also makes a headless
          // browser render frames for a page whose only content is off-screen.
          await page.screenshot({ fullPage: true });
          const geometry = await gutterGeometry(page);
          return aligned(geometry) ? 'aligned' : JSON.stringify(geometry);
        })
        .toBe('aligned');
      // Off-window, CodeMirror draws only the lines near the top it measured: all 32 when they do
      // not wrap, fewer at phone width, where they do. Before the fix the drawn numbers ran short
      // of the lines and drifted.
      const geometry = await gutterGeometry(page);
      if (width === 1280) expect(geometry.lines, 'the whole short document is drawn').toBe(32);
      else expect(geometry.lines).toBeGreaterThan(10);
      expect(await page.evaluate(() => window.scrollY), 'mounting never scrolls the page').toBe(0);
      expect(await page.evaluate(() => document.activeElement?.tagName)).toBe('BODY');
    } finally {
      await page.context().close();
    }
  });
}

test('JsonEditor gutter sits on its lines for an editor in view', async ({ browser }) => {
  const page = await openFixture(browser, {
    fixtureName: 'long-document',
    width: 1280,
    height: 900,
  });
  try {
    await expect
      .poll(async () => {
        const geometry = await gutterGeometry(page);
        return aligned(geometry) ? 'aligned' : JSON.stringify(geometry);
      })
      .toBe('aligned');
  } finally {
    await page.context().close();
  }
});

test('JsonEditor Format is a tab stop ahead of the text when the source parses', async ({
  browser,
}) => {
  const page = await openFixture(browser, { fixtureName: 'assertion', width: 1280, height: 900 });
  try {
    await expect(page.getByRole('status')).toContainText('Valid JSON');
    const format = page.getByRole('button', { name: 'Format' });
    await format.focus();
    await expect(format).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.locator('.cinder-json-editor .cm-content')).toBeFocused();
  } finally {
    await page.context().close();
  }
});

type MarkGeometry = {
  line: { left: number; right: number; top: number; bottom: number; borderStart: string };
  message: { left: number; right: number; top: number; bottom: number; borderStart: string };
  content: { left: number; right: number };
  lineFill: string;
  messageFill: string;
  gutterFill: string;
  gutterColor: string;
  normalNumberColor: string;
};

for (const theme of ['light', 'dark'] as const) {
  for (const width of [1280, 390]) {
    test(`JsonEditor marks a problem line as one rectangle with a bar at its start, ${theme} at ${width}`, async ({
      browser,
    }) => {
      const page = await openFixture(browser, {
        fixtureName: 'problem-line',
        theme,
        width,
        height: 900,
      });
      try {
        const message = page.locator('.cinder-json-editor__problem');
        const line = page.locator('.cinder-json-editor__line--problem');
        await expect(message).toBeVisible();
        // The widget can be visible before CodeMirror's line resolves the dark surface token.
        // Require both backgrounds to resolve to the danger fill before measuring the rectangle.
        const fill = await resolvedTokenColor(message, '--cinder-status-danger-background');
        await expect(line).toHaveCSS('background-color', fill);
        await expect(message).toHaveCSS('background-color', fill);
        const mark = await page.evaluate((): MarkGeometry => {
          const read = (selector: string) => {
            const element = document.querySelector(selector);
            if (!(element instanceof HTMLElement)) throw new Error(`Missing ${selector}.`);
            return element;
          };
          const box = (element: HTMLElement) => {
            const rect = element.getBoundingClientRect();
            return {
              left: rect.left,
              right: rect.right,
              top: rect.top,
              bottom: rect.bottom,
              borderStart: `${getComputedStyle(element).borderLeftWidth} ${getComputedStyle(element).borderLeftStyle}`,
            };
          };
          const line = read('.cinder-json-editor__line--problem');
          const message = read('.cinder-json-editor__problem');
          const content = read('.cm-content').getBoundingClientRect();
          const gutter = read('.cm-gutterElement.cinder-json-editor__gutter--problem');
          const normal = [...document.querySelectorAll('.cm-lineNumbers .cm-gutterElement')].find(
            (element) => element.textContent === '1',
          );
          if (!(normal instanceof HTMLElement)) throw new Error('Missing line number 1.');
          return {
            line: box(line),
            message: box(message),
            content: { left: content.left, right: content.right },
            lineFill: getComputedStyle(line).backgroundColor,
            messageFill: getComputedStyle(message).backgroundColor,
            gutterFill: getComputedStyle(gutter).backgroundColor,
            gutterColor: getComputedStyle(gutter).color,
            normalNumberColor: getComputedStyle(normal).color,
          };
        });

        // One rectangle: the line and its message share both edges and touch, with one fill.
        expect(Math.abs(mark.line.left - mark.message.left)).toBeLessThanOrEqual(TOLERANCE);
        expect(Math.abs(mark.line.right - mark.message.right)).toBeLessThanOrEqual(TOLERANCE);
        expect(Math.abs(mark.message.top - mark.line.bottom)).toBeLessThanOrEqual(TOLERANCE);
        expect(mark.messageFill).toBe(mark.lineFill);
        // The full width of the text area, starting at its inline start.
        expect(Math.abs(mark.line.left - mark.content.left)).toBeLessThanOrEqual(TOLERANCE);
        expect(mark.line.right).toBeGreaterThanOrEqual(mark.content.right - TOLERANCE);
        // A coloured bar down its inline start, on both parts.
        expect(mark.line.borderStart).toBe('3px solid');
        expect(mark.message.borderStart).toBe('3px solid');
        // The gutter takes no fill, so the mark has no step; only the number turns red.
        expect(mark.gutterFill).toBe('rgba(0, 0, 0, 0)');
        expect(mark.gutterColor).not.toBe(mark.normalNumberColor);
      } finally {
        await page.context().close();
      }
    });

    test(`JsonEditor has no header band: status and Format float in the top corner, ${theme} at ${width}`, async ({
      browser,
    }) => {
      const page = await openFixture(browser, {
        fixtureName: 'problem-line',
        theme,
        width,
        height: 900,
      });
      try {
        await page.locator('.cinder-json-editor__problem').waitFor();
        expect(await page.locator('.cinder-json-editor__toolbar').count()).toBe(0);
        // CodeMirror measures its line height after the fixture mounts, and the stylesheet that sets
        // the editor's font size can land after that, so the first line's height is settled only
        // once the geometry stops changing. Poll it instead of reading it once.
        await expect
          .poll(async () => {
            const corner = await page.evaluate(() => {
              const rect = (selector: string) => {
                const element = document.querySelector(selector);
                if (!(element instanceof HTMLElement)) throw new Error(`Missing ${selector}.`);
                return element.getBoundingClientRect();
              };
              const frame = rect('.cinder-json-editor__input');
              const actions = rect('.cinder-json-editor__actions');
              const editor = rect('.cm-editor');
              const gutters = rect('.cm-gutters');
              const firstLine = rect('.cm-content > .cm-line');
              const actionsElement = document.querySelector('.cinder-json-editor__actions');
              return {
                frameTop: frame.top,
                frameRight: frame.right,
                editorTop: editor.top,
                actionsTop: actions.top,
                actionsBottom: actions.bottom,
                actionsLeft: actions.left,
                actionsRight: actions.right,
                guttersRight: gutters.right,
                firstLineBottom: firstLine.bottom,
                actionsBorder: actionsElement
                  ? getComputedStyle(actionsElement).borderTopWidth
                  : '',
              };
            });
            const problems: string[] = [];
            // The editor starts at the frame's top edge: nothing sits above it.
            if (Math.abs(corner.editorTop - corner.frameTop) > 1 + TOLERANCE) {
              problems.push('the editor does not start at the frame top');
            }
            // The actions float in the top inline-end corner, over the first line only.
            if (corner.actionsTop - corner.frameTop > 8) problems.push('actions sit too low');
            if (corner.frameRight - corner.actionsRight > 24)
              problems.push('actions sit too far in');
            if (corner.actionsBottom > corner.firstLineBottom + TOLERANCE) {
              problems.push('actions reach past the first line');
            }
            if (corner.actionsLeft < corner.guttersRight) problems.push('actions cover the gutter');
            if (corner.actionsBorder !== '0px') problems.push('actions have a border');
            return problems.length === 0
              ? 'in the corner'
              : `${problems.join('; ')} ${JSON.stringify(corner)}`;
          })
          .toBe('in the corner');

        // Reachable by keyboard and announced: the status action is a tab stop ahead of the text
        // (Format is off while the source does not parse), and the status is a live region.
        await expect(page.getByRole('status')).toContainText('Line 4');
        await expect(page.getByRole('button', { name: 'Format' })).toBeDisabled();
        const statusAction = page.locator('.cinder-json-editor__status-action');
        await statusAction.focus();
        await expect(statusAction).toBeFocused();
        await page.keyboard.press('Tab');
        await expect(page.locator('.cinder-json-editor .cm-content')).toBeFocused();
      } finally {
        await page.context().close();
      }
    });
  }
}
