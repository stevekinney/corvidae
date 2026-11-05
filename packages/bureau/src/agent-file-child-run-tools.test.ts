/** COR-2028: registered child-run tools on real file-agent runs. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MemoryStorage } from '@lostgradient/storage';
import type { GenerateFunction } from '@lostgradient/operative';
import { afterEach, describe, expect, it } from 'bun:test';

import { createMemoryAssetStorage } from './assets/storage';
import { createBureau } from './create-bureau';
import { agentFileDirectory } from './sources/agent-file-directory';
import {
  agentFileText,
  KNOWN_MODEL,
  OTHER_MODEL,
} from './testing/agent-file-fixtures.test-support';
import type { AgentDefinitions } from './agent-catalog';
import type { Bureau } from './types';

type Script = GenerateFunction;
const roots: string[] = [];
const bureaus: Bureau<AgentDefinitions>[] = [];

afterEach(async () => {
  for (const bureau of bureaus.splice(0).toReversed()) await bureau.dispose();
  for (const root of roots.splice(0).toReversed()) await rm(root, { recursive: true, force: true });
});

function lastResult(context: Parameters<Script>[0]): unknown {
  return context.conversation.getMessages().findLast((message) => message.toolResult)?.toolResult
    ?.content;
}

function resultObject(context: Parameters<Script>[0]): Record<string, unknown> | undefined {
  const raw = lastResult(context);
  const result = typeof raw === 'string' ? (JSON.parse(raw) as unknown) : raw;
  return typeof result === 'object' && result !== null
    ? (result as Record<string, unknown>)
    : undefined;
}

async function open(options: {
  readonly parent: Script;
  readonly child?: Script;
  readonly childAgents?: string;
  readonly approval?: string;
  readonly rootAuthority?: { readonly levels: number; readonly concurrentChildren: number };
}): Promise<{ bureau: Bureau<AgentDefinitions>; directory: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'corvidae-file-child-tools-'));
  roots.push(directory);
  const approval =
    options.approval === undefined
      ? ''
      : `toolApproval:\n${options.approval
          .split(',')
          .map((entry) => {
            const [name, mode] = entry.split('=');
            return `  '${name}': ${mode}`;
          })
          .join('\n')}\n`;
  const parentText = agentFileText({
    model: KNOWN_MODEL,
    tools:
      '[bureau:discover-agents, bureau:child-runs-dispatch, bureau:child-runs-list, bureau:child-runs-get, bureau:child-runs-cancel]',
    ...(options.childAgents === undefined ? {} : { childAgents: options.childAgents }),
  }).replace('---\n', `---\n${approval}`);
  await writeFile(join(directory, 'parent.md'), parentText);
  await writeFile(join(directory, 'worker.md'), agentFileText({ model: OTHER_MODEL }, 'Worker.\n'));
  const scripts: Record<string, Script> = {
    [KNOWN_MODEL.split('/')[1]!]: options.parent,
    [OTHER_MODEL.split('/')[1]!]:
      options.child ?? (async () => ({ content: 'child done', toolCalls: [] })),
  };
  const bureau = await createBureau<AgentDefinitions>({
    agents: {},
    durable: true,
    storage: new MemoryStorage(),
    assets: { storage: createMemoryAssetStorage() },
    agentSource: agentFileDirectory(directory),
    models: { generate: (descriptor) => async (context) => scripts[descriptor.model]!(context) },
    ...(options.rootAuthority === undefined
      ? {}
      : {
          children: {
            delegation: {
              secret: 'child-delegation-secret',
              rootAuthority: {
                levels: options.rootAuthority.levels,
                budget: { concurrentChildren: options.rootAuthority.concurrentChildren },
              },
            },
          },
        }),
    ...(options.approval === undefined ? {} : { agentApprovalSecret: 'child-tools-secret' }),
  });
  await bureau.agents.refresh();
  if (bureau.agents.find('parent') === undefined)
    throw new Error(JSON.stringify(bureau.agents.list()));
  bureaus.push(bureau);
  return { bureau, directory };
}

describe('registered child-run tools on file agents', () => {
  it('limits discovery and dispatch to the declared child grant, then lists and gets the child', async () => {
    let dispatched = false;
    const { bureau } = await open({
      childAgents: '[worker]',
      approval: 'bureau:child-runs-dispatch=never',
      parent: async (context) => {
        if (lastResult(context) === undefined)
          return { content: '', toolCalls: [{ name: 'bureau__discover-agents', arguments: {} }] };
        if (!dispatched) {
          dispatched = true;
          return {
            content: '',
            toolCalls: [
              {
                name: 'bureau__child-runs-dispatch',
                arguments: { agent: 'worker', input: 'work' },
              },
            ],
          };
        }
        return { content: 'done', toolCalls: [] };
      },
    });
    const task = await bureau.tasks.start('parent', 'delegate', { principal: 'alice' });
    const finished = await task.result();
    expect(finished.content).toBe('done');
    const discoveryContent = finished.conversation.getMessages().find((m) => m.toolResult)
      ?.toolResult?.content;
    const discovery = JSON.parse(
      typeof discoveryContent === 'string' ? discoveryContent : JSON.stringify(discoveryContent),
    ) as Array<{ name: string }>;
    expect(discovery.map(({ name }) => name)).toEqual(['worker']);
    const children = await bureau.children.list(task.id, { principal: 'alice' });
    expect(children).toHaveLength(1);
    const child = await bureau.children.get({
      parentRunId: task.id,
      childRunId: children[0]!.childRunId,
      principal: 'alice',
    });
    expect(child?.childAgentName).toBe('worker');
  });

  it('refuses dispatch without a grant and does not expose the registered dispatch tool', async () => {
    let seenTools: readonly string[] = [];
    const { bureau } = await open({
      childAgents: '[]',
      parent: async ({ toolbox }) => {
        seenTools = toolbox.tools().map((tool) => tool.name);
        return {
          content: 'done',
          toolCalls: [
            { name: 'bureau__child-runs-dispatch', arguments: { agent: 'worker', input: 'x' } },
          ],
        };
      },
    });
    const task = await bureau.tasks.start('parent', 'delegate');
    const finished = await task.result();
    expect(finished.content).toBe('done');
    expect(seenTools).not.toContain('bureau__child-runs-dispatch');
    expect(await bureau.children.list(task.id)).toEqual([]);
  });

  it('refuses a registered dispatch for a target outside the child grant', async () => {
    let seenTools: readonly string[] = [];
    const { bureau } = await open({
      childAgents: '[worker]',
      approval: 'bureau:child-runs-dispatch=never',
      parent: async ({ toolbox }) => {
        seenTools = toolbox.tools().map((tool) => tool.name);
        return {
          content: 'done',
          toolCalls: [
            { name: 'bureau__child-runs-dispatch', arguments: { agent: 'unknown', input: 'x' } },
          ],
        };
      },
    });
    const task = await bureau.tasks.start('parent', 'delegate');
    const finished = await task.result();
    expect(finished.content).toBe('done');
    expect(seenTools).toContain('child-runs-dispatch');
    expect(await bureau.children.list(task.id)).toEqual([]);
  });

  it('returns a fifth concurrent dispatch refusal from the registered tool', async () => {
    const { bureau } = await open({
      childAgents: '[worker]',
      approval: 'bureau:child-runs-dispatch=never',
      rootAuthority: { levels: 2, concurrentChildren: 4 },
      child: async () => new Promise(() => {}),
      parent: async (context) =>
        lastResult(context) === undefined
          ? {
              content: '',
              toolCalls: Array.from({ length: 5 }, (_, index) => ({
                id: `dispatch-${index}`,
                name: 'bureau__child-runs-dispatch',
                arguments: { agent: 'worker', input: `work-${index}` },
              })),
            }
          : { content: 'done', toolCalls: [] },
    });
    const task = await bureau.tasks.start('parent', 'fan out', { principal: 'alice' });
    const finished = await task.result();
    const outcomes = finished.steps
      .flatMap((step) => step.results)
      .map((result) => result.content as { outcome?: string });
    expect(outcomes.filter(({ outcome }) => outcome === 'started')).toHaveLength(4);
    expect(outcomes.filter(({ outcome }) => outcome === 'rejected')).toHaveLength(1);
  });

  it('raises approval for a mutating tool after a real child was dispatched', async () => {
    let dispatched = false;
    const { bureau } = await open({
      childAgents: '[worker]',
      rootAuthority: { levels: 2, concurrentChildren: 4 },
      approval: 'bureau:child-runs-cancel=on-changes,bureau:child-runs-dispatch=never',
      child: async () => new Promise(() => {}),
      parent: async (context) => {
        if (!dispatched) {
          dispatched = true;
          return {
            content: '',
            toolCalls: [
              {
                name: 'bureau__child-runs-dispatch',
                arguments: { agent: 'worker', input: 'hold' },
              },
            ],
          };
        }
        const childRunId = (resultObject(context)?.['child'] as { childRunId?: string } | undefined)
          ?.childRunId;
        return {
          content: '',
          toolCalls: [{ name: 'bureau__child-runs-cancel', arguments: { childRunId } }],
        };
      },
    });
    const task = await bureau.tasks.start('parent', 'dispatch then cancel', { principal: 'alice' });
    await task.result();
    const review = bureau.reviews.list().find((candidate) => candidate.runId === task.id);
    expect(review).toMatchObject({ kind: 'tool-approval' });
    expect(review?.kind === 'tool-approval' ? review.approval.toolName : undefined).toBe(
      'bureau:child-runs-cancel',
    );
    expect(await bureau.children.list(task.id)).toHaveLength(1);
  });

  it('denies a different principal access to a dispatched child', async () => {
    const { bureau } = await open({
      childAgents: '[worker]',
      parent: async () => ({ content: 'done', toolCalls: [] }),
    });
    const task = await bureau.tasks.start('parent', 'delegate', { principal: 'alice' });
    const dispatched = await bureau.children.dispatch({
      parentRunId: task.id,
      agentName: 'worker',
      input: 'work',
      principal: 'alice',
    });
    if (dispatched.outcome !== 'started') throw new Error('expected child to start');
    expect(await bureau.children.list(task.id, { principal: 'bob' })).toEqual([]);
    expect(
      await bureau.children.get({
        parentRunId: task.id,
        childRunId: dispatched.child.childRunId,
        principal: 'bob',
      }),
    ).toBeUndefined();
    await task.abort('test cleanup');
  });
});
