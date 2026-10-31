/**
 * COR-1853 — what the Access tab saves is enforced in a chat. The tab writes an agent file through
 * `bureau.agents.definitions.update` (`updateAgent`), so each case writes the file that way and then
 * chats with the agent over AG-UI, with the real host and Bureau and a stub model:
 *
 * - `lookup-order` only reads, so under the default `on-changes` a chat runs it without asking;
 *   once the tab sets it to `always`, the next chat parks on an approval before the tool runs;
 *   set to `blocked`, the tool never runs and the model is told so.
 * - A tool budget saved on the tab ends a run that reaches it, with the limit named in the reason.
 * - A cost budget saved on the tab ends a run that reaches it, with `perRunUsd` named.
 */
import { resolveProviderGenerate } from '@lostgradient/bureau';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createAgent,
  getAgentDefinition,
  updateAgent,
  type AgentDefinitionInput,
} from '../lib/agent-definitions.ts';
import type { Fetcher } from '../lib/bureau-client.ts';
import { urlOf } from '../lib/bureau-stub.test-support.ts';
import { writeProviderHome } from './fake-provider.test-support.ts';
import { enableDemoPlugin, pluginsWithUnseededDemo } from './demo-plugin.test-support.ts';
import { startHost, type Host, type HostOptions } from './host.ts';

const directories: string[] = [];
const hosts: Host[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

/** How many tokens the stub model reports each request used, so a cost budget can be reached. */
const TOKENS_PER_REQUEST = 2_000_000;

/**
 * An Anthropic client that asks for `lookup-order` until the tool has answered once, then says it
 * is done; with `loop`, it never stops asking, so only a limit on the run ends it.
 */
function stubClient(options: { loop: boolean }) {
  let calls = 0;
  return {
    messages: {
      create: async (body: { messages: { role: string; content: unknown }[] }) => {
        const blocks: unknown = body.messages.at(-1)?.content;
        const last: unknown = Array.isArray(blocks) ? blocks.at(-1) : undefined;
        const afterTool = (last as { type?: string } | undefined)?.type === 'tool_result';
        const done = afterTool && !options.loop;
        calls += 1;
        return {
          id: `message-${String(calls)}`,
          type: 'message',
          role: 'assistant',
          model: 'claude-sonnet-5',
          content: done
            ? [{ type: 'text', text: 'Looked it up.' }]
            : [
                {
                  type: 'tool_use',
                  id: `toolu_${crypto.randomUUID()}`,
                  name: 'lookup-order',
                  input: { orderId: 'order-1001' },
                },
              ],
          stop_reason: done ? 'end_turn' : 'tool_use',
          stop_sequence: null,
          usage: { input_tokens: TOKENS_PER_REQUEST, output_tokens: 1 },
        };
      },
    },
  };
}

async function start(loop: boolean): Promise<{ host: Host; fetcher: Fetcher }> {
  const home = await mkdtemp(join(tmpdir(), 'interborough-access-'));
  directories.push(home);
  await writeProviderHome(home);
  await enableDemoPlugin(home);
  const client = stubClient({ loop });
  const resolver: NonNullable<HostOptions['resolveProviderGenerate']> = (
    definitions,
    provider,
    streamEventTarget,
    streaming,
  ) =>
    resolveProviderGenerate(
      definitions,
      Object.assign({}, provider, { client }),
      streamEventTarget,
      streaming,
    );
  const host = await startHost({
    environment: { INTERBOROUGH_HOME: home },
    port: 0,
    plugins: pluginsWithUnseededDemo(),
    resolveProviderGenerate: resolver,
  });
  hosts.push(host);
  const fetcher: Fetcher = (input, init) => fetch(new URL(urlOf(input), host.url), init);
  return { host, fetcher };
}

const BASE: AgentDefinitionInput = {
  name: 'Clerk',
  description: 'Looks orders up.',
  model: 'anthropic/sonnet',
  tools: ['demo:lookup-order'],
  skillDescriptors: [],
  instructions: 'Look the order up.',
};

/**
 * What the Access tab writes: the file as read, with `access` applied over it, over the hash it
 * read. This is the same carry rule as `AgentAccessState.toDefinition`.
 */
async function saveAccess(
  fetcher: Fetcher,
  access: Pick<AgentDefinitionInput, 'toolApproval' | 'costBudget' | 'toolBudget'>,
): Promise<void> {
  const detail = await getAgentDefinition('clerk', { fetch: fetcher });
  if (detail.definition === null || detail.hash === null) throw new Error('expected a file');
  const file = detail.definition;
  await updateAgent(
    'clerk',
    detail.hash,
    {
      name: file.name,
      description: file.description,
      model: file.model,
      tools: file.tools,
      skillDescriptors: file.skillDescriptors,
      a2a: file.a2a,
      instructions: file.instructions,
      ...access,
    },
    { fetch: fetcher },
  );
}

async function chat(host: Host, threadId: string): Promise<string> {
  const response = await fetch(new URL('/bureau/ag-ui/agents/clerk/run', host.url), {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify({
      threadId,
      runId: `run-${crypto.randomUUID()}`,
      messages: [{ id: 'user-1', role: 'user', content: 'Find order order-1001.' }],
      tools: [],
      context: [],
      state: {},
      forwardedProps: {},
    }),
  });
  return response.text();
}

/** The AG-UI events of a stream, in order. */
function eventsOf(
  stream: string,
): { type: string; message?: string; code?: string; content?: string }[] {
  return stream
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => JSON.parse(line.slice('data:'.length)) as { type: string });
}

describe('a per-tool setting saved on the Access tab, in a chat', () => {
  test('runs a read without asking by default', async () => {
    const { host, fetcher } = await start(false);
    await createAgent('clerk', BASE, { fetch: fetcher });

    const stream = await chat(host, 'thread-default');

    expect(stream).toContain('Looked it up.');
    expect(stream).not.toContain('"type":"interrupt"');
  });

  test('asks first for a tool set to always, before the tool runs', async () => {
    const { host, fetcher } = await start(false);
    await createAgent('clerk', BASE, { fetch: fetcher });
    await saveAccess(fetcher, { toolApproval: { 'demo:lookup-order': 'always' } });

    const stream = await chat(host, 'thread-always');

    expect(stream).toContain('"type":"interrupt"');
    expect(stream).toContain('lookup-order');
    expect(stream).not.toContain('Looked it up.');
  });

  test('never runs a tool set to blocked', async () => {
    const { host, fetcher } = await start(false);
    await createAgent('clerk', BASE, { fetch: fetcher });
    await saveAccess(fetcher, { toolApproval: { 'demo:lookup-order': 'blocked' } });

    const stream = await chat(host, 'thread-blocked');

    expect(stream).not.toContain('"type":"interrupt"');
    const results = eventsOf(stream).filter((event) => event.type === 'TOOL_CALL_RESULT');
    expect(results.map((event) => event.content)).toEqual([
      expect.stringContaining('denied by approval policy'),
    ]);
  });
});

describe('a budget saved on the Access tab, in a chat', () => {
  test('stops a run at its tool-call limit, and names the limit', async () => {
    const { host, fetcher } = await start(true);
    await createAgent('clerk', BASE, { fetch: fetcher });
    await saveAccess(fetcher, { toolBudget: { maxCalls: 1 } });

    const stream = await chat(host, 'thread-tool-budget');

    const failure = eventsOf(stream).find((event) => event.type === 'RUN_ERROR');
    expect(failure).toMatchObject({ code: 'BUDGET_EXCEEDED' });
    expect(failure?.message).toContain('Budget exceeded: max calls 1');
  });

  test('stops a run at its spend limit, and names it', async () => {
    const { host, fetcher } = await start(true);
    await createAgent('clerk', BASE, { fetch: fetcher });
    await saveAccess(fetcher, { costBudget: { perRunUsd: 0.01 } });

    const stream = await chat(host, 'thread-cost-budget');

    const failure = eventsOf(stream).find((event) => event.type === 'RUN_ERROR');
    expect(failure).toMatchObject({ code: 'BUDGET_EXCEEDED' });
    expect(failure?.message).toContain('perRunUsd: $0.01');
  });
});
