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
  await page.getByLabel('Preview category').selectOption(scene.category);
  await page.getByLabel('Example').selectOption(sceneId);
  await waitForPreviewApplied(page);
  const frame = await previewFrame(page);
  await expect(frame.locator('main.stage')).toHaveAttribute('data-scene', sceneId);
  await waitForScene(frame);
  return frame;
}

async function axeViolations(page: Page): Promise<string[]> {
  const results = await new AxeBuilder({ page }).withTags([...WCAG_22_AA_TAGS]).analyze();
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
      // The checks panel is part of the builder chrome that Axe sees.
      await expect(page.getByTestId('checks-panel')).toBeVisible();
      expect(await axeViolations(page), `builder chrome ${label}`).toEqual([]);
      for (const sceneId of scenes) {
        await showScene(page, sceneId);
        expect(await axeViolations(page), `${sceneId} in ${label}`).toEqual([]);
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
    const result = await frame.evaluate(() => ({
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      controls: [...document.querySelectorAll('button, a[href], input, select')].map((element) => {
        const box = element.getBoundingClientRect();
        return {
          visible: box.width > 0 && box.height > 0,
          inside: box.right <= window.innerWidth + 1,
        };
      }),
    }));
    expect(result.overflow, 'no sideways scrolling at 200% text').toBeLessThanOrEqual(1);
    expect(result.controls.length).toBeGreaterThan(0);
    expect(result.controls.every((control) => control.visible && control.inside)).toBe(true);
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
      const state = await frame.evaluate(() => {
        const element = document.activeElement;
        if (element === null || element === document.body) return null;
        const style = getComputedStyle(element);
        const box = element.getBoundingClientRect();
        const top = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
        return {
          name: element.tagName.toLowerCase() + (element.getAttribute('aria-label') ?? ''),
          matches: element.matches(':focus-visible'),
          indicator:
            (style.outlineStyle !== 'none' && Number.parseFloat(style.outlineWidth) > 0) ||
            style.boxShadow !== 'none',
          covered:
            top !== null && top !== element && !element.contains(top) && !top.contains(element),
        };
      });
      if (state === null) continue;
      if (!state.matches || !state.indicator) failures.push(`${state.name}: no visible indicator`);
      if (state.covered) failures.push(`${state.name}: focus is covered`);
    }
    expect(failures).toEqual([]);
  });

  test('2.5.8: interactive targets are at least 24 by 24 CSS px', async ({ page }) => {
    await openBuilder(page, DESKTOP);
    const frame = await showScene(page, REFERENCE_SCENE);
    const small = await frame.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('button, input, select, [role="tab"], a[href]')]
        .filter((element) => {
          const box = element.getBoundingClientRect();
          if (box.width === 0 || box.height === 0) return false;
          // Documented exception: an inline link inside a sentence is sized by its text.
          const inline = element.tagName === 'A' && getComputedStyle(element).display === 'inline';
          return !inline && (box.width < 24 || box.height < 24);
        })
        .map(
          (element) =>
            `${element.tagName.toLowerCase()} ${element.textContent?.trim().slice(0, 30)}`,
        ),
    );
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
