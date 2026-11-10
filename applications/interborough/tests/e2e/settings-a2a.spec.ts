/**
 * Settings › A2A (board PageSettingsSections, "A2A · /settings/a2a" and "A2A with Accept A2A calls
 * off") on the sample world: Accept A2A calls with the restart it needs, the address of the agent
 * card, a switch per agent that saves as it changes, push notifications, and the compact empty
 * state of Recent calls. Turning Accept A2A calls off is drawn from a host that booted with it off.
 *
 * Each captioned state is captured for the design review (`design-review-capture.ts`) at the widths
 * Settings is drawn at.
 */
import type { Page } from '@playwright/test';

import { A2A_COPY } from '../../src/app/copy.ts';
import { captureClock } from './capture-clock.ts';
import { captureForDesignReview } from './design-review-capture.ts';
import { E2E_SHOWCASE_PORT, E2E_SHOWCASE_URL } from './e2e-constants.ts';
import { expect, test } from './fixtures.ts';

const SOURCE = 'settings-a2a.spec.ts';
const ROUTE = '/settings/a2a';

const settingRow = (page: Page, key: string) => page.locator(`[data-setting="${key}"]`);

/** Captures the screen at the three widths Settings is drawn at: desktop, tablet and phone. */
async function captureAtEveryWidth(page: Page, state: string) {
  for (const width of [1280, 768, 375] as const) {
    await page.setViewportSize({ width, height: 900 });
    await captureForDesignReview(page, { route: ROUTE, state, source: SOURCE });
  }
  await page.setViewportSize({ width: 1280, height: 900 });
}

async function open(page: Page) {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${E2E_SHOWCASE_URL}${ROUTE}`);
  await expect(page.locator('[data-view="settings"]')).toHaveAttribute('data-state', 'ready');
  await expect(page.getByRole('heading', { level: 1, name: 'A2A' })).toBeVisible();
  await expect(settingRow(page, 'a2a.agents').locator('[data-agent]').first()).toBeVisible();
}

/**
 * The sample world's eight agents, in the one order every agent list shares, the New chat board's:
 * the six built-ins, then the two the disabled Demo plugin holds back, which a switch is still
 * drawn for.
 */
const AGENTS = [
  ['Assistant', true],
  ['Tool runner', true],
  ['Request human input', false],
  ['Workflow author', false],
  ['Echo', false],
  ['Model switcher', false],
  ['Release helper', false],
  ['Changelog writer', false],
] as const;

test.describe('Settings › A2A', () => {
  test('ready: the Agent2Agent rows and an empty Recent calls under an A2A heading', async ({
    page,
    checkA11y,
  }) => {
    await open(page);

    // The shell: breadcrumb, A2A active in the section navigation, a 170px column.
    const breadcrumb = page.getByRole('navigation', { name: 'Breadcrumb' });
    await expect(breadcrumb).toContainText('Settings');
    await expect(breadcrumb).toContainText('A2A');
    const nav = page.getByRole('navigation', { name: 'Settings sections' });
    await expect(nav.getByRole('link', { name: 'A2A', exact: true })).toHaveAttribute(
      'aria-current',
      'page',
    );
    const navigationBox = await nav.boundingBox();
    expect(Math.round(navigationBox?.width ?? 0)).toBe(170);
    // The sample world's saved change that waits for a restart rides above every section.
    const banner = page.getByTestId('settings-restart-summary');
    await expect(banner).toContainText('1 change waits for a restart');
    await expect(banner.getByRole('button', { name: 'Revert 1 change' })).toBeVisible();
    await expect(banner.getByRole('button', { name: 'Restart now' })).toBeVisible();

    await expect(page.getByText(A2A_COPY.intro)).toBeVisible();
    await expect(page.locator('main h2')).toHaveText(['Agent2Agent', 'Recent calls']);

    const enabled = settingRow(page, 'a2a.enabled');
    await expect(enabled).toContainText('Accept A2A calls');
    await expect(enabled).toContainText(A2A_COPY.enabled.description);
    await expect(enabled).toContainText('Applies after restart');
    await expect(enabled.getByRole('switch', { name: 'Accept A2A calls' })).toBeChecked();

    const card = settingRow(page, 'agent-card-url');
    await expect(card).toContainText('Agent card URL');
    await expect(card).toContainText(A2A_COPY.cardUrl.description);
    await expect(card.getByTestId('a2a-card-url')).toHaveValue(
      `http://127.0.0.1:${E2E_SHOWCASE_PORT}/bureau/a2a/.well-known/agent-card.json`,
    );
    await expect(card.getByRole('button', { name: A2A_COPY.cardUrl.copy })).toBeVisible();

    const agents = settingRow(page, 'a2a.agents');
    await expect(agents).toContainText('Shared agents');
    await expect(agents).toContainText(A2A_COPY.agents.description(AGENTS.length));
    await expect(agents.locator('[data-agent]')).toHaveCount(AGENTS.length);
    for (const [name, on] of AGENTS) {
      const entry = agents.getByRole('switch', { name, exact: true });
      if (on) await expect(entry).toBeChecked();
      else await expect(entry).not.toBeChecked();
    }
    await expect(agents.locator('[data-agent]')).toHaveText(AGENTS.map(([name]) => name));

    const push = settingRow(page, 'a2a.push.enabled');
    await expect(push).toContainText('Push notifications');
    await expect(push).toContainText(A2A_COPY.pushNotifications.description);
    await expect(push.getByRole('switch', { name: 'Push notifications' })).not.toBeChecked();

    const empty = page.getByTestId('a2a-calls-empty');
    await expect(empty).toContainText(A2A_COPY.recent.empty.title);
    await expect(empty).toContainText(A2A_COPY.recent.empty.description);
    await expect(page.getByTestId('a2a-read-only')).toHaveCount(0);

    await checkA11y('settings a2a at 1280px');
    await captureAtEveryWidth(page, 'ready');

    // Below 640px the navigation is a select under the heading Settings.
    await page.setViewportSize({ width: 375, height: 900 });
    await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Section' })).toHaveValue('/settings/a2a');
    await page.setViewportSize({ width: 1280, height: 900 });
  });

  test('sharing an agent saves it as the switch changes, and the row says Saved just now', async ({
    page,
  }) => {
    await open(page);
    const agents = settingRow(page, 'a2a.agents');
    const echo = agents.getByRole('switch', { name: 'Echo', exact: true });
    await expect(echo).not.toBeChecked();

    try {
      await echo.click();
      await expect(agents).toContainText('Saved just now');
      await expect(echo).toBeChecked();
      await captureAtEveryWidth(page, 'agent-shared');
      // The choice is live: the Agents list reports the agent as shared at once.
      await page.reload();
      await expect(page.locator('[data-view="settings"]')).toHaveAttribute('data-state', 'ready');
      await expect(
        settingRow(page, 'a2a.agents').getByRole('switch', { name: 'Echo', exact: true }),
      ).toBeChecked();
    } finally {
      const restore = settingRow(page, 'a2a.agents').getByRole('switch', {
        name: 'Echo',
        exact: true,
      });
      if (await restore.isChecked()) {
        await restore.click();
        await expect(settingRow(page, 'a2a.agents')).toContainText('Saved just now');
      }
    }
  });

  test('Accept A2A calls off: the rows after it read only, and a line says why', async ({
    page,
  }) => {
    // The host booted with Accept A2A calls off and nothing waiting: the stored value is the running one.
    await page.route('**/bureau/jsonrpc', async (route) => {
      const body = route.request().postDataJSON() as { method?: string } | null;
      if (body?.method !== 'bureau.settings.get') {
        await route.continue();
        return;
      }
      const response = await route.fetch();
      const answer = (await response.json()) as {
        result: { values: Record<string, unknown>; running: Record<string, unknown> };
      };
      answer.result.values['a2a.enabled'] = false;
      answer.result.running['a2a.enabled'] = false;
      await route.fulfill({ response, json: answer });
    });
    await open(page);

    const enabled = settingRow(page, 'a2a.enabled');
    await expect(enabled.getByRole('switch', { name: 'Accept A2A calls' })).not.toBeChecked();
    await expect(enabled).toContainText(A2A_COPY.enabled.off);
    for (const row of ['a2a.agents', 'a2a.push.enabled'] as const) {
      for (const entry of await settingRow(page, row).getByRole('switch').all()) {
        await expect(entry).toBeDisabled();
      }
    }
    await expect(page.getByTestId('a2a-read-only')).toHaveText(A2A_COPY.readOnly);
    // What it controls stays visible: the address, the agents and push.
    await expect(settingRow(page, 'agent-card-url')).toBeVisible();
    await expect(settingRow(page, 'a2a.agents').locator('[data-agent]')).toHaveCount(AGENTS.length);
    await expect(settingRow(page, 'a2a.push.enabled')).toBeVisible();
    await captureAtEveryWidth(page, 'accept-off');
  });

  test('Recent calls list each call with when, who made it and which agent answered', async ({
    page,
  }) => {
    // The sample world has no remote call, so the audit trail answers two for this case (row 50z).
    const call = (at: number, taskId: string, agentName: string) => ({
      sequence: null,
      timestamp: new Date(at).toISOString(),
      type: 'a2a.call',
      resource: taskId,
      principal: 'api-key:planner',
      detail: { agentName, taskId, callerName: 'planner' },
    });
    // A capture pins the browser to the sample world's clock, so the calls are told against that one.
    const now = Date.parse(captureClock()?.now ?? new Date().toISOString());
    const trail = [
      call(now - 5 * 24 * 60 * 60 * 1000, 'task-older', 'assistant'),
      call(now - 60_000, 'task-newer', 'tool-runner'),
    ];
    await page.route('**/bureau/jsonrpc', async (route) => {
      const body = route.request().postDataJSON() as {
        id?: unknown;
        method?: unknown;
        params?: { type?: unknown };
      } | null;
      if (body?.method !== 'bureau.audit.query' || body.params?.type !== 'a2a.call') {
        return route.fallback();
      }
      return route.fulfill({
        json: { jsonrpc: '2.0', id: body.id ?? null, result: { records: trail, nextCursor: null } },
      });
    });
    await open(page);

    const calls = page.getByTestId('a2a-call');
    await expect(calls).toHaveCount(2);
    // Newest first: today's call, then the older one on a named day.
    // It reads "Today" unless the clock passed midnight between the call and the page.
    await expect(calls.nth(0)).toContainText(
      /^(Today|[A-Z][a-z]{2} [A-Z][a-z]{2} \d{1,2}), \d{1,2}:\d{2} [AP]M/,
    );
    await expect(calls.nth(0)).toContainText('Remote agent “planner”');
    await expect(calls.nth(0)).toContainText('answered by Tool runner');
    await expect(calls.nth(1)).toContainText(/^[A-Z][a-z]{2} [A-Z][a-z]{2} \d{1,2}, /);
    await expect(calls.nth(1)).toContainText('Remote agent “planner”');
    await expect(calls.nth(1)).toContainText('answered by Assistant');
    await expect(page.getByTestId('a2a-calls-empty')).toHaveCount(0);
    await captureAtEveryWidth(page, 'recent-calls');
  });
});
