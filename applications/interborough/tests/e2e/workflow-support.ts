/**
 * What the Workflows specs share: calls to the Bureau's workflow operations through Playwright's
 * request context, the directory the host reports, and cleanup. A workflow is a JSON file in the
 * host's temporary home, so a spec that creates one removes it, and a later spec's list never sees
 * it. The files the specs read without changing are seeded by `e2e-server.ts`.
 */
import type { APIRequestContext, Locator } from '@playwright/test';
import { expect } from '@playwright/test';
import { join } from 'node:path';

import { WORKFLOW_COPY } from '../../src/app/copy.ts';
import { bureau } from './agent-support.ts';

/** The files `e2e-server.ts` seeds into the host's workflow directory before it starts. */
export const SEEDED_WORKFLOWS = {
  /** A file that loads, written by the seeded `assistant`, started by a schedule. */
  digest: 'e2e-digest',
  /** A file that loads, started by the signal `e2e-begin`, whose one step waits for `e2e-approve`. */
  approval: 'e2e-approval',
  /** A file the Bureau cannot use, so it is listed with its error. */
  broken: 'e2e-broken',
} as const;

export const APPROVAL_START_SIGNAL = 'e2e-begin';
export const APPROVAL_SIGNAL = 'e2e-approve';

/** What a spec writes through the Bureau to create a workflow, unless it says otherwise. */
export const BASE_WORKFLOW = {
  agent: 'assistant',
  trigger: { kind: 'schedule', spec: '24h' },
  steps: [
    { kind: 'activity', handler: 'agent', input: { agent: 'assistant', message: 'Say hello.' } },
  ],
} as const;

export type WorkflowDetailResult = {
  id: string;
  state: 'ready' | 'invalid';
  hash: string | null;
  paused: boolean;
  agent: string | null;
  text: string | null;
  problem: { code: string; message: string } | null;
};

export async function readWorkflow(
  request: APIRequestContext,
  id: string,
): Promise<WorkflowDetailResult> {
  const answer = await bureau(request, 'bureau.workflows.get', { id });
  expect(answer.fault, `reading ${id}`).toBeUndefined();
  return answer.result as WorkflowDetailResult;
}

/** The wire fault code reading a workflow answers with, or `undefined` when it reads. */
export async function workflowFaultCode(
  request: APIRequestContext,
  id: string,
): Promise<string | undefined> {
  const answer = await bureau(request, 'bureau.workflows.get', { id });
  return answer.fault?.code;
}

/** Creates a workflow file through the Bureau, and answers its identifier and hash. */
export async function createWorkflowFile(
  request: APIRequestContext,
  id: string,
  definition: Record<string, unknown> = {},
): Promise<{ id: string; hash: string }> {
  const answer = await bureau(request, 'bureau.workflows.create', {
    id,
    definition: { ...BASE_WORKFLOW, ...definition },
  });
  expect(answer.fault, `creating ${id}`).toBeUndefined();
  return answer.result as { id: string; hash: string };
}

/** The directory the host keeps workflow files in, which is inside the temporary home. */
export async function workflowDirectory(request: APIRequestContext): Promise<string> {
  const response = await request.get('/host/paths');
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { workflowDirectory: string }).workflowDirectory;
}

export async function workflowFilePath(request: APIRequestContext, id: string): Promise<string> {
  return join(await workflowDirectory(request), `${id}.json`);
}

/** Deletes a workflow if it still exists. A spec that already removed or broke the file is fine. */
export async function removeWorkflow(request: APIRequestContext, id: string): Promise<void> {
  const read = await bureau(request, 'bureau.workflows.get', { id });
  const detail = read.result as WorkflowDetailResult | undefined;
  if (detail?.hash === undefined || detail.hash === null) return;
  await bureau(request, 'bureau.workflows.delete', { id, expectedHash: detail.hash });
}

export type RunSummary = { id: string; workflow: string; status: string };

/** The instances of one workflow, newest first, as `bureau.workflows.runs.list` shows them. */
export async function listWorkflowRuns(
  request: APIRequestContext,
  workflow: string,
): Promise<RunSummary[]> {
  const answer = await bureau(request, 'bureau.workflows.runs.list', { workflow, limit: 100 });
  expect(answer.fault, `listing the runs of ${workflow}`).toBeUndefined();
  return (answer.result as { runs: RunSummary[] }).runs;
}

/** The status of one instance of a workflow file. */
export async function workflowRunStatus(
  request: APIRequestContext,
  runId: string,
): Promise<string> {
  const answer = await bureau(request, 'bureau.workflows.runs.get', { runId });
  expect(answer.fault, `reading run ${runId}`).toBeUndefined();
  return (answer.result as { status: string }).status;
}

/** Opens the JSON tab of the workflow builder on `root`, whose editor holds the file's text. */
export async function openJsonTab(root: Locator): Promise<void> {
  await root.getByRole('tab', { name: WORKFLOW_COPY.builder.jsonTab }).click();
}
