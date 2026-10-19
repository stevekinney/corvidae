/**
 * What the Tasks and Reviews specs share: finding the task a session's run became, and the AG-UI
 * mount's own record of what a tool did.
 */
import type { APIRequestContext } from '@playwright/test';

import { E2E_BASE_URL } from './e2e-constants.ts';
import { expect } from './fixtures.ts';

type TaskRow = { id: string; contextId: string; status: string };

/** Calls one Bureau operation as the page does and returns its result. */
export async function bureauCall(
  request: APIRequestContext,
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const response = await request.post(`${E2E_BASE_URL}/bureau/jsonrpc`, {
    data: { jsonrpc: '2.0', id: method, method, params },
  });
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as { result?: unknown; error?: unknown };
  if (body.error !== undefined) throw new Error(`${method} answered ${JSON.stringify(body.error)}`);
  return body.result;
}

/** The task of a session's run, which is the only one a session started through the mount has. */
export async function taskOfSession(request: APIRequestContext, threadId: string): Promise<TaskRow> {
  const result = (await bureauCall(request, 'bureau.tasks.list', { contextId: threadId })) as {
    tasks: TaskRow[];
  };
  const [task] = result.tasks;
  if (task === undefined) throw new Error(`The session ${threadId} has no task.`);
  return task;
}

/** The tasks of a session, newest first. */
export async function tasksOfSession(
  request: APIRequestContext,
  threadId: string,
): Promise<TaskRow[]> {
  const result = (await bureauCall(request, 'bureau.tasks.list', { contextId: threadId })) as {
    tasks: TaskRow[];
  };
  return result.tasks;
}

/** A session's conversation as AG-UI messages, which is where a tool's result is recorded. */
export async function threadMessages(
  request: APIRequestContext,
  threadId: string,
): Promise<unknown[]> {
  const response = await request.get(
    `${E2E_BASE_URL}/bureau/ag-ui/threads/${encodeURIComponent(threadId)}/messages`,
  );
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { messages: unknown[] }).messages;
}
