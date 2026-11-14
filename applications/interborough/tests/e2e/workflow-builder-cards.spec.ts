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

import { WORKFLOW_COPY } from '../../src/app/copy/workflows.ts';
import { captureForDesignReview } from './design-review-capture.ts';
import { expect, loggedFailedResponse, test } from './fixtures.ts';
import { jsonEditor, replaceJsonEditorText } from './json-editor-support.ts';
import { openJsonTab, openTab } from './workflow-support.ts';

const BUILDER = WORKFLOW_COPY.builder;
const WIDTHS = [1280, 375] as const;

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

/** Opens a new workflow on the Builder tab holding `document`. */
async function openWith(page: Page, document: unknown): Promise<void> {
  await page.goto('/workflows/new');
  await expect(page.locator('[data-view="workflows"]')).toHaveAttribute('data-state', 'ready');
  const root = page.locator('[data-page="workflow-creator"]');
  await openJsonTab(root);
  const json = await jsonEditor(root, WORKFLOW_COPY.creator.textLabel);
  await replaceJsonEditorText(json, JSON.stringify(document, null, 2));
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

test.describe('the workflow builder’s read-only step cards', () => {
  test('workflow builder cards: read-only below 640 pixels, at 375 pixels', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 900 });
    await openWith(page, EVERY_KIND);
    const root = page.locator('[data-page="workflow-creator"]');
    await expect(root.locator('.weft-workflow-builder__body')).toHaveAttribute('inert', '');
    await captureForDesignReview(page, {
      route: '/workflows/new (step cards)',
      state: 'read-only',
      source: 'workflow-builder-cards.spec.ts',
    });
  });
});
