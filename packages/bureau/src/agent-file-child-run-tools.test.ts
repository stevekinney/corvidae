/** COR-2028: registered child-run tools on real file-agent runs. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MemoryStorage } from '@lostgradient/storage';
import type { GenerateFunction } from '@lostgradient/operative';
import { awakeTurns } from '@lostgradient/testing/wait-until';
import type { ToolRequestContext } from 'armorer';
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

function parsedResult(context: Parameters<Script>[0]): unknown {
  const raw = lastResult(context);
  return typeof raw === 'string' ? (JSON.parse(raw) as unknown) : raw;
}

async function open(options: {
  readonly parent: Script;
  readonly child?: Script;
  readonly childTools?: string;
  readonly childApproval?: string;
  readonly childModel?: boolean;
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
  const workerModel = options.childModel === true ? KNOWN_MODEL : OTHER_MODEL;
  const workerApproval =
    options.childApproval === undefined
      ? ''
      : `toolApproval:\n${options.childApproval
          .split(',')
          .map((entry) => {
            const [name, mode] = entry.split('=');
            return `  '${name}': ${mode}`;
          })
          .join('\n')}\n`;
  await writeFile(
    join(directory, 'worker.md'),
    agentFileText(
      {
        model: workerModel,
        ...(options.childTools === undefined ? {} : { tools: options.childTools }),
      },
      'Worker.\n',
    ).replace('---\n', `---\n${workerApproval}`),
  );
  const scripts: Record<string, Script> = {
    [KNOWN_MODEL.split('/')[1]!]:
      options.childModel === true
        ? async (context) =>
            context.conversation
              .getMessages()
              .some((message) => message.role === 'user' && message.content === 'mutate')
              ? (options.child ?? (async () => ({ content: 'child done', toolCalls: [] })))(context)
              : options.parent(context)
        : options.parent,
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
    requestAuthorityValidator: () => true,
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
    let listed = false;
    let fetched = false;
    let attackerMode = false;
    let attackerGetAttempted = false;
    let attackerCancelAttempted = false;
    let childRunId: string | undefined;
    const { bureau } = await open({
      childAgents: '[worker]',
      approval: 'bureau:child-runs-dispatch=never,bureau:child-runs-cancel=never',
      child: async () => new Promise(() => {}),
      parent: async (context) => {
        if (attackerMode) {
          if (!attackerGetAttempted) {
            attackerGetAttempted = true;
            return {
              content: '',
              toolCalls: [{ name: 'bureau__child-runs-get', arguments: { childRunId } }],
            };
          }
          if (!attackerCancelAttempted) {
            expect(parsedResult(context)).toEqual({ status: 'not-found' });
            attackerCancelAttempted = true;
            return {
              content: '',
              toolCalls: [{ name: 'bureau__child-runs-cancel', arguments: { childRunId } }],
            };
          }
          expect(parsedResult(context)).toEqual({ status: 'not-found' });
          return { content: 'attacker denied', toolCalls: [] };
        }
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
        if (!listed) {
          const result = parsedResult(context) as {
            outcome?: string;
            child?: { childRunId?: string };
          };
          expect(result.outcome).toBe('started');
          childRunId = result.child?.childRunId;
          expect(childRunId).toBeString();
          listed = true;
          return { content: '', toolCalls: [{ name: 'bureau__child-runs-list', arguments: {} }] };
        }
        if (!fetched) {
          const result = parsedResult(context) as {
            status?: string;
            children?: Array<{ childRunId?: string }>;
          };
          expect(result.status).toBe('ok');
          expect(result.children?.map(({ childRunId: id }) => id)).toEqual([childRunId]);
          fetched = true;
          return {
            content: '',
            toolCalls: [{ name: 'bureau__child-runs-get', arguments: { childRunId } }],
          };
        }
        const result = parsedResult(context) as {
          status?: string;
          child?: { childRunId?: string; childAgentName?: string };
        };
        expect(result.status).toBe('ok');
        expect(result.child).toMatchObject({ childRunId, childAgentName: 'worker' });
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
    expect(childRunId).toBeString();
    attackerMode = true;
    const attacker = await bureau.tasks.start('parent', 'attack', { principal: 'api-key:a2a' });
    const attackerResult = await attacker.result();
    expect(attackerResult.content).toBe('attacker denied');
    expect(attackerGetAttempted).toBe(true);
    expect(attackerCancelAttempted).toBe(true);
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
    if (review === undefined) throw new Error('expected a cancel approval');
    const resolved = await bureau.reviews.resolve({
      id: review.id,
      decision: 'approve',
      principal: 'bob',
    });
    expect(resolved).toMatchObject({ decision: 'approve' });
  });

  it('raises approval from the dispatched child model for its registered mutating tool', async () => {
    let dispatched = false;
    let childCalled = false;
    let childToolResult: unknown;
    let parentDispatchResult: unknown;
    const { bureau } = await open({
      childAgents: '[worker]',
      childTools: '[bureau:child-runs-cancel]',
      childModel: true,
      childApproval: 'bureau:child-runs-cancel=never',
      rootAuthority: { levels: 2, concurrentChildren: 4 },
      approval: 'bureau:child-runs-dispatch=never',
      child: async (context) => {
        if (childCalled) {
          childToolResult = context.conversation
            .getMessages()
            .findLast((message) => message.toolResult)?.toolResult?.content;
          return { content: 'child observed result', toolCalls: [] };
        }
        childCalled = true;
        return {
          content: '',
          toolCalls: [
            {
              name: 'bureau__child-runs-cancel',
              arguments: { childRunId: 'missing-child' },
            },
          ],
        };
      },
      parent: async (context) => {
        if (dispatched) {
          parentDispatchResult = parsedResult(context);
          return { content: 'parent done', toolCalls: [] };
        }
        dispatched = true;
        return {
          content: '',
          toolCalls: [
            {
              name: 'bureau__child-runs-dispatch',
              arguments: { agent: 'worker', input: 'mutate' },
            },
          ],
        };
      },
    });
    const task = await bureau.tasks.start('parent', 'dispatch mutating child', {
      principal: 'alice',
      requestContext: {
        authority: {
          principalId: 'alice',
          tenantId: 'child-tools-test',
          ownerId: 'alice',
          capabilities: ['tools:execute'],
          authorizationRevision: 'test:1',
        },
      } satisfies ToolRequestContext,
    });
    const parentResult = await task.result();
    expect(parentResult.content).toBe('parent done');
    expect(parentDispatchResult).toMatchObject({ outcome: 'started' });
    for await (const _turn of awakeTurns()) {
      if (childToolResult !== undefined) break;
    }
    expect(childCalled).toBe(true);
    expect(childToolResult).toEqual({ status: 'not-found' });
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
