import {
  decodeRemoteTaskRecord,
  taskLedgerKey,
  type RemoteTaskRecord,
} from '../../core/task-ledger/task-ledger.ts';
import type { ServeOptions } from '../index.ts';
import { isAuthenticated, type Principal } from '../principal.ts';
import { readRestJsonBody, type RestBodyReadOptions } from '../rest-body.ts';
import type { ServerContext } from './context.ts';
import type {
  TaskLedgerCompletionFailureReason,
  TaskResultDisposition,
} from './task-ledger-completion.ts';
import { recordTaskBacklogMetric } from './task-metrics.ts';
import { applyWorkerTaskResult } from './task-result-application.ts';
import {
  authorizeTaskResultForCurrentAttempt,
  currentAttemptFromLedgerRecord,
  type TaskResultAuthorizationFailure,
} from './task-result-authorization.ts';
import { taskResultPayloadSizeError } from './task-result-resolution.ts';

const TASK_RESULT_RE = /^\/v1\/tasks\/([\w-]+)\/result$/;

export async function parseTaskResultBody(
  request: Request,
  options?: RestBodyReadOptions,
): Promise<Record<string, unknown> | null | Response> {
  try {
    return (await readRestJsonBody(request, options)) as Record<string, unknown>;
  } catch (error) {
    if (isPayloadTooLargeFault(error)) {
      return Response.json({ error: error.message }, { status: 413 });
    }
    return null;
  }
}

function isPayloadTooLargeFault(value: unknown): value is { message: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<string, unknown>)['code'] === 'PayloadTooLarge' &&
    typeof (value as Record<string, unknown>)['message'] === 'string'
  );
}

type ValidatedTaskResult = {
  operationId: string;
  status: 'completed' | 'failed' | 'cancelled';
  workerId: string | undefined;
  value: unknown;
  error: string | undefined;
  attemptToken: string;
  workflowRevision: string | undefined;
};

type TaskResultStatus = ValidatedTaskResult['status'];

function isTaskResultStatus(value: string): value is TaskResultStatus {
  return value === 'completed' || value === 'failed' || value === 'cancelled';
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function authorizeWorkerPrincipal(principal: Principal | undefined): Response | null {
  if (principal === undefined) return null;
  if (isAuthenticated(principal) && principal.hasScope('workers:write')) return null;
  return Response.json({ error: 'Forbidden' }, { status: 403 });
}

export async function awaitTaskLedgerRecovery(context: ServerContext): Promise<Response | null> {
  try {
    await context.taskLedgerRecovery.ready;
    return null;
  } catch (error) {
    return Response.json(
      {
        error: `Startup task-ledger recovery failed — cannot admit new task claims: ${error instanceof Error ? error.message : String(error)}`,
      },
      { status: 503 },
    );
  }
}

function validateTaskResultBody(body: Record<string, unknown>): ValidatedTaskResult | Response {
  const operationId = body['operationId'];
  const status = body['status'];
  if (typeof operationId !== 'string' || typeof status !== 'string') {
    return Response.json(
      { error: 'Missing required fields: operationId, status' },
      { status: 400 },
    );
  }

  if (!isTaskResultStatus(status)) {
    return Response.json(
      { error: 'status must be "completed", "failed", or "cancelled"' },
      { status: 400 },
    );
  }

  const rawAttemptToken = body['attemptToken'];
  if (typeof rawAttemptToken !== 'string' || rawAttemptToken === '') {
    return Response.json({ error: 'attemptToken must be a non-empty string' }, { status: 400 });
  }

  return {
    operationId,
    status,
    workerId: optionalString(body['workerId']),
    value: body['value'],
    error: optionalString(body['error']),
    attemptToken: rawAttemptToken,
    workflowRevision: optionalString(body['workflowRevision']),
  };
}

/** Every permanent rejection reason exposed by long-poll result submission. */
export type LongPollTaskResultRejectionReason =
  | TaskResultAuthorizationFailure
  | 'queue-mismatch'
  | 'revision-mismatch'
  | TaskLedgerCompletionFailureReason;

type LongPollCompletionAuthorization =
  Readonly<{ ok: true }> | Readonly<{ ok: false; reason: LongPollTaskResultRejectionReason }>;

function isLongPollCompletionAuthorized(
  record: RemoteTaskRecord | null,
  validated: ValidatedTaskResult,
  queue: string,
): LongPollCompletionAuthorization {
  if (record !== null && record.queue !== queue) {
    return { ok: false, reason: 'queue-mismatch' };
  }

  const authorization = authorizeTaskResultForCurrentAttempt(
    currentAttemptFromLedgerRecord(record),
    validated.workerId,
    validated.attemptToken,
  );
  if (!authorization.ok) return authorization;

  if (
    record !== null &&
    (record.state === 'leased' || record.state === 'completing' || record.state === 'cancelling') &&
    record.workflowRevision !== undefined &&
    validated.workflowRevision !== record.workflowRevision
  ) {
    return { ok: false, reason: 'revision-mismatch' };
  }

  return { ok: true };
}

async function applyTaskResult(
  context: ServerContext,
  options: ServeOptions,
  result: ValidatedTaskResult,
): Promise<
  | { ok: true; disposition: TaskResultDisposition }
  | { ok: false; reason: string; reasonCode?: TaskLedgerCompletionFailureReason }
> {
  const { operationId, status, value, error } = result;

  const applied = await applyWorkerTaskResult(
    options,
    context.metricsCollector,
    {
      operationId,
      attemptToken: result.attemptToken,
      status,
      ...(status === 'completed' ? { value } : {}),
      ...(status !== 'completed' && error !== undefined ? { error } : {}),
    },
    result.workerId,
  );
  if (!applied.ok) {
    return {
      ok: false,
      reason: applied.reason,
      ...(applied.reasonCode !== undefined ? { reasonCode: applied.reasonCode } : {}),
    };
  }

  context.deadlineTracker.remove(operationId);
  if (applied.disposition !== 'dead-lettered') {
    context.taskQueue.complete({ operationId, status, value, error });
    context.registry?.completeTask(operationId);
    recordTaskBacklogMetric(context.metricsCollector, context.taskQueue);
  }

  return { ok: true, disposition: applied.disposition };
}

function taskResultForbiddenResponse(
  operationId: string,
  attemptToken: string,
  reason?: LongPollTaskResultRejectionReason,
): Response {
  return Response.json(
    { error: 'Forbidden', operationId, attemptToken, ...(reason !== undefined ? { reason } : {}) },
    { status: 403 },
  );
}

function payloadSizeExceededResponse(error: {
  code: string;
  message: string;
  maxBytes: number;
  serializedBytes: number;
  payloadKind: string;
}): Response {
  return Response.json(
    {
      error: error.message,
      code: error.code,
      maxBytes: error.maxBytes,
      serializedBytes: error.serializedBytes,
      payloadKind: error.payloadKind,
    },
    { status: 413 },
  );
}

async function applyOversizedTaskResult(
  context: ServerContext,
  options: ServeOptions,
  result: ValidatedTaskResult,
  payloadError: NonNullable<ReturnType<typeof taskResultPayloadSizeError>>,
): Promise<void> {
  const rejected = await applyWorkerTaskResult(
    options,
    context.metricsCollector,
    {
      operationId: result.operationId,
      attemptToken: result.attemptToken,
      status: 'failed',
      error: payloadError.message,
    },
    result.workerId,
  );
  if (rejected.ok) {
    context.deadlineTracker.remove(result.operationId);
    if (rejected.disposition !== 'dead-lettered') {
      context.taskQueue.complete({
        operationId: result.operationId,
        status: 'failed',
        error: payloadError.message,
      });
      recordTaskBacklogMetric(context.metricsCollector, context.taskQueue);
    }
    return;
  }
  console.error(
    `[weft] Failed to persist oversized task result rejection for task "${result.operationId}":`,
    rejected.reason,
  );
}

async function submitValidatedTaskResult(
  context: ServerContext,
  options: ServeOptions,
  result: ValidatedTaskResult,
  queue: string,
): Promise<Response> {
  const record = decodeRemoteTaskRecord(
    await options.engine.storage.get(taskLedgerKey(result.operationId)),
  );
  const authorization = isLongPollCompletionAuthorized(record, result, queue);
  if (!authorization.ok) {
    return taskResultForbiddenResponse(
      result.operationId,
      result.attemptToken,
      authorization.reason,
    );
  }

  const payloadError = taskResultPayloadSizeError(
    {
      status: result.status,
      ...(result.status === 'completed' ? { value: result.value } : { error: result.error }),
    },
    context.payloadSizeMaxBytes,
  );
  if (payloadError !== null) {
    await applyOversizedTaskResult(context, options, result, payloadError);
    return payloadSizeExceededResponse(payloadError);
  }

  const applied = await applyTaskResult(context, options, result);
  if (applied.ok) {
    return Response.json({ ok: true, disposition: applied.disposition });
  }
  console.error(
    `[weft] Failed to commit task result for "${result.operationId}" through the durable ledger:`,
    applied.reason,
  );
  return taskResultForbiddenResponse(result.operationId, result.attemptToken, applied.reasonCode);
}

export async function handleTaskResultRequest(
  context: ServerContext,
  options: ServeOptions,
  request: Request,
  url: URL,
  principal?: Principal,
): Promise<Response | null> {
  if (request.method !== 'POST') {
    return null;
  }

  const completeMatch = TASK_RESULT_RE.exec(url.pathname);
  if (!completeMatch?.[1]) {
    return null;
  }
  const queue = decodeURIComponent(completeMatch[1]);

  const authorizationResponse = authorizeWorkerPrincipal(principal);
  if (authorizationResponse !== null) return authorizationResponse;

  const recoveryResponse = await awaitTaskLedgerRecovery(context);
  if (recoveryResponse !== null) return recoveryResponse;

  const body = await parseTaskResultBody(
    request,
    options.maxRequestBodyBytes !== undefined ? { maxBodyBytes: options.maxRequestBodyBytes } : {},
  );
  if (body instanceof Response) {
    return body;
  }
  if (body === null) {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const validated = validateTaskResultBody(body);
  if (validated instanceof Response) {
    return validated;
  }
  return submitValidatedTaskResult(context, options, validated, queue);
}
