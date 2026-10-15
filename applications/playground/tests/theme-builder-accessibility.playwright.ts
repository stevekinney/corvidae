import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Frame, type Page } from '@playwright/test';

import { WCAG_22_AA_TAGS } from '@lostgradient/testing';

import { THEME_PREVIEW_SCENES } from '../src/shell-app/theme-preview-scenes.ts';
import {
  hasNoHorizontalOverflow,
  openBuilder,
  previewFrame,
  selectContext,
  trackConsoleProblems,
  waitForPreviewApplied,
  waitForScene,
  type PreviewContext,
} from './support/theme-builder.ts';

/**
 * Rendered accessibility checks for the theme builder (COR-259): Axe on the builder and on the
 * preview scenes in all six contexts, and the WCAG 2.2 criteria no static check can prove:
 * 1.4.4 text resize, 1.4.10 reflow, 1.4.12 text spacing, 2.4.7 and 2.4.11 focus, 2.5.8 target
 * size, forced colors, and reduced motion. Every applicable Axe violation fails, whatever its
 * impact. Criteria that need a person (2.1.1/2.1.2 end to end, 3.3.1/3.3.2 wording, 4.1.2 with
 * assistive technology) are recorded in the rule ledger as manual.
 */

let problems: string[] = [];
test.beforeEach(({ page }) => {
  problems = trackConsoleProblems(page);
});
test.afterEach(() => {
  expect(problems, 'console errors and warnings are defects').toEqual([]);
});

const CONTEXTS: PreviewContext[] = (['light', 'dark'] as const).flatMap((colorMode) =>
  (['default', 'reduced', 'forced-reduced-motion'] as const).map((motion) => ({
    colorMode,
    motion,
  })),
);
const REFERENCE_SCENE = 'application/settings-dashboard';
const DESKTOP = { width: 1440, height: 1000 };

async function showScene(page: Page, sceneId: string): Promise<Frame> {
  const scene = THEME_PREVIEW_SCENES.find((candidate) => candidate.id === sceneId)!;
  // Below 768px the preview is a tab panel; open it before reaching for its controls.
  const previewTab = page.getByRole('tab', { name: 'Preview' });
  if (await previewTab.isVisible()) await previewTab.click();
  await page.getByLabel('Preview category').selectOption(scene.category);
  await page.getByLabel('Example').selectOption(sceneId);
  await waitForPreviewApplied(page);
  const frame = await previewFrame(page);
  await expect(frame.locator('main.stage')).toHaveAttribute('data-scene', sceneId);
  await waitForScene(frame);
  return frame;
}

const FRAME = 'iframe[title="Theme preview"]';

/**
 * Axe over the builder chrome (the preview frame excluded) or over the frame's document alone.
 * Axe re-fetches the playground's `@import`ed stylesheets relative to the page, which answers
 * 404 and logs a console error that is Axe's own request, not the page's, so those are removed
 * from the console tracker for the duration of the analysis and nothing else is.
 */
async function axeViolations(page: Page, scope: 'builder' | 'frame'): Promise<string[]> {
  // A dialog that is still fading in has colors in between; Axe reads them as a contrast
  // failure. Wait until no finite, time-driven animation is running; looping ones and
  // scroll-driven ones (the modal body's scroll fade) are left alone.
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document
            .getAnimations()
            .filter(
              (animation) =>
                animation.playState === 'running' &&
                animation.timeline === document.timeline &&
                animation.effect?.getComputedTiming().iterations !== Infinity,
            ).length,
      ),
    )
    .toBe(0);
  const before = problems.length;
  const builder = new AxeBuilder({ page }).withTags([...WCAG_22_AA_TAGS]);
  const results = await (scope === 'builder'
    ? builder.exclude(FRAME).analyze()
    : builder.include([FRAME, 'html']).analyze());
  const fresh = problems.splice(before);
  problems.push(...fresh.filter((problem) => !/Failed to load resource.*404/.test(problem)));
  return results.violations.map(
    (violation) =>
      `${violation.id} (${violation.impact ?? 'no impact'}): ${violation.nodes
        .map((node) => node.target.join(' '))
        .join(' | ')}`,
  );
}

/** Axe over the builder chrome in one context, with the checks panel's long list open. */
test.describe('axe on the builder chrome, one test per context', () => {
  for (const context of CONTEXTS) {
    const label = `${context.colorMode}/${context.motion}`;
    test(`the builder in ${label}`, async ({ page }) => {
      await openBuilder(page, DESKTOP);
      await selectContext(page, context);
      await waitForPreviewApplied(page);
      await expect(page.getByTestId('checks-panel')).toBeVisible();
      await expect(page.getByTestId('checks-panel')).toHaveAttribute('data-readiness', 'ready', {
        timeout: 60_000,
      });
      expect(await axeViolations(page, 'builder'), `builder chrome ${label}`).toEqual([]);
      await page.getByTestId('group-advisory').locator('summary').click();
      expect(await axeViolations(page, 'builder'), `advisory findings ${label}`).toEqual([]);
    });
  }
});

/**
 * Axe over each preview scene, one test per scene and context. Motion only changes motion
 * tokens, so the four non-default motion contexts check the reference scenes.
 */
test.describe('axe on the preview scenes, one test per scene and context', () => {
  for (const context of CONTEXTS) {
    const label = `${context.colorMode}/${context.motion}`;
    const scenes =
      context.motion === 'default'
        ? THEME_PREVIEW_SCENES.map((scene) => scene.id)
        : [REFERENCE_SCENE, 'foundations/specimens'];
    for (const sceneId of scenes) {
      test(`${sceneId} in ${label}`, async ({ page }) => {
        await openBuilder(page, DESKTOP);
        await selectContext(page, context);
        await waitForPreviewApplied(page);
        await showScene(page, sceneId);
        expect(await axeViolations(page, 'frame'), `${sceneId} in ${label}`).toEqual([]);
      });
    }
  }
});

/** Every builder surface and state other than the resting page: dialogs, proposals, disclosure. */
test.describe('axe on every builder surface and state', () => {
  const clean = async (page: Page, name: string) => {
    expect(await axeViolations(page, 'builder'), name).toEqual([]);
  };

  async function select(page: Page, group: string, path: string): Promise<void> {
    await page.locator('nav[aria-label="Token categories"] button', { hasText: group }).click();
    await page.locator('#theme-builder-token-filter').fill(path);
    await page.locator(`[data-token-path="${path}"]`).click();
    await expect(page.getByTestId('selected-token-path')).toHaveText(path);
  }

  async function makeFailingDraft(page: Page): Promise<void> {
    await select(page, 'Semantic', 'text.default');
    await page.locator('[id="theme-builder-color-text-default-text"]').fill('oklch(0.93 0.01 245)');
    await page.getByRole('button', { name: 'Apply', exact: true }).click();
    await expect(page.getByTestId('checks-panel')).toHaveAttribute(
      'data-readiness',
      'blocked-accessibility-errors',
      { timeout: 60_000 },
    );
  }

  test.beforeEach(async ({ page }) => {
    await openBuilder(page, DESKTOP);
    await expect(page.getByTestId('save-state')).toHaveText('Saved locally');
  });

  test('library: new theme, rename and a name conflict', async ({ page }) => {
    await page.getByRole('button', { name: 'New theme' }).click();
    await expect(page.getByRole('dialog', { name: 'New theme' })).toBeVisible();
    await clean(page, 'new theme dialog');
    await page.getByLabel('Theme name').fill('Ocean');
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(page.getByTestId('theme-name')).toHaveText('Ocean');
    await page.getByRole('button', { name: 'Rename', exact: true }).click();
    await page.getByLabel('Theme name').fill('cinder default');
    await page.getByRole('button', { name: 'Rename', exact: true }).last().click();
    await expect(page.getByLabel('Theme name')).toHaveAttribute('aria-invalid', 'true');
    await clean(page, 'rename dialog with its error');
  });

  test('library: delete, trash and permanent delete', async ({ page }) => {
    await page.getByRole('button', { name: 'New theme' }).click();
    await page.getByLabel('Theme name').fill('Ocean');
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(page.getByRole('dialog')).toContainText('Ocean');
    await clean(page, 'delete dialog');
    await page.getByRole('dialog').getByRole('button', { name: 'Move to Trash' }).click();
    await page.getByRole('button', { name: /Trash \(1\)/ }).click();
    await expect(page.getByRole('dialog', { name: 'Trash' })).toBeVisible();
    await clean(page, 'trash dialog');
    await page.getByRole('button', { name: 'Delete Ocean permanently' }).click();
    await expect(page.getByRole('dialog').last()).toContainText('embedded Cinder base');
    await clean(page, 'permanent delete confirmation');
  });

  test('proposals: a palette', async ({ page }) => {
    await select(page, 'Semantic', 'accent.solid');
    await page.getByRole('button', { name: 'Create palette' }).click();
    await page.locator('[id="palette-seed"]').fill('#0ea5e9');
    await expect(page.getByTestId('palette-roles-light')).toBeVisible();
    await clean(page, 'palette proposal');
    await page.getByRole('button', { name: 'Preview Application' }).click();
    await expect(page.getByTestId('proposal-preview-note')).toBeVisible();
    await clean(page, 'palette proposal previewed');
  });

  test('proposals: a spacing preset and an alias replacement', async ({ page }) => {
    await page
      .locator('nav[aria-label="Token categories"] button', { hasText: 'Foundations' })
      .click();
    await page
      .getByTestId('presets-spacing')
      .getByRole('button', { name: 'Compact (0.75)' })
      .click();
    await expect(page.getByTestId('proposal-spacing')).toBeVisible();
    await clean(page, 'spacing preset proposal');
    await page.getByTestId('presets-spacing').getByRole('button', { name: 'Cancel' }).click();

    await select(page, 'Foundations', 'radius.surface');
    await page.getByRole('button', { name: 'Replace with literal', exact: true }).click();
    await expect(page.getByTestId('impact-list')).toBeVisible();
    await clean(page, 'alias impact list');
  });

  test('proposals: a remediation fix', async ({ page }) => {
    await makeFailingDraft(page);
    await clean(page, 'checks panel with errors');
    await page.getByRole('button', { name: /Go to the first accessibility errors/ }).click();
    await page
      .locator('[data-testid="finding"][data-severity="accessibility-error"]:focus')
      .getByRole('button', { name: /Review a fix/ })
      .click();
    await expect(page.getByTestId('remediation-proposal')).toBeVisible({ timeout: 30_000 });
    await clean(page, 'remediation proposal');
    await page.getByRole('button', { name: /Apply fix/ }).click();
    await expect(page.getByRole('button', { name: /Undo last fix/ })).toBeVisible({
      timeout: 60_000,
    });
    await clean(page, 'checks panel after a fix');
  });

  test('the export dialog, before and after acknowledgement', async ({ page }) => {
    await page.getByRole('button', { name: 'Export', exact: true }).click();
    const exporter = page.getByRole('dialog', { name: 'Export theme' });
    await expect(exporter.getByTestId('export-base')).toBeVisible({ timeout: 60_000 });
    await clean(page, 'export dialog');
    const acknowledge = exporter.getByLabel(/I have read the \d+ items/);
    if ((await acknowledge.count()) > 0) await acknowledge.check();
    await clean(page, 'export dialog acknowledged');
  });

  test('the import dialog with an invalid and a supported result', async ({ page }) => {
    await page.getByRole('button', { name: 'Import', exact: true }).click();
    const importer = page.getByRole('dialog', { name: 'Import theme' });
    await expect(importer).toBeVisible();
    await clean(page, 'import dialog');
    await importer
      .getByLabel('Or paste JSON')
      .fill('{"radius":{"medium":{"$type":"dimension","$value":"{radius.nowhere}"}}}');
    await importer.getByRole('button', { name: 'Check pasted JSON' }).click();
    await expect(importer.getByTestId('import-result')).toHaveAttribute('data-outcome', 'invalid', {
      timeout: 60_000,
    });
    await clean(page, 'import dialog with an invalid result');
    await importer.getByLabel('Or paste JSON').fill(
      JSON.stringify({
        radius: { medium: { $type: 'dimension', $value: { value: 5, unit: 'px' } } },
      }),
    );
    await importer.getByRole('button', { name: 'Check pasted JSON' }).click();
    await expect(importer.getByTestId('import-result')).not.toHaveAttribute(
      'data-outcome',
      'invalid',
      { timeout: 60_000 },
    );
    await clean(page, 'import dialog with a supported result');
  });

  test('the Source and dependencies disclosure', async ({ page }) => {
    await select(page, 'Foundations', 'radius.large');
    await page.locator('#theme-source-radius-large-header').click();
    await expect(page.getByTestId('source-disclosure')).toBeVisible();
    await clean(page, 'source and dependencies disclosure');
  });

  test('the checks panel, passing and failing', async ({ page }) => {
    await expect(page.getByTestId('checks-panel')).toHaveAttribute('data-readiness', 'ready', {
      timeout: 60_000,
    });
    await clean(page, 'checks panel, passing');
    await makeFailingDraft(page);
    await clean(page, 'checks panel, failing');
  });

  for (const tab of ['Edit', 'Preview', 'Checks']) {
    test(`the mobile ${tab} tab at 390px`, async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 800 });
      await page.getByRole('tab', { name: tab }).click();
      await expect(page.getByRole('tab', { name: tab })).toHaveAttribute('aria-selected', 'true');
      await clean(page, `${tab} tab at 390px`);
    });
  }
});

test.describe('rendered checks on the reference scene', () => {
  test('1.4.4: content and controls survive text at 200%', async ({ page }) => {
    await openBuilder(page, DESKTOP);
    const frame = await showScene(page, REFERENCE_SCENE);
    await frame.evaluate(() => {
      document.documentElement.style.fontSize = '200%';
    });
    const result = await frame.evaluate(() => {
      // Content inside its own horizontal scroll region (a table, a chart, an example's
      // scroller) keeps working; only content that pushes the page sideways is lost (1.4.10).
      const insideScrollRegion = (element: Element): boolean => {
        for (
          let node: Element | null = element;
          node !== null && node !== document.body;
          node = node.parentElement
        ) {
          if (['auto', 'scroll'].includes(getComputedStyle(node).overflowX)) return true;
        }
        return element.closest('svg, figure') !== null;
      };
      const overflowing = [...document.querySelectorAll('body *')]
        .filter((element) => !insideScrollRegion(element))
        .filter((element) => element.getBoundingClientRect().right > window.innerWidth + 1)
        .map((element) => element.outerHTML.slice(0, 100));
      const controls = [...document.querySelectorAll('button, a[href], input, select')].map(
        (element) => {
          const box = element.getBoundingClientRect();
          return { visible: box.width > 0 && box.height > 0 };
        },
      );
      return { overflowing, controls };
    });
    expect(result.overflowing, 'content pushed past the frame at 200% text').toEqual([]);
    expect(result.controls.length).toBeGreaterThan(0);
    expect(result.controls.every((control) => control.visible)).toBe(true);
  });

  test('1.4.10: the builder and the scene reflow at 320 CSS px', async ({ page }) => {
    await openBuilder(page, { width: 320, height: 800 });
    expect(await hasNoHorizontalOverflow(page), 'builder page').toBe(true);
    const frame = await showScene(page, REFERENCE_SCENE);
    const overflow = await frame.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, 'preview scene').toBeLessThanOrEqual(1);
    await page.getByRole('tab', { name: 'Checks' }).click();
    expect(await hasNoHorizontalOverflow(page), 'checks tab').toBe(true);
  });

  test('1.4.12: text spacing overrides clip or hide nothing', async ({ page }) => {
    await openBuilder(page, DESKTOP);
    const frame = await showScene(page, REFERENCE_SCENE);
    await frame.addStyleTag({
      content:
        '* { line-height: 1.5 !important; letter-spacing: 0.12em !important; word-spacing: 0.16em !important; } p { margin-block-end: 2em !important; }',
    });
    const clipped = await frame.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('body *')]
        .filter((element) => {
          const style = getComputedStyle(element);
          const hides =
            ['hidden', 'clip'].includes(style.overflowX) ||
            ['hidden', 'clip'].includes(style.overflowY);
          const hasText = [...element.childNodes].some(
            (node) => node.nodeType === Node.TEXT_NODE && (node.textContent ?? '').trim() !== '',
          );
          return (
            hides &&
            hasText &&
            (element.scrollHeight > element.clientHeight + 1 ||
              element.scrollWidth > element.clientWidth + 1)
          );
        })
        .map((element) => element.outerHTML.slice(0, 120)),
    );
    expect(clipped, 'text clipped by the spacing overrides').toEqual([]);
  });

  test('2.4.7 and 2.4.11: keyboard focus is visible and not covered', async ({ page }) => {
    await openBuilder(page, DESKTOP);
    const frame = await showScene(page, REFERENCE_SCENE);
    await frame.locator('body').click({ position: { x: 1, y: 1 } });
    const failures: string[] = [];
    for (let step = 0; step < 14; step += 1) {
      await page.keyboard.press('Tab');
      // Let the component react to the focus (a chart draws its own ring on the next frame).
      await frame.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      );
      const state = await frame.evaluate(() => {
        const element = document.activeElement;
        if (element === null || element === document.body) return null;
        const style = getComputedStyle(element);
        const box = element.getBoundingClientRect();
        const top = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
        // A chart point is an invisible SVG hit target; the chart draws its own ring layer.
        const inSvg = element.closest('svg') !== null;
        const ring =
          inSvg && element.closest('svg')!.querySelector('[class*="focus-ring-layer"] *') !== null;
        return {
          name: element.tagName.toLowerCase() + (element.getAttribute('aria-label') ?? ''),
          matches: element.matches(':focus-visible'),
          svg: inSvg,
          indicator:
            ring ||
            (style.outlineStyle !== 'none' && Number.parseFloat(style.outlineWidth) > 0) ||
            style.boxShadow !== 'none',
          covered:
            !inSvg &&
            top !== null &&
            top !== element &&
            !element.contains(top) &&
            !top.contains(element),
        };
      });
      if (state === null) continue;
      if (!state.indicator || (!state.matches && !state.svg))
        failures.push(`${state.name}: no visible indicator`);
      if (state.covered) failures.push(`${state.name}: focus is covered`);
    }
    expect(failures).toEqual([]);
  });

  test('2.5.8: interactive targets are at least 24 by 24 CSS px', async ({ page }) => {
    await openBuilder(page, DESKTOP);
    const frame = await showScene(page, REFERENCE_SCENE);
    const small = await frame.evaluate(() => {
      type Target = { element: HTMLElement; box: DOMRect };
      const targets: Target[] = [
        ...document.querySelectorAll<HTMLElement>('button, input, select, [role="tab"], a[href]'),
      ]
        .map((element) => {
          // Documented exception (equivalent control): a checkbox or radio is also operated by
          // its label, so the label's box is the target that is measured.
          const isToggle =
            element instanceof HTMLInputElement && ['checkbox', 'radio'].includes(element.type);
          const label = isToggle ? element.labels?.[0] : undefined;
          return { element, box: (label ?? element).getBoundingClientRect() };
        })
        .filter(({ box }) => box.width > 0 && box.height > 0);
      // Documented exception (spacing): a 24 CSS px circle centred on an undersized target must
      // not touch any other target.
      const distanceToBox = (x: number, y: number, box: DOMRect) =>
        Math.hypot(
          Math.max(box.left - x, 0, x - box.right),
          Math.max(box.top - y, 0, y - box.bottom),
        );
      return targets
        .filter(({ element, box }) => {
          // Documented exception (inline): a link within a sentence is sized by its text.
          if (element.tagName === 'A' && getComputedStyle(element).display === 'inline') {
            return false;
          }
          if (box.width >= 24 && box.height >= 24) return false;
          const x = box.left + box.width / 2;
          const y = box.top + box.height / 2;
          return targets.some((other) => other.box !== box && distanceToBox(x, y, other.box) < 12);
        })
        .map(
          ({ element, box }) =>
            `${element.outerHTML.slice(0, 80)} => ${Math.round(box.width)}x${Math.round(box.height)}`,
        );
    });
    expect(small, 'targets under 24x24 CSS px').toEqual([]);
  });

  test('forced colors: controls keep a visible boundary and text stays readable', async ({
    page,
  }) => {
    await page.emulateMedia({ forcedColors: 'active' });
    await openBuilder(page, DESKTOP);
    const frame = await showScene(page, REFERENCE_SCENE);
    expect(await frame.evaluate(() => matchMedia('(forced-colors: active)').matches)).toBe(true);
    const bare = await frame.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('button, input, select')]
        .filter((element) => {
          const style = getComputedStyle(element);
          const border =
            style.borderTopStyle !== 'none' && Number.parseFloat(style.borderTopWidth) > 0;
          const outline =
            style.outlineStyle !== 'none' && Number.parseFloat(style.outlineWidth) > 0;
          return !border && !outline;
        })
        .map((element) => element.outerHTML.slice(0, 100)),
    );
    expect(bare, 'controls with no boundary in forced colors').toEqual([]);
    const readable = await frame.evaluate(() => {
      const style = getComputedStyle(document.body);
      return style.color !== style.backgroundColor;
    });
    expect(readable).toBe(true);
  });

  test('reduced motion: the user preference and the simulated setting are separate', async ({
    page,
  }) => {
    const chromeDuration = () =>
      page.evaluate(() =>
        getComputedStyle(document.documentElement)
          .getPropertyValue('--cinder-duration-normal')
          .trim(),
      );
    const frameDuration = async () => {
      const frame = await previewFrame(page);
      return frame.evaluate(() =>
        getComputedStyle(document.documentElement)
          .getPropertyValue('--cinder-duration-normal')
          .trim(),
      );
    };

    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await openBuilder(page, DESKTOP);
    const chromeBaseline = await chromeDuration();
    await selectContext(page, { colorMode: 'light', motion: 'reduced' });
    await waitForPreviewApplied(page);
    // The simulated setting reaches the frame and never the builder's own chrome.
    expect(await chromeDuration()).toBe(chromeBaseline);
    const simulated = await frameDuration();
    await selectContext(page, { colorMode: 'light', motion: 'default' });
    await waitForPreviewApplied(page);
    expect(simulated).not.toBe(await frameDuration());

    await page.emulateMedia({ reducedMotion: 'reduce' });
    // The user's own preference governs the chrome even while the preview simulates default motion.
    await expect.poll(chromeDuration).not.toBe(chromeBaseline);
  });
});
