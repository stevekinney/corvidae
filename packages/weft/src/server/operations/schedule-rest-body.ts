import type { RestInputContext } from '../rest-binding.ts';
import { readOptionalRestJsonBody, readRestJsonBody } from '../rest-body.ts';
import { invalidParamsFault, isOperationFault } from './operation-helpers.ts';

export type SharedScheduleRestFields = {
  readonly cronExpression: unknown;
  readonly every: unknown;
  readonly description: unknown;
  readonly overlap: unknown;
  readonly backfill: unknown;
  readonly jitter: unknown;
  readonly timeZone: unknown;
  readonly revisionPolicy: unknown;
};

function isJsonObjectLikeRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export async function parseScheduleRestBodyRequestRecord(
  request: Request,
  context?: RestInputContext,
): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await readRestJsonBody(request, context);
  } catch (error) {
    if (isOperationFault(error)) throw error;
    throw invalidParamsFault('Invalid JSON body');
  }

  if (!isJsonObjectLikeRecord(body)) {
    throw invalidParamsFault('Request body must be a JSON object');
  }

  return body;
}

/**
 * The JSON object a bodiless-by-default request may carry: an empty body is `{}`, and a body that is
 * not a JSON object is an `InvalidParams` fault, as for {@link parseScheduleRestBodyRequestRecord}.
 */
export async function parseOptionalScheduleRestBodyRecord(
  request: Request,
  context?: RestInputContext,
): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await readOptionalRestJsonBody(request, context);
  } catch (error) {
    if (isOperationFault(error)) throw error;
    throw invalidParamsFault('Invalid JSON body');
  }

  if (body === undefined) return {};
  if (!isJsonObjectLikeRecord(body) || Array.isArray(body)) {
    throw invalidParamsFault('Request body must be a JSON object');
  }

  return body;
}

export function extractSharedScheduleRestFields(
  record: Record<string, unknown>,
): SharedScheduleRestFields {
  return {
    cronExpression: Object.hasOwn(record, 'cronExpression') ? record['cronExpression'] : undefined,
    every: Object.hasOwn(record, 'every') ? record['every'] : undefined,
    description: record['description'],
    overlap: record['overlap'],
    backfill: record['backfill'],
    jitter: record['jitter'],
    timeZone: record['timeZone'],
    revisionPolicy: record['revisionPolicy'],
  };
}
