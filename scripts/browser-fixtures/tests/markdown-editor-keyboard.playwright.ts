import type { ComponentEntry, Viewport } from '@lostgradient/testing';
import type { Page } from '@playwright/test';
import { expect, test } from './component-page-fixture.ts';
import { fixtureEntry } from './editor-fixture.ts';

// Real-browser authority for MarkdownEditor's plain-Tab bindings. The happy-dom
// tests in components/editor/src/lib/editor/editor.tab-escape-keymap.test.ts
// dispatch a synthetic keydown on the view and cannot model the browser's own
// Tab keydown, so these are the tests that prove Tab indents a list item, moves
// to the next table cell, and still releases focus after Escape.
//
// The list tests type their document into the page's FIRST editor mount on
// purpose: COR-1324 lost every custom binding on exactly that mount, while a
// remount (the Raw Markdown round trip the table test uses) hid the defect.

const markdownEditorEntry = fixtureEntry('markdown-editor');
const MOUNT = '#example-mount-basic';
const VIEWPORT: Viewport = { name: 'desktop', width: 1280, height: 800 };

type ComponentPage = {
  open(args: {
    entry: ComponentEntry;
    theme: 'light';
    viewport: Viewport;
    fixtureName: string;
  }): Promise<Page>;
};

async function openFixture(componentPage: ComponentPage): Promise<Page> {
  const page = await componentPage.open({
    entry: markdownEditorEntry,
    theme: 'light',
    viewport: VIEWPORT,
    fixtureName: 'assertion',
  });
  await expect(page.locator(`${MOUNT} .markdown-editor-wrapper`)).toHaveAttribute(
    'data-ready',
    'true',
  );
  return page;
}

/** Build `- one` / `- two` by typing, so input rules create the list. */
async function typeTwoItemList(page: Page) {
  const editor = page.locator(`${MOUNT} .ProseMirror`);
  await editor.click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.press('Backspace');
  await page.keyboard.type('- one');
  await page.keyboard.press('Enter');
  await page.keyboard.type('two');
  await expect(editor.locator(':scope > ul > li')).toHaveCount(2);
  return editor;
}

test.describe('MarkdownEditor keyboard: plain Tab', () => {
  test('plain Tab indents a non-first list item in a real browser', async ({ componentPage }) => {
    const page = await openFixture(componentPage);
    const editor = await typeTwoItemList(page);

    await page.keyboard.press('Tab');

    await expect(editor).toBeFocused();
    const topLevelItems = editor.locator(':scope > ul > li');
    await expect(topLevelItems).toHaveCount(1);
    await expect(topLevelItems.first().locator('p').first()).toHaveText('one');
    await expect(editor.locator(':scope > ul > li > ul > li > p')).toHaveText('two');
  });

  test('plain Tab moves to the next table cell in a real browser', async ({ componentPage }) => {
    const page = await openFixture(componentPage);

    await page.locator('#editor-basic-mode-toggle button[aria-label="Raw Markdown"]').click();
    await page.locator(`${MOUNT} textarea`).fill('| A | B |\n| --- | --- |\n| c | d |');
    await page.locator('#editor-basic-mode-toggle button[aria-label="Rich editor"]').click();
    await expect(page.locator(`${MOUNT} .markdown-editor-wrapper`)).toHaveAttribute(
      'data-ready',
      'true',
    );

    const editor = page.locator(`${MOUNT} .ProseMirror`);
    await editor.locator('th', { hasText: /^A$/ }).click();
    await page.keyboard.press('Tab');

    await expect(editor).toBeFocused();
    await expect
      .poll(() =>
        page.evaluate(() => {
          const anchor = window.getSelection()?.anchorNode ?? null;
          const element = anchor instanceof Element ? anchor : (anchor?.parentElement ?? null);
          return element?.closest('th, td')?.textContent?.trim() ?? null;
        }),
      )
      .toBe('B');
  });

  test('Escape then Tab in a non-first list item releases focus without indenting', async ({
    componentPage,
  }) => {
    const page = await openFixture(componentPage);
    const editor = await typeTwoItemList(page);

    await page.keyboard.press('Escape');
    await page.keyboard.press('Tab');

    await expect(editor).not.toBeFocused();
    await expect(editor.locator(':scope > ul > li')).toHaveCount(2);
    await expect(editor.locator('ul ul')).toHaveCount(0);
  });
});
