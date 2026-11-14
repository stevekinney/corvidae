/**
 * The workflow builder's step cards for the design review (COR-2247, COR-2248): one workflow with a
 * step of every kind the builder draws (a plugin's activity with a form from its schema, a code
 * workflow, a wait with a limit, a path chosen by a value with a path nested in it, steps side by
 * side, and steps repeated for each item), in each state the cards have: the data, empty lists that
 * are problems to fix, the catalog still loading, the catalog failing, the add menu open, and the
 * read-only phone. The Bureau serves no operation for the catalog of activities yet, so each scene
 * answers `bureau.workflows.catalog` itself, and the code workflows the list holds with it.
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

const CATALOG = {
  stepKinds: [],
  triggers: [],
  activities: [
    {
      id: 'demo:echo-input',
      title: 'Echo input',
      description: 'Hands back the text it is given.',
      inputSchema: {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        properties: {
          text: { type: 'string', title: 'Text' },
          loud: { type: 'boolean', title: 'Loud' },
          recipients: {
            type: 'array',
            title: 'Recipients',
            items: {
              type: 'object',
              properties: { address: { type: 'string', title: 'Address' } },
            },
          },
        },
        required: ['text'],
      },
    },
  ],
};

const CODE_WORKFLOWS = [
  {
    kind: 'code',
    id: 'demo:echo-workflow',
    name: 'echo-workflow',
    title: 'Echo workflow',
    plugin: 'demo',
    version: '1.0.0',
  },
];

/** A workflow with one step of every kind, a branch inside a branch three levels deep included. */
const EVERY_KIND = {
  name: 'e2e-cards',
  title: 'Every kind of step',
  trigger: { kind: 'manual' },
  steps: [
    {
      title: 'Echo what came in',
      kind: 'activity',
      handler: 'demo:echo-input',
      input: { text: 'Hello', loud: false, recipients: [{ address: 'a@example.com' }] },
    },
    { kind: 'workflow', workflow: 'demo:echo-workflow' },
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
  ],
};

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

type CatalogAnswer = 'data' | 'loading' | 'error';

/** Answers the catalog of activities, and adds the code workflows to the list of workflows. */
async function answerCatalogs(page: Page, answer: CatalogAnswer): Promise<Route[]> {
  const held: Route[] = [];
  await page.route('**/jsonrpc', async (route) => {
    const body = route.request().postData() ?? '';
    if (body.includes('bureau.workflows.catalog')) {
      if (answer === 'loading') {
        held.push(route);
        return;
      }
      if (answer === 'error') {
        await route.fulfill({ status: 400, json: { error: { message: 'No such operation.' } } });
        return;
      }
      await route.fulfill({
        json: { jsonrpc: '2.0', id: 'bureau.workflows.catalog', result: CATALOG },
      });
      return;
    }
    if (body.includes('bureau.workflows.list') && answer === 'data') {
      const response = await route.fetch();
      const json = (await response.json()) as { result?: { workflows?: unknown[] } };
      json.result?.workflows?.push(...CODE_WORKFLOWS);
      await route.fulfill({ response, json });
      return;
    }
    await route.fallback();
  });
  return held;
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
      await answerCatalogs(page, 'data');
      await openWith(page, EVERY_KIND);
      const root = page.locator('[data-page="workflow-creator"]');
      await expect(
        root.locator('[data-step-kind="activity"] .cinder-schema-form').first(),
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
      await answerCatalogs(page, 'data');
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
      const held = await answerCatalogs(page, 'loading');
      await openWith(page, EVERY_KIND);
      const root = page.locator('[data-page="workflow-creator"]');
      await expect(root.getByTestId('step-activity-loading').first()).toBeVisible();
      await captureForDesignReview(page, {
        route: '/workflows/new (step cards)',
        state: 'loading',
        source: 'workflow-builder-cards.spec.ts',
      });
      for (const route of held) await route.abort();
    });

    test(`workflow builder cards: the catalog failing, at ${width} pixels`, async ({
      page,
      pageErrors,
    }) => {
      pageErrors.expectEvery({
        pattern: loggedFailedResponse(400, /\/jsonrpc/),
        reason: 'the scene refuses the read of the catalog of activities',
      });
      await answerCatalogs(page, 'error');
      await openWith(page, EVERY_KIND);
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
    await answerCatalogs(page, 'data');
    await openWith(page, EVERY_KIND);
    const root = page.locator('[data-page="workflow-creator"]');
    await root.locator('#workflow-builder-add').click();
    await expect(page.getByRole('menuitem', { name: 'Echo input' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Echo workflow' })).toBeVisible();
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
    await answerCatalogs(page, 'data');
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
