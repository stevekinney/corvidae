/**
 * The four typed-confirmation dialogs in each state they draw, for the design review of COR-2547:
 * the bulk action dialog, the purge dialog, the drain dialog and the clear dead letter dialog, all
 * Cinder's `ConfirmDialog`. `scripts/design-review-capture.ts` screenshots pages, which never see
 * a dialog's states, so this specification reaches each one the way a person does and captures it
 * for the design review at 1280 (and 1920, which the helper repeats) and at 375 (and 320 by 640).
 * Each capture is named `<dialog>--<state>` (the route and the state of `captureForDesignReview`),
 * and a capture of a width the page is not at is taken by resizing the open dialog, never by
 * opening it again.
 *
 * What the host answers is the real one wherever it can be (the workflow list, the worker fleet,
 * the deployments and their builds); what a person cannot cause on demand is answered at the
 * JSON-RPC transport, as the other state specifications do: a dry run held in flight, a commit held
 * in flight, a refused commit, a stale confirmation token, a routing pointer that names the build
 * being drained, a dead letter. Nothing is committed: every bulk operation and every drain is
 * answered here, and the held ones are released when a test ends. The capture runs only when
 * `INTERBOROUGH_DESIGN_REVIEW_CAPTURE` is set; an ordinary run reaches each state and checks it
 * is the one named.
 *
 * The drain dialog's worker target is not drawn: the Workers page confirms a worker's drain with
 * its own dialog (`worker-confirmations.svelte`) and opens `DrainDialog` only for a deployment and
 * a build.
 */
import type { Locator, Page } from '@playwright/test';

import { designReviewCaptureDirectory } from '../../scripts/environment-configuration.ts';
import { captureForDesignReview } from './design-review-capture.ts';
import {
  E2E_CURRENT_BUILD_ID,
  E2E_DEPLOYMENT_NAME,
  E2E_FLEET_WORKER_ID,
  E2E_LEDGER_DEPLOYMENT_NAME,
  E2E_LEDGER_QUEUE,
  E2E_PREVIOUS_BUILD_ID,
} from './e2e-constants.ts';
import { expect, test } from './fixtures.ts';

const SOURCE = 'confirm-dialog-states.spec.ts';

/** The widths a state is captured at; the helper repeats 1280 at 1920 and 375 at 320 by 640. */
const SIZES = [
  { width: 1280, height: 900 },
  { width: 375, height: 812 },
] as const;

/** Captures the open dialog at each width, resizing it in place. Does nothing outside a capture. */
async function captureDialog(page: Page, dialog: string, state: string): Promise<void> {
  if (designReviewCaptureDirectory() === undefined) return;
  for (const size of SIZES) {
    await page.setViewportSize(size);
    await expect(page.getByRole('dialog')).toBeVisible();
    await captureForDesignReview(page, {
      route: dialog,
      state,
      source: SOURCE,
      ready: async (current) => {
        await expect(current.getByRole('dialog')).toBeVisible();
      },
    });
  }
}

// ---------------------------------------------------------------------------------------------
// JSON-RPC answers
// ---------------------------------------------------------------------------------------------

interface RpcCall {
  readonly id: unknown;
  readonly method: string;
  readonly params: Readonly<Record<string, unknown>>;
}

/** A refusal as the JSON-RPC transport carries it: the HTTP status and the coarse fault code. */
interface Fault {
  readonly message: string;
  readonly httpStatus: number;
  readonly weftCode: string;
}

type Answer =
  | { readonly result: unknown }
  | { readonly fault: Fault }
  | { readonly patch: (result: unknown) => unknown }
  | undefined;

/**
 * Answers the Weft operations `answer` names, and leaves the host to answer the rest. A `patch`
 * answer takes the host's own answer and rewrites its result, so a page keeps the real fleet and
 * only the part a state needs is made.
 */
async function answerJsonRpc(
  page: Page,
  answer: (call: RpcCall) => Promise<Answer> | Answer,
): Promise<void> {
  await page.route('**/jsonrpc', async (route) => {
    const parsed: unknown = JSON.parse(route.request().postData() ?? '{}');
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      await route.fallback();
      return;
    }
    const body = parsed as { id?: unknown; method?: unknown; params?: unknown };
    const call: RpcCall = {
      id: body.id ?? 1,
      method: typeof body.method === 'string' ? body.method : '',
      params:
        typeof body.params === 'object' && body.params !== null
          ? (body.params as Record<string, unknown>)
          : {},
    };
    const decided = await answer(call);
    if (decided === undefined) {
      await route.fallback();
    } else if ('result' in decided) {
      await route.fulfill({ json: { jsonrpc: '2.0', id: call.id, result: decided.result } });
    } else if ('fault' in decided) {
      await route.fulfill({
        json: {
          jsonrpc: '2.0',
          id: call.id,
          error: {
            code: -32000,
            message: decided.fault.message,
            data: { httpStatus: decided.fault.httpStatus, weftCode: decided.fault.weftCode },
          },
        },
      });
    } else {
      const response = await route.fetch();
      const json = (await response.json()) as { result?: unknown };
      await route.fulfill({ response, json: { ...json, result: decided.patch(json.result) } });
    }
  });
}

/** Requests the test holds in flight; releasing them answers each with what it was waiting for. */
class Held {
  private readonly waiting: (() => void)[] = [];

  /** Waits until `release`. */
  wait(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.waiting.push(resolve);
    });
  }

  release(): void {
    for (const resolve of this.waiting.splice(0)) resolve();
  }
}

// ---------------------------------------------------------------------------------------------
// Bulk operations
// ---------------------------------------------------------------------------------------------

const MATCHED = 47;
const SAMPLE_IDS = Array.from(
  { length: 20 },
  (_, index) => `payment-failing-${String(index + 1).padStart(4, '0')}`,
);
const OPERATION = /^weft\.workflows\.(bulk\.[a-z]+|purge)$/;

const CONFLICT: Fault = {
  message: 'Bulk confirmation token does not match the current dry-run scope',
  httpStatus: 409,
  weftCode: 'Conflict',
};
const ENGINE_FAILURE: Fault = {
  message: 'The engine could not finish the operation.',
  httpStatus: 500,
  weftCode: 'EngineFailure',
};

interface BulkScript {
  /** What the dry run counts. */
  readonly matched?: number;
  /** The dry run waits for the test, or is refused. */
  readonly dryRun?: 'hold' | Fault;
  /** The commit waits for the test, or is refused. */
  readonly commit?: 'hold' | Fault;
}

function previewOf(matched: number, action: string) {
  const sample = SAMPLE_IDS.slice(0, Math.min(matched, SAMPLE_IDS.length));
  return {
    dryRun: true,
    action,
    matched,
    requestId: 'bulk:capture',
    scope: {
      matched,
      filter: { status: 'failed', type: 'payment-failing' },
      statuses: ['failed'],
      workflowTypes: ['payment-failing'],
      sampleWorkflowIds: sample,
      sampleLimit: 20,
    },
    sampleWorkflowIds: sample,
    confirmationToken: 'bulk:capture-token',
    confirmationTokenVersion: 1,
  };
}

/** What each operation answers once its commit goes through, in the shape its client reads. */
function committedOf(method: string, matched: number): unknown {
  switch (method) {
    case 'weft.workflows.bulk.cancel':
      return {
        cancelled: matched - 2,
        failed: 2,
        errors: [
          { id: SAMPLE_IDS[3], error: 'The workflow had already finished.' },
          { id: SAMPLE_IDS[11], error: 'The workflow was cancelled by someone else first.' },
        ],
      };
    case 'weft.workflows.bulk.signal':
      return { signalled: matched, failed: 0 };
    case 'weft.workflows.bulk.tags':
      return { modified: matched };
    case 'weft.workflows.purge':
      return { deleted: matched };
    default:
      return { deleted: matched };
  }
}

/** Answers every bulk operation and the purge, so nothing the host holds is ever changed. */
async function answerBulk(page: Page, script: BulkScript = {}): Promise<Held> {
  const held = new Held();
  const matched = script.matched ?? MATCHED;
  await answerJsonRpc(page, async (call) => {
    if (!OPERATION.test(call.method)) return undefined;
    const isDryRun = call.params['dryRun'] === true;
    const step = isDryRun ? script.dryRun : script.commit;
    if (step === 'hold') await held.wait();
    else if (step !== undefined) return { fault: step };
    return {
      result: isDryRun ? previewOf(matched, call.method) : committedOf(call.method, matched),
    };
  });
  return held;
}

/** Selects every failed workflow the list matches and presses `button` on the bulk bar. */
async function openBulkDialog(page: Page, button: string): Promise<Locator> {
  await page.goto('/workflows/payment-failing/runs');
  await page
    .getByRole('group', { name: 'Filter by status' })
    .getByRole('button', { name: 'Failed' })
    .click();
  await expect(page.getByRole('row', { name: /payment-failing/ })).toBeVisible();
  await page.getByRole('checkbox', { name: 'Select all rows' }).click();
  await page.getByRole('checkbox', { name: /^Select all \d+ matching the filter$/ }).click();
  await page.locator('.weft-bulk-bar').getByRole('button', { name: button, exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  return dialog;
}

const phraseOf = (verb: string, matched: number): string =>
  `${verb} ${String(matched)} workflow${matched === 1 ? '' : 's'}`;

const capitalised = (text: string): string => `${text.slice(0, 1).toUpperCase()}${text.slice(1)}`;

/** Types the confirmation the preview asks for and presses the button it arms. */
async function confirmPreview(dialog: Locator, verb: string, matched = MATCHED): Promise<void> {
  const phrase = phraseOf(verb, matched);
  await dialog.getByRole('textbox', { name: `Type "${phrase}" to confirm` }).fill(phrase);
  await dialog.getByRole('button', { name: capitalised(phrase), exact: true }).click();
}

/** The dialog holds the preview: the typed field is there. */
async function expectPreview(dialog: Locator, verb: string, matched = MATCHED): Promise<void> {
  await expect(
    dialog.getByRole('textbox', { name: `Type "${phraseOf(verb, matched)}" to confirm` }),
  ).toBeVisible();
}

const BULK = 'bulk-action-dialog';

test.describe('confirm-dialog-states: the bulk action dialog', () => {
  test('params, for a signal', async ({ page }) => {
    await answerBulk(page);
    const dialog = await openBulkDialog(page, 'Signal');
    await expect(dialog.getByLabel('Signal name')).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Continue' })).toBeDisabled();
    await captureDialog(page, BULK, 'params-signal');
  });

  test('params, for mutating tags', async ({ page }) => {
    await answerBulk(page);
    const dialog = await openBulkDialog(page, 'Mutate tags');
    await expect(dialog.getByLabel('Tags (comma-separated)')).toBeVisible();
    await captureDialog(page, BULK, 'params-tags');
  });

  test('loading: the count is in flight', async ({ page }) => {
    const held = await answerBulk(page, { dryRun: 'hold' });
    const dialog = await openBulkDialog(page, 'Cancel');
    await expect(
      dialog.getByRole('status').filter({ hasText: 'Checking how many workflows match' }),
    ).toHaveCount(1);
    await expect(dialog.getByRole('button', { name: 'Cancel workflows' })).toBeDisabled();
    await captureDialog(page, BULK, 'loading');
    held.release();
  });

  test('preview with the typed field', async ({ page }) => {
    await answerBulk(page);
    const dialog = await openBulkDialog(page, 'Cancel');
    await expectPreview(dialog, 'cancel');
    await expect(dialog.getByRole('button', { name: 'Cancel 47 workflows' })).toBeDisabled();
    await captureDialog(page, BULK, 'preview');
  });

  test('zero matches: nothing to do', async ({ page }) => {
    await answerBulk(page, { matched: 0 });
    const dialog = await openBulkDialog(page, 'Cancel');
    await expect(dialog.getByText(/nothing to do/)).toBeVisible();
    await expect(dialog.getByRole('textbox')).toHaveCount(0);
    await captureDialog(page, BULK, 'zero-matches');
  });

  test('committing: the commit is in flight', async ({ page }) => {
    const held = await answerBulk(page, { commit: 'hold' });
    const dialog = await openBulkDialog(page, 'Cancel');
    await expectPreview(dialog, 'cancel');
    await confirmPreview(dialog, 'cancel');
    await expect(dialog.getByText(/keeps running on the server/)).toBeVisible();
    await expect(dialog.getByRole('progressbar')).toBeVisible();
    await captureDialog(page, BULK, 'committing');
    held.release();
  });

  test('result, with errors', async ({ page }) => {
    await answerBulk(page);
    const dialog = await openBulkDialog(page, 'Cancel');
    await expectPreview(dialog, 'cancel');
    await confirmPreview(dialog, 'cancel');
    await expect(dialog.getByText('Cancelled 45 of 47 workflows')).toBeVisible();
    await expect(dialog.getByRole('listitem')).toHaveCount(2);
    await captureDialog(page, BULK, 'result-with-errors');
  });

  test('dry-run fault', async ({ page }) => {
    await answerBulk(page, { dryRun: ENGINE_FAILURE });
    const dialog = await openBulkDialog(page, 'Cancel');
    await expect(dialog.getByText(ENGINE_FAILURE.message)).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Retry' })).toBeVisible();
    await captureDialog(page, BULK, 'dry-run-fault');
  });

  test('stale: the preview no longer matches', async ({ page }) => {
    await answerBulk(page, { commit: CONFLICT });
    const dialog = await openBulkDialog(page, 'Cancel');
    await expectPreview(dialog, 'cancel');
    await confirmPreview(dialog, 'cancel');
    await expect(dialog.getByRole('button', { name: 'Refresh preview' })).toBeVisible();
    await expect(dialog.getByText('The matching workflows changed')).toBeVisible();
    await expect(dialog.getByText(CONFLICT.message)).toHaveCount(0);
    await captureDialog(page, BULK, 'stale');
  });

  test('commit fault', async ({ page }) => {
    await answerBulk(page, { commit: ENGINE_FAILURE });
    const dialog = await openBulkDialog(page, 'Cancel');
    await expectPreview(dialog, 'cancel');
    await confirmPreview(dialog, 'cancel');
    await expect(dialog.getByText(ENGINE_FAILURE.message)).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Retry' })).toBeVisible();
    await captureDialog(page, BULK, 'commit-fault');
  });
});

// ---------------------------------------------------------------------------------------------
// Purge
// ---------------------------------------------------------------------------------------------

const PURGE = 'purge-dialog';

test.describe('confirm-dialog-states: the purge dialog', () => {
  test('loading: the count is in flight', async ({ page }) => {
    const held = await answerBulk(page, { dryRun: 'hold' });
    const dialog = await openBulkDialog(page, 'Purge');
    await expect(
      dialog.getByRole('status').filter({ hasText: 'Counting the workflows a purge' }),
    ).toHaveCount(1);
    await expect(dialog.getByRole('button', { name: 'Purge', exact: true })).toBeDisabled();
    await captureDialog(page, PURGE, 'loading');
    held.release();
  });

  test('preview with the id sample', async ({ page }) => {
    await answerBulk(page);
    const dialog = await openBulkDialog(page, 'Purge');
    await expectPreview(dialog, 'purge');
    await expect(
      dialog.getByRole('list', { name: 'These workflows will be deleted:' }),
    ).toBeVisible();
    await captureDialog(page, PURGE, 'preview-with-sample');
  });

  test('zero matches: nothing to purge', async ({ page }) => {
    await answerBulk(page, { matched: 0 });
    const dialog = await openBulkDialog(page, 'Purge');
    await expect(dialog.getByText(/there is nothing to purge/)).toBeVisible();
    await expect(dialog.getByRole('textbox')).toHaveCount(0);
    await captureDialog(page, PURGE, 'zero-matches');
  });

  test('committing: the purge is in flight', async ({ page }) => {
    const held = await answerBulk(page, { commit: 'hold' });
    const dialog = await openBulkDialog(page, 'Purge');
    await expectPreview(dialog, 'purge');
    await confirmPreview(dialog, 'purge');
    await expect(dialog.getByText(/keeps running on the server/)).toBeVisible();
    await captureDialog(page, PURGE, 'committing');
    held.release();
  });

  test('result', async ({ page }) => {
    await answerBulk(page);
    const dialog = await openBulkDialog(page, 'Purge');
    await expectPreview(dialog, 'purge');
    await confirmPreview(dialog, 'purge');
    await expect(dialog.getByText('Purged 47 workflows')).toBeVisible();
    await captureDialog(page, PURGE, 'result');
  });

  test('stale: the matching workflows changed', async ({ page }) => {
    await answerBulk(page, { commit: CONFLICT });
    const dialog = await openBulkDialog(page, 'Purge');
    await expectPreview(dialog, 'purge');
    await confirmPreview(dialog, 'purge');
    await expect(dialog.getByText('The matching workflows changed')).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Refresh preview' })).toBeVisible();
    await captureDialog(page, PURGE, 'stale');
  });

  test('failed commit', async ({ page }) => {
    await answerBulk(page, {
      commit: {
        message: 'Purge deleted 30 workflows and failed for 17.',
        httpStatus: 500,
        weftCode: 'EngineFailure',
      },
    });
    const dialog = await openBulkDialog(page, 'Purge');
    await expectPreview(dialog, 'purge');
    await confirmPreview(dialog, 'purge');
    await expect(dialog.getByText('Purge deleted 30 workflows and failed for 17.')).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Refresh preview' })).toBeVisible();
    await captureDialog(page, PURGE, 'failed-commit');
  });

  test('failed dry run', async ({ page }) => {
    await answerBulk(page, { dryRun: ENGINE_FAILURE });
    const dialog = await openBulkDialog(page, 'Purge');
    await expect(dialog.getByText(ENGINE_FAILURE.message)).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Retry' })).toBeVisible();
    await captureDialog(page, PURGE, 'failed-dry-run');
  });
});

// ---------------------------------------------------------------------------------------------
// Drain
// ---------------------------------------------------------------------------------------------

const DRAIN = 'drain-dialog';

/** The deployments panel's routing for the ledger deployment, in place of the host's pointer. */
function routingNaming(current: string, ramping: string | undefined): Answer {
  return {
    patch: (result) => {
      const diagnostics = (result ?? {}) as Record<string, unknown>;
      return {
        ...diagnostics,
        routing: {
          deploymentName: E2E_LEDGER_DEPLOYMENT_NAME,
          currentBuildId: current,
          ...(ramping === undefined ? {} : { rampingBuildId: ramping }),
          rampBasisPoints: ramping === undefined ? 0 : 2500,
          generation: 1,
          updatedAt: Date.now(),
        },
      };
    },
  };
}

/** Opens the Drain dialog of a build on the deployments tab, with routing as `routing` says. */
async function openBuildDrain(
  page: Page,
  buildId: string,
  routing: { readonly current: string; readonly ramping?: string },
): Promise<Locator> {
  await answerJsonRpc(page, (call) => {
    if (call.method !== 'weft.worker.deployments.diagnostics') return undefined;
    if (call.params['deploymentName'] !== E2E_LEDGER_DEPLOYMENT_NAME) return undefined;
    return routingNaming(routing.current, routing.ramping);
  });
  await page.goto('/health/workers?tab=deployments');
  const deployment = page.getByRole('region', { name: E2E_LEDGER_DEPLOYMENT_NAME, exact: true });
  await expect(deployment).toBeVisible();
  await deployment
    .getByRole('row')
    .filter({ hasText: buildId })
    .getByRole('button', { name: 'Drain' })
    .click();
  const dialog = page.getByRole('dialog', { name: 'Drain build' });
  await expect(dialog).toBeVisible();
  return dialog;
}

test.describe('confirm-dialog-states: the drain dialog', () => {
  test('deployment', async ({ page }) => {
    await page.goto(`/health/workers?worker=${E2E_FLEET_WORKER_ID}&tab=queues`);
    await page
      .getByTestId('worker-technical-details')
      .getByRole('button', { name: 'Drain deployment' })
      .click();
    const dialog = page.getByRole('dialog', { name: 'Drain deployment' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(E2E_DEPLOYMENT_NAME)).toBeVisible();
    await captureDialog(page, DRAIN, 'deployment');
  });

  test('deployment, with a reason, while the drain is in flight', async ({ page }) => {
    const held = new Held();
    await answerJsonRpc(page, async (call) => {
      if (call.method !== 'weft.worker.deployments.drain') return undefined;
      await held.wait();
      return { result: {} };
    });
    await page.goto(`/health/workers?worker=${E2E_FLEET_WORKER_ID}&tab=queues`);
    await page
      .getByTestId('worker-technical-details')
      .getByRole('button', { name: 'Drain deployment' })
      .click();
    const dialog = page.getByRole('dialog', { name: 'Drain deployment' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('textbox', { name: 'Reason' }).fill('rolling deploy #4791');
    await dialog.getByRole('button', { name: 'Drain deployment' }).click();
    await expect(dialog.getByRole('button', { name: 'Drain deployment' })).toHaveAttribute(
      'aria-busy',
      'true',
    );
    await captureDialog(page, DRAIN, 'busy');
    held.release();
  });

  test('build, which routing does not name', async ({ page }) => {
    const dialog = await openBuildDrain(page, E2E_PREVIOUS_BUILD_ID, {
      current: E2E_CURRENT_BUILD_ID,
    });
    await expect(dialog.getByRole('note')).toHaveCount(0);
    await captureDialog(page, DRAIN, 'build');
  });

  test('the current build: the warning that new starts are refused', async ({ page }) => {
    const dialog = await openBuildDrain(page, E2E_CURRENT_BUILD_ID, {
      current: E2E_CURRENT_BUILD_ID,
      ramping: E2E_PREVIOUS_BUILD_ID,
    });
    await expect(dialog.getByRole('note')).toContainText('This is the current build');
    await captureDialog(page, DRAIN, 'current-build-warning');
  });

  test('the ramping build: the warning that the ramp share is refused', async ({ page }) => {
    const dialog = await openBuildDrain(page, E2E_PREVIOUS_BUILD_ID, {
      current: E2E_CURRENT_BUILD_ID,
      ramping: E2E_PREVIOUS_BUILD_ID,
    });
    await expect(dialog.getByRole('note')).toContainText('This is the ramping build');
    await captureDialog(page, DRAIN, 'ramping-build-warning');
  });
});

// ---------------------------------------------------------------------------------------------
// Clear dead letter
// ---------------------------------------------------------------------------------------------

const DEAD_LETTER_ID = 'dl-ledger-1';

test.describe('confirm-dialog-states: the clear dead letter dialog', () => {
  test('its typed confirmation', async ({ page }) => {
    await answerJsonRpc(page, (call) => {
      if (call.method !== 'weft.tasks.diagnostics') return undefined;
      return {
        patch: (result) => {
          const diagnostics = (result ?? {}) as {
            items?: unknown[];
            summary?: Record<string, unknown>;
          };
          return {
            ...diagnostics,
            items: [
              {
                kind: 'dead-lettered',
                state: 'dead-lettered',
                retryCount: 5,
                requeueCount: 5,
                evidence: ['exhausted retries'],
                operationId: DEAD_LETTER_ID,
                activityName: 'ChargeCard',
                queue: E2E_LEDGER_QUEUE,
                deadLetteredAt: Date.UTC(2026, 10, 2, 16, 30),
              },
              ...(diagnostics.items ?? []),
            ],
            summary: { ...diagnostics.summary, deadLettered: 1 },
          };
        },
      };
    });
    await page.goto(`/health/workers?tab=queues&queue=${E2E_LEDGER_QUEUE}`);
    await page
      .getByRole('row')
      .filter({ hasText: DEAD_LETTER_ID })
      .getByRole('button', { name: 'Clear' })
      .click();
    const dialog = page.getByRole('dialog', { name: 'Clear dead letter' });
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByRole('textbox', { name: `Type "${DEAD_LETTER_ID}" to confirm` }),
    ).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Clear dead letter' })).toBeDisabled();
    await captureDialog(page, 'clear-dead-letter-dialog', 'typed-confirmation');
  });
});
