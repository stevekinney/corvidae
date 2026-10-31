/**
 * What the Tasks and Reviews specs share: finding the task a session's run became, and the AG-UI
 * mount's own record of what a tool did.
 */
import type { APIRequestContext } from '@playwright/test';

import { E2E_BASE_URL } from './e2e-constants.ts';
import { expect, loggedFailedResponse, type PageErrorLog } from './fixtures.ts';

type TaskRow = { id: string; contextId: string; status: string };

/** Calls one Bureau operation as the page does and returns its result. */
export async function bureauCall(
  request: APIRequestContext,
  method: string,
  params: Record<string, unknown>,
  origin: string = E2E_BASE_URL,
): Promise<unknown> {
  const response = await request.post(`${origin}/bureau/jsonrpc`, {
    data: { jsonrpc: '2.0', id: method, method, params },
  });
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as { result?: unknown; error?: unknown };
  if (body.error !== undefined) throw new Error(`${method} answered ${JSON.stringify(body.error)}`);
  return body.result;
}

/** The task of a session's run, which is the only one a session started through the mount has. */
export async function taskOfSession(
  request: APIRequestContext,
  threadId: string,
): Promise<TaskRow> {
  const result = (await bureauCall(request, 'bureau.tasks.list', { contextId: threadId })) as {
    tasks: TaskRow[];
  };
  const [task] = result.tasks;
  if (task === undefined) throw new Error(`The session ${threadId} has no task.`);
  return task;
}

/** A review a run is waiting on, as `bureau.reviews.list` shows it. */
export type WaitingReview = { id: string; runId: string; sessionId?: string; kind: string };

/** The review a session's run is waiting on, once the Bureau lists it. */
export async function waitingReviewOf(
  request: APIRequestContext,
  threadId: string,
  origin: string = E2E_BASE_URL,
): Promise<WaitingReview> {
  let found: WaitingReview | undefined;
  await expect
    .poll(async () => {
      const listed = (await bureauCall(request, 'bureau.reviews.list', {}, origin)) as {
        reviews: WaitingReview[];
      };
      found = listed.reviews.find((review) => review.sessionId === threadId);
      return found?.id;
    })
    .toBeTruthy();
  return found!;
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

/**
 * Covers the 404 the run page's read of the workflow engine logs for a run of the Bureau's (a task,
 * or a goal's attempt). On the default host those are engine runs, and the page asks the engine for
 * them; this suite's engine is a fixture that holds none of them, so it answers each read with a
 * 404 (the page shows no engine sections). How many reads there are follows the page's mounts and
 * refetches, so none is counted, and a read that lands after the test ends is no failure.
 */
export function expectEngineMissesForRuns(pageErrors: PageErrorLog): void {
  pageErrors.expectEvery({
    pattern: loggedFailedResponse(404, /\/v1\/workflows\/(?:run|goal)-[^\s)]+\)/),
    reason:
      'the fixture engine holds no task or attempt, so the run page’s engine read of one is a 404',
  });
}
