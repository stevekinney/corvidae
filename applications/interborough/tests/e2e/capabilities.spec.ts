/**
 * `/capabilities` against the real host (COR-1840): every tool of the catalog and every executable
 * skill the host discovered is listed with its tier, source and users, the open item is in the
 * address, a skill from a source the host does not trust is marked, and G P opens the page.
 * The host starts with three skills in two configured sources (`skills-support.ts`): two from a
 * trusted source, one of them with a long name and description, and one from a source it does not
 * trust.
 */
import type { Page } from '@playwright/test';

import { CAPABILITIES_COPY } from '../../src/app/copy.ts';
import { readCatalog } from './agent-support.ts';
import { expect, test } from './fixtures.ts';
import { E2E_SKILLS, skillAddressKey } from './skills-support.ts';

const WIDTHS = [375, 1280] as const;
const copy = CAPABILITIES_COPY;

const area = (page: Page) => page.locator('[data-view="capabilities"]');
const toolRows = (page: Page) => page.locator('[data-tool-row]');
const skillRows = (page: Page) => page.locator('[data-skill-row]');

test.describe('the Tools tab', () => {
  test('lists every tool of the catalog, each with its tier', async ({ page, request }) => {
    const { tools } = await readCatalog(request);
    expect(tools.length).toBeGreaterThan(0);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/capabilities');
    await expect(area(page)).toHaveAttribute('data-state', 'ready');
    await expect(toolRows(page)).toHaveCount(tools.length);
    for (const tool of tools) {
      const row = page.locator(`[data-tool-row="${tool.name}"]`);
      await expect(row).toHaveCount(1);
      await expect(row).toContainText(/Reads only|Changes things|Dangerous|Not classified/);
    }
    await expect(page.getByTestId('tools-count')).toHaveText(String(tools.length));
  });

  for (const width of WIDTHS) {
    test(`opens a tool with its tier, approval, source, inputs and users, at ${width} pixels`, async ({
      page,
      request,
      checkA11y,
    }) => {
      const { tools } = await readCatalog(request);
      const tool = tools[0]!;
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/capabilities');
      await page.locator(`[data-tool-row="${tool.name}"]`).click();
      const detail = page.getByTestId('tool-detail');
      await expect(detail).toHaveAttribute('data-tool', tool.name);
      await expect(detail.getByTestId('tool-approval')).toHaveText(
        /Runs without asking|Asks you first/,
      );
      await expect(detail.getByTestId('tool-source')).toHaveText(
        /Provided by this host|Built into Interborough/,
      );
      await expect(detail.getByTestId('tool-input-schema')).toBeVisible();
      await expect(detail.getByTestId('capability-users')).toBeVisible();
      // The open tool is in the address, so the page can be linked.
      await expect(page).toHaveURL(new RegExp(`tool=${encodeURIComponent(tool.name)}`));
      // No word stands in for an empty list.
      await expect(detail).not.toContainText(/\bNone\b/);
      await checkA11y(`the Tools tab with ${tool.name} open at ${width}px`);
    });
  }

  test('filters by name and says so when nothing matches', async ({ page, request }) => {
    const { tools } = await readCatalog(request);
    const total = tools.length;
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/capabilities');
    await expect(toolRows(page)).toHaveCount(total);
    await page.getByRole('searchbox', { name: copy.filterLabel.tools }).fill('zzz-no-such-tool');
    await expect(page.getByText(copy.tool.filtered.title)).toBeVisible();
    await page.getByRole('button', { name: copy.tool.filtered.clear }).click();
    await expect(toolRows(page)).toHaveCount(total);
  });
});

test.describe('the Skills tab', () => {
  for (const width of WIDTHS) {
    test(`lists the discovered skills and marks the untrusted one, at ${width} pixels`, async ({
      page,
      checkA11y,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/capabilities?tab=skills');
      await expect(area(page)).toHaveAttribute('data-state', 'ready');
      await expect(skillRows(page)).toHaveCount(Object.keys(E2E_SKILLS).length);
      const untrusted = page.locator(`[data-skill-row="${E2E_SKILLS.deploy.name}"]`);
      await expect(untrusted).toHaveAttribute('data-trust', 'untrusted');
      await expect(untrusted).toContainText(copy.skill.untrustedBadge);
      const trusted = page.locator(`[data-skill-row="${E2E_SKILLS.summarize.name}"]`);
      await expect(trusted).toHaveAttribute('data-trust', 'trusted');
      await expect(trusted).not.toContainText(copy.skill.untrustedBadge);
      await checkA11y(`the Skills tab at ${width}px`);
    });
  }

  test('opens an untrusted skill with why agents are refused it, and a trusted one with its tools', async ({
    page,
    checkA11y,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/capabilities?tab=skills');
    await page.locator(`[data-skill-row="${E2E_SKILLS.deploy.name}"]`).click();
    const detail = page.getByTestId('skill-detail');
    await expect(detail).toHaveAttribute('data-skill', E2E_SKILLS.deploy.name);
    await expect(detail).toHaveAttribute('data-trust', 'untrusted');
    await expect(detail.getByTestId('skill-trust')).toContainText('Not trusted');
    await expect(detail.getByTestId('skill-unavailable')).toContainText(
      copy.skill.unavailable['source-untrusted'],
    );
    await expect(detail.getByTestId('skill-allowed-tools')).toContainText('run_shell');
    await expect(page).toHaveURL(
      new RegExp(`skill=${encodeURIComponent(skillAddressKey(E2E_SKILLS.deploy))}`),
    );
    await checkA11y('an untrusted skill open');

    await page.locator(`[data-skill-row="${E2E_SKILLS.long.name}"]`).click();
    await expect(page.getByTestId('skill-detail')).toHaveAttribute(
      'data-skill',
      E2E_SKILLS.long.name,
    );
    await expect(page.getByTestId('skill-detail').getByTestId('skill-unavailable')).toHaveCount(0);
    await expect(page.getByTestId('skill-allowed-tools')).toContainText('grep');
  });

  test('opens the skill the address names, and Back from the Skills tab returns to Tools', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(
      `/capabilities?tab=skills&skill=${encodeURIComponent(skillAddressKey(E2E_SKILLS.summarize))}`,
    );
    await expect(page.getByTestId('skill-detail')).toHaveAttribute(
      'data-skill',
      E2E_SKILLS.summarize.name,
    );
    await page.getByRole('tab', { name: copy.tabs.tools }).click();
    await expect(page.getByTestId('tools-panel')).toBeVisible();
    await expect(page).toHaveURL(/\/capabilities$/);
  });
});

test('G P opens the page, and the sidebar marks it current', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/agents');
  await expect(page.getByRole('navigation', { name: 'Views' })).toBeVisible();
  await page.keyboard.press('g');
  await page.keyboard.press('p');
  await expect(page).toHaveURL(/\/capabilities$/);
  await expect(
    page
      .getByRole('navigation', { name: 'Views' })
      .getByRole('link', { name: new RegExp(`^${copy.title}`) }),
  ).toHaveAttribute('aria-current', 'page');
  await expect(area(page)).toHaveAttribute('data-state', 'ready');
});
