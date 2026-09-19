import { THEMES, VIEWPORTS } from '@corvidae/testing';
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
