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

test.describe('axe, WCAG 2.2 AA tags, every impact level', () => {
  for (const context of CONTEXTS) {
    const label = `${context.colorMode}/${context.motion}`;
    // Motion only changes motion tokens, so the other four contexts check the reference scenes.
    const scenes =
      context.motion === 'default'
        ? THEME_PREVIEW_SCENES.map((scene) => scene.id)
        : [REFERENCE_SCENE, 'foundations/specimens'];

    test(`the builder and its preview scenes in ${label}`, async ({ page }) => {
      test.setTimeout(420_000);
      await openBuilder(page, DESKTOP);
      await selectContext(page, context);
      await waitForPreviewApplied(page);
      // The checks panel is part of the builder chrome that Axe sees, with its long list open.
      await expect(page.getByTestId('checks-panel')).toBeVisible();
      await expect(page.getByTestId('checks-panel')).toHaveAttribute('data-readiness', 'ready', {
        timeout: 60_000,
      });
      expect(await axeViolations(page, 'builder'), `builder chrome ${label}`).toEqual([]);
      await page.getByTestId('group-advisory').locator('summary').click();
      expect(await axeViolations(page, 'builder'), `advisory findings ${label}`).toEqual([]);
      for (const sceneId of scenes) {
        await showScene(page, sceneId);
        expect(await axeViolations(page, 'frame'), `${sceneId} in ${label}`).toEqual([]);
      }
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
