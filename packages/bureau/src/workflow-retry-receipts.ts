/**
 * The retry receipt of an instance of a workflow file (COR-2424): how many times the instance was
 * retried from its failed step, and the request that retried it last.
 *
 * An `agent` step's run has an id that is a function of the instance and the step, so a step a
 * restart runs again finds its own run (`workflowStepRunId`). A retry runs the failed step again
 * in the same instance, so that id would find the run that failed and fail the step again without
 * running anything. The receipt's `generation` is the instance's retry count, and a step that runs
 * after a retry folds it into its run's id: generation 0 (no receipt, every instance from before
 * retries existed) keeps the id it always had, and each retry's steps have ids of their own that a
 * restart inside that retry still finds.
 *
 * The receipt is written before the engine reactivates the instance, with the request `pending`,
 * and again once the reactivation committed, with the request `applied`. A request repeated with
 * the same `retryId` after a crash between the two finds its own pending request and finishes it,
 * and one repeated after the second write answers what the first did; neither reactivates twice.
 *
 * Records live under `bureau-workflow-retry:v1:<runId>`. A record that cannot be read counts as
 * generation 0 for a step and is replaced by the next retry.
 *
 * @module workflow-retry-receipts
 */

import { MemoryStorage, textValueStore, type TextValueStore } from '@lostgradient/storage';

/** Where the receipts live. */
export const WORKFLOW_RETRY_KEY_PREFIX = 'bureau-workflow-retry:v1:';

/** One retry request, as its receipt keeps it. */
export interface WorkflowRetryRequest {
  /** The caller's identifier of the request, or `null` when it gave none. */
  readonly retryId: string | null;
  /** The step retried, counted from 1 in the canonical order of the run's revision. */
  readonly step: number;
  /** When the request was recorded. */
  readonly requestedAt: string;
}

/** The retry receipt of one instance. */
export interface WorkflowRetryReceipt {
  readonly schemaVersion: 1;
  readonly runId: string;
  /** How many retries of the instance were recorded: the generation its steps now run under. */
  readonly generation: number;
  /** The request recorded and not yet known to have reactivated the instance, or `null`. */
  readonly pending: WorkflowRetryRequest | null;
  /** The last request that reactivated the instance, or `null`. */
  readonly applied: WorkflowRetryRequest | null;
}

/** The receipts kept in one store. */
export interface WorkflowRetryReceipts {
  /** The receipt of `runId`, or `undefined` when it has none or it cannot be read. */
  readonly get: (runId: string) => Promise<WorkflowRetryReceipt | undefined>;
  /** The generation the steps of `runId` run under: `0` without a readable receipt. */
  readonly generation: (runId: string) => Promise<number>;
  /** Replace the receipt of its run. */
  readonly put: (receipt: WorkflowRetryReceipt) => Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRequest(value: unknown): value is WorkflowRetryRequest {
  return (
    isRecord(value) &&
    (value['retryId'] === null || typeof value['retryId'] === 'string') &&
    typeof value['step'] === 'number' &&
    Number.isSafeInteger(value['step']) &&
    typeof value['requestedAt'] === 'string'
  );
}

/** `text` as the receipt of `runId`, or `undefined` when it is not one. */
export function parseWorkflowRetryReceipt(
  text: string | null,
  runId: string,
): WorkflowRetryReceipt | undefined {
  if (text === null) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (
    !isRecord(value) ||
    value['schemaVersion'] !== 1 ||
    value['runId'] !== runId ||
    typeof value['generation'] !== 'number' ||
    !Number.isSafeInteger(value['generation']) ||
    value['generation'] < 0 ||
    (value['pending'] !== null && !isRequest(value['pending'])) ||
    (value['applied'] !== null && !isRequest(value['applied']))
  ) {
    return undefined;
  }
  return value as unknown as WorkflowRetryReceipt;
}

/** The receipts kept in `store`; one that lasts as long as the process when omitted. */
export function createWorkflowRetryReceipts(
  options: { readonly store?: TextValueStore | undefined } = {},
): WorkflowRetryReceipts {
  const store = options.store ?? textValueStore(new MemoryStorage());
  async function get(runId: string): Promise<WorkflowRetryReceipt | undefined> {
    return parseWorkflowRetryReceipt(
      await store.get(`${WORKFLOW_RETRY_KEY_PREFIX}${runId}`),
      runId,
    );
  }
  return {
    get,
    generation: async (runId) => {
      const receipt = await get(runId);
      return receipt?.generation ?? 0;
    },
    put: async (receipt) => {
      await store.set(`${WORKFLOW_RETRY_KEY_PREFIX}${receipt.runId}`, JSON.stringify(receipt));
    },
  };
}
