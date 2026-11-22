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
import { captureForDesignReview } from './design-review-capture.ts';
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

/** Opens a fork's page at its Versioning tab, where the Lineage panel is, and answers that panel. */
async function openLineage(page: Page, forkId: string): Promise<Locator> {
  await page.goto(`/runs/${encodeURIComponent(forkId)}`);
  await openHowItRan(page);
  await page.getByRole('tab', { name: 'Versioning' }).click();
  const lineage = page.locator('[data-section="lineage"]');
  await expect(lineage.getByRole('button', { name: 'Compare with source' })).toBeVisible();
  return lineage;
}

async function captureLineage(page: Page, state: string, ready: () => Promise<void>) {
  await ready();
  await captureForDesignReview(page, {
    route: '/runs/:run',
    tab: 'Versioning',
    state,
    source: SOURCE,
    ready,
  });
}

test.describe('fork-comparison-states: the comparison on a fork’s Lineage panel', () => {
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

    const shared = comparison.getByRole('button', { name: '2 steps shared with the source' });
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
      await expect(
        output.locator('[data-cinder-diff-kind="changed"]').filter({ hasText: 'id' }),
      ).toContainText('1 → 2');
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

async function captureDialog(page: Page, state: string, ready: () => Promise<void>) {
  await ready();
  await captureForDesignReview(page, {
    route: '/runs/:run',
    tab: 'Events and logs',
    state,
    source: SOURCE,
    ready,
  });
}

const isDryRun = (body: JsonRpcBody) => body.params?.['dryRun'] === true;

test.describe('fork-comparison-states: the fork dialog’s preview', () => {
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
      await expect(dialog.getByText('Kept, not run again (1)')).toBeVisible();
      await expect(dialog.getByText('Run again (1)')).toBeVisible();
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
      await expect(dialog.getByText(/The fork would run on .*, not the source’s /)).toBeVisible();
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
 * workflow runs). The seeded runs are the engine's own, with no Bureau task: the run inspector says
 * it has no task to inspect, the schedule editor lists the schedules, and the comparison card reads
 * `bureau.runs.compare`, which the Bureau serves for an instance of a workflow file and answers
 * with its own message for a run it does not hold as one. A fork of a workflow file is not in the
 * seeded world (the Bureau's engine cannot fork under its default lease, COR-2635), so the card
 * with a comparison is answered at the panel route's edge, in the shape the Bureau serves.
 */
test.describe('fork-comparison-states: the run panels on a workflow run’s page', () => {
  const PANEL_TITLES = ['Run inspector', 'Schedule editor', 'Run comparison'] as const;

  /** `bureau.runs.compare` as the Bureau answers a fork of a workflow file. */
  function bureauComparisonOf(forkId: string) {
    const { steps, forkPoint } = comparisonOf(forkId);
    return { runId: forkId, sourceRunId: FORK_COMPARISON_RUN_ID, forkPoint, steps };
  }

  async function openPanels(page: Page, runId: string): Promise<void> {
    await page.goto(`/runs/${encodeURIComponent(runId)}`);
    await openHowItRan(page);
    await page.getByRole('tab', { name: 'Inspector' }).click();
    for (const title of PANEL_TITLES) {
      await expect(page.locator(`iframe[title="${title}"]`)).toBeVisible();
    }
  }

  async function capturePanels(page: Page, state: string, ready: () => Promise<void>) {
    await ready();
    await captureForDesignReview(page, {
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
        card.getByRole('button', { name: '2 steps shared with the source' }),
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

  test('a workflow run’s page: the run inspector and the schedule editor cards', async ({
    page,
  }) => {
    await openPanels(page, FORK_COMPARISON_RUN_ID);
    const inspector = page.frameLocator('iframe[title="Run inspector"]');
    const editor = page.frameLocator('iframe[title="Schedule editor"]');
    await capturePanels(
      page,
      'workflow run page, run inspector and schedule editor cards',
      async () => {
        await expect(inspector.locator('[data-inspector-notice]')).toContainText(
          'has no agent task to inspect',
        );
        await expect(inspector.getByRole('button', { name: 'Abort run' })).toHaveCount(0);
        await expect(editor.getByRole('button', { name: 'New schedule' })).toBeVisible();
      },
    );
  });
});
