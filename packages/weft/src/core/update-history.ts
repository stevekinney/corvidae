/**
 * A workflow's update history (COR-1463): one `uph:` entry per update it received through the
 * durable request path, written `pending` in the same batch as the request and replaced in the
 * same batch as the response, so the history and the response cannot disagree. Unlike the request
 * (deleted on answer) and the response (swept after five minutes), an entry outlives both: terminal
 * cleanup never sweeps it and only a purge removes it.
 *
 * @module update-history
 */

import type { BatchOperation, Storage } from '../storage/interface.ts';
import { KEYS } from '../storage/interface.ts';
import { decode, encode } from './codec.ts';

/** Where an update stands in a workflow's update history. */
export type UpdateHistoryOutcome = 'pending' | 'completed' | 'failed';

/**
 * One entry of a workflow's update history (`uph:` keys, COR-1463): written
 * `pending` in the same batch as the request and replaced in the same batch as
 * the response, so the history and `upr:` cannot disagree. It keeps the outcome
 * after the response is swept, and it holds no payload or result.
 */
export interface UpdateHistoryEntry {
  updateId: string;
  name: string;
  receivedAt: number;
  outcome: UpdateHistoryOutcome;
  /** Absent while `pending`. */
  completedAt?: number | undefined;
  /** The failure's message; present only when `outcome` is `failed`. */
  error?: string | undefined;
}

/** What the response's batch needs to replace the request's `pending` history entry. */
export interface UpdateHistoryContext {
  name: string;
  /** The `createdAt` of the persisted request: it is part of the entry's key. */
  receivedAt: number;
}

/** One page of a workflow's update history, newest first. */
export interface UpdateHistoryPage {
  items: UpdateHistoryEntry[];
  /** Pass as `cursor` for the next page; absent on the last page. */
  nextCursor?: string | undefined;
}

export const DEFAULT_UPDATE_HISTORY_LIMIT = 50;
export const MAX_UPDATE_HISTORY_LIMIT = 200;
/** `<sixteen-digit receivedAt>:<updateId>`, the tail of an entry's key. */
const UPDATE_HISTORY_CURSOR_PATTERN = /^\d{16}:[^:\s]{1,128}$/u;

export function isUpdateHistoryCursor(value: string): boolean {
  return UPDATE_HISTORY_CURSOR_PATTERN.test(value);
}

/** The `pending` entry written in the same batch as the request it describes. */
export function pendingHistoryOperation(request: {
  workflowId: string;
  updateId: string;
  name: string;
  createdAt: number;
}): BatchOperation {
  const entry: UpdateHistoryEntry = {
    updateId: request.updateId,
    name: request.name,
    receivedAt: request.createdAt,
    outcome: 'pending',
  };
  return {
    type: 'put',
    key: KEYS.updateHistory(request.workflowId, request.createdAt, request.updateId),
    value: encode(entry),
  };
}

/** The entry that replaces the `pending` one, at the identical key, in the response's batch. */
export function answeredHistoryOperation(
  workflowId: string,
  updateId: string,
  history: UpdateHistoryContext,
  completedAt: number,
  error: string | undefined,
): BatchOperation {
  const entry: UpdateHistoryEntry = {
    updateId,
    name: history.name,
    receivedAt: history.receivedAt,
    outcome: error === undefined ? 'completed' : 'failed',
    completedAt,
    ...(error === undefined ? {} : { error }),
  };
  return {
    type: 'put',
    key: KEYS.updateHistory(workflowId, history.receivedAt, updateId),
    value: encode(entry),
  };
}

/** List a workflow's update history, newest first. */
export async function listUpdateHistory(
  storage: Storage,
  workflowId: string,
  options: { limit?: number; cursor?: string } = {},
): Promise<UpdateHistoryPage> {
  const limit = Math.min(options.limit ?? DEFAULT_UPDATE_HISTORY_LIMIT, MAX_UPDATE_HISTORY_LIMIT);
  const prefix = KEYS.updateHistoryPrefix(workflowId);
  const items: UpdateHistoryEntry[] = [];
  let lastKey: string | undefined;
  let more = false;

  // One entry past the limit tells a full last page from a page with more behind it.
  for await (const [key, value] of storage.scan(prefix, {
    reverse: true,
    limit: limit + 1,
    ...(options.cursor === undefined ? {} : { lt: `${prefix}${options.cursor}` }),
  })) {
    if (items.length === limit) {
      more = true;
      break;
    }
    items.push(decode(value) as UpdateHistoryEntry);
    lastKey = key;
  }

  return {
    items,
    ...(more && lastKey !== undefined ? { nextCursor: lastKey.slice(prefix.length) } : {}),
  };
}
