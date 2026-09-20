import type { ComponentEntry, Theme, Viewport } from '@corvidae/testing';
import {
  applyComponentFilter,
  applyInteractions,
  loadManifest,
  manifestDigest,
  parseComponentFilter,
  THEMES,
  VIEWPORTS,
} from '@corvidae/testing';

import { resolve } from 'node:path';
import { environmentConfiguration } from '../environment-configuration.ts';
import { expect, test } from './component-page-fixture.ts';
import { runFixtureSweep } from './component-sweep.ts';

type LiveManifest = { digest: string; entries: unknown[] };
type ComponentPage = {
  open(args: {
    entry: ComponentEntry;
    theme: Theme;
    viewport: Viewport;
    fixtureName?: string;
    fixtureContentHash?: string;
    onPage?: (page: import('@playwright/test').Page) => void | Promise<void>;
  }): Promise<import('@playwright/test').Page>;
};
type ToolbarControlBox = {
  label: string;
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
};
type ToolbarMetrics = {
  toolbar: ToolbarControlBox;
  controls: ToolbarControlBox[];
  rows: ToolbarControlBox[][];
  scrollWidth: number;
  clientWidth: number;
};

function isLiveManifest(value: unknown): value is LiveManifest {
  return (
    value !== null &&
    typeof value === 'object' &&
    'digest' in value &&
    typeof value.digest === 'string' &&
    'entries' in value &&
    Array.isArray(value.entries)
  );
}

test.describe('server identity', () => {
  test('cached manifest matches live standalone manifest', async ({ request }) => {
    const response = await request.get('/api/manifest?standalone=1');
    expect(response.ok()).toBeTruthy();

    const live: unknown = await response.json();
    if (!isLiveManifest(live)) throw new Error('Live fixture manifest has an invalid shape.');

    expect(
      live.digest,
      [
        'Live manifest digest must match cached manifest digest.',
        'Re-run the fixture host manifest preparation command to regenerate the cache.',
        '',
        `Live components:   ${loadManifest()
          .map((entry) => entry.name)
          .toSorted()
          .join(', ')}`,
        `Cached components: ${loadManifest()
          .map((entry) => entry.name)
          .toSorted()
          .join(', ')}`,
      ].join('\n'),
    ).toBe(manifestDigest());
  });
});

// `CINDER_TEST_COMPONENTS` is an optional comma-separated allow-list supplied
// by the caller when a focused component run is useful. Empty, whitespace, or
// unset values run the full matrix. Unknown slugs throw so a stale scope
// selection cannot silently omit coverage.
const allEntries = loadManifest();
const knownSlugs = new Set(allEntries.map((entry) => entry.slug));
const filterSlugs = parseComponentFilter(
  environmentConfiguration().cinderTestComponents,
  knownSlugs,
);
const entries = applyComponentFilter(allEntries, filterSlugs);

test('visual baselines belong to the application, browser project, and platform', () => {
  const testInfo = test.info();
  expect(testInfo.snapshotPath('button', 'light-desktop-assertion.png')).toBe(
    resolve(
      import.meta.dirname,
      '..',
      'snapshots',
      testInfo.project.name,
      process.platform,
      'button',
      'light-desktop-assertion.png',
    ),
  );
});

test.describe('fixture manifest metadata', () => {
  test('embeds fixture metadata and content hashes without fixture props', () => {
    const input = allEntries.find((entry) => entry.slug === 'input');
    expect(input).toBeDefined();
    const focused = input?.fixtures?.find((fixture) => fixture.name === 'focused');
    expect(focused).toBeDefined();
    expect(focused?.fixtureContentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(focused?.category).toBe('interaction-state');
    expect(focused?.interact).toEqual([{ action: 'focus', target: { label: 'Focused input' } }]);
    expect(Object.hasOwn(focused ?? {}, 'props')).toBe(false);
  });
});

test.describe('fixture interaction rendering', () => {
  test('focused input fixture reaches document.activeElement', async ({ componentPage }) => {
    const entry = allEntries.find((candidate) => candidate.slug === 'input');
    const fixture = entry?.fixtures?.find((candidate) => candidate.name === 'focused');
    expect(entry).toBeDefined();
    expect(fixture).toBeDefined();

    const page = await componentPage.open({
      entry: entry!,
      theme: 'light',
      viewport: VIEWPORTS.find((viewport) => viewport.name === 'desktop')!,
      fixtureName: fixture!.name,
      fixtureContentHash: fixture!.fixtureContentHash,
    });

    await applyInteractions(page, fixture!.interact ?? [], {
      component: entry!.slug,
      fixture: fixture!.name,
    });

    await expect(page.getByLabel('Focused input')).toBeFocused();
  });

  test('dropdown interaction fixture exposes the opened menu surface', async ({
    componentPage,
  }) => {
    const entry = allEntries.find((candidate) => candidate.slug === 'dropdown');
    const fixture = entry?.fixtures?.find((candidate) => candidate.name === 'opened-by-trigger');
    expect(entry).toBeDefined();
    expect(fixture).toBeDefined();

    const page = await componentPage.open({
      entry: entry!,
      theme: 'light',
      viewport: VIEWPORTS.find((viewport) => viewport.name === 'desktop')!,
      fixtureName: fixture!.name,
      fixtureContentHash: fixture!.fixtureContentHash,
    });

    await applyInteractions(page, fixture!.interact ?? [], {
      component: entry!.slug,
      fixture: fixture!.name,
    });

    await expect(page.getByRole('menu')).toBeVisible();
  });
});

async function assertRows(page: import('@playwright/test').Page, selector: string) {
  const result = await page.locator(selector).evaluateAll((rows, expectedSelector) => {
    const pseudo = (row: Element) => getComputedStyle(row, '::after').content !== 'none';
    return rows.map((row) => {
      const siblings = Array.from(row.parentElement?.children ?? []);
      const index = siblings.indexOf(row);
      const later = siblings.slice(index + 1);
      const nextSeparator = later.findIndex((sibling) =>
        sibling.classList.contains('cinder-dropdown-separator'),
      );
      const beforeSeparator = nextSeparator < 0 ? later : later.slice(0, nextSeparator);
      const hasVisibleLaterRow = beforeSeparator.some(
        (sibling) =>
          sibling.matches(expectedSelector) && !(sibling instanceof HTMLElement && sibling.hidden),
      );
      return { hasVisibleLaterRow, hasDivider: pseudo(row) };
    });
  }, selector);
  expect(result.length, `${selector} must render real option rows`).toBeGreaterThan(0);
  for (const row of result) expect(row.hasDivider).toBe(row.hasVisibleLaterRow);
}

async function openAssertionFixture(
  componentPage: ComponentPage,
  slug: string,
  theme: (typeof THEMES)[number],
  width: number,
) {
  const entry = allEntries.find((candidate) => candidate.slug === slug);
  expect(entry, `${slug} must be present in the fixture manifest`).toBeDefined();
  const fixture = entry?.fixtures?.find((candidate) => candidate.name === 'assertion');
  expect(fixture, `${slug} must expose its assertion fixture`).toBeDefined();
  const page = await componentPage.open({
    entry: entry!,
    theme,
    viewport: VIEWPORTS.find((viewport) => viewport.name === 'desktop')!,
    fixtureName: fixture!.name,
    fixtureContentHash: fixture!.fixtureContentHash,
  });
  await page.setViewportSize({ width, height: 900 });
  return page;
}

const diffViewerEntry = allEntries.find((candidate) => candidate.slug === 'diff-viewer');
expect(diffViewerEntry, 'diff-viewer must be present in the fixture manifest').toBeDefined();
const desktopViewport = VIEWPORTS.find((viewport) => viewport.name === 'desktop');
expect(desktopViewport, 'desktop viewport must be present').toBeDefined();

async function diffToolbarMetrics(
  page: import('@playwright/test').Page,
  width: number,
): Promise<ToolbarMetrics> {
  const viewer = page.locator('.diff-viewer').first();
  await expect(viewer).toHaveAttribute('data-ready', 'true');
  await viewer.evaluate((element, inlineSize) => {
    if (!(element instanceof HTMLElement)) throw new Error('Expected DiffViewer root.');
    element.style.inlineSize = `${inlineSize}px`;
    element.style.maxInlineSize = `${inlineSize}px`;
  }, width);
  return viewer.locator('.diff-toolbar').evaluate((element): ToolbarMetrics => {
    if (!(element instanceof HTMLElement)) throw new Error('Expected toolbar element.');
    const toolbarRect = element.getBoundingClientRect();
    const toBox = (label: string, rect: DOMRect): ToolbarControlBox => ({
      label,
      left: Math.round(rect.left),
      right: Math.round(rect.right),
      top: Math.round(rect.top),
      bottom: Math.round(rect.bottom),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    });
    const controls = Array.from(
      element.querySelectorAll<HTMLElement>('button, [role="radio"], .change-counter'),
    )
      .filter((control) => {
        const rect = control.getBoundingClientRect();
        const nestedControl = control.querySelector('button, [role="radio"], .change-counter');
        return rect.width > 0 && rect.height > 0 && nestedControl === null;
      })
      .map((control) =>
        toBox(
          control.getAttribute('aria-label') ??
            control.textContent?.replace(/\s+/g, ' ').trim() ??
            '',
          control.getBoundingClientRect(),
        ),
      );
    const rows = controls.reduce<ToolbarControlBox[][]>((groups, control) => {
      const group = groups.find((candidate) =>
        candidate.some(
          (member) => control.top <= member.bottom + 1 && control.bottom + 1 >= member.top,
        ),
      );
      if (group === undefined) groups.push([control]);
      else group.push(control);
      return groups;
    }, []);
    return {
      toolbar: toBox('toolbar', toolbarRect),
      controls,
      rows,
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
    };
  });
}

async function expectTooltipText(
  page: import('@playwright/test').Page,
  trigger: import('@playwright/test').Locator,
  text: string,
) {
  await trigger.hover();
  await expect(page.getByRole('tooltip', { name: text })).toBeVisible();
  await page.mouse.move(0, 0);
  await expect(page.getByRole('tooltip', { name: text })).toBeHidden();
  await trigger.focus();
  await expect(page.getByRole('tooltip', { name: text })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('tooltip', { name: text })).toBeHidden();
}

const DIFF_VIEWER_MODES = ['Unified', 'Final', 'Original'] as const;
const DIFF_VIEWER_WIDTHS = [320, 512, 848] as const;
const DIFF_VIEWER_EDITABLE_WIDTHS = [320, 848] as const;

async function openDiffViewerFixturePage(
  componentPage: ComponentPage,
  theme: (typeof THEMES)[number],
  editable: boolean,
) {
  const page = await componentPage.open({
    entry: diffViewerEntry!,
    theme,
    viewport: desktopViewport!,
    onPage: async (nextPage) => {
      await nextPage.setViewportSize({ width: 1280, height: 720 });
      await nextPage.addInitScript(() => {
        const state = globalThis as typeof globalThis & {
          __diffViewerActionCount?: number;
          __diffViewerClipboardWrites?: string[];
          __diffViewerRevertAllCount?: number;
        };
        state.__diffViewerActionCount = 0;
        state.__diffViewerClipboardWrites = [];
        state.__diffViewerRevertAllCount = 0;
        Object.defineProperty(navigator, 'clipboard', {
          configurable: true,
          value: {
            writeText(text: string) {
              state.__diffViewerClipboardWrites?.push(text);
              return Promise.resolve();
            },
          },
        });
      });
    },
  });

  await page.setViewportSize({ width: 1280, height: 720 });
  if (editable) {
    await page.goto(`${diffViewerEntry!.route}?snapshot=1&editable=1`, { waitUntil: 'load' });
    await page.waitForSelector('#app > *', { state: 'visible', timeout: 20_000 });
    await page.evaluate(
      'const active = document.activeElement; if (active && typeof active.blur === "function") active.blur();',
    );
  }
  return page;
}

function assertToolbarGeometry(metrics: ToolbarMetrics, label: string) {
  expect(metrics.scrollWidth, `${label}: toolbar clips`).toBeLessThanOrEqual(
    metrics.clientWidth + 1,
  );
  for (const control of metrics.controls) {
    expect(control.width, `${label}: ${control.label} has width`).toBeGreaterThan(0);
    expect(control.height, `${label}: ${control.label} has height`).toBeGreaterThan(0);
    expect(control.left, `${label}: ${control.label} starts inside toolbar`).toBeGreaterThanOrEqual(
      metrics.toolbar.left - 1,
    );
    expect(control.right, `${label}: ${control.label} ends inside toolbar`).toBeLessThanOrEqual(
      metrics.toolbar.right + 1,
    );
    expect(
      control.top,
      `${label}: ${control.label} starts vertically inside toolbar`,
    ).toBeGreaterThanOrEqual(metrics.toolbar.top - 1);
    expect(
      control.bottom,
      `${label}: ${control.label} ends vertically inside toolbar`,
    ).toBeLessThanOrEqual(metrics.toolbar.bottom + 1);
  }
  for (const row of metrics.rows) {
    const rowTop = Math.min(...row.map((control) => control.top));
    const rowBottom = Math.max(...row.map((control) => control.bottom));
    const rowCenter = (rowTop + rowBottom) / 2;
    for (const control of row) {
      const controlCenter = (control.top + control.bottom) / 2;
      expect(
        Math.abs(controlCenter - rowCenter),
        `${label}: ${control.label} center aligns with its toolbar row`,
      ).toBeLessThanOrEqual(2);
    }
  }
  for (let outerIndex = 0; outerIndex < metrics.controls.length; outerIndex += 1) {
    for (let innerIndex = outerIndex + 1; innerIndex < metrics.controls.length; innerIndex += 1) {
      const first = metrics.controls[outerIndex]!;
      const second = metrics.controls[innerIndex]!;
      const separatedHorizontally =
        first.right <= second.left + 1 || second.right <= first.left + 1;
      const separatedVertically = first.bottom <= second.top + 1 || second.bottom <= first.top + 1;
      expect(
        separatedHorizontally || separatedVertically,
        `${label}: ${first.label} overlaps ${second.label}`,
      ).toBe(true);
    }
  }
}

async function expectDiffRow(
  row: import('@playwright/test').Locator,
  expectedGutter: string,
  label: string,
) {
  await expect(row, `${label}: row is visible`).toBeVisible();
  await expect(row.locator('.diff-gutter'), `${label}: gutter symbol`).toHaveText(expectedGutter);
  const gutterWidth = await row
    .locator('.diff-gutter')
    .evaluate((element) => Math.round(element.getBoundingClientRect().width));
  expect(gutterWidth, `${label}: gutter width`).toBe(24);
}

async function expectDiffRowsForMode(
  viewer: import('@playwright/test').Locator,
  mode: (typeof DIFF_VIEWER_MODES)[number],
  label: string,
) {
  const oldBody = 'The first version includes authentication, a dashboard, and export tools.';
  const newBody = 'The first version includes authentication, a dashboard, and CSV export tools.';
  const selectedBodyRow =
    mode === 'Unified'
      ? viewer.getByRole('button', { name: `Removed line: ${oldBody}` })
      : mode === 'Final'
        ? viewer.getByRole('button', { name: `Modified line: ${newBody}` })
        : viewer.getByRole('button', { name: `Modified line: ${oldBody}` });

  if (mode === 'Unified') {
    await expectDiffRow(selectedBodyRow, '-', `${label}: unified removed body row`);
    await expectDiffRow(
      viewer.getByRole('button', { name: `Added line: ${newBody}` }),
      '+',
      `${label}: unified added body row`,
    );
    await expectDiffRow(
      viewer.getByRole('group', { name: 'Removed line: status: draft' }),
      '-',
      `${label}: unified removed front matter row`,
    );
    await expectDiffRow(
      viewer.getByRole('group', { name: 'Added line: status: published' }),
      '+',
      `${label}: unified added front matter row`,
    );
  } else if (mode === 'Final') {
    await expectDiffRow(selectedBodyRow, '+', `${label}: final body row`);
    await expectDiffRow(
      viewer.getByRole('group', { name: 'Modified line: status: published' }),
      '+',
      `${label}: final front matter row`,
    );
  } else {
    await expectDiffRow(selectedBodyRow, '-', `${label}: original body row`);
    await expectDiffRow(
      viewer.getByRole('group', { name: 'Modified line: status: draft' }),
      '-',
      `${label}: original front matter row`,
    );
  }

  const beforeSelection = await selectedBodyRow.boundingBox();
  if (beforeSelection === null) throw new Error(`${label}: selected body row has no box.`);
  await selectedBodyRow.click();
  await expect(selectedBodyRow).toHaveAttribute('data-selected', 'true');
  const afterSelection = await selectedBodyRow.boundingBox();
  if (afterSelection === null) throw new Error(`${label}: selected body row lost its box.`);
  expect(Math.round(afterSelection.width), `${label}: selection keeps row width`).toBe(
    Math.round(beforeSelection.width),
  );
  expect(Math.round(afterSelection.height), `${label}: selection keeps row height`).toBe(
    Math.round(beforeSelection.height),
  );
}

function expectedChangeCount(mode: (typeof DIFF_VIEWER_MODES)[number]): number {
  return mode === 'Original' ? 3 : 4;
}

for (const theme of THEMES) {
  for (const width of DIFF_VIEWER_WIDTHS) {
    for (const mode of DIFF_VIEWER_MODES) {
      test(`DiffViewer toolbar geometry readonly ${theme}-${width}-${mode}`, async ({
        componentPage,
      }, testInfo) => {
        const page = await openDiffViewerFixturePage(componentPage, theme, false);
        const viewer = page.locator('.diff-viewer').first();
        await expect(viewer).toBeVisible();
        await viewer.getByRole('radio', { name: mode }).click();

        const label = `${theme}-${width}-${mode}-readonly`;
        const metrics = await diffToolbarMetrics(page, width);
        assertToolbarGeometry(metrics, label);
        await expectDiffRowsForMode(viewer, mode, label);

        await expect(viewer.locator('.nav-kbd')).toHaveCount(0);
        const copyButton = viewer.getByRole('button', { name: 'Copy unified diff' });
        const previousButton = viewer.getByRole('button', { name: 'Previous change ([)' });
        const nextButton = viewer.getByRole('button', { name: 'Next change (])' });
        await expect(copyButton).toBeVisible();
        await expectTooltipText(page, copyButton, 'Copy unified diff');
        await expectTooltipText(page, previousButton, 'Previous change ([)');
        await expectTooltipText(page, nextButton, 'Next change (])');

        const total = expectedChangeCount(mode);
        const counter = viewer.locator('.change-counter');
        await expect(counter).toHaveText(`1 / ${total}`);
        await previousButton.click();
        await expect(counter).toHaveText(`${total} / ${total}`);
        await nextButton.click();
        await expect(counter).toHaveText(`1 / ${total}`);
        await nextButton.click();
        await expect(counter).toHaveText(`2 / ${total}`);
        await viewer.press(']');
        await expect(counter).toHaveText(`3 / ${total}`);
        await previousButton.click();
        await expect(counter).toHaveText(`2 / ${total}`);
        await viewer.press('[');
        await expect(counter).toHaveText(`1 / ${total}`);
        await copyButton.click();
        await expect(viewer.getByText('Unified diff copied.')).toHaveCount(1);
        await expect(
          viewer.locator('.diff-toolbar button', { hasText: /^Copy diff$/ }),
          `${label}: copy control is icon-only`,
        ).toHaveCount(0);

        const writes = await page.evaluate(() => {
          const state = globalThis as typeof globalThis & {
            __diffViewerClipboardWrites?: string[];
          };
          return state.__diffViewerClipboardWrites ?? [];
        });
        expect(writes).toHaveLength(1);
        expect(writes[0]).toContain('--- a/document.md');
        expect(writes[0]).toContain('+++ b/document.md');
        expect(writes[0]).toContain('-status: draft');
        expect(writes[0]).toContain('+status: published');
        expect(writes[0]).toContain(
          '-The first version includes authentication, a dashboard, and export tools.',
        );
        expect(writes[0]).toContain(
          '+The first version includes authentication, a dashboard, and CSV export tools.',
        );

        await page.screenshot({
          path: testInfo.outputPath(
            `diff-viewer-toolbar-${theme}-${width}-${mode.toLowerCase()}-readonly.png`,
          ),
          fullPage: true,
        });
      });
    }
  }
}

for (const theme of THEMES) {
  for (const width of DIFF_VIEWER_EDITABLE_WIDTHS) {
    test(`DiffViewer toolbar geometry editable actions ${theme}-${width}`, async ({
      componentPage,
    }, testInfo) => {
      const page = await openDiffViewerFixturePage(componentPage, theme, true);
      const viewer = page.locator('.diff-viewer').first();
      await expect(viewer).toBeVisible();
      await viewer.getByRole('radio', { name: 'Unified' }).click();

      const label = `${theme}-${width}-Unified-editable`;
      const metrics = await diffToolbarMetrics(page, width);
      assertToolbarGeometry(metrics, label);
      const labels = metrics.controls.map((control) => control.label);
      expect(
        labels.indexOf('Mark reviewed'),
        `${label}: custom action precedes revert`,
      ).toBeLessThan(labels.indexOf('Revert All'));
      expect(labels.indexOf('Revert All'), `${label}: revert precedes copy`).toBeLessThan(
        labels.indexOf('Copy unified diff'),
      );
      expect(
        labels.indexOf('Copy unified diff'),
        `${label}: copy precedes navigation`,
      ).toBeLessThan(labels.indexOf('Previous change ([)'));

      await expectDiffRowsForMode(viewer, 'Unified', label);
      await viewer.getByRole('button', { name: 'Mark reviewed' }).click();
      await viewer.getByRole('button', { name: 'Revert All' }).click();
      const callbackCounts = await page.evaluate(() => {
        const state = globalThis as typeof globalThis & {
          __diffViewerActionCount?: number;
          __diffViewerRevertAllCount?: number;
        };
        return {
          action: state.__diffViewerActionCount ?? 0,
          revertAll: state.__diffViewerRevertAllCount ?? 0,
        };
      });
      expect(callbackCounts).toEqual({ action: 1, revertAll: 1 });

      await page.screenshot({
        path: testInfo.outputPath(`diff-viewer-toolbar-${theme}-${width}-editable-actions.png`),
        fullPage: true,
      });
    });
  }
}

for (const theme of THEMES) {
  for (const width of [320, 512, 848]) {
    test(`dropdown dividers appear only between visible items ${theme}-${width}`, async ({
      componentPage,
    }) => {
      const page = await openAssertionFixture(componentPage, 'dropdown', theme, width);
      const trigger = page.getByRole('button', { name: 'Row regression' });
      await trigger.focus();
      await trigger.press('Enter');
      await expect(page.getByRole('menu').last()).toBeVisible();
      await assertRows(page, '.cinder-dropdown-item');
    });

    test(`dropdown dividers appear only between visible items: command-menu ${theme}-${width}`, async ({
      componentPage,
    }) => {
      const page = await openAssertionFixture(componentPage, 'command-menu', theme, width);
      const notes = page.getByLabel('Notes');
      await notes.fill('/');
      await expect(page.locator('.cinder-command-item').first()).toBeVisible();
      await page.locator('.cinder-command-item').first().press('ArrowDown');
      await notes.fill('/summary');
      await expect(page.locator('.cinder-command-item:visible')).toHaveCount(1);
      await assertRows(page, '.cinder-command-item');
      await notes.fill('/');
      await expect(page.locator('.cinder-command-item:visible')).toHaveCount(4);
      await assertRows(page, '.cinder-command-item');
    });

    test(`dropdown dividers appear only between visible items: side-navigation ${theme}-${width}`, async ({
      componentPage,
    }) => {
      const page = await openAssertionFixture(componentPage, 'side-navigation', theme, width);
      const first = page.locator('.cinder-navigation-item').first();
      await first.focus();
      await first.press('Tab');
      const projects = page.getByRole('button', { name: 'Projects' });
      await projects.click();
      await expect(page.locator('.cinder-navigation-item:visible')).toHaveCount(3);
      await expect(page.getByRole('link', { name: 'Standalone second' })).toHaveCount(0);
      await assertRows(page, '.cinder-navigation-item');
      const standalone = page.getByRole('navigation', { name: 'Standalone entries' });
      const standaloneRows = standalone.locator('.cinder-navigation-item');
      const collapsedFirstStandaloneDivider = await standaloneRows
        .first()
        .evaluate((row) => getComputedStyle(row, '::after').content);
      expect(collapsedFirstStandaloneDivider).toBe('none');
      await projects.click();
      await expect(page.locator('.cinder-navigation-item:visible')).toHaveCount(7);
      await expect(page.getByRole('link', { name: 'Standalone second' })).toBeVisible();
      await expect(standaloneRows).toHaveCount(3);
      const firstStandaloneDivider = await standaloneRows
        .nth(0)
        .evaluate((row) => getComputedStyle(row, '::after').content);
      expect(firstStandaloneDivider).not.toBe('none');
      const secondStandaloneDivider = await standaloneRows
        .nth(1)
        .evaluate((row) => getComputedStyle(row, '::after').content);
      expect(secondStandaloneDivider).toBe('none');
      await assertRows(page, '.cinder-navigation-item');
    });

    test(`dropdown dividers appear only between visible items: combobox ${theme}-${width}`, async ({
      componentPage,
    }) => {
      const page = await openAssertionFixture(componentPage, 'combobox', theme, width);
      const input = page.getByLabel('Favorite fruit');
      await input.click();
      await expect(page.locator('.cinder-combobox__option').first()).toBeVisible();
      await input.press('ArrowDown');
      await input.fill('apri');
      await expect(page.locator('.cinder-combobox__option:visible')).toHaveCount(1);
      await expect(page.locator('.cinder-combobox__option:visible')).toHaveText(/Apricot/);
      await expect(page.locator('.cinder-combobox__option[data-cinder-active]')).toHaveText(
        /Apricot/,
      );
      await assertRows(page, '.cinder-combobox__option');
      await input.fill('');
      await expect(page.locator('.cinder-combobox__option:visible')).toHaveCount(10);
      await expect(input).toBeFocused();
      await assertRows(page, '.cinder-combobox__option');
    });

    test(`dropdown dividers appear only between visible items: native select keyboard behavior ${theme}-${width}`, async ({
      componentPage,
    }) => {
      const page = await openAssertionFixture(componentPage, 'select', theme, width);
      const select = page.getByLabel('Environment');
      await select.focus();
      await expect(select.locator('option')).toHaveCount(2);
      await expect(select).toBeFocused();
      await expect(select).toHaveValue('alpha');
      await select.press('b');
      await expect(select).toHaveValue('beta');
      await expect(select).toBeFocused();
      await expect(page.locator('.cinder-select__option')).toHaveCount(0);
    });
  }
}

for (const entry of entries) {
  test.describe(entry.name, () => {
    const fixtures = entry.fixtures;
    if (fixtures === undefined || fixtures.length === 0) {
      throw new Error(`Fixture manifest entry '${entry.slug}' has no extracted fixtures.`);
    }

    for (const theme of THEMES) {
      for (const viewport of VIEWPORTS) {
        for (const fixture of fixtures) {
          test(`${theme}-${viewport.name}-${fixture.name}`, async ({ componentPage }) => {
            await runFixtureSweep(componentPage, entry, theme, viewport, fixture);
          });
        }
      }
    }
  });
}
