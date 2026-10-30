/**
 * COR-1935 — a chat's steered effort reaches the provider request. The host serves one agent per
 * real provider adapter (Anthropic, OpenAI, Gemini) over a stubbed transport; `bureau.contexts.steer`
 * sets the effort over HTTP, and the body the adapter then sends carries it: from the next step of a
 * running chat, and from the first step of the next run of an idle one. A model that takes no effort
 * is not failed by one.
 */
import { createAgent } from '@lostgradient/operative';
import { createAnthropicProvider } from '@lostgradient/operative-anthropic';
import { createGeminiProvider } from '@lostgradient/operative-gemini';
import { createOpenAIProvider } from '@lostgradient/operative-openai';
import { waitUntil } from '@lostgradient/testing/wait-until';
import { createTool } from 'armorer';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

import { writeProviderHome } from './fake-provider.test-support.ts';
import { startHost, type Host, type HostOptions } from './host.ts';

const noop = createTool({
  name: 'noop',
  description: 'Does nothing',
  input: z.object({}),
  execute: async () => 'ok',
});

/** What a stubbed transport answers for its nth request (from 1): a tool call, or the end. */
type Answer = 'tool' | 'end';
const answerFor = (call: number): Answer => (call % 2 === 1 ? 'tool' : 'end');

/**
 * A transport stub: the bodies it was sent, and a gate that holds the very first request until a
 * test releases it, so a test can steer while a run is mid-step.
 */
function transport() {
  const bodies: Record<string, unknown>[] = [];
  const gate = Promise.withResolvers<void>();
  const take = async (body: Record<string, unknown>): Promise<Answer> => {
    bodies.push(body);
    const call = bodies.length;
    if (call === 1) await gate.promise;
    return answerFor(call);
  };
  return { bodies, release: () => gate.resolve(), take };
}

type Agent = NonNullable<HostOptions['extraAgents']>['agents'][string];

type Case = {
  readonly provider: string;
  /** The agent over the real adapter, whose client is the stub. */
  readonly agent: (take: (body: Record<string, unknown>) => Promise<Answer>) => Agent;
  /** What the adapter put on the wire for the effort, or `undefined` when it sent none. */
  readonly wire: (body: Record<string, unknown>) => unknown;
  /** The wire value for the steered effort `high`. */
  readonly high: unknown;
};

const CASES: readonly Case[] = [
  {
    provider: 'anthropic',
    agent: (take) =>
      createAgent({
        name: 'effort-anthropic',
        tools: { noop },
        generate: createAnthropicProvider({
          model: 'claude-opus-5-5',
          client: {
            messages: {
              create: async (body: never) =>
                (await take(body)) === 'tool'
                  ? {
                      content: [
                        {
                          type: 'tool_use',
                          id: `toolu_${crypto.randomUUID()}`,
                          name: 'noop',
                          input: {},
                        },
                      ],
                      usage: { input_tokens: 1, output_tokens: 1 },
                      stop_reason: 'tool_use',
                    }
                  : {
                      content: [{ type: 'text', text: 'done' }],
                      usage: { input_tokens: 1, output_tokens: 1 },
                      stop_reason: 'end_turn',
                    },
            },
          },
        }),
      }),
    wire: (body) => (body['output_config'] as { effort?: string } | undefined)?.effort,
    high: 'high',
  },
  {
    provider: 'openai',
    agent: (take) =>
      createAgent({
        name: 'effort-openai',
        tools: { noop },
        generate: createOpenAIProvider({
          model: 'o3',
          client: {
            chat: {
              completions: {
                create: async (body: never) =>
                  (await take(body)) === 'tool'
                    ? {
                        choices: [
                          {
                            message: {
                              content: null,
                              tool_calls: [
                                {
                                  id: `call_${crypto.randomUUID()}`,
                                  type: 'function',
                                  function: { name: 'noop', arguments: '{}' },
                                },
                              ],
                            },
                            finish_reason: 'tool_calls',
                          },
                        ],
                      }
                    : {
                        choices: [{ message: { content: 'done' }, finish_reason: 'stop' }],
                      },
              },
            },
          },
        }),
      }),
    wire: (body) => body['reasoning_effort'],
    high: 'high',
  },
  {
    provider: 'gemini',
    agent: (take) =>
      createAgent({
        name: 'effort-gemini',
        tools: { noop },
        generate: createGeminiProvider({
          model: 'gemini-2.5-pro',
          client: {
            models: {
              generateContent: async (body: never) =>
                (await take(body)) === 'tool'
                  ? {
                      candidates: [
                        { content: { parts: [{ functionCall: { name: 'noop', args: {} } }] } },
                      ],
                    }
                  : { candidates: [{ content: { parts: [{ text: 'done' }] } }] },
            },
          },
        }),
      }),
    wire: (body) =>
      (body['config'] as { thinkingConfig?: { thinkingBudget?: number } } | undefined)
        ?.thinkingConfig?.thinkingBudget,
    // `high` is the 16384-token thinking budget.
    high: 16384,
  },
];

const directories: string[] = [];
const hosts: Host[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

/** A host serving `agent`, with a catalog that holds the efforts a steer is checked against. */
async function start(agent: Agent): Promise<Host> {
  const home = await mkdtemp(join(tmpdir(), 'interborough-effort-'));
  directories.push(home);
  await writeProviderHome(home);
  const host = await startHost({
    environment: { INTERBOROUGH_HOME: home },
    port: 0,
    extraAgents: { agents: { [agent.name]: agent } },
  });
  hosts.push(host);
  return host;
}

async function call(host: Host, method: string, params: unknown): Promise<unknown> {
  const response = await fetch(new URL('/bureau/jsonrpc', host.url), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: method, method, params }),
  });
  const body = (await response.json()) as { result?: unknown; error?: unknown };
  if (body.error !== undefined) throw new Error(JSON.stringify(body.error));
  return body.result;
}

/** One run of a chat, read to its end. */
async function send(host: Host, agentName: string, threadId: string): Promise<void> {
  const response = await fetch(new URL(`/bureau/ag-ui/agents/${agentName}/run`, host.url), {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify({
      threadId,
      runId: `run-${crypto.randomUUID()}`,
      messages: [{ id: `user-${crypto.randomUUID()}`, role: 'user', content: 'go' }],
      tools: [],
      context: [],
      state: {},
      forwardedProps: {},
    }),
  });
  expect(response.status).toBe(200);
  await response.text();
}

const steerEffort = (host: Host, contextId: string, effort: string) =>
  call(host, 'bureau.contexts.steer', {
    contextId,
    commandId: `steer-${crypto.randomUUID()}`,
    effort,
  });

describe.each(CASES)('a steered effort reaches the $provider request', (scenario) => {
  test('from the next step of a running chat', async () => {
    const stub = transport();
    const agent = scenario.agent(stub.take);
    const host = await start(agent);
    const threadId = `running-${crypto.randomUUID()}`;

    const run = send(host, agent.name, threadId);
    await waitUntil(() => stub.bodies.length === 1, { message: 'first step sent' });
    const outcome = await steerEffort(host, threadId, 'high');
    stub.release();
    await run;

    expect(outcome).toMatchObject({ outcome: 'accepted' });
    // The first step was already on the wire; the next carries the effort.
    expect(stub.bodies.map(scenario.wire)).toEqual([undefined, scenario.high]);
    expect(await call(host, 'bureau.contexts.get', { contextId: threadId })).toMatchObject({
      effort: 'high',
    });
  });

  test('from the first step of the next run of an idle chat', async () => {
    const stub = transport();
    stub.release();
    const agent = scenario.agent(stub.take);
    const host = await start(agent);
    const threadId = `idle-${crypto.randomUUID()}`;
    await send(host, agent.name, threadId);
    const before = stub.bodies.length;

    const outcome = await steerEffort(host, threadId, 'high');
    await send(host, agent.name, threadId);

    expect(outcome).toMatchObject({ outcome: 'accepted' });
    expect(stub.bodies.slice(0, before).map(scenario.wire)).toEqual([undefined, undefined]);
    expect(stub.bodies.slice(before).map(scenario.wire)).toEqual([scenario.high, scenario.high]);
  });
});

describe('a steered effort on a model that takes no effort', () => {
  test('is dropped from the request and does not fail the step', async () => {
    const stub = transport();
    stub.release();
    const agent = createAgent({
      name: 'effort-plain-openai',
      tools: { noop },
      generate: createOpenAIProvider({
        model: 'gpt-4.1',
        client: {
          chat: {
            completions: {
              create: async (body: never) => {
                await stub.take(body);
                return { choices: [{ message: { content: 'done' }, finish_reason: 'stop' }] };
              },
            },
          },
        },
      }),
    });
    const host = await start(agent);
    const threadId = `plain-${crypto.randomUUID()}`;
    await send(host, agent.name, threadId);

    const outcome = await steerEffort(host, threadId, 'max');
    await send(host, agent.name, threadId);

    // Admitted: the catalog holds the effort, so the drop is the adapter's.
    expect(outcome).toMatchObject({ outcome: 'accepted' });
    expect(stub.bodies.map((body) => body['reasoning_effort'])).toEqual([undefined, undefined]);
  });
});
