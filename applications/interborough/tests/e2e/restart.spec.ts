/**
 * The restart flow the shell shows (`shell:restart-flow`, COR-2015), on the sample world: the dialog
 * that says Interborough did not come back after 8 tries, with what to check, the exact command it
 * was launched with and Keep waiting; the banner that says it is back up and what applied; and the
 * same banner after a plugin is turned off. The host really restarting is `connect-tools-restart.spec.ts`;
 * here the host's plugin, restart and settings routes are answered by the specification, so the
 * host being down for 8 tries is a state the test holds instead of a minute it waits out, and the
 * page's clock is run forward through the backoff.
 *
 * Each captioned state is captured for the design review at 1280 and 375 pixels.
 */
import type { Page } from '@playwright/test';

import { PLUGINS_COPY, RESTART_COPY } from '../../src/app/copy.ts';
import { captureForDesignReview } from './design-review-capture.ts';
import { E2E_SHOWCASE_URL } from './e2e-constants.ts';
import { expect, test } from './fixtures.ts';

const SOURCE = 'restart.spec.ts';
const SETTINGS_KEY = 'engine.workflowClaimRenewInterval';

type Fixture = {
  readonly name: string;
  readonly title: string;
  readonly status: 'running' | 'needs-setup' | 'disabled';
};

const PLUGINS: readonly Fixture[] = [
  { name: 'web-search', title: 'Web search', status: 'running' },
  { name: 'anthropic', title: 'Anthropic', status: 'needs-setup' },
  { name: 'openai', title: 'OpenAI', status: 'needs-setup' },
  { name: 'gemini', title: 'Gemini', status: 'needs-setup' },
  { name: 'typesafe', title: 'TypeSafe', status: 'needs-setup' },
  { name: 'files', title: 'Files', status: 'running' },
  { name: 'linear', title: 'Linear', status: 'disabled' },
  { name: 'demo', title: 'Demo', status: 'disabled' },
];

/** What `GET /host/plugins` answers: the sample world's plugins, with `changed` waiting for a restart. */
function snapshotOf(options: { readonly applied: boolean; readonly changed?: string }) {
  return {
    // The revision a write is checked against (`mutationInput`): the page refuses a snapshot without one.
    configurationRevision: 'e2e-configuration-revision',
    plugins: PLUGINS.map((plugin) => {
      const turnedOff = plugin.name === options.changed && options.applied;
      const status = turnedOff ? 'disabled' : plugin.status;
      const waiting = plugin.name === options.changed && !options.applied;
      return {
        descriptor: {
          name: plugin.name,
          title: plugin.title,
          version: '1.0.0',
          description: `${plugin.title} adds tools agents can use.`,
          required: false,
          enabledByDefault: true,
        },
        source: 'package',
        location: `@lostgradient/plugin-${plugin.name}`,
        status,
        problems: [],
        contributions: [],
        enabled: waiting ? false : status !== 'disabled',
        configuration: {},
        configurationSchema: null,
        running: { enabled: plugin.status !== 'disabled', configuration: {} },
        secrets: [],
        restartRequired: waiting,
      };
    }),
    unloaded: [],
  };
}

type HostState = 'up' | 'down' | 'back';

/**
 * Stands in for the host's plugin and restart routes. Asking it to restart takes it `down`; it
 * answers again (`back`) only when the test says so, so the test decides whether it comes back.
 */
async function installHost(page: Page) {
  let state: HostState = 'up';
  let written = false;
  const launch = { command: 'bun run start', directory: '/home/steve/interborough' };
  await page.route('**/host/plugins/*', async (route) => {
    written = true;
    await route.fulfill({
      json: { plugin: 'web-search', enabled: false, configuration: {}, restartRequired: true },
    });
  });
  await page.route('**/host/plugins', async (route) => {
    if (state === 'down') {
      await route.abort('connectionfailed');
      return;
    }
    await route.fulfill({
      json: snapshotOf({
        applied: state === 'back',
        ...(written ? { changed: 'web-search' } : {}),
      }),
    });
  });
  await page.route('**/host/restart', async (route) => {
    if (route.request().method() === 'POST') {
      state = 'down';
      await route.fulfill({ status: 202, json: { restarting: true } });
      return;
    }
    await route.fulfill({ json: { available: true, launch } });
  });
  return {
    comeBack: () => {
      state = 'back';
    },
  };
}

/** Runs the page's clock through the backoff until the dialog reaches `phase`. */
async function untilPhase(page: Page, phase: 'reconnecting' | 'failed') {
  const card = page.locator(`.cinder-restart-state__card[data-cinder-phase="${phase}"]`);
  await expect
    .poll(
      async () => {
        await page.clock.runFor(9_000);
        return card.count();
      },
      { intervals: [100] },
    )
    .toBe(1);
  return card;
}

/** Captures the screen at the two widths the design draws it at. */
async function captureAtBothWidths(page: Page, route: string, state: string) {
  for (const width of [1280, 375] as const) {
    await page.setViewportSize({ width, height: 900 });
    await captureForDesignReview(page, { route, state, source: SOURCE });
  }
  await page.setViewportSize({ width: 1280, height: 900 });
}

/**
 * Stands in for the host while Settings restarts it: the sample world holds one change that waits
 * for a restart, the host goes `down` when asked, and answers again only when the test calls
 * `comeBack`.
 */
async function installSettingsHost(page: Page) {
  let state: HostState = 'up';
  await page.route('**/bureau/jsonrpc', async (route) => {
    const body = route.request().postDataJSON() as { method?: string } | null;
    if (body?.method !== 'bureau.settings.get') {
      await route.continue();
      return;
    }
    if (state === 'down') {
      await route.abort('connectionfailed');
      return;
    }
    // The sample world holds the one change that waits for a restart.
    const response = await route.fetch();
    const answer = (await response.json()) as {
      result: { keys: Record<string, { pendingRestart: boolean }> };
    };
    const key = answer.result.keys[SETTINGS_KEY];
    if (key !== undefined) key.pendingRestart = state === 'up';
    await route.fulfill({ response, json: answer });
  });
  await page.route('**/host/restart', async (route) => {
    if (route.request().method() === 'POST') {
      state = 'down';
      await route.fulfill({ status: 202, json: { restarting: true } });
      return;
    }
    await route.fulfill({
      json: { available: true, launch: { command: 'bun run start', directory: '/home' } },
    });
  });
  return {
    comeBack: () => {
      state = 'back';
    },
  };
}

/** Opens Settings, and restarts the host through the summary's button and its confirmation. */
async function restartFromSettings(page: Page) {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${E2E_SHOWCASE_URL}/settings`);
  const summary = page.getByTestId('settings-restart-summary');
  await summary.getByRole('button', { name: RESTART_COPY.confirm.confirm }).click();
  const question = page.getByRole('dialog', { name: RESTART_COPY.confirm.title });
  await expect(question).toContainText(RESTART_COPY.confirm.description(1));
  await question.getByRole('button', { name: RESTART_COPY.confirm.confirm }).click();
  return summary;
}

test.describe('Restart', () => {
  test('Disable · failed: says Interborough did not come back, then Keep waiting and the host back up say what became of Web search', async ({
    page,
    pageErrors,
  }) => {
    pageErrors.expectEvery({
      pattern: /net::ERR_CONNECTION_FAILED/,
      reason: 'the test holds the host down, so every read of its plugins fails',
    });
    await page.clock.install();
    const host = await installHost(page);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${E2E_SHOWCASE_URL}/settings/plugins?plugin=web-search`);

    await page.getByRole('switch', { name: PLUGINS_COPY.enabled }).click();
    const question = page.getByRole('dialog', { name: PLUGINS_COPY.disable.title('Web search') });
    await question.getByRole('button', { name: PLUGINS_COPY.disable.confirm }).click();

    // The host stops answering: the attempts count, then give up after 8.
    const reconnecting = await untilPhase(page, 'reconnecting');
    await expect(reconnecting).toContainText('Attempt');
    const failed = await untilPhase(page, 'failed');

    await expect(failed.getByRole('heading')).toHaveText('Interborough didn’t come back');
    await expect(failed).toContainText(RESTART_COPY.failed.description(1, 'Web search'));
    await expect(failed).toContainText('What to check');
    await expect(failed).toContainText(RESTART_COPY.failed.check);
    await expect(failed.getByText('Show the error details')).toBeVisible();
    await expect(failed.locator('.cinder-restart-state__command-text')).toHaveText('bun run start');
    await expect(failed.getByRole('button', { name: 'Copy' })).toBeVisible();
    await expect(failed.getByRole('button', { name: 'Keep waiting' })).toBeVisible();
    // The route that restarts the host lives on the host that is not answering.
    await expect(failed.getByRole('button', { name: /restart/i })).toHaveCount(0);
    // The shell does not speak over it.
    await expect(page.getByRole('region', { name: 'Connection problem' })).toHaveCount(0);
    await captureAtBothWidths(page, '/settings/plugins', 'restart-failed');

    // Keep waiting watches again; the host answers, and the page says what became of Web search.
    host.comeBack();
    await failed.getByRole('button', { name: 'Keep waiting' }).click();
    const back = page.getByTestId('restart-back');
    await expect(back).toBeVisible();
    await expect(back).toContainText('Back up. Web search is disabled.');
    await expect(back).toContainText(
      '1 plugin running (Files); Anthropic, OpenAI, Gemini and TypeSafe need setup; Web search, Linear and Demo are disabled. Nothing used Web search, so nothing became unavailable. Enable it again at any time.',
    );
    await expect(page.locator('.cinder-restart-state__card')).toHaveCount(0);
    await captureAtBothWidths(page, '/settings/plugins', 'disable-back-up');

    await back.getByRole('button', { name: 'Dismiss' }).click();
    await expect(back).toHaveCount(0);
  });

  test('Restart · failed: after 8 tries the dialog says Your change was saved, what to check, the launch command and Keep waiting', async ({
    page,
    pageErrors,
  }) => {
    pageErrors.expectEvery({
      pattern: /net::ERR_CONNECTION_FAILED/,
      reason: 'the test holds the host down, so every read of its settings fails',
    });
    await page.clock.install();
    await installSettingsHost(page);
    await restartFromSettings(page);

    const failed = await untilPhase(page, 'failed');
    await expect(failed.getByRole('heading')).toHaveText('Interborough didn’t come back');
    await expect(failed).toContainText(
      'It didn’t answer after 8 tries. Your change was saved before it stopped, so they apply once it starts.',
    );
    await expect(failed).toContainText('What to check');
    await expect(failed).toContainText(RESTART_COPY.failed.check);
    await expect(failed.getByText('Show the error details')).toBeVisible();
    // Row 47y: "Start it again from the terminal", the exact command and Copy.
    await expect(failed).toContainText('Start it again from the terminal');
    await expect(failed.locator('.cinder-restart-state__command-text')).toHaveText('bun run start');
    await expect(failed.getByRole('button', { name: 'Copy' })).toBeVisible();
    // Row 47z: Keep waiting is the one primary, and there is no way to restart from here.
    await expect(failed.getByRole('button', { name: 'Keep waiting' })).toBeVisible();
    await expect(failed.getByRole('button', { name: /restart/i })).toHaveCount(0);
    await captureAtBothWidths(page, '/settings', 'settings-restart-failed');
  });

  test('Restart · back up: Settings says what applied once Interborough is back', async ({
    page,
    pageErrors,
  }) => {
    pageErrors.expectEvery({
      pattern: /net::ERR_CONNECTION_FAILED/,
      reason: 'the test holds the host down until it comes back, so reads of its settings fail',
    });
    await page.clock.install();
    const host = await installSettingsHost(page);
    const summary = await restartFromSettings(page);

    await untilPhase(page, 'reconnecting');
    host.comeBack();
    const back = page.getByTestId('restart-back');
    await expect
      .poll(
        async () => {
          await page.clock.runFor(9_000);
          return back.count();
        },
        { intervals: [100] },
      )
      .toBe(1);
    await expect(back).toContainText('Back up');
    // The board's success banner leads with a check-circle (design rows 48a and 50c).
    await expect(back.locator('.cinder-banner__icon svg.lucide-circle-check')).toHaveCount(1);
    await expect(back).toContainText(
      '1 change applied: Workflow claim renew interval. Running work picked up where it stopped; reviews stayed waiting.',
    );
    await expect(back.getByRole('button', { name: 'Dismiss' })).toBeVisible();
    await expect(summary).toHaveCount(0);
    await captureAtBothWidths(page, '/settings', 'restart-back-up');
  });
});
