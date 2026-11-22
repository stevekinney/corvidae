/**
 * The fork comparison and the fork dialog's preview in each state they draw (COR-2538), for the
 * design review: the Lineage panel's Compare with source row on a fork's page, and the Checkpoints
 * tab's Fork panel, against the real end-to-end host.
 *
 * The runs are real: the seeded `fork-comparison` run (`fixtures/fork-comparison.ts`), a fork of it
 * this spec makes through the server, and the seeded `order-processing` run for the refused revision.
 * What the server answers is the real answer wherever a person can cause it on demand: the dialog's
 * dry run, and its refusal of the candidate revision. What one cannot is answered at the page's edge,
 * as the other state specifications do: a comparison with a step of every kind (the seeded fork has
 * one shared step and one changed one), a comparison that is still loading, one that fails, one with
 * nothing to compare, a dry run held in flight, and one whose fork would run on another revision.
 * Both go over JSON-RPC (`/jsonrpc`), so a route there rewrites them; the Bureau's calls share the
 * endpoint and go on untouched.
 */
import type { APIRequestContext, Locator, Page } from '@playwright/test';

import { FORK_COMPARISON_RUN_ID } from '../../fixtures/fork-comparison-ids.ts';
import { captureForDesignReviewWithPhone } from './design-review-capture.ts';
import { expect, test } from './fixtures.ts';
import { openHowItRan } from './workflow-support.ts';

const SOURCE = 'fork-comparison-states.spec.ts';

type JsonRpcBody = { id?: unknown; method?: string; params?: Record<string, unknown> };
type Reply = { result: unknown } | { error: { code: number; message: string; data: object } };

/**
 * Answers the Weft operations in `answers` from the spec, with the call's own body, and sends every
 * other call (the Bureau's, and any answer that is `undefined`) on to the host.
 */
async function answerWeft(
  page: Page,
  answers: Record<string, (body: JsonRpcBody) => Promise<Reply | undefined> | Reply | undefined>,
): Promise<void> {
  await page.route('**/jsonrpc', async (route) => {
    const body = route.request().postDataJSON() as JsonRpcBody | null;
    const answer = body?.method === undefined ? undefined : answers[body.method];
    const reply = answer === undefined || body === null ? undefined : await answer(body);
    if (reply === undefined) {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ jsonrpc: '2.0', id: body?.id ?? null, ...reply }),
    });
  });
}

const side = (overrides: Record<string, string | undefined> = {}) => ({
  operationType: 'activity',
  label: 'issueTicket',
  status: 'completed',
  input: '{"order":"ord_6001"}',
  output: '{"ticket":{"id":1,"lane":"north"},"cents":4999}',
  ...overrides,
});

/** A fork of the run `source-1` with a step of every kind: two shared, one changed, one the same, one in each run only. */
function comparisonOf(forkId: string) {
  return {
    workflowId: forkId,
    sourceWorkflowId: FORK_COMPARISON_RUN_ID,
    forkPoint: 3,
    steps: [
      {
        index: 0,
        shared: true,
        source: side({ label: 'reserveStock' }),
        fork: side({ label: 'reserveStock' }),
      },
      {
        index: 1,
        shared: true,
        source: side({ label: 'chargeCard' }),
        fork: side({ label: 'chargeCard' }),
      },
      {
        index: 2,
        shared: false,
        source: side(),
        fork: side({ output: '{"ticket":{"id":2,"lane":"north"},"cents":4999}' }),
      },
      {
        index: 3,
        shared: false,
        source: side({ label: 'notify' }),
        fork: side({ label: 'notify' }),
      },
      { index: 4, shared: false, source: side({ label: 'archive' }) },
      { index: 5, shared: false, fork: side({ label: 'audit' }) },
    ],
  };
}

/** Forks the seeded run through the server and waits until the fork has finished. */
async function makeFork(request: APIRequestContext): Promise<string> {
  const forked = await request.post('/jsonrpc', {
    data: {
      jsonrpc: '2.0',
      id: 1,
      method: 'weft.workflows.fork',
      params: { workflowId: FORK_COMPARISON_RUN_ID },
    },
  });
  const forkId = ((await forked.json()) as { result: { id: string } }).result.id;
  await expect
    .poll(async () => {
      const response = await request.get(`/v1/workflows/${encodeURIComponent(forkId)}`);
      return ((await response.json()) as { status?: string }).status;
    })
    .toBe('completed');
  return forkId;
}

/**
 * The one changed row whose key is `id`: a leaf row, so the row of its parent object, which contains
 * it, does not match as well.
 */
function changedIdRow(output: Locator): Locator {
  return output
    .locator('[data-cinder-diff-kind="changed"]')
    .filter({ hasNot: output.page().locator('[data-cinder-diff-kind]') })
    .filter({ has: output.page().locator('.cinder-json-diff-viewer__key', { hasText: /^id$/ }) });
}

/**
 * Opens a fork's page. Its Lineage panel, with the Compare with source button, leads the page ahead
 * of the operator tabs, so no tab is opened to reach it.
 */
async function openLineage(page: Page, forkId: string): Promise<Locator> {
  await page.goto(`/runs/${encodeURIComponent(forkId)}`);
  const lineage = page.locator('[data-section="lineage"]');
  await expect(lineage.getByRole('button', { name: 'Compare with source' })).toBeVisible();
  return lineage;
}

/** Captures at the desktop widths and at 375 and 320, where the list and its detail stack. */
async function captureLineage(page: Page, state: string, ready: () => Promise<void>) {
  await ready();
  await captureForDesignReviewWithPhone(page, {
    route: '/runs/:run',
    state,
    source: SOURCE,
    ready,
  });
}

test.describe('fork-comparison-states: /runs/:run, the comparison on a fork’s Lineage panel', () => {
  test('the Compare with source row, closed', async ({ page, request }) => {
    const forkId = await makeFork(request);
    const lineage = await openLineage(page, forkId);
    await captureLineage(page, 'compare with source row', async () => {
      await expect(lineage.getByText('Forked from')).toBeVisible();
      await expect(lineage.getByRole('button', { name: 'Compare with source' })).toHaveAttribute(
        'aria-expanded',
        'false',
      );
    });
  });

  test('loading: the comparison is being read', async ({ page, request }) => {
    const forkId = await makeFork(request);
    const held = Promise.withResolvers<void>();
    try {
      await answerWeft(page, {
        'weft.workflows.compare': async () => {
          await held.promise;
          return { result: comparisonOf(forkId) };
        },
      });
      const lineage = await openLineage(page, forkId);
      await lineage.getByRole('button', { name: 'Compare with source' }).click();
      await captureLineage(page, 'comparison loading', async () => {
        await expect(lineage.locator('[data-section="fork-comparison"]')).toBeVisible();
        await expect(lineage.locator('[data-compared-step]')).toHaveCount(0);
      });
    } finally {
      held.resolve();
    }
  });

  test('ready, the shared steps open, and a changed step selected', async ({ page, request }) => {
    const forkId = await makeFork(request);
    await answerWeft(page, {
      'weft.workflows.compare': () => ({ result: comparisonOf(forkId) }),
    });
    const lineage = await openLineage(page, forkId);
    await lineage.getByRole('button', { name: 'Compare with source' }).click();
    const comparison = lineage.locator('[data-section="fork-comparison"]');

    const shared = comparison.getByRole('button', { name: '2 steps the same as the source' });
    await captureLineage(page, 'comparison ready, every kind of step', async () => {
      await expect(shared).toHaveAttribute('aria-expanded', 'false');
      const kinds = ['changed', 'unchanged', 'source-only', 'fork-only'];
      for (const [position, kind] of kinds.entries()) {
        await expect(
          comparison.locator(`[data-compared-step="${String(position + 2)}"]`),
        ).toHaveAttribute('data-kind', kind);
      }
      await expect(comparison.getByText('Select a step')).toBeVisible();
    });

    await shared.click();
    await captureLineage(page, 'comparison shared steps open', async () => {
      await expect(comparison.locator('[data-shared-step]')).toHaveCount(2);
    });

    await comparison.locator('[data-compared-step="2"]').click();
    await captureLineage(page, 'comparison changed step selected, output diff', async () => {
      await expect(comparison.getByText('The input is the same in both runs.')).toBeVisible();
      const output = comparison.getByRole('group', { name: 'Output differences, step 3' });
      await expect(output).toBeVisible();
      await expect(changedIdRow(output)).toContainText('1 → 2');
    });
  });

  test('error: the comparison could not be read', async ({ page, request }) => {
    const forkId = await makeFork(request);
    await answerWeft(page, {
      'weft.workflows.compare': () => ({
        error: {
          code: -32022,
          message: 'Workflow is not a fork, so there is no source to compare it with.',
          data: { httpStatus: 422, weftCode: 'Unprocessable', retryable: false },
        },
      }),
    });
    const lineage = await openLineage(page, forkId);
    await lineage.getByRole('button', { name: 'Compare with source' }).click();
    await captureLineage(page, 'comparison error', async () => {
      await expect(lineage.getByText('The comparison could not be read')).toBeVisible();
      await expect(lineage.getByRole('button', { name: 'Try again' })).toBeVisible();
    });
  });

  test('nothing to compare: the fork has run nothing after the fork point', async ({
    page,
    request,
  }) => {
    const forkId = await makeFork(request);
    await answerWeft(page, {
      'weft.workflows.compare': () => ({
        result: { ...comparisonOf(forkId), steps: comparisonOf(forkId).steps.slice(0, 2) },
      }),
    });
    const lineage = await openLineage(page, forkId);
    await lineage.getByRole('button', { name: 'Compare with source' }).click();
    await captureLineage(page, 'comparison nothing to compare', async () => {
      await expect(lineage.getByRole('heading', { name: 'Nothing to compare' })).toBeVisible();
    });
  });
});

/** Opens a run's Checkpoints, selects the newest checkpoint and opens its Fork panel. */
async function openForkPanel(page: Page, runId: string): Promise<Locator> {
  await page.goto(`/runs/${encodeURIComponent(runId)}`);
  await openHowItRan(page);
  await page.getByRole('tab', { name: 'Events and logs' }).click();
  await page.getByRole('button', { name: 'Checkpoints' }).click();
  const list = page.locator('.weft-checkpoints-tab__list');
  await expect(list).toBeVisible();
  await list.locator('.weft-checkpoints-tab__row').first().click();
  await page.getByRole('radio', { name: 'Fork' }).click();
  const dialog = page.locator('.weft-fork-dialog');
  await expect(dialog).toBeVisible();
  return dialog;
}

/** Captures at the desktop widths and at 375 and 320, where the dialog's lists and button reflow. */
async function captureDialog(page: Page, state: string, ready: () => Promise<void>) {
  await ready();
  await captureForDesignReviewWithPhone(page, {
    route: '/runs/:run',
    tab: 'Events and logs',
    state,
    source: SOURCE,
    ready,
  });
}

const isDryRun = (body: JsonRpcBody) => body.params?.['dryRun'] === true;

test.describe('fork-comparison-states: /runs/:run, the fork dialog’s preview', () => {
  test('loading: the dry run is being read, and Create fork waits', async ({ page }) => {
    const held = Promise.withResolvers<void>();
    try {
      await answerWeft(page, {
        'weft.workflows.fork': async (body) => {
          if (!isDryRun(body)) return undefined;
          await held.promise;
          return undefined;
        },
      });
      const dialog = await openForkPanel(page, FORK_COMPARISON_RUN_ID);
      await captureDialog(page, 'fork preview loading', async () => {
        await expect(dialog.getByText('Reading what the fork would do')).toBeVisible();
        await expect(dialog.getByRole('button', { name: 'Create fork' })).toBeDisabled();
      });
    } finally {
      held.resolve();
    }
  });

  test('ready: the steps the fork keeps and the steps it runs again', async ({ page }) => {
    const dialog = await openForkPanel(page, FORK_COMPARISON_RUN_ID);
    await captureDialog(page, 'fork preview ready', async () => {
      // Exact, or "Run again (1)" also matches the button's own words and the heading's sentence.
      await expect(dialog.getByText('Kept, not run again (1)', { exact: true })).toBeVisible();
      await expect(dialog.getByText('Run again (1)', { exact: true })).toBeVisible();
      await expect(dialog.locator('[data-fork-preview-kept] li')).toHaveText([
        'Step 1, reserveStock',
      ]);
      await expect(dialog.locator('[data-fork-preview-rerun] li')).toHaveText([
        'Step 2, issueTicket',
      ]);
      await expect(dialog.getByRole('button', { name: 'Create fork' })).toBeEnabled();
    });
  });

  test('revision would change: the fork would run on another revision', async ({ page }) => {
    await answerWeft(page, {
      'weft.workflows.fork': async (body) => {
        if (!isDryRun(body)) return undefined;
        return {
          result: {
            dryRun: true,
            workflowId: FORK_COMPARISON_RUN_ID,
            forkPoint: 2,
            keptSteps: [
              { index: 0, operationType: 'activity', label: 'reserveStock', status: 'completed' },
            ],
            rerunSteps: [
              { index: 1, operationType: 'activity', label: 'issueTicket', status: 'completed' },
            ],
            revisionWouldChange: true,
            sourceRevision: 'sha256:5f2c0a8d91b3',
            forkRevision: 'sha256:c41e7d02ab66',
          },
        };
      },
    });
    const dialog = await openForkPanel(page, FORK_COMPARISON_RUN_ID);
    await captureDialog(page, 'fork preview revision would change', async () => {
      // A warning Callout that is the dialog's one statement of the revision, and names no revision.
      const warning = dialog.locator('.cinder-callout[data-cinder-variant="warning"]');
      await expect(warning).toBeVisible();
      await expect(warning).toContainText('Runs on a different revision');
      await expect(warning).toContainText(
        'The fork would run on a different revision than the source run.',
      );
      await expect(dialog.getByText(/^Retains /)).toHaveCount(0);
    });
  });

  test('refused: the revision is not available, and Create fork stays disabled', async ({
    page,
    request,
  }) => {
    // The seeded order-processing run, whose type has an installed candidate revision the server
    // refuses to fork onto (`tests/fixture-seed.test.ts` pins the refusal on a real engine).
    const listed = await request.get('/api/v1/workflows', {
      params: { type: 'order-processing', limit: '1' },
    });
    const orderId = ((await listed.json()) as { items: Array<{ id: string }> }).items[0]?.id;
    if (orderId === undefined) throw new Error('The seeded engine has no order-processing run.');
    const dialog = await openForkPanel(page, orderId);
    await dialog.getByRole('button', { name: 'Fork a different revision' }).click();
    await dialog
      .getByRole('combobox', { name: 'Revision' })
      .selectOption('order-processing-candidate-2');
    await captureDialog(page, 'fork preview refused', async () => {
      const banner = dialog.getByRole('alert').filter({ hasText: 'Revision unavailable' });
      await expect(banner).toBeVisible();
      await expect(banner.getByText(/Pick a different revision/)).toBeVisible();
      await expect(dialog.getByRole('button', { name: 'Create fork' })).toBeDisabled();
    });
  });

  test('after a fork: the new fork compared with this run, under the tab', async ({ page }) => {
    const fork = { id: '' };
    await answerWeft(page, {
      // The new fork is real; its comparison is the fixture, so the capture does not race the fork's run.
      'weft.workflows.compare': (body) => {
        const id = String(body.params?.['workflowId']);
        fork.id = id;
        return { result: comparisonOf(id) };
      },
    });
    const dialog = await openForkPanel(page, FORK_COMPARISON_RUN_ID);
    await expect(dialog.getByRole('button', { name: 'Create fork' })).toBeEnabled();
    await dialog.getByRole('button', { name: 'Create fork' }).click();
    const comparison = page.locator('[data-section="fork-comparison"]');
    await captureDialog(page, 'fork created, comparison under the tab', async () => {
      await expect(dialog.getByText(/^Forked as /)).toBeVisible();
      await expect(page.getByText('Compared with the source run')).toBeVisible();
      await expect(comparison.locator('[data-compared-step="2"]')).toHaveAttribute(
        'data-kind',
        'changed',
      );
    });
    expect(fork.id).not.toBe('');
  });
});

/**
 * The run panels on a workflow run's page (owner decision, 2026-11-22: run-page panels mount on
 * workflow runs; refined by the design review of #1219: a card is mounted only when it has something
 * to say about the run). The seeded runs are the engine's own, with no Bureau task, so the run
 * inspector has nothing to show and is not mounted, nor is the schedule editor, which cannot narrow
 * to the run's workflow; the comparison card is mounted on a fork, where it reads
 * `bureau.runs.compare`, which the Bureau serves for an instance of a workflow file and answers
 * with its own message for a run it does not hold as one. The seeded fork is a fork of a fixture
 * workflow the console's own engine runs, not of an instance of a workflow file, and a fork of a
 * workflow file would need an instance the seeded world does not hold (a seeded file's run calls the
 * model and sleeps, and an extra instance changes the Workflows list other specifications count). So
 * the card with a comparison is answered at the panel route's edge, in the shape the Bureau serves;
 * the Bureau's own answer for a fork of a workflow file is `runs-compare-operation.test.ts`.
 */
test.describe('fork-comparison-states: /runs/:run, the run panels on a workflow run’s page', () => {
  /** `bureau.runs.compare` as the Bureau answers a fork of a workflow file. */
  function bureauComparisonOf(forkId: string) {
    const { steps, forkPoint } = comparisonOf(forkId);
    return { runId: forkId, sourceRunId: FORK_COMPARISON_RUN_ID, forkPoint, steps };
  }

  /**
   * Opens a fork's Inspector tab. A card is mounted only when it has something to say about the run,
   * so a fork's page holds the comparison and nothing else: the run has no agent task for the run
   * inspector, and the schedule editor cannot narrow to its workflow.
   */
  async function openPanels(page: Page, runId: string): Promise<void> {
    await page.goto(`/runs/${encodeURIComponent(runId)}`);
    await openHowItRan(page);
    await page.getByRole('tab', { name: 'Inspector' }).click();
    await expect(page.locator('iframe[title="Run comparison"]')).toBeVisible();
    await expect(page.locator('[data-section="plugin-panel"]')).toHaveCount(1);
  }

  /** Captures at the desktop widths and at 375 and 320. */
  async function capturePanels(page: Page, state: string, ready: () => Promise<void>) {
    await ready();
    await captureForDesignReviewWithPhone(page, {
      route: '/runs/:run',
      tab: 'Inspector',
      state,
      source: SOURCE,
      ready,
    });
  }

  test('a fork’s page: the comparison card, with the comparison', async ({ page, request }) => {
    const forkId = await makeFork(request);
    await page.route('**/host/plugins/inspectors/apps/run-comparison/tool-calls', async (route) => {
      const comparison = bureauComparisonOf(forkId);
      await route.fulfill({
        json: {
          content: [{ type: 'text', text: JSON.stringify(comparison) }],
          structuredContent: comparison,
        },
      });
    });
    await openPanels(page, forkId);
    const card = page.frameLocator('iframe[title="Run comparison"]');
    await capturePanels(page, 'workflow run page, comparison card with a comparison', async () => {
      await expect(card.locator('[data-compared-step="2"]')).toHaveAttribute(
        'data-kind',
        'changed',
      );
      await expect(
        card.getByRole('button', { name: '2 steps the same as the source' }),
      ).toBeVisible();
    });
  });

  test('a fork’s page: the comparison card, with the Bureau’s own message', async ({
    page,
    request,
  }) => {
    const forkId = await makeFork(request);
    await openPanels(page, forkId);
    const card = page.frameLocator('iframe[title="Run comparison"]');
    await capturePanels(
      page,
      'workflow run page, comparison card with the server’s message',
      async () => {
        await expect(card.locator('[data-comparison-message]')).toBeVisible();
        await expect(card.locator('[data-compared-step]')).toHaveCount(0);
      },
    );
  });

  test('a workflow run’s page that is not a fork: no cards, since none has anything to say', async ({
    page,
  }) => {
    await page.goto(`/runs/${encodeURIComponent(FORK_COMPARISON_RUN_ID)}`);
    await openHowItRan(page);
    await page.getByRole('tab', { name: 'Inspector' }).click();
    await capturePanels(page, 'workflow run page, no run cards', async () => {
      // The page's own controls are there; no run inspector (no agent task), no schedule editor
      // (it cannot narrow to this run's workflow) and no comparison (the run is not a fork).
      await expect(page.locator('[data-section="change"]')).toBeVisible();
      await expect(page.locator('[data-section="plugin-panel"]')).toHaveCount(0);
      await expect(page.locator('iframe')).toHaveCount(0);
    });
  });
});
