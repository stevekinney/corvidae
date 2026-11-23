/**
 * The workflow builder's step cards for the design review (COR-2247, COR-2248): one workflow with a
 * step of every kind the builder draws (a code workflow with a form from its schema, a wait with a
 * limit, a path chosen by a value with a path nested in it, steps side by side, and steps repeated
 * for each item), in each state the cards have: the data, empty lists that are problems to fix, the
 * catalog still loading, the catalog failing, the add menu open, and the read-only phone.
 *
 * The seeded host serves the catalog (`bureau.workflows.catalog`) itself: its only activity is the
 * built-in `agent`, and its one code workflow is the demo plugin's `demo:echo-input`. Only the two
 * scenes that hold or refuse the read touch it, so a card for a plugin's activity, which the demo
 * plugin does not provide, is drawn there from a handler no plugin has to answer for.
 * These scenes only capture: the assertions on each card are in
 * `src/routes/workflow-definitions/workflow-builder-cards.test.ts`.
 */
import type { Page, Route } from '@playwright/test';

import { designReviewCaptureDirectory } from '../../scripts/environment-configuration.ts';
import { WORKFLOW_COPY } from '../../src/app/copy/workflows.ts';
import { captureForDesignReview } from './design-review-capture.ts';
import { expect, loggedFailedResponse, test } from './fixtures.ts';
import { jsonEditor, replaceJsonEditorText } from './json-editor-support.ts';
import { readBoxes } from './read-boxes.ts';
import { openJsonTab, openTab } from './workflow-support.ts';

const BUILDER = WORKFLOW_COPY.builder;
const WIDTHS = designReviewCaptureDirectory() === undefined ? [1280, 375] : [1280, 768, 375];
/** Below this the builder is read-only (`PHONE_VIEWPORT_BREAKPOINT`). */
const PHONE_BELOW = 640;

/** The step of a plugin's activity, which the scenes that hold or refuse the catalog draw. */
const ACTIVITY_STEP = {
  title: 'Echo what came in',
  kind: 'activity',
  handler: 'demo:echo-text',
  input: { text: 'Hello' },
};

/** The step of the demo plugin's code workflow, whose form the seeded host's catalog draws. */
const WORKFLOW_STEP = {
  title: 'Echo what came in',
  kind: 'workflow',
  workflow: 'demo:echo-input',
  input: { message: 'Hello' },
};

/** The other kinds of step, a branch inside a branch included. */
const OTHER_KINDS = [
  { kind: 'await-signal', signal: 'review-1', review: true, timeout: '2h' },
  {
    kind: 'branch',
    on: 'status',
    cases: {
      approved: [
        {
          kind: 'branch',
          on: 'region',
          cases: { north: [{ kind: 'await-signal', signal: 'north-ready' }] },
        },
      ],
      rejected: [],
    },
    otherwise: [{ kind: 'sleep', duration: '1m' }],
  },
  {
    kind: 'parallel',
    branches: {
      notify: [
        {
          kind: 'activity',
          handler: 'agent',
          input: { agent: 'assistant', message: 'Tell them.' },
        },
      ],
      log: [{ kind: 'sleep', duration: '5s' }],
    },
  },
  { kind: 'map', over: 'files', concurrency: 2, steps: [{ kind: 'sleep', duration: '1s' }] },
];

/** A workflow with one step of every kind the seeded host provides. */
const EVERY_KIND = {
  name: 'e2e-cards',
  title: 'Every kind of step',
  trigger: { kind: 'manual' },
  steps: [WORKFLOW_STEP, ...OTHER_KINDS],
};

/** The same, with a plugin's activity first, for the scenes the catalog does not answer. */
const EVERY_KIND_WITH_ACTIVITY = { ...EVERY_KIND, steps: [ACTIVITY_STEP, ...OTHER_KINDS] };

/** Empty lists the engine would refuse: each one is a problem the page says at its own Add a step. */
const EMPTY_LISTS = {
  name: 'e2e-empty-cards',
  trigger: { kind: 'manual' },
  steps: [
    { kind: 'branch', on: '', cases: {} },
    { kind: 'parallel', branches: { notify: [], log: [] } },
    { kind: 'map', over: '', steps: [] },
  ],
};

/** Holds the read of the catalog until the scene lets it go, or refuses it. */
async function holdCatalog(page: Page): Promise<Route[]> {
  const held: Route[] = [];
  await page.route('**/jsonrpc', async (route) => {
    if ((route.request().postData() ?? '').includes('bureau.workflows.catalog')) {
      held.push(route);
      return;
    }
    await route.fallback();
  });
  return held;
}

async function refuseCatalog(page: Page): Promise<void> {
  await page.route('**/jsonrpc', async (route) => {
    if ((route.request().postData() ?? '').includes('bureau.workflows.catalog')) {
      await route.fulfill({ status: 400, json: { error: { message: 'No such operation.' } } });
      return;
    }
    await route.fallback();
  });
}

/**
 * Opens a new workflow on the Builder tab holding `document`, at the width the page is set to. Below
 * 640 pixels the builder and the JSON tab are read-only, so a document cannot be typed there: it is
 * typed at a desktop width and the page is then narrowed, as a person who opens the draft on a phone
 * sees it.
 */
async function openWith(page: Page, document: unknown): Promise<void> {
  const size = page.viewportSize() ?? { width: 1280, height: 900 };
  if (size.width < PHONE_BELOW) await page.setViewportSize({ width: 1280, height: size.height });
  await page.goto('/workflows/new');
  await expect(page.locator('[data-view="workflows"]')).toHaveAttribute('data-state', 'ready');
  const root = page.locator('[data-page="workflow-creator"]');
  await openJsonTab(root);
  const json = await jsonEditor(root, WORKFLOW_COPY.creator.textLabel);
  await replaceJsonEditorText(json, JSON.stringify(document, null, 2));
  if (size.width < PHONE_BELOW) {
    await page.setViewportSize(size);
    await expect(root.locator('.weft-workflow-builder__read-only')).toHaveText(BUILDER.readOnly);
  }
  await openTab(root, BUILDER.builderTab);
}

for (const width of WIDTHS) {
  test.describe(`the workflow builder's step cards at ${width} pixels`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
    });

    test(`workflow builder cards: a step of every kind, from the catalog, at ${width} pixels`, async ({
      page,
      checkA11y,
    }) => {
      await openWith(page, EVERY_KIND);
      const root = page.locator('[data-page="workflow-creator"]');
      await expect(
        root.locator('[data-step-kind="workflow"] .cinder-schema-form').first(),
      ).toBeVisible();
      await expect(root.locator('[data-step-kind="map"]')).toBeVisible();
      await captureForDesignReview(page, {
        route: '/workflows/new (step cards)',
        state: 'ready',
        source: 'workflow-builder-cards.spec.ts',
      });
      await checkA11y(`the step cards at ${width}px`);
    });

    test(`workflow builder cards: empty lists are problems at their own Add a step, at ${width} pixels`, async ({
      page,
    }) => {
      await openWith(page, EMPTY_LISTS);
      const root = page.locator('[data-page="workflow-creator"]');
      if (width > 640) {
        await root.getByRole('button', { name: WORKFLOW_COPY.creator.saveAction }).click();
        await expect(root.getByTestId('workflow-builder-problems')).toBeVisible();
      }
      await captureForDesignReview(page, {
        route: '/workflows/new (step cards)',
        state: 'empty',
        source: 'workflow-builder-cards.spec.ts',
      });
    });

    test(`workflow builder cards: the catalog loading, at ${width} pixels`, async ({ page }) => {
      const held = await holdCatalog(page);
      await openWith(page, EVERY_KIND_WITH_ACTIVITY);
      const root = page.locator('[data-page="workflow-creator"]');
      await expect(root.getByTestId('step-activity-loading').first()).toBeVisible();
      await captureForDesignReview(page, {
        route: '/workflows/new (step cards)',
        state: 'loading',
        source: 'workflow-builder-cards.spec.ts',
      });
      // The held read goes on to the host, which answers it: a request the page loses logs an error.
      for (const route of held) await route.continue();
    });

    test(`workflow builder cards: the catalog failing, at ${width} pixels`, async ({
      page,
      pageErrors,
    }) => {
      pageErrors.expectEvery({
        pattern: loggedFailedResponse(400, /\/jsonrpc/),
        reason: 'the scene refuses the read of the catalog',
      });
      await refuseCatalog(page);
      await openWith(page, EVERY_KIND_WITH_ACTIVITY);
      const root = page.locator('[data-page="workflow-creator"]');
      await expect(root.getByTestId('step-activity-error').first()).toBeVisible();
      await captureForDesignReview(page, {
        route: '/workflows/new (step cards)',
        state: 'error',
        source: 'workflow-builder-cards.spec.ts',
      });
    });
  });
}

test.describe('the workflow builder’s add menu', () => {
  test('workflow builder cards: the add menu lists the catalog by title, at 1280 pixels', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await openWith(page, EVERY_KIND);
    const root = page.locator('[data-page="workflow-creator"]');
    await root.locator('#workflow-builder-add').click();
    await expect(page.getByRole('menuitem', { name: 'Echo the input' })).toBeVisible();
    await captureForDesignReview(page, {
      route: '/workflows/new (add a step menu)',
      state: 'ready',
      source: 'workflow-builder-cards.spec.ts',
    });
  });
});

/**
 * A catalog the seeded host does not have: a code workflow whose input holds an object, and one that
 * declares no schema. The demo plugin contributes neither, so these scenes answer the read.
 */
async function answerCatalog(page: Page): Promise<void> {
  await page.route('**/jsonrpc', async (route) => {
    const body = route.request().postData() ?? '';
    if (!body.includes('bureau.workflows.catalog')) {
      await route.fallback();
      return;
    }
    const id = (JSON.parse(body) as { id?: unknown }).id ?? null;
    await route.fulfill({
      json: {
        jsonrpc: '2.0',
        id,
        result: {
          stepKinds: [],
          triggers: [],
          activities: [],
          workflows: [
            {
              id: 'demo:profile',
              name: 'profile',
              title: 'Update a profile',
              inputSchema: {
                type: 'object',
                properties: {
                  owner: {
                    type: 'object',
                    title: 'Owner',
                    properties: {
                      name: { type: 'string', title: 'Name' },
                      email: { type: 'string', title: 'Email' },
                    },
                  },
                  notify: { type: 'boolean', title: 'Notify' },
                },
                required: ['owner'],
              },
            },
            { id: 'demo:bare', name: 'bare', title: 'Run without input', inputSchema: null },
          ],
        },
      },
    });
  });
}

/** A first step that needs no catalog, so a menu that opens is what asks for it. */
const SLEEP_ONLY = {
  name: 'e2e-menu',
  trigger: { kind: 'manual' },
  steps: [{ kind: 'sleep', duration: '1m' }],
};

test.describe('the workflow builder’s nested and missing states', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
  });

  test('workflow builder cards: two steps in one case draw a Move button inside the case, at 1280 pixels', async ({
    page,
  }) => {
    await openWith(page, {
      name: 'e2e-nested-move',
      trigger: { kind: 'manual' },
      steps: [
        {
          kind: 'branch',
          on: 'status',
          cases: {
            approved: [
              { kind: 'await-signal', signal: 'first' },
              { kind: 'await-signal', signal: 'second' },
            ],
          },
        },
      ],
    });
    const root = page.locator('[data-page="workflow-creator"]');
    await expect(
      root.getByRole('button', {
        name: BUILDER.moveLater(
          BUILDER.where.nested(1, BUILDER.where.caseOf('approved', BUILDER.where.step(1))),
        ),
      }),
    ).toBeVisible();
    await captureForDesignReview(page, {
      route: '/workflows/new (step cards)',
      state: 'nested-move',
      source: 'workflow-builder-cards.spec.ts',
    });
  });

  test('workflow builder cards: an object-typed input draws a nested group, and a workflow with no schema says so, at 1280 pixels', async ({
    page,
  }) => {
    await answerCatalog(page);
    await openWith(page, {
      name: 'e2e-schemas',
      trigger: { kind: 'manual' },
      steps: [
        { kind: 'workflow', workflow: 'demo:profile', input: { owner: { name: 'Ada' } } },
        { kind: 'workflow', workflow: 'demo:bare', input: { raw: [1, 2] } },
      ],
    });
    const root = page.locator('[data-page="workflow-creator"]');
    await expect(
      root.locator('[data-step-kind="workflow"] .cinder-schema-form').first(),
    ).toBeVisible();
    await expect(root.getByTestId('step-input-note').first()).toBeVisible();
    await captureForDesignReview(page, {
      route: '/workflows/new (step cards)',
      state: 'nested-schema',
      source: 'workflow-builder-cards.spec.ts',
    });
  });

  test('workflow builder cards: replacing edited workflow input asks first, at 1280 pixels', async ({
    page,
  }) => {
    await answerCatalog(page);
    await openWith(page, {
      name: 'e2e-replace-input',
      trigger: { kind: 'manual' },
      steps: [{ kind: 'workflow', workflow: 'demo:profile', input: { owner: { name: 'Ada' } } }],
    });
    const root = page.locator('[data-page="workflow-creator"]');
    await root
      .getByRole('combobox', { name: BUILDER.workflowCard.label(BUILDER.where.step(1)) })
      .selectOption('demo:bare');
    await expect(
      page.getByRole('dialog', { name: BUILDER.workflowCard.replaceInput.title }),
    ).toBeVisible();
    await captureForDesignReview(page, {
      route: '/workflows/new (step cards)',
      state: 'replace edited workflow input',
      source: 'workflow-builder-cards.spec.ts',
    });
  });

  test('workflow builder cards: the add menu while the catalog loads, at 1280 pixels', async ({
    page,
  }) => {
    const held = await holdCatalog(page);
    await openWith(page, SLEEP_ONLY);
    const root = page.locator('[data-page="workflow-creator"]');
    await root.locator('#workflow-builder-add').click();
    await expect(
      page.getByRole('menuitem', { name: BUILDER.addMenu.loadingActivities }),
    ).toBeVisible();
    await captureForDesignReview(page, {
      route: '/workflows/new (add a step menu)',
      state: 'loading',
      source: 'workflow-builder-cards.spec.ts',
    });
    for (const route of held) await route.continue();
  });

  test('workflow builder cards: the add menu after the catalog failed, at 1280 pixels', async ({
    page,
    pageErrors,
  }) => {
    pageErrors.expectEvery({
      pattern: loggedFailedResponse(400, /\/jsonrpc/),
      reason: 'the scene refuses the read of the catalog',
    });
    await refuseCatalog(page);
    await openWith(page, SLEEP_ONLY);
    const root = page.locator('[data-page="workflow-creator"]');
    await root.locator('#workflow-builder-add').click();
    await expect(
      page.getByRole('menuitem', { name: BUILDER.addMenu.activitiesFailed }),
    ).toBeVisible();
    await captureForDesignReview(page, {
      route: '/workflows/new (add a step menu)',
      state: 'error',
      source: 'workflow-builder-cards.spec.ts',
    });
  });

  test('workflow builder cards: a workflow step with no workflow chosen says so as a problem, at 1280 pixels', async ({
    page,
  }) => {
    await openWith(page, {
      name: 'e2e-missing-workflow',
      trigger: { kind: 'manual' },
      steps: [{ kind: 'workflow', workflow: '' }],
    });
    const root = page.locator('[data-page="workflow-creator"]');
    await root.getByRole('button', { name: WORKFLOW_COPY.creator.saveAction }).click();
    // One problem is said at its own field, which Save focuses; the summary line is for two or more.
    await expect(root.getByLabel(BUILDER.workflowCard.label(BUILDER.where.step(1)))).toBeFocused();
    await expect(root.getByText(BUILDER.problems.workflow)).toBeVisible();
    await captureForDesignReview(page, {
      route: '/workflows/new (step cards)',
      state: 'missing-workflow',
      source: 'workflow-builder-cards.spec.ts',
    });
  });
});

test.describe('the workflow builder’s read-only step cards', () => {
  test('workflow builder cards: reset stays reachable on desktop and the phone status shares its tab row', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/workflows/new');
    await expect(page.locator('[data-view="workflows"]')).toHaveAttribute('data-state', 'ready');
    const root = page.locator('[data-page="workflow-creator"]');
    await root.getByLabel(BUILDER.titleLabel, { exact: true }).fill('Morning briefing');
    await root.getByRole('button', { name: BUILDER.idChange }).click();
    await root.getByLabel(BUILDER.idLabel, { exact: true }).fill('custom-briefing');
    const reset = root.getByRole('button', { name: BUILDER.resetId });
    await expect(reset).toBeVisible();
    await captureForDesignReview(page, {
      route: '/workflows/new (step cards)',
      state: 'workflow-id-reset',
      source: 'workflow-builder-cards.spec.ts',
    });
    await reset.click();
    const change = root.getByRole('button', { name: BUILDER.idChange });
    await expect(change).toBeFocused();

    const tabRow = root.locator('.weft-workflow-builder__tabs');
    const tabList = root.getByRole('tablist');
    const desktop = await readBoxes(page, { tabRow, tabList });
    expect(Math.round(desktop.tabList.x + desktop.tabList.width)).toBe(
      Math.round(desktop.tabRow.x + desktop.tabRow.width),
    );

    await page.setViewportSize({ width: 375, height: 900 });
    const status = root.locator('.weft-workflow-builder__read-only');
    await expect(status).toHaveText(BUILDER.readOnly);
    const phone = await readBoxes(page, { tabList, status });
    const tabsCenter = phone.tabList.y + phone.tabList.height / 2;
    const statusCenter = phone.status.y + phone.status.height / 2;
    expect(Math.abs(tabsCenter - statusCenter)).toBeLessThanOrEqual(1);
    expect(phone.tabList.x + phone.tabList.width).toBeLessThan(phone.status.x);
    await expect(root.getByRole('link', { name: /Back to (the workflow|Workflows)/ })).toHaveCount(
      0,
    );
  });

  test('workflow builder cards: read-only below 640 pixels, at 375 pixels', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 900 });
    await openWith(page, EVERY_KIND);
    const root = page.locator('[data-page="workflow-creator"]');
    await expect(root.locator('.weft-workflow-builder__body')).toHaveAttribute('inert', '');
    await expect(root.getByText(BUILDER.addField, { exact: true })).toHaveCount(0);
    const primary = root.locator('button').filter({ hasText: WORKFLOW_COPY.creator.saveAction });
    await expect(primary).toBeVisible();
    await expect(primary).toBeDisabled();
    await captureForDesignReview(page, {
      route: '/workflows/new (step cards)',
      state: 'read-only',
      source: 'workflow-builder-cards.spec.ts',
    });
  });
});
