/**
 * What the agent specs share: calls to the Bureau's management plane through Playwright's request
 * context, the agent directory the host reports, and cleanup. An agent is a Markdown file in the
 * host's temporary home, so a spec that creates one removes it, and a later spec's list or count
 * never sees it.
 */
import type { APIRequestContext, Page } from '@playwright/test';
import { expect } from '@playwright/test';
import { join } from 'node:path';

import { AGENT_EDITOR_COPY } from '../../src/app/copy.ts';

/** What a spec writes through the management plane to create an agent, unless it says otherwise. */
export const BASE_DEFINITION = {
  name: 'End-to-end agent',
  description: 'Made by a specification',
  model: 'anthropic/sonnet',
  tools: ['demo:lookup-order'],
  skillDescriptors: [
    { id: 'cite', name: 'Cite', description: 'Cites the sources', tags: ['research'] },
  ],
  instructions: 'You are an end-to-end agent.',
} as const;

type JsonRpcAnswer = {
  result?: unknown;
  error?: { message: string; data?: { weftCode?: string } };
};

/** One call to the Bureau's management plane. A fault answers as `{ fault }`, a result as `{ result }`. */
export async function bureau(
  request: APIRequestContext,
  method: string,
  params: Record<string, unknown>,
): Promise<{ result?: unknown; fault?: { code: string; message: string } }> {
  const response = await request.post('/bureau/jsonrpc', {
    data: { jsonrpc: '2.0', id: method, method, params },
  });
  const body = (await response.json()) as JsonRpcAnswer;
  if (body.error !== undefined) {
    return { fault: { code: body.error.data?.weftCode ?? 'unknown', message: body.error.message } };
  }
  return { result: body.result };
}

export type AgentDetailResult = {
  id: string;
  source: 'code' | 'file';
  state: 'ready' | 'invalid';
  a2a: boolean;
  hash: string | null;
  problem: { code: string; message: string } | null;
  definition: {
    name: string;
    model: string;
    tools: string[];
    skillDescriptors: unknown[];
    a2a: boolean;
    instructions: string;
  } | null;
};

export async function readAgent(
  request: APIRequestContext,
  id: string,
): Promise<AgentDetailResult> {
  const answer = await bureau(request, 'bureau.agents.definitions.get', { id });
  expect(answer.fault, `reading ${id}`).toBeUndefined();
  return answer.result as AgentDetailResult;
}

/** Creates an agent file through the management plane, and answers its identifier and hash. */
export async function createAgentFile(
  request: APIRequestContext,
  id: string,
  definition: Record<string, unknown> = {},
): Promise<{ id: string; hash: string }> {
  const answer = await bureau(request, 'bureau.agents.definitions.create', {
    id,
    definition: { ...BASE_DEFINITION, ...definition },
  });
  expect(answer.fault, `creating ${id}`).toBeUndefined();
  return answer.result as { id: string; hash: string };
}

export type CatalogTool = {
  name: string;
  description: string;
  shortDescription: string | null;
  source: 'host' | 'bureau';
  defaultApproval: 'allow' | 'ask';
};

/** Opens the editor's Add tools picker, which every tool the catalog lists is chosen from. */
export async function openToolPicker(page: Page): Promise<void> {
  await page.getByRole('button', { name: AGENT_EDITOR_COPY.addToolsAction }).click();
  await expect(
    page.getByRole('dialog', { name: AGENT_EDITOR_COPY.toolPicker.title }),
  ).toBeVisible();
}

/** Closes the picker with Done. */
export async function closeToolPicker(page: Page): Promise<void> {
  await page.getByRole('button', { name: AGENT_EDITOR_COPY.toolPicker.done }).click();
  await expect(page.getByRole('dialog', { name: AGENT_EDITOR_COPY.toolPicker.title })).toBeHidden();
}

/** Gives the agent in the editor the named tools, through the picker, and closes it. */
export async function addTools(page: Page, names: readonly string[]): Promise<void> {
  await openToolPicker(page);
  for (const name of names) {
    await page.getByRole('checkbox', { name, exact: true }).check();
  }
  await closeToolPicker(page);
}

/** The models and tools `bureau.agents.catalog` offers, which is all the editor may offer. */
export async function readCatalog(
  request: APIRequestContext,
): Promise<{ models: { provider: string; model: string }[]; tools: CatalogTool[] }> {
  const answer = await bureau(request, 'bureau.agents.catalog', {});
  expect(answer.fault, 'reading the catalog').toBeUndefined();
  return answer.result as {
    models: { provider: string; model: string }[];
    tools: CatalogTool[];
  };
}

/** What `/host/paths` says about where the host keeps its configuration and its providers' keys. */
export type ProviderPaths = {
  configurationFile: string;
  providers: { name: string; secretFile: string }[];
};

export async function readProviderPaths(request: APIRequestContext): Promise<ProviderPaths> {
  const response = await request.get('/host/paths');
  expect(response.ok()).toBe(true);
  return (await response.json()) as ProviderPaths;
}

/** The directory the host keeps agent files in, which is inside the temporary home. */
export async function agentDirectory(request: APIRequestContext): Promise<string> {
  const response = await request.get('/host/paths');
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { agentDirectory: string }).agentDirectory;
}

export async function agentFilePath(request: APIRequestContext, id: string): Promise<string> {
  return join(await agentDirectory(request), `${id}.md`);
}

/** The wire fault code reading an agent answers with, or `undefined` when it reads. */
export async function faultCodeOf(
  request: APIRequestContext,
  id: string,
): Promise<string | undefined> {
  const answer = await bureau(request, 'bureau.agents.definitions.get', { id });
  return answer.fault?.code;
}

/** Deletes an agent if it still exists. A spec that already removed or broke the file is fine. */
export async function removeAgent(request: APIRequestContext, id: string): Promise<void> {
  const read = await bureau(request, 'bureau.agents.definitions.get', { id });
  const detail = read.result as AgentDetailResult | undefined;
  if (detail?.source !== 'file' || detail.hash === null) return;
  await bureau(request, 'bureau.agents.definitions.delete', { id, expectedHash: detail.hash });
}
