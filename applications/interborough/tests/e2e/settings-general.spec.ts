/**
 * Settings › General (board SettingsShell, "General, /settings") on the sample world: the page at
 * 1280 and 375 pixels, a setting saved as its field is left, a value that is refused at its field,
 * a save that does not go through, the banner's Revert with its Undo toast, a remote deployment's
 * locked settings, and the placeholders while the settings load. The restart that follows a saved change is `restart.spec.ts`.
 *
 * The Embedder row (board COR-2189, rows EM6-01 to EM6-23) has its own states at the end, each
 * named `embedder-…`: the picker, the confirmation before a switch, a running, canceled or failed
 * switch, and what the row says while the embedder in use has a problem. The Bureau's embedding
 * status, its cancel and the write of `memory.embedder` are answered by the test, so the real
 * deployment's memory is never switched.
 *
 * Each captioned state is captured for the design review (`design-review-capture.ts`), at the two
 * widths the design draws it at.
 */
import type { Page } from '@playwright/test';

import { SETTINGS_COPY } from '../../src/app/copy/settings.ts';
import { VIEW_COPY } from '../../src/app/copy/view-pages.ts';
import { API_SCOPES } from '../../src/lib/api-scopes.ts';
import { captureForDesignReview } from './design-review-capture.ts';
import { E2E_SHOWCASE_URL } from './e2e-constants.ts';
import { expect, loggedFailedResponse, test } from './fixtures.ts';
import { readBoxes } from './read-boxes.ts';

const SOURCE = 'settings-general.spec.ts';
const ROUTE = '/settings';

const settingRow = (page: Page, key: string) => page.locator(`[data-setting="${key}"]`);

/** Captures the screen at the two widths the design draws it at. */
async function captureAtBothWidths(page: Page, state: string) {
  for (const width of [1280, 375] as const) {
    await page.setViewportSize({ width, height: 900 });
    await captureForDesignReview(page, { route: ROUTE, state, source: SOURCE });
  }
  await page.setViewportSize({ width: 1280, height: 900 });
}

async function openGeneral(page: Page) {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${E2E_SHOWCASE_URL}${ROUTE}`);
  await expect(page.locator('[data-view="settings"]')).toHaveAttribute('data-state', 'ready');
  await expect(settingRow(page, 'tools.wakeup')).toBeVisible();
}

test.describe('Settings › General', () => {
  test('ready: four sections of rows under a General heading, with the section navigation beside them', async ({
    page,
    checkA11y,
  }) => {
    await openGeneral(page);
    await expect(page.getByRole('heading', { level: 1, name: 'General' })).toBeVisible();
    await expect(page.getByText(SETTINGS_COPY.general.intro)).toBeVisible();
    for (const heading of ['Tools', 'Runs', 'Memory', 'Storage', 'Your preferences']) {
      await expect(page.getByRole('heading', { level: 2, name: heading })).toBeVisible();
    }
    await expect(page.getByRole('heading', { name: /engine/i })).toHaveCount(0);
    await expect(settingRow(page, 'storage.backend')).toContainText('SQLite, on this machine');
    await expect(
      page.getByRole('navigation', { name: 'Settings sections' }).getByRole('link'),
    ).toHaveText([
      'General',
      'Models',
      'Allowed models',
      'A2A',
      'Plugins',
      'Data and retention',
      'API reference',
    ]);
    // At 640px and wider the navigation is a 170px column.
    const column = await page.getByRole('navigation', { name: 'Settings sections' }).boundingBox();
    expect(Math.round(column?.width ?? 0)).toBe(170);
    // The sample world holds one saved change that waits for a restart.
    const banner = page.getByTestId('settings-restart-summary');
    await expect(banner).toContainText('1 change waits for a restart');
    await expect(settingRow(page, 'engine.workflowClaimRenewInterval')).toContainText(
      'Saved, waiting for a restart',
    );
    await expect(
      settingRow(page, 'engine.workflowClaimRenewInterval').getByRole('spinbutton'),
    ).toHaveValue('15');
    await expect(banner.getByRole('button', { name: 'Revert 1 change' })).toBeVisible();
    await expect(banner.getByRole('button', { name: 'Restart now' })).toBeVisible();
    const cap = settingRow(page, 'engine.maxConcurrentRuns');
    await expect(cap).toContainText('Max concurrent runs');
    await expect(cap).toContainText(
      'The most workflow runs that execute at the same time on this machine.',
    );
    await expect(cap.getByRole('spinbutton')).toHaveValue('4');
    await expect(cap).toContainText('runs');
    await checkA11y('settings general at 1280px');
    await captureAtBothWidths(page, 'ready');

    // Below 640px the navigation is a select under the heading Settings.
    await page.setViewportSize({ width: 375, height: 900 });
    await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Section' })).toHaveValue('/settings');
    // The banner stacks: its Revert and Restart now sit below its words.
    const words = await banner.getByText('Running work picks up where it stopped').boundingBox();
    const revert = await banner.getByRole('button', { name: 'Revert 1 change' }).boundingBox();
    expect(revert?.y ?? 0).toBeGreaterThan((words?.y ?? 0) + (words?.height ?? 0) - 1);
    await checkA11y('settings general at 375px');
  });

  test('reverted: Revert puts the waiting change back to the running value, with an Undo toast', async ({
    page,
  }) => {
    await openGeneral(page);
    const banner = page.getByTestId('settings-restart-summary');
    const row = settingRow(page, 'engine.workflowClaimRenewInterval');
    const saved = await row.getByRole('spinbutton').inputValue();
    await banner.getByRole('button', { name: 'Revert 1 change' }).click();
    await expect(row.getByRole('status')).toContainText('Reverted, in effect now');
    // The host runs the 30 seconds it started with; the 15 it saved waited for a restart.
    await expect(row.getByRole('spinbutton')).toHaveValue('30');
    await expect(banner).toHaveCount(0);
    const toast = page.locator('.cinder-toast', {
      hasText: 'Reverted 1 change. Nothing needs a restart.',
    });
    await expect(toast.getByRole('button', { name: 'Undo' })).toBeVisible();
    await captureAtBothWidths(page, 'reverted');

    // Undo puts the sample world's saved change back for the specs that follow.
    await toast.getByRole('button', { name: 'Undo' }).click();
    await expect(row.getByRole('status')).toContainText('Saved, waiting for a restart');
    await expect(row.getByRole('spinbutton')).toHaveValue(saved);
  });

  test('saved: a switch saves as it changes, and its row says Saved just now', async ({ page }) => {
    await openGeneral(page);
    const row = settingRow(page, 'tools.wakeup');
    const toggle = row.getByRole('switch', { name: 'Wakeup' });
    const before = await toggle.getAttribute('aria-checked');
    try {
      await toggle.click();
      await expect(row.getByRole('status')).toContainText('Saved just now');
      await captureAtBothWidths(page, 'saved');
    } finally {
      if ((await toggle.getAttribute('aria-checked')) !== before) await toggle.click();
      await expect(row).toHaveAttribute('data-dirty', 'false');
    }
  });

  test('invalid value: a number past its limit fails at its field, with Nothing was saved', async ({
    page,
  }) => {
    await openGeneral(page);
    const row = settingRow(page, 'logs.maximumLinesPerRun');
    await row.getByRole('spinbutton').fill('9999');
    await settingRow(page, 'tools.wakeup').getByRole('switch').focus();
    await expect(row).toContainText(SETTINGS_COPY.nothingSaved);
    await expect(row.locator('[aria-invalid="true"]')).toHaveCount(1);
    await captureAtBothWidths(page, 'invalid-value');
  });

  test('save failed: the typed value stays in the field, with Try again', async ({
    page,
    pageErrors,
  }) => {
    pageErrors.expectEvery({
      pattern: /Failed to load resource|ERR_CONNECTION_FAILED|status of 5\d\d/,
      reason: 'the test refuses the save, so the request fails',
    });
    await openGeneral(page);
    await page.route('**/jsonrpc', async (route) => {
      const body = route.request().postDataJSON() as { method?: string } | null;
      if (body?.method === 'bureau.settings.update') {
        await route.abort('connectionfailed');
        return;
      }
      await route.continue();
    });
    const row = settingRow(page, 'logs.maximumLinesPerRun');
    await row.getByRole('spinbutton').fill('321');
    await settingRow(page, 'tools.wakeup').getByRole('switch').focus();
    await expect(row).toContainText(SETTINGS_COPY.couldNotSave);
    await expect(row.getByRole('button', { name: 'Try again' })).toBeVisible();
    await expect(row.getByRole('spinbutton')).toHaveValue('321');
    await captureAtBothWidths(page, 'save-failed');
  });

  test('locked, remote mode: the backend and what the deployment owns sit in a Remote deployment card', async ({
    page,
  }) => {
    await page.route('**/host/paths', async (route) => {
      const response = await route.fetch();
      const paths = (await response.json()) as Record<string, unknown>;
      await route.fulfill({
        response,
        json: {
          ...paths,
          mode: 'remote',
          database: { kind: 'postgres', location: 'db.internal:5432/interborough' },
          locked: { configuration: 'deployment', providerKeys: 'deployment' },
        },
      });
    });
    await page.route('**/jsonrpc', async (route) => {
      const body = route.request().postDataJSON() as { method?: string } | null;
      if (body?.method !== 'bureau.settings.get') {
        await route.continue();
        return;
      }
      const response = await route.fetch();
      const answer = (await response.json()) as {
        result: { keys: Record<string, { locked: boolean; lockReason?: string }> };
      };
      for (const key of [
        'durable',
        'engine.workflowClaimTtl',
        'engine.workflowClaimRenewInterval',
      ]) {
        const state = answer.result.keys[key];
        if (state !== undefined) {
          state.locked = true;
          state.lockReason = 'shared-storage';
        }
      }
      // The host locks the run cap for the deployment in remote mode (`host.ts`).
      const cap = answer.result.keys['engine.maxConcurrentRuns'];
      if (cap !== undefined) {
        cap.locked = true;
        cap.lockReason = 'deployment';
      }
      await route.fulfill({ response, json: answer });
    });
    await openGeneral(page);
    await expect(page.getByRole('heading', { level: 2, name: 'Remote deployment' })).toBeVisible();
    await expect(settingRow(page, 'storage.backend')).toContainText('Postgres and S3');
    await expect(settingRow(page, 'storage.backend')).toContainText('Set by the deployment');
    const locked = settingRow(page, 'engine.workflowClaimRenewInterval');
    await expect(locked).toContainText(SETTINGS_COPY.lockedMessage);
    await expect(locked.getByRole('spinbutton')).toBeDisabled();
    const cap = settingRow(page, 'engine.maxConcurrentRuns');
    await expect(cap).toContainText('The most workflow runs that execute at the same time.');
    await expect(cap).not.toContainText('on this machine');
    await expect(cap).toContainText(SETTINGS_COPY.lockedMessage);
    await expect(cap.getByRole('spinbutton')).toBeDisabled();
    await expect(cap.getByRole('spinbutton')).toHaveValue('4');
    await captureAtBothWidths(page, 'locked-remote');
  });

  test('load failed: with nothing to show, the full error state replaces the section, with Try again and no banner', async ({
    page,
    pageErrors,
  }) => {
    // The test answers every read of the settings with an error, and Chromium logs each one. How
    // many there are is not the test's to say: the view's probe and the page's own reads both ask.
    pageErrors.expectEvery({
      pattern: loggedFailedResponse(500, /\/bureau\/jsonrpc/),
      reason: 'the test answers the reads of the settings with a 500',
    });
    await page.route('**/jsonrpc', async (route) => {
      const body = route.request().postDataJSON() as { method?: string } | null;
      if (body?.method === 'bureau.settings.get' || body?.method === 'bureau.settings.schema') {
        await route.fulfill({ status: 500, json: { error: 'The server broke.' } });
        return;
      }
      await route.fallback();
    });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${E2E_SHOWCASE_URL}${ROUTE}`);

    const frame = page.locator('[data-view="settings"]');
    await expect(frame).toHaveAttribute('data-state', 'error');
    // The section's content is the error state; the navigation and the heading stay, as on Plugins.
    await expect(frame.getByRole('heading', { level: 1 })).toHaveText('General');
    await expect(
      frame.getByRole('navigation', { name: 'Settings sections' }).getByRole('link', {
        name: 'General',
        exact: true,
      }),
    ).toHaveAttribute('aria-current', 'page');
    await expect(frame.getByRole('heading', { level: 2 })).toHaveText(
      VIEW_COPY.settings.error.title,
    );
    await expect(frame.getByRole('button', { name: 'Try again' })).toBeVisible();
    // No rows, and no refresh banner beside it.
    await expect(settingRow(page, 'tools.wakeup')).toHaveCount(0);
    await expect(frame.getByRole('alert')).toHaveCount(1);
    await expect(page.getByTestId('settings-refresh-failed')).toHaveCount(0);
    await captureAtBothWidths(page, 'load-failed');
  });

  test('loading: the navigation and heading are real, the rows are placeholders after 300 ms, and Still loading follows at 10 s', async ({
    page,
  }) => {
    await page.clock.install();
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route('**/jsonrpc', async (route) => {
      const body = route.request().postDataJSON() as { method?: string } | null;
      if (body?.method === 'bureau.settings.get' || body?.method === 'bureau.settings.schema') {
        await held;
      }
      await route.continue();
    });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${E2E_SHOWCASE_URL}${ROUTE}`);
    await expect(page.getByRole('heading', { level: 1, name: 'General' })).toBeVisible();
    await expect(
      page
        .getByRole('navigation', { name: 'Settings sections' })
        .getByRole('link', { name: 'General' }),
    ).toBeVisible();
    await page.clock.runFor(400);
    await expect(page.locator('.cinder-skeleton-group')).toBeVisible();
    await captureAtBothWidths(page, 'loading');
    await page.clock.runFor(10_000);
    await expect(page.getByText(SETTINGS_COPY.general.loading.stillLoading)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Cancel' })).toBeVisible();
    await captureAtBothWidths(page, 'still-loading');
    release();
  });
});

/** The embedders, as the Bureau reports them to the Embedder row. */
type EmbeddingStatusFixture = {
  active: { embedder: string; dimension: number; model: string | null };
  problem: string | null;
  job: {
    target: string;
    state: 'running' | 'failed' | 'cancelled';
    done: number;
    total: number;
    error: string | null;
  } | null;
  embedders: { id: string; dimension: number; availability: 'available' | 'needs-setup' }[];
};

/** Memory on the built-in embedder with Gemini registered beside it, and nothing to report. */
function embeddingStatus(overrides: Partial<EmbeddingStatusFixture> = {}): EmbeddingStatusFixture {
  return {
    active: { embedder: 'hashing', dimension: 256, model: 'hashing' },
    problem: null,
    job: null,
    embedders: [
      { id: 'hashing', dimension: 256, availability: 'available' },
      { id: 'gemini:embedder', dimension: 768, availability: 'available' },
    ],
    ...overrides,
  };
}

/** A switch to Gemini in the state given. */
function geminiJob(
  state: 'running' | 'failed' | 'cancelled',
  error: string | null = null,
  done = 3,
): NonNullable<EmbeddingStatusFixture['job']> {
  return { target: 'gemini:embedder', state, done, total: 10, error };
}

/**
 * What the stubbed Bureau and host say of the embedding. Nothing here writes to the real
 * deployment: the status, the cancel and the write of `memory.embedder` are answered from this
 * object, and every other request goes on to the real one.
 */
type EmbeddingWorld = {
  status: EmbeddingStatusFixture;
  /** How the status read fails, or `hold` to leave it unanswered until `release` is called. */
  statusFault?: 'no-memory' | 'failed' | 'hold';
  /** What the write of `memory.embedder` does: start the switch, be refused, or never get an answer. */
  write: 'accept' | 'refuse' | 'unreachable';
  /** What the cancel does: cancel the switch, or never get an answer. */
  cancel: 'accept' | 'unreachable';
  /** Plugins the host lists in addition to its own. */
  plugin?: ReturnType<typeof pluginStanding>;
  /** The scopes the session holds; the host's own answer when left out. */
  scopes?: readonly string[];
  held: Promise<void>;
  release: () => void;
};

function embeddingWorld(overrides: Partial<EmbeddingWorld> = {}): EmbeddingWorld {
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    status: embeddingStatus(),
    write: 'accept',
    cancel: 'accept',
    plugin: pluginStanding('gemini', 'Gemini', { embedders: ['gemini:embedder'] }),
    held,
    release,
    ...overrides,
  };
}

/** A plugin as `GET /host/plugins` lists it. */
function pluginStanding(
  name: string,
  title: string,
  options: {
    status?: 'running' | 'needs-setup' | 'skipped';
    embedders?: readonly string[];
    secrets?: readonly { key: string; set: boolean }[];
  } = {},
) {
  return {
    descriptor: {
      name,
      title,
      version: '1.0.0',
      description: `The ${title} plugin.`,
      required: false,
      enabledByDefault: true,
    },
    source: 'package' as const,
    location: `@lostgradient/plugin-${name}`,
    status: options.status ?? ('running' as const),
    problems: [],
    contributions: (options.embedders ?? []).map((id) => ({
      kind: 'embedder',
      id,
      references: { agents: 0, schedules: 0, waitingRuns: 0 },
    })),
    enabled: true,
    configuration: {},
    configurationSchema: null,
    running: { enabled: true, configuration: {} },
    secrets: (options.secrets ?? []).map((secret) => ({
      key: secret.key,
      generated: false,
      set: secret.set,
      location: `/home/e2e/.interborough/secrets/${secret.key}`,
    })),
    restartRequired: false,
  };
}

const rpcResult = (id: unknown, result: unknown) => ({ jsonrpc: '2.0', id, result });
const rpcFault = (id: unknown, weftCode: string, httpStatus: number, message: string) => ({
  jsonrpc: '2.0',
  id,
  error: { code: -32000, message, data: { weftCode, httpStatus } },
});

/** Answers the embedding operations, the write of `memory.embedder`, the plugins and the session from `world`. */
async function stubEmbedding(page: Page, world: EmbeddingWorld): Promise<void> {
  await page.route('**/jsonrpc', async (route) => {
    const body = route.request().postDataJSON() as {
      id?: unknown;
      method?: string;
      params?: { patch?: Record<string, unknown> };
    } | null;
    const id = body?.id ?? null;
    if (body?.method === 'bureau.memory.embedding') {
      if (world.statusFault === 'hold') await world.held;
      if (world.statusFault === 'no-memory') {
        return route.fulfill({
          json: rpcFault(id, 'UnsupportedCapability', 501, 'This Bureau keeps no memory.'),
        });
      }
      if (world.statusFault === 'failed') {
        return route.fulfill({ json: rpcFault(id, 'Internal', 500, 'The server did not answer.') });
      }
      return route.fulfill({ json: rpcResult(id, world.status) });
    }
    if (body?.method === 'bureau.memory.embedding.cancel') {
      if (world.cancel === 'unreachable') return route.abort('connectionfailed');
      if (world.status.job !== null) world.status.job.state = 'cancelled';
      return route.fulfill({ json: rpcResult(id, { cancelled: true }) });
    }
    const target = body?.params?.patch?.['memory.embedder'];
    if (body?.method === 'bureau.settings.update' && typeof target === 'string') {
      if (world.write === 'unreachable') return route.abort('connectionfailed');
      if (world.write === 'refuse') {
        // Another switch, to a third embedder, started first: the Bureau refuses this one, and the
        // status says so.
        world.status.job = {
          target: 'ollama:embed',
          state: 'running',
          done: 1,
          total: 4,
          error: null,
        };
        return route.fulfill({
          json: rpcFault(id, 'InvalidParams', 400, 'A switch is already running.'),
        });
      }
      world.status.job = { ...geminiJob('running', null, 0), target };
      return route.fulfill({ json: rpcResult(id, { revision: 1_000_000, pendingRestart: [] }) });
    }
    return route.fallback();
  });
  const { plugin, scopes } = world;
  if (plugin !== undefined) {
    await page.route('**/host/plugins', async (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      const response = await route.fetch();
      const body = (await response.json()) as { plugins: { descriptor: { name: string } }[] };
      return route.fulfill({
        response,
        json: {
          ...body,
          plugins: [
            ...body.plugins.filter((entry) => entry.descriptor.name !== plugin.descriptor.name),
            plugin,
          ],
        },
      });
    });
  }
  if (scopes !== undefined) {
    await page.route('**/host/session', (route) =>
      route.fulfill({ json: { subject: 'reader', scopes } }),
    );
  }
}

const embedderRow = (page: Page) => settingRow(page, 'memory.embedder');
const picker = (page: Page) => embedderRow(page).getByRole('combobox');
const optionLabelled = (page: Page, label: string) =>
  page.getByRole('option').filter({ has: page.getByText(label, { exact: true }) });
const switchLine = (page: Page) => embedderRow(page).getByTestId('embedder-switch');
// The row's own paragraphs: a quiet action (a link, a button) sits in the same paragraph as the
// sentence it follows, so each is matched by its whole text, the action's words last.
const embedderDescription = (page: Page) =>
  embedderRow(page).locator('.cinder-form-field__description');
const embedderLoadError = (page: Page) => embedderRow(page).locator('.cinder-form-field__warning');
const embedderError = (page: Page) => embedderRow(page).locator('.cinder-form-field__error-text');

async function openEmbedder(page: Page, world: EmbeddingWorld): Promise<void> {
  await stubEmbedding(page, world);
  await openGeneral(page);
  await expect(embedderRow(page)).toBeVisible();
}

/** The embedder's row has read the embedders, so its picker can be used. */
const embedderReady = (page: Page) => expect(picker(page)).toBeEnabled();

/** Leaves the picker's list open, whatever a resize or a scroll did to it. */
async function showPickerOpen(page: Page): Promise<void> {
  await picker(page).scrollIntoViewIfNeeded();
  await picker(page).press('Escape');
  await expect(picker(page)).toHaveAttribute('aria-expanded', 'false');
  await picker(page).click();
  await expect(picker(page)).toHaveAttribute('aria-expanded', 'true');
}

/** Captures an Embedder state at the two widths the design draws it at, and at 320 by 640 as the capture adds. */
async function captureEmbedder(page: Page, state: string, ready?: (page: Page) => Promise<void>) {
  for (const width of [1280, 375] as const) {
    await page.setViewportSize({ width, height: 900 });
    await ready?.(page);
    await captureForDesignReview(page, { route: ROUTE, state, source: SOURCE, ready });
  }
  await page.setViewportSize({ width: 1280, height: 900 });
}

const failedReads = {
  pattern: /Failed to load resource|ERR_CONNECTION_FAILED|status of 5\d\d/,
  reason: 'the test leaves a request of the Embedder row unanswered',
} as const;

test.describe('Settings › General, the Embedder row', () => {
  test('embedder-ready: a picker of the embedders in words, and nothing else on the row', async ({
    page,
    checkA11y,
  }) => {
    await openEmbedder(page, embeddingWorld());
    await embedderReady(page);

    await expect(picker(page)).toContainText('Text hashing');
    await expect(embedderRow(page).getByRole('textbox')).toHaveCount(0);
    // No dot, bar, panel or line: only the label, identifier, description and picker.
    await expect(embedderRow(page).getByRole('img')).toHaveCount(0);
    await expect(embedderRow(page).getByRole('progressbar')).toHaveCount(0);
    await expect(switchLine(page)).toHaveCount(0);
    await expect(embedderRow(page).getByText('memory.embedder', { exact: true })).toBeVisible();
    await checkA11y('settings general embedder ready at 1280px');
    await captureEmbedder(page, 'embedder-ready');
  });

  test('embedder-picker-open: the built-in embedder, one that needs setup and the one in use that is not loaded', async ({
    page,
    checkA11y,
  }) => {
    const world = embeddingWorld({
      status: embeddingStatus({
        active: { embedder: 'ollama:embed', dimension: 4, model: 'm' },
        problem: 'embedder-unavailable',
        embedders: [
          { id: 'hashing', dimension: 256, availability: 'available' },
          { id: 'gemini:embedder', dimension: 768, availability: 'needs-setup' },
        ],
      }),
      plugin: pluginStanding('gemini', 'Gemini', {
        status: 'needs-setup',
        embedders: ['gemini:embedder'],
        secrets: [{ key: 'gemini-api-key', set: false }],
      }),
    });
    await openEmbedder(page, world);
    await expect(picker(page)).toContainText('Ollama');
    await showPickerOpen(page);

    await expect(optionLabelled(page, 'Text hashing, built in')).toBeVisible();
    const gemini = optionLabelled(page, 'Gemini');
    await expect(gemini).toHaveAttribute('aria-disabled', 'true');
    await expect(gemini.getByText('Needs setup', { exact: true })).toBeVisible();
    await expect(
      gemini.getByText('Save its key in Settings › Plugins first.', { exact: true }),
    ).toBeVisible();
    const ollama = optionLabelled(page, 'Ollama');
    await expect(ollama.getByText('Not loaded', { exact: true })).toBeVisible();
    await checkA11y('settings general embedder picker open at 1280px');
    await captureEmbedder(page, 'embedder-picker-open', showPickerOpen);
  });

  test('embedder-one: with one embedder registered, the picker holds it and the description names it and links to Plugins', async ({
    page,
  }) => {
    const world = embeddingWorld({
      status: embeddingStatus({
        embedders: [{ id: 'hashing', dimension: 256, availability: 'available' }],
      }),
    });
    await openEmbedder(page, world);

    await expect(embedderDescription(page)).toHaveText(
      'Text hashing is the only embedder. Plugins can add others. Open Plugins',
    );
    await expect(embedderRow(page).getByRole('link', { name: 'Open Plugins' })).toHaveAttribute(
      'href',
      '/settings/plugins',
    );
    await expect(picker(page)).toContainText('Text hashing');
    await captureEmbedder(page, 'embedder-one');
  });

  test('embedder-no-memory: the row stays, with its picker disabled and empty and the reason in the description', async ({
    page,
  }) => {
    await openEmbedder(page, embeddingWorld({ statusFault: 'no-memory' }));

    await expect(embedderDescription(page)).toHaveText(
      'This home keeps no memory, so there is nothing to embed.',
    );
    await expect(picker(page)).toBeDisabled();
    await expect(picker(page)).not.toContainText('Text hashing');
    await captureEmbedder(page, 'embedder-no-memory');
  });

  test('embedder-loading: while the embedders are read, the picker is disabled on its current value', async ({
    page,
  }) => {
    const world = embeddingWorld({ statusFault: 'hold' });
    await stubEmbedding(page, world);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${E2E_SHOWCASE_URL}${ROUTE}`);
    await expect(embedderRow(page)).toBeVisible();

    await expect(picker(page)).toBeDisabled();
    await expect(picker(page)).toContainText('Text hashing');
    await expect(embedderRow(page).getByRole('progressbar')).toHaveCount(0);
    await captureEmbedder(page, 'embedder-loading');
    world.release();
    await embedderReady(page);
  });

  test('embedder-load-failed: the row says the embedders could not be loaded, with Try again, and the page stays usable', async ({
    page,
  }) => {
    const world = embeddingWorld({ statusFault: 'failed' });
    await openEmbedder(page, world);

    await expect(embedderLoadError(page)).toHaveText('Couldn’t load the embedders. Try again');
    await expect(picker(page)).toBeDisabled();
    await expect(settingRow(page, 'tools.wakeup').getByRole('switch')).toBeEnabled();
    await captureEmbedder(page, 'embedder-load-failed');
    delete world.statusFault;
    await embedderRow(page).getByRole('button', { name: 'Try again' }).click();
    await embedderReady(page);
  });

  test('embedder-switch-confirm: picking another embedder asks first, and Keep leaves the picker as it was', async ({
    page,
    checkA11y,
  }) => {
    await openEmbedder(page, embeddingWorld());
    await embedderReady(page);
    await showPickerOpen(page);
    await optionLabelled(page, 'Gemini').click();

    const dialog = page.getByRole('dialog', { name: 'Switch memory search to Gemini?' });
    await expect(dialog).toContainText(
      'Interborough embeds every stored memory again with Gemini. Search keeps using Text hashing until all of them are done, and you can cancel at any point. A paid embedder charges for each memory it embeds.',
    );
    await expect(dialog.getByRole('button', { name: 'Switch embedder' })).toBeVisible();
    await checkA11y('settings general embedder switch confirm at 1280px');
    await captureEmbedder(page, 'embedder-switch-confirm');

    await dialog.getByRole('button', { name: 'Keep Text hashing' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(picker(page)).toContainText('Text hashing');
  });

  test('embedder-save-refused: a switch the Bureau refuses says why on the row, with no retry', async ({
    page,
  }) => {
    await openEmbedder(page, embeddingWorld({ write: 'refuse' }));
    await embedderReady(page);
    await showPickerOpen(page);
    await optionLabelled(page, 'Gemini').click();
    await page
      .getByRole('dialog', { name: 'Switch memory search to Gemini?' })
      .getByRole('button', { name: 'Switch embedder' })
      .click();

    await expect(embedderError(page)).toHaveText(
      'Couldn’t switch to Gemini: another switch is already running. Nothing changed.',
    );
    await expect(embedderRow(page).getByRole('button', { name: 'Try again' })).toHaveCount(0);
    await captureEmbedder(page, 'embedder-save-refused');
  });

  test('embedder-save-refused: a switch that gets no answer offers Try again, and the second try goes through', async ({
    page,
    pageErrors,
  }) => {
    pageErrors.expectEvery(failedReads);
    const world = embeddingWorld({ write: 'unreachable' });
    await openEmbedder(page, world);
    await embedderReady(page);
    await showPickerOpen(page);
    await optionLabelled(page, 'Gemini').click();
    await page
      .getByRole('dialog', { name: 'Switch memory search to Gemini?' })
      .getByRole('button', { name: 'Switch embedder' })
      .click();

    await expect(embedderError(page)).toHaveText(
      'Couldn’t switch to Gemini: Interborough didn’t answer. Nothing changed.',
    );
    world.write = 'accept';
    await embedderRow(page).getByRole('button', { name: 'Try again' }).click();
    await expect(switchLine(page)).toBeVisible();
  });

  test('embedder-switching: the Running word and the count over a bar with Cancel switch on its row', async ({
    page,
    checkA11y,
  }) => {
    await openEmbedder(
      page,
      embeddingWorld({ status: embeddingStatus({ job: geminiJob('running') }) }),
    );

    const line = switchLine(page);
    await expect(line.getByRole('img', { name: 'Running' })).toBeVisible();
    await expect(
      line.getByText('Switch to Gemini, 3 of 10 memories', { exact: true }),
    ).toBeVisible();
    const bar = line.getByRole('progressbar');
    await expect(bar).toHaveAttribute('aria-valuenow', '3');
    await expect(bar).toHaveAttribute('aria-valuemax', '10');
    await expect(picker(page)).toBeDisabled();
    // Nothing else states the switch: the row's own save line is empty and no toast shows.
    await expect(embedderRow(page).getByRole('status')).toHaveCount(0);
    await expect(page.locator('.cinder-toast')).toHaveCount(0);
    await checkA11y('settings general embedder switching at 1280px');
    await captureEmbedder(page, 'embedder-switching');
  });

  test('embedder-cancel-confirm: Cancel switch asks first, in the danger style, and Keep switching changes nothing', async ({
    page,
  }) => {
    await openEmbedder(
      page,
      embeddingWorld({ status: embeddingStatus({ job: geminiJob('running') }) }),
    );
    await switchLine(page).getByRole('button', { name: 'Cancel switch' }).click();

    const dialog = page.getByRole('dialog', { name: 'Cancel the switch to Gemini?' });
    await expect(dialog).toContainText(
      'The 3 memories embedded so far are thrown away. Search keeps using Text hashing, and nothing else changes.',
    );
    await expect(dialog.getByRole('button', { name: 'Cancel switch' })).toHaveAttribute(
      'data-cinder-variant',
      'danger',
    );
    await captureEmbedder(page, 'embedder-cancel-confirm');
    await dialog.getByRole('button', { name: 'Keep switching' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(switchLine(page).getByRole('img', { name: 'Running' })).toBeVisible();
  });

  test('embedder-cancel-failed: a cancel the Bureau does not answer keeps the dialog open, and can be pressed again', async ({
    page,
    pageErrors,
  }) => {
    pageErrors.expectEvery(failedReads);
    const world = embeddingWorld({
      status: embeddingStatus({ job: geminiJob('running') }),
      cancel: 'unreachable',
    });
    await openEmbedder(page, world);
    await switchLine(page).getByRole('button', { name: 'Cancel switch' }).click();
    const dialog = page.getByRole('dialog', { name: 'Cancel the switch to Gemini?' });
    await dialog.getByRole('button', { name: 'Cancel switch' }).click();

    await expect(dialog.getByText('Couldn’t cancel the switch.', { exact: true })).toBeVisible();
    // The reason follows the bold lead in the same callout.
    await expect(dialog.locator('.cinder-confirm-dialog__error')).toHaveText(
      'Couldn’t cancel the switch. Interborough didn’t answer. The switch is still running.',
    );
    await expect(dialog.getByRole('button', { name: 'Cancel switch' })).toBeEnabled();
    await captureEmbedder(page, 'embedder-cancel-failed');
    world.cancel = 'accept';
    await dialog.getByRole('button', { name: 'Cancel switch' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(switchLine(page).getByRole('img', { name: 'Canceled' })).toBeVisible();
  });

  test('embedder-canceled: the picker holds the embedder in use while the setting names the other, and the line has no button', async ({
    page,
  }) => {
    await openEmbedder(
      page,
      embeddingWorld({ status: embeddingStatus({ job: geminiJob('cancelled') }) }),
    );

    const line = switchLine(page);
    await expect(line.getByRole('img', { name: 'Canceled' })).toBeVisible();
    await expect(
      line.getByText('You canceled the switch to Gemini. Search still uses Text hashing.', {
        exact: true,
      }),
    ).toBeVisible();
    await expect(line.getByRole('button')).toHaveCount(0);
    await expect(picker(page)).toContainText('Text hashing');
    await expect(picker(page)).toBeEnabled();
    await captureEmbedder(page, 'embedder-canceled');
  });

  test('embedder-failed: the Failed word, the cause in words and Retry switch, which asks again', async ({
    page,
  }) => {
    const world = embeddingWorld({
      status: embeddingStatus({ job: geminiJob('failed', 'embedder-timeout') }),
    });
    await openEmbedder(page, world);

    const line = switchLine(page);
    await expect(line.getByRole('img', { name: 'Failed' })).toBeVisible();
    await expect(
      line.getByText(
        'The switch to Gemini failed: Gemini took too long to answer. Search still uses Text hashing.',
        { exact: true },
      ),
    ).toBeVisible();
    await captureEmbedder(page, 'embedder-failed');
    await line.getByRole('button', { name: 'Retry switch' }).click();
    const dialog = page.getByRole('dialog', { name: 'Switch memory search to Gemini?' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Keep Text hashing' }).click();

    // A code the page has no words for says the switch stopped, with the code in monospace.
    world.status = embeddingStatus({ job: geminiJob('failed', 'quota-exceeded') });
    await page.reload();
    await expect(
      line.getByText(
        'The switch to Gemini failed: Gemini stopped the switch (quota-exceeded). Search still uses Text hashing.',
        { exact: true },
      ),
    ).toBeVisible();
    await expect(line.getByText('quota-exceeded', { exact: true })).toHaveCSS(
      'font-family',
      /mono/i,
    );
  });

  test('embedder-not-loaded: the embedder in use is named in words with Not loaded, and the row links to its plugin', async ({
    page,
  }) => {
    const world = embeddingWorld({
      status: embeddingStatus({
        active: { embedder: 'gemini:embedder', dimension: 768, model: 'm' },
        problem: 'embedder-unavailable',
        embedders: [{ id: 'hashing', dimension: 256, availability: 'available' }],
      }),
      plugin: pluginStanding('gemini', 'Gemini', { status: 'skipped' }),
    });
    await openEmbedder(page, world);

    await expect(embedderDescription(page)).toHaveText(
      'Gemini isn’t loaded, so memory search matches words only until it’s back or you switch embedders. Open Gemini in Settings',
    );
    await expect(picker(page)).toContainText('Gemini');
    await expect(
      embedderRow(page).getByRole('link', { name: 'Open Gemini in Settings' }),
    ).toHaveAttribute('href', '/settings/plugins?plugin=gemini');
    await showPickerOpen(page);
    await expect(
      optionLabelled(page, 'Gemini').getByText('Not loaded', { exact: true }),
    ).toBeVisible();
    await captureEmbedder(page, 'embedder-not-loaded', showPickerOpen);
  });

  test('embedder-needs-setup: the embedder in use needs its key, and Add the key opens the existing dialog', async ({
    page,
  }) => {
    const world = embeddingWorld({
      status: embeddingStatus({
        active: { embedder: 'gemini:embedder', dimension: 768, model: 'm' },
        problem: 'embedder-unavailable',
        embedders: [
          { id: 'hashing', dimension: 256, availability: 'available' },
          { id: 'gemini:embedder', dimension: 768, availability: 'needs-setup' },
        ],
      }),
      plugin: pluginStanding('gemini', 'Gemini', {
        status: 'needs-setup',
        embedders: ['gemini:embedder'],
        secrets: [{ key: 'gemini-api-key', set: false }],
      }),
    });
    await openEmbedder(page, world);

    await expect(embedderDescription(page)).toHaveText(
      'Gemini needs its key, so memory search matches words only until it’s saved. Add the key',
    );
    await captureEmbedder(page, 'embedder-needs-setup');
    await embedderRow(page).getByRole('button', { name: 'Add the key' }).click();
    await expect(page.getByRole('dialog', { name: 'Save gemini-api-key' })).toBeVisible();
  });

  test('embedder-dimension-changed: the vectors are another size, and Embed again asks to embed every memory again', async ({
    page,
  }) => {
    const world = embeddingWorld({
      status: embeddingStatus({
        active: { embedder: 'gemini:embedder', dimension: 768, model: 'm' },
        problem: 'embedder-unavailable',
        embedders: [
          { id: 'hashing', dimension: 256, availability: 'available' },
          { id: 'gemini:embedder', dimension: 1536, availability: 'available' },
        ],
      }),
    });
    await openEmbedder(page, world);

    await expect(embedderDescription(page)).toHaveText(
      'Gemini now makes vectors of another size than your memories were made with, so search matches words only. Embed again',
    );
    await captureEmbedder(page, 'embedder-dimension-changed');
    await embedderRow(page).getByRole('button', { name: 'Embed again' }).click();
    const dialog = page.getByRole('dialog', { name: 'Embed every memory again with Gemini?' });
    await expect(dialog.getByRole('button', { name: 'Embed again' })).toBeVisible();
    await captureEmbedder(page, 'embedder-dimension-changed-embed-again');
  });

  test('embedder-model-changed: the model changed at the same size, with Embed again', async ({
    page,
  }) => {
    const world = embeddingWorld({
      status: embeddingStatus({
        active: { embedder: 'gemini:embedder', dimension: 768, model: 'm' },
        problem: 'embedder-unavailable',
      }),
    });
    await openEmbedder(page, world);

    await expect(embedderDescription(page)).toHaveText(
      'Gemini now runs another model than your memories were made with, so search matches words only. Embed again',
    );
    await expect(embedderRow(page).getByRole('button', { name: 'Embed again' })).toBeVisible();
    await captureEmbedder(page, 'embedder-model-changed');
  });

  test('embedder-read-only: a caller that cannot change settings sees the picker held, with no Cancel switch or Retry switch', async ({
    page,
  }) => {
    const world = embeddingWorld({
      status: embeddingStatus({ job: geminiJob('running') }),
      scopes: API_SCOPES.filter((scope) => scope !== 'settings:write'),
    });
    await openEmbedder(page, world);

    await expect(
      embedderRow(page).getByText(SETTINGS_COPY.forbidden, { exact: true }),
    ).toBeVisible();
    await expect(picker(page)).toBeDisabled();
    await expect(switchLine(page).getByRole('img', { name: 'Running' })).toBeVisible();
    await expect(embedderRow(page).getByRole('button', { name: 'Cancel switch' })).toHaveCount(0);
    world.status = embeddingStatus({ job: geminiJob('failed', 'embedder-failed') });
    await page.reload();
    await expect(switchLine(page).getByRole('img', { name: 'Failed' })).toBeVisible();
    await expect(embedderRow(page).getByRole('button', { name: 'Retry switch' })).toHaveCount(0);
    await captureEmbedder(page, 'embedder-read-only');
  });
});

test.describe('Settings › General, the Embedder row on a phone', () => {
  test.use({ viewport: { width: 320, height: 640 }, hasTouch: true });

  test('embedder-switching: the dot starts at the label’s edge, the bar and Cancel switch share a row, and Cancel switch is at most 36 pixels tall with a 44 by 44 hit area', async ({
    page,
  }) => {
    await stubEmbedding(
      page,
      embeddingWorld({ status: embeddingStatus({ job: geminiJob('running') }) }),
    );
    await page.goto(`${E2E_SHOWCASE_URL}${ROUTE}`);
    await expect(embedderRow(page)).toBeVisible();

    const line = switchLine(page);
    const dot = line.getByRole('img', { name: 'Running' });
    const label = embedderRow(page).locator('.cinder-form-field__label-row');
    const bar = line.getByRole('progressbar');
    const cancel = line.getByRole('button', { name: 'Cancel switch' });
    // Scrolled into the viewport and settled, since the hit test below is made in viewport coordinates.
    await cancel.scrollIntoViewIfNeeded();
    await expect(cancel).toBeInViewport();
    const boxes = await readBoxes(page, { dot, label, bar, cancel });
    expect(Math.abs(boxes.dot.x - boxes.label.x)).toBeLessThanOrEqual(2);
    // One row: the bar's vertical middle lies within the button's height.
    const barMiddle = boxes.bar.y + boxes.bar.height / 2;
    expect(barMiddle).toBeGreaterThanOrEqual(boxes.cancel.y);
    expect(barMiddle).toBeLessThanOrEqual(boxes.cancel.y + boxes.cancel.height);
    expect(boxes.cancel.height).toBeLessThanOrEqual(36);
    // The touch target around the button is at least 44 by 44: a press 21 pixels off its middle
    // on each axis still lands on the button.
    const middleX = boxes.cancel.x + boxes.cancel.width / 2;
    const middleY = boxes.cancel.y + boxes.cancel.height / 2;
    for (const [offsetX, offsetY] of [
      [0, -21],
      [0, 21],
      [-21, 0],
      [21, 0],
    ] as const) {
      const lands = await page.evaluate(
        ([x, y]) => {
          const hit = document.elementFromPoint(x as number, y as number);
          return hit?.closest('button')?.textContent?.trim() ?? null;
        },
        [middleX + offsetX, middleY + offsetY],
      );
      expect(lands).toBe('Cancel switch');
    }
  });
});
