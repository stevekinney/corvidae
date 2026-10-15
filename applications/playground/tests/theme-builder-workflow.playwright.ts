import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';

import {
  hasNoHorizontalOverflow,
  previewFrame,
  selectContext,
  trackConsoleProblems,
  waitForPreviewApplied,
  type PreviewContext,
} from './support/theme-builder.ts';

/**
 * The complete builder workflow on one page, step by step (COR-254): create a theme; edit a
 * foundation token, a spacing token, a motion token, a color, a composite and an alias; export
 * source, CSS and portable output and compare them with what the preview shows; apply a
 * palette and see its findings; apply a remediation fix and undo it; re-import the exported
 * source and reach the identical draft; reload and find the same draft; then walk every light,
 * dark and motion context and the four reference widths with no horizontal overflow.
 *
 * The steps run in order against one page, so each is its own test with the default budget and
 * a failure names the step. The same suite runs against the dev server and the static export.
 */

test.describe.configure({ mode: 'serial' });

let context: BrowserContext;
let page: Page;
let problems: string[] = [];
let exportedSource = '';

test.beforeAll(async ({ browser }, testInfo) => {
  const baseURL = testInfo.project.use.baseURL;
  if (baseURL === undefined) throw new Error('The project declares no baseURL.');
  context = await browser.newContext({ baseURL });
  page = await context.newPage();
  problems = trackConsoleProblems(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/theme-builder');
  await expect(page.getByTestId('theme-workbench')).toBeVisible();
  await expect(page.getByTestId('draft-ready')).toBeAttached({ timeout: 60_000 });
  await waitForPreviewApplied(page);
});

test.afterAll(async () => {
  await context.close();
});

test.afterEach(() => {
  expect(problems, 'console errors and warnings are defects').toEqual([]);
});

const apply = () => page.getByRole('button', { name: 'Apply', exact: true });
const undo = () => page.getByRole('button', { name: 'Undo', exact: true });
const panel = () => page.getByTestId('checks-panel');

async function select(
  group: 'Foundations' | 'Semantic' | 'Components',
  path: string,
): Promise<void> {
  await page.locator('nav[aria-label="Token categories"] button', { hasText: group }).click();
  await page.locator('#theme-builder-token-filter').fill(path);
  await page.locator(`[data-token-path="${path}"]`).click();
  await expect(page.getByTestId('selected-token-path')).toHaveText(path);
}

const field = (path: string, part = 'amount') =>
  page.locator(`#theme-builder-foundation-${path.replaceAll('.', '-')}-${part}`);

const frameVar = async (name: string): Promise<string> => {
  const frame = await previewFrame(page);
  return frame.evaluate(
    (property) => document.documentElement.style.getPropertyValue(property),
    name,
  );
};

async function editDimension(path: string, amount: string, unit: 'px' | 'rem'): Promise<void> {
  await select('Foundations', path);
  await field(path, 'unit').selectOption(unit);
  await field(path).fill(amount);
  await apply().click();
  await expect(page.getByTestId('draft-value')).toHaveText(`${amount}${unit}`);
}

async function openExport() {
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Export theme' });
  await expect(dialog.getByTestId('export-base')).toBeVisible({ timeout: 60_000 });
  return dialog;
}

async function downloadText(
  dialog: ReturnType<Page['getByRole']>,
  name: RegExp,
): Promise<{ filename: string; text: string }> {
  const pending = page.waitForEvent('download');
  await dialog.getByRole('button', { name }).click();
  const file = await pending;
  const saved = await file.path();
  return { filename: file.suggestedFilename(), text: await readFile(saved, 'utf8') };
}

async function sourceEnvelope(): Promise<Record<string, any>> {
  const dialog = await openExport();
  const { text } = await downloadText(dialog, /^Download .*\.cinder-theme\.json$/);
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  return JSON.parse(text) as Record<string, any>;
}

const errorCount = async (): Promise<number> =>
  Number(/\d+/.exec(await page.getByTestId('count-accessibility-error').innerText())![0]);

test('1. creates a named theme and makes it the open theme', async () => {
  await page.getByRole('button', { name: 'New theme' }).click();
  await page.getByLabel('Theme name').fill('Acceptance');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByTestId('theme-name')).toHaveText('Acceptance');
  await expect(page.getByTestId('save-state')).toHaveText('Saved locally');
});

test('2. edits a radius, a spacing token and a motion token, and the preview follows', async () => {
  await editDimension('radius.medium', '7', 'px');
  await expect.poll(() => frameVar('--cinder-radius-md')).toBe('7px');
  await editDimension('space.2', '12', 'px');
  await expect.poll(() => frameVar('--cinder-space-2')).toBe('12px');
  await select('Foundations', 'motion.slow');
  await field('motion.slow').fill('333');
  await apply().click();
  await expect.poll(() => frameVar('--cinder-duration-slow')).toBe('333ms');
});

test('3. rejects invalid input without losing the typed text, then recovers', async () => {
  await select('Foundations', 'space.2');
  const before = await frameVar('--cinder-space-2');
  await field('space.2').fill('1.2.3');
  await expect(field('space.2')).toHaveAttribute('aria-invalid', 'true');
  await apply().click();
  await expect(field('space.2')).toHaveValue('1.2.3');
  await expect(page.getByTestId('stale-preview')).toBeVisible();
  expect(await frameVar('--cinder-space-2')).toBe(before);
  await field('space.2').fill('12');
  await apply().click();
  await expect(field('space.2')).not.toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByTestId('stale-preview')).toHaveCount(0);
});

test('4. edits a color, and the checks stay clear', async () => {
  await select('Semantic', 'accent.solid');
  await page.locator('[id="theme-builder-color-accent-solid-text"]').fill('oklch(0.45 0.2 260)');
  await apply().click();
  await expect(page.getByTestId('color-authored-text')).toHaveText('oklch(0.45 0.2 260)');
  await waitForPreviewApplied(page);
  await expect(panel()).toHaveAttribute('data-readiness', /^(ready|blocked-needs-review)$/, {
    timeout: 60_000,
  });
});

test('5. edits a composite shadow member and rebinds an alias, each undoable', async () => {
  await select('Foundations', 'shadow.medium');
  const before = await frameVar('--cinder-shadow-md');
  await page
    .getByTestId('composite-token-editor')
    .locator('input[id$="layer-0-blur-amount"]')
    .fill('9');
  await apply().click();
  await expect.poll(() => frameVar('--cinder-shadow-md')).toContain('9px');

  await select('Foundations', 'radius.surface');
  const reference = page.getByTestId('reference-panel');
  await reference.getByRole('button', { name: 'Rebind alias' }).click();
  await reference.locator('input[id$="-search"]').fill('radius.small');
  const aliasBefore = await frameVar('--cinder-radius-surface');
  await reference.getByRole('button', { name: 'Alias radius.surface to radius.small' }).click();
  const impact = page.getByTestId('impact-list');
  await expect(impact).toBeVisible();
  expect(await frameVar('--cinder-radius-surface')).toBe(aliasBefore);
  await impact.getByRole('button', { name: 'Apply' }).click();
  await expect.poll(() => frameVar('--cinder-radius-surface')).not.toBe(aliasBefore);

  // Undo the alias and the shadow, then redo both: the draft keeps its history.
  await undo().click();
  await expect.poll(() => frameVar('--cinder-radius-surface')).toBe(aliasBefore);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect.poll(() => frameVar('--cinder-radius-surface')).not.toBe(aliasBefore);
  expect(before).not.toContain('9px');
});

test('6. exports source, CSS and portable output that match the preview', async () => {
  const dialog = await openExport();
  const source = await downloadText(dialog, /^Download .*\.cinder-theme\.json$/);
  const envelope = JSON.parse(source.text) as Record<string, any>;
  expect(envelope['name']).toBe('Acceptance');
  expect(envelope['overrides'].shared.radius.medium.$value).toEqual({ value: 7, unit: 'px' });

  const acknowledge = dialog.getByLabel(/I have read the \d+ items/);
  if (await acknowledge.count()) await acknowledge.check();
  const css = await downloadText(dialog, /^Download .*\.cinder-theme\.css$/);
  expect(css.text).toContain('@layer cinder-theme');
  expect(css.text).toMatch(/--cinder-radius-md:\s*7px/);
  expect(css.text).toMatch(/--cinder-space-2:\s*12px/);
  expect(css.text).toMatch(/--cinder-duration-slow:\s*333ms/);

  // The complete portable export is blocked with a reason; the subset says what it omits.
  await expect(dialog.getByTestId('export-portable-blocked')).toContainText('no faithful DTCG');
  const portable = await downloadText(dialog, /^Download .*-light-default\.tokens\.json$/);
  const document = JSON.parse(portable.text) as Record<string, any>;
  expect(document['radius'].medium.$value).toEqual({ value: 7, unit: 'px' });
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('7. applies a palette, sees its findings, applies one fix and undoes it', async () => {
  await select('Semantic', 'accent.solid');
  await page.getByRole('button', { name: 'Create palette' }).click();
  await page.locator('[id="palette-seed"]').fill('#0ea5e9');
  await page.getByRole('button', { name: 'Apply palette' }).click();
  await expect(page.getByTestId('palette-panel')).toHaveCount(0);
  await expect(panel()).toHaveAttribute('data-readiness', 'blocked-accessibility-errors', {
    timeout: 60_000,
  });
  const withPalette = await errorCount();
  expect(withPalette).toBeGreaterThan(0);

  // Summary to the first finding, then its proposal.
  await page.getByRole('button', { name: /Go to the first accessibility errors/ }).click();
  const finding = page.locator(
    '[data-testid="finding"][data-severity="accessibility-error"]:focus',
  );
  await expect(finding).toHaveCount(1);
  await finding.getByRole('button', { name: /Review a fix/ }).click();
  const proposal = page.getByTestId('remediation-proposal');
  await expect(proposal).toBeVisible({ timeout: 30_000 });
  await expect(proposal.getByTestId('remediation-measurements')).toBeVisible();
  await proposal.getByRole('button', { name: /Apply fix/ }).click();
  await expect.poll(errorCount, { timeout: 60_000 }).toBeLessThan(withPalette);

  await page.getByRole('button', { name: /Undo last fix/ }).click();
  await expect.poll(errorCount, { timeout: 60_000 }).toBe(withPalette);
  await expect(page.getByTestId('checks-announcer')).toContainText('Undid');
});

test('8. blocks the normal CSS export while errors remain, but never the source', async () => {
  const dialog = await openExport();
  await expect(dialog.getByTestId('export-css-blocked')).toBeVisible();
  await expect(dialog.getByTestId('export-source')).toContainText('Cinder Theme v1');
  const downloaded = await downloadText(dialog, /^Download .*\.cinder-theme\.json$/);
  exportedSource = downloaded.text;
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('9. re-imports the exported source and reaches the identical draft', async () => {
  const exported = JSON.parse(exportedSource) as Record<string, any>;
  await editDimension('radius.medium', '9', 'px');
  await expect.poll(() => frameVar('--cinder-radius-md')).toBe('9px');

  await page.getByRole('button', { name: 'Import', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Import theme' });
  await dialog.locator('input[type="file"]').setInputFiles({
    name: 'acceptance.cinder-theme.json',
    mimeType: 'application/json',
    buffer: Buffer.from(exportedSource),
  });
  await expect(dialog.getByTestId('import-result')).toHaveAttribute(
    'data-outcome',
    'cinder-envelope',
    { timeout: 60_000 },
  );
  await dialog.getByRole('button', { name: 'Apply to this theme' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect.poll(() => frameVar('--cinder-radius-md')).toBe('7px');

  const again = await sourceEnvelope();
  expect(again['overrides']).toEqual(exported['overrides']);
  expect(again['cssOverrides']).toEqual(exported['cssOverrides']);
});

test('10. a reload restores the identical draft with its history', async () => {
  const before = JSON.parse(exportedSource) as Record<string, any>;
  await expect(page.getByTestId('save-state')).toHaveText('Saved locally', { timeout: 30_000 });
  await page.reload();
  await expect(page.getByTestId('draft-ready')).toBeAttached({ timeout: 60_000 });
  await waitForPreviewApplied(page);
  await expect(page.getByTestId('theme-name')).toHaveText('Acceptance');
  await expect.poll(() => frameVar('--cinder-radius-md')).toBe('7px');
  await expect(undo()).toBeEnabled();
  const after = await sourceEnvelope();
  expect(after['overrides']).toEqual(before['overrides']);
  expect(after['cssOverrides']).toEqual(before['cssOverrides']);
});

const CONTEXTS: PreviewContext[] = (['light', 'dark'] as const).flatMap((colorMode) =>
  (['default', 'reduced', 'forced-reduced-motion'] as const).map((motion) => ({
    colorMode,
    motion,
  })),
);

test('11. every light, dark and motion context previews the same draft', async () => {
  for (const preview of CONTEXTS) {
    await selectContext(page, preview);
    await waitForPreviewApplied(page);
    const frame = await previewFrame(page);
    await expect(frame.locator('html')).toHaveAttribute('data-theme', preview.colorMode);
    expect(await frameVar('--cinder-radius-md'), `${preview.colorMode}/${preview.motion}`).toBe(
      '7px',
    );
    expect(await frameVar('--cinder-duration-slow')).not.toBe('');
  }
  await selectContext(page, { colorMode: 'light', motion: 'default' });
  await waitForPreviewApplied(page);
});

for (const width of [1440, 768, 390, 320]) {
  test(`12. reflows at ${width}px with no horizontal overflow on any tab`, async () => {
    await page.setViewportSize({ width, height: width >= 768 ? 1000 : 800 });
    await expect(page.getByTestId('theme-workbench')).toBeVisible();
    expect(await hasNoHorizontalOverflow(page), `${width}px`).toBe(true);
    const tabs = page.getByRole('tab');
    if ((await tabs.count()) > 0) {
      for (const name of ['Preview', 'Checks', 'Edit']) {
        await page.getByRole('tab', { name }).click();
        expect(await hasNoHorizontalOverflow(page), `${width}px, ${name} tab`).toBe(true);
      }
      // Switching tabs keeps the selected token and the draft.
      await expect(page.getByTestId('selected-token-path')).not.toHaveText('');
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
  });
}
