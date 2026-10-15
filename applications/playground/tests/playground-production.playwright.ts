/**
 * Browser cases of the static production gate. `scripts/check-static-playground.ts` writes the
 * shard's case list and serves `build/`; every HTTP-level property was already checked before this
 * file runs, so it covers only what needs a browser: view tabs, a positively mounted Playground,
 * console and page errors, failed same-origin requests, axe, and overflow at 390px.
 *
 * Timeouts are Playwright's defaults and the configuration sets zero retries.
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { AxeBuilder } from '@axe-core/playwright';
import { test as base, expect, type Page } from '@playwright/test';

import type { StaticCase } from '../scripts/static-playground-cases.ts';
import { readEnvironmentConfiguration } from '../src/environment-configuration.ts';
import { COMPOUND_COMPONENT_PARENTS } from '../src/shell-app/compound-families.ts';

const environment = readEnvironmentConfiguration();
const casesPath = environment.playgroundStaticCases;
if (casesPath === undefined) throw new Error('PLAYGROUND_STATIC_CASES is required');
const cases = JSON.parse(readFileSync(casesPath, 'utf8')) as StaticCase[];
const screenshotDirectory = environment.playgroundStaticScreenshots;

const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

/**
 * Every case records what the browser reported, and a failing case leaves a screenshot in the
 * gate's output directory. Both reach `report.json` through `tests/static-playground-reporter.ts`.
 */
const test = base.extend<{ diagnostics: string[] }>({
  diagnostics: [
    async ({ page, baseURL }, use, testInfo) => {
      const origin = new URL(baseURL ?? 'http://127.0.0.1').origin;
      const diagnostics: string[] = [];
      page.on('pageerror', (error) => diagnostics.push(`pageerror: ${error.message}`));
      page.on('console', (message) => {
        if (message.type() === 'error' || message.type() === 'warning') {
          diagnostics.push(`console ${message.type()}: ${message.text()}`);
        }
      });
      page.on('requestfailed', (request) => {
        if (new URL(request.url()).origin !== origin) return;
        diagnostics.push(`requestfailed: ${request.url()} ${request.failure()?.errorText ?? ''}`);
      });
      page.on('response', (response) => {
        if (new URL(response.url()).origin !== origin || response.status() < 400) return;
        diagnostics.push(`response ${response.status()}: ${response.url()}`);
      });
      await use(diagnostics);
      await testInfo.attach('browser-diagnostics', {
        body: JSON.stringify(diagnostics),
        contentType: 'application/json',
      });
      if (testInfo.status === testInfo.expectedStatus || screenshotDirectory === undefined) return;
      mkdirSync(screenshotDirectory, { recursive: true });
      const path = join(
        screenshotDirectory,
        `${testInfo.title.replace(/[^A-Za-z0-9]+/g, '-')}.png`,
      );
      await page.screenshot({ path }).then(
        () => testInfo.attach('failure-screenshot-path', { body: path, contentType: 'text/plain' }),
        () => undefined,
      );
    },
    { auto: true },
  ],
});

async function expectAccessible(page: Page, label: string): Promise<void> {
  const { violations } = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
  expect(
    violations.map((violation) => `${violation.id}: ${violation.nodes.length} nodes`),
    `${label} axe violations`,
  ).toEqual([]);
}

async function expectNoHorizontalOverflow(page: Page, testCase: StaticCase): Promise<void> {
  if (testCase.width !== 390) return;
  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(scrollWidth, `${testCase.id} document width`).toBeLessThanOrEqual(testCase.width);
}

async function expectView(page: Page, view: 'documentation' | 'playground'): Promise<void> {
  const tabs = page.getByRole('tablist', { name: 'Component views', exact: true });
  const other = view === 'documentation' ? 'playground' : 'documentation';
  await expect(tabs.locator(`#view-tab-${view}`)).toHaveAttribute('aria-selected', 'true');
  await expect(tabs.locator(`#view-tab-${other}`)).toHaveAttribute('aria-selected', 'false');
  await expect(page.locator(`#view-panel-${view}`)).toBeVisible();
  await expect(page.locator(`#view-panel-${other}`)).toBeHidden();
  await expect
    .poll(() => new URL(page.url()).searchParams.get('view'))
    .toBe(view === 'playground' ? 'playground' : null);
}

async function selectView(page: Page, view: 'documentation' | 'playground'): Promise<void> {
  await page.locator(`#view-tab-${view}`).click();
  await expectView(page, view);
}

/** A Playground passes only on a positive mounted signal, never on an empty frame. */
async function expectMountedPlayground(page: Page, route: string): Promise<void> {
  const panel = page.locator('#view-panel-playground');
  const name = route.split('/').at(-1) ?? '';
  const parent = COMPOUND_COMPONENT_PARENTS[name];
  const ready = panel.locator('.dx-stage__canvas > .example-preview[data-example-preview-ready]');
  if (parent === undefined || (await panel.locator('[data-stage-composed]').count()) === 0) {
    await expect(ready.first(), `${route} mounted preview`).toBeAttached();
  } else {
    const composed = panel.locator('[data-stage-composed]');
    await expect(composed.locator(`a[href="/page/${parent}"]`)).toBeVisible();
  }
  await expect(panel.getByText(/failed to render/)).toHaveCount(0);
}

for (const testCase of cases) {
  test(testCase.id, async ({ page, diagnostics }) => {
    await page.setViewportSize({ width: testCase.width, height: testCase.height });
    const response = await page.goto(testCase.route, { waitUntil: 'load' });
    expect(response?.status(), `${testCase.route} status`).toBe(200);
    await expect(page.locator('h1')).toHaveCount(1);

    if (testCase.view !== 'page') {
      await expect(page.locator('[data-component-page][data-page-hydrated]')).toBeAttached();
      await expectView(page, 'documentation');
      await selectView(page, 'playground');
      if (testCase.view === 'playground') {
        await expectMountedPlayground(page, testCase.route);
      } else {
        await selectView(page, 'documentation');
      }
    }

    await page.waitForLoadState('networkidle');
    await expectNoHorizontalOverflow(page, testCase);
    await expectAccessible(page, testCase.id);
    expect(diagnostics, `${testCase.id} browser diagnostics`).toEqual([]);
  });
}
