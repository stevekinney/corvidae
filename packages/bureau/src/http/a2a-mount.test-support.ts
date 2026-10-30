/** Shared fixtures for the Bureau A2A mount tests: a Bureau serving agents, and JSON-RPC calls. */
import { createAgent, type GenerateFunction } from '@lostgradient/operative';

import type { AgentDefinitions, BureauAgentCatalog } from '../agent-catalog.ts';
import { type OpenedBureau, openBureau } from './management/management-fixtures.test-support.ts';

/**
 * Rewrites a persisted agent's file with `a2a: false`, the way an editor turns the opt-in off,
 * and rescans so the mount sees it. Throws when the agent has no readable file.
 */
export async function optOutOfA2A(
  agents: Pick<BureauAgentCatalog<AgentDefinitions>, 'detail' | 'update' | 'refresh'>,
  id: string,
): Promise<void> {
  const detail = await agents.detail(id);
  if (detail?.definition == null || detail.definitionHash === undefined) {
    throw new Error(`expected the file of agent "${id}"`);
  }
  await agents.update(
    id,
    { ...detail.definition, a2a: false },
    { expectedHash: detail.definitionHash },
  );
  await agents.refresh();
}

export const PUBLIC_URL = 'http://localhost';
export const BUREAU_ID = 'management-bureau';

// A JSON-RPC body read back from the wire: each test asserts the shape it needs.
export type Json = any;

export function answering(content: string): GenerateFunction {
  return async () => ({ content, toolCalls: [] });
}

/** A model that parks the run on a human wait, then answers with what it was told. */
export function parksThenAnswers(signalName = 'human-response'): GenerateFunction {
  let calls = 0;
  return async () => {
    calls += 1;
    return calls === 1
      ? {
          content: '',
          toolCalls: [
            {
              id: 'wait-1',
              name: 'requestHumanInput',
              arguments: { signalName, prompt: 'Which?' },
            },
          ],
        }
      : { content: 'resolved', toolCalls: [] };
  };
}

export async function withA2A<T>(
  agents: Record<string, GenerateFunction>,
  body: (opened: OpenedBureau) => Promise<T>,
  options: {
    a2aAgents?: readonly string[];
    handlerOptions?: NonNullable<Parameters<typeof openBureau>[0]>['handlerOptions'];
  } = {},
): Promise<T> {
  const opened = await openBureau({
    agents: Object.fromEntries(
      Object.entries(agents).map(([name, generate]) => [
        name,
        createAgent({ name, description: `The ${name} agent`, generate }),
      ]),
    ),
    a2aAgents: options.a2aAgents ?? Object.keys(agents),
    handlerOptions: { publicUrl: PUBLIC_URL, ...options.handlerOptions },
  });
  try {
    return await body(opened);
  } finally {
    await opened.dispose();
  }
}

export type CallOptions = {
  readonly key?: string | undefined;
  readonly headers?: Record<string, string>;
  readonly version?: string | null;
};

export async function call(
  opened: OpenedBureau,
  agent: string,
  method: string,
  params: Json,
  options: CallOptions = {},
): Promise<{ status: number; headers: Headers; body: Json }> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...options.headers,
  };
  if (options.version !== null) headers['A2A-Version'] = options.version ?? '1.0';
  if (options.key !== undefined || !('key' in options))
    headers['X-API-Key'] = options.key ?? 'alice-key';
  const response = await opened.handler(
    new Request(`http://localhost/a2a/${agent}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    }),
  );
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    body: text === '' ? {} : JSON.parse(text),
  };
}

let counter = 0;
export function message(text: string, extra: Json = {}): Json {
  counter += 1;
  return { messageId: `m-${counter}`, role: 'ROLE_USER', parts: [{ text }], ...extra };
}

export async function send(
  opened: OpenedBureau,
  agent: string,
  params: Json,
  options: CallOptions = {},
) {
  return call(opened, agent, 'SendMessage', params, options);
}

export async function sendForTask(
  opened: OpenedBureau,
  agent: string,
  params: Json,
  options: CallOptions = {},
): Promise<Json> {
  const sent = await send(opened, agent, params, options);
  return taskOf(sent.body);
}

export function taskOf(body: Json): Json {
  return body.result?.task ?? body.result;
}
