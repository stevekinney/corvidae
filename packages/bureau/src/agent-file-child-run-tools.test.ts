/** COR-2028: registered child-run tools on real file-agent runs. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MemoryStorage } from '@lostgradient/storage';
import {
  withBackendDescriptors,
  type GenerateContext,
  type GenerateFunction,
} from '@lostgradient/operative';
import { awakeTurns } from '@lostgradient/testing/wait-until';
import { createTool, type Tool } from 'armorer';
import { z } from 'zod';
import { afterEach, describe, expect, it } from 'bun:test';

import { createMemoryAssetStorage } from './assets/storage';
import { createBureau } from './create-bureau';
import { createBureauHandler } from './http/create-bureau-handler';
import { as, authentication } from './http/management/management-fixtures.test-support';
import { base64Of, pdfBytes } from './testing/asset-fixtures.test-support';
import { agentFileDirectory } from './sources/agent-file-directory';
import {
  agentFileText,
  KNOWN_MODEL,
  OTHER_MODEL,
} from './testing/agent-file-fixtures.test-support';
import type { AgentDefinitions } from './agent-catalog';
import type { Bureau } from './bureau-types/facade';
import type { WorkspaceMembershipOptions } from './http/workspace-principal';

type Script = GenerateFunction;
const roots: string[] = [];
const bureaus: Bureau<AgentDefinitions>[] = [];
let childMutationCount = 0;

const issueRefund = createTool({
  name: 'issue-refund',
  version: '1.0.0',
  description: 'Issue a test refund.',
  input: z.object({}),
  metadata: { mutates: true },
  execute: async () => {
    childMutationCount += 1;
    return { ok: true };
  },
});

afterEach(async () => {
  for (const bureau of bureaus.splice(0).toReversed()) await bureau.dispose();
  for (const root of roots.splice(0).toReversed()) await rm(root, { recursive: true, force: true });
  childMutationCount = 0;
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
  readonly parentTools?: string;
  readonly childApproval?: string;
  readonly childModel?: boolean;
  readonly agentTools?: Readonly<Record<string, Tool>>;
  readonly children?: string;
  readonly approval?: string;
  readonly rootAuthority?: { readonly levels: number; readonly concurrentChildren: number };
  readonly workspace?: WorkspaceMembershipOptions;
}): Promise<{
  bureau: Bureau<AgentDefinitions>;
  directory: string;
  handler: (request: Request) => Promise<Response>;
}> {
  const directory = await mkdtemp(join(tmpdir(), 'corvidae-file-child-tools-'));
  roots.push(directory);
  const approval =
    options.approval === undefined
      ? ''
      : `approvals:\n${options.approval
          .split(',')
          .map((entry) => {
            const [name, mode] = entry.split('=');
            return `  '${name}': ${mode}`;
          })
          .join('\n')}\n`;
  const parentText = agentFileText({
    model: KNOWN_MODEL,
    tools:
      options.parentTools ??
      '[bureau:discover-agents, bureau:child-runs-dispatch, bureau:child-runs-list, bureau:child-runs-get, bureau:child-runs-wait, bureau:child-runs-cancel]',
    ...(options.children === undefined ? {} : { children: options.children }),
  }).replace('---\n', `---\n${approval}`);
  await writeFile(join(directory, 'parent.md'), parentText);
  const workerModel = options.childModel === true ? KNOWN_MODEL : OTHER_MODEL;
  const workerApproval =
    options.childApproval === undefined
      ? ''
      : `approvals:\n${options.childApproval
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
    id: 'agent-file-child-tools',
    agents: {},
    durable: true,
    storage: new MemoryStorage(),
    assets: { storage: createMemoryAssetStorage() },
    agentSource: agentFileDirectory(
      directory,
      options.agentTools === undefined ? {} : { tools: options.agentTools },
    ),
    models: {
      generate: (descriptor) =>
        withBackendDescriptors(
          async (context) => scripts[descriptor.model]!(context),
          [descriptor],
        ),
    },
    requestAuthorityValidator: () => true,
    ...(options.workspace === undefined ? {} : { workspace: options.workspace }),
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
  return {
    bureau,
    directory,
    handler: createBureauHandler(bureau, {
      authentication,
      ...(options.workspace === undefined ? {} : { workspace: options.workspace }),
    }),
  };
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
    let sameOwnerA2A: unknown[] = [];
    const { bureau } = await open({
      children: '[worker]',
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
          if (context.runId === undefined) throw new Error('expected a parent run id');
          const requestContext = {
            authority: {
              principalId: 'api-key:a2a',
              tenantId: 'child-tools-test',
              ownerId: 'alice',
              capabilities: ['tools:execute'],
              authorizationRevision: 'test:1',
            },
            audience: 'tenant' as const,
            agentId: 'parent',
            runId: context.runId,
          };
          sameOwnerA2A = [
            await context.toolbox.execute(
              { name: 'bureau__child-runs-get', arguments: { childRunId } },
              { requestContext },
            ),
            await context.toolbox.execute(
              { name: 'bureau__child-runs-cancel', arguments: { childRunId } },
              { requestContext },
            ),
          ];
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
    expect(sameOwnerA2A.map((result) => (result as { result: unknown }).result)).toEqual([
      { status: 'not-found' },
      { status: 'not-found' },
    ]);
  });

  it('refuses dispatch without a grant and does not expose the registered dispatch tool', async () => {
    let seenTools: readonly string[] = [];
    const { bureau } = await open({
      children: '[]',
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
      children: '[worker]',
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
      children: '[worker]',
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
    let canceledChildRunId: string | undefined;
    let ownerContext: GenerateContext | undefined;
    const { bureau } = await open({
      children: '[worker]',
      rootAuthority: { levels: 2, concurrentChildren: 4 },
      approval: 'bureau:child-runs-cancel=on-changes,bureau:child-runs-dispatch=never',
      child: async () => new Promise(() => {}),
      parent: async (context) => {
        ownerContext = context;
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
        canceledChildRunId = childRunId;
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
    expect(resolved).toMatchObject({
      decision: 'approve',
      result: { result: { status: 'requested' } },
    });
    const settled = await bureau.children.wait({
      parentRunId: task.id,
      childRunId: canceledChildRunId!,
    });
    expect(settled).toMatchObject({ outcome: 'settled', child: { status: 'aborted' } });
    expect(
      await bureau.children.get({ parentRunId: task.id, childRunId: canceledChildRunId! }),
    ).toMatchObject({
      childRunId: canceledChildRunId,
      status: 'aborted',
    });
    if (ownerContext === undefined) throw new Error('expected the owner toolbox context');
    const postSettlementGet = await ownerContext.toolbox.execute(
      { name: 'bureau__child-runs-get', arguments: { childRunId: canceledChildRunId } },
      { executionContext: { parentRunId: task.id } },
    );
    expect((postSettlementGet as { result: unknown }).result).toMatchObject({
      status: 'ok',
      child: { childRunId: canceledChildRunId, status: 'aborted' },
    });
  });

  it('holds a registered child mutating tool in the real chat-root path', async () => {
    let dispatched = false;
    let childCalled = false;
    let childToolResult: unknown;
    let rootPrimed = false;
    let parentDispatchResult: unknown;
    const { bureau } = await open({
      children: '[worker]',
      childTools: '[issue-refund]',
      childModel: true,
      agentTools: { 'issue-refund': issueRefund },
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
              name: 'issue-refund',
              arguments: {},
            },
          ],
        };
      },
      parent: async (context) => {
        if (!rootPrimed) {
          rootPrimed = true;
          return { content: 'root ready', toolCalls: [] };
        }
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
    const root = await bureau.tasks.start('parent', 'root chat', { principal: 'alice' });
    await root.result();
    const task = await bureau.tasks.start('parent', 'dispatch mutating child', {
      principal: 'alice',
      contextId: root.contextId,
    });
    const parentResult = await task.result();
    expect(parentResult.content).toBe('parent done');
    expect(parentDispatchResult).toMatchObject({ outcome: 'started' });
    for await (const _turn of awakeTurns()) {
      if (childToolResult !== undefined) break;
    }
    expect(childCalled).toBe(true);
    expect(childMutationCount).toBe(0);
    expect(String(childToolResult)).toMatch(/held|denied|approval/i);
  });

  it('denies a different principal access to a dispatched child', async () => {
    const { bureau } = await open({
      children: '[worker]',
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

  it('refuses missing and unreadable asset refs before any child record is written', async () => {
    for (const principal of ['alice', 'bob']) {
      let dispatched = false;
      const { bureau } = await open({
        children: '[worker]',
        approval: 'bureau:child-runs-dispatch=never',
        parent: async () => {
          if (dispatched) return { content: 'done', toolCalls: [] };
          dispatched = true;
          return {
            content: '',
            toolCalls: [
              {
                name: 'bureau__child-runs-dispatch',
                arguments: { agent: 'worker', input: 'x', assets: ['missing-asset'] },
              },
            ],
          };
        },
      });
      const task = await bureau.tasks.start('parent', 'missing asset', { principal });
      await task.result();
      expect(await bureau.children.list(task.id)).toEqual([]);
    }
  });

  it('rechecks workspace authority for registered asset reads and child preflight', async () => {
    const owner = 'workspace:alice';
    const service = 'workspace:service';
    const workspace: WorkspaceMembershipOptions = {
      workspaceId: 'workspace-a',
      resolveMembership: async ({ subject }) =>
        subject === 'alice'
          ? {
              version: 1,
              workspaceId: 'workspace-a',
              actorId: 'alice',
              actorKind: 'user',
              owner,
              membershipRevision: '1',
              capabilities: ['workspace:use'],
            }
          : subject === 'service'
            ? {
                version: 1,
                workspaceId: 'workspace-a',
                actorId: 'service',
                actorKind: 'service',
                owner: service,
                membershipRevision: '1',
                capabilities: ['workspace:use'],
              }
            : null,
      resolveOwnerMembership: async (candidate) =>
        candidate === owner
          ? {
              version: 1,
              workspaceId: 'workspace-a',
              actorId: 'alice',
              actorKind: 'user',
              owner,
              membershipRevision: '1',
              capabilities: ['workspace:use'],
            }
          : candidate === service
            ? {
                version: 1,
                workspaceId: 'workspace-a',
                actorId: 'service',
                actorKind: 'service',
                owner: service,
                membershipRevision: '1',
                capabilities: ['workspace:use'],
              }
            : null,
    };
    let assetId: string | undefined;
    let readChecked = false;
    let dispatchChecked = false;
    const { bureau } = await open({
      workspace,
      parentTools: '[bureau:assets-read, bureau:child-runs-dispatch]',
      children: '[worker]',
      approval: 'bureau:child-runs-dispatch=never',
      parent: async (context) => {
        if (!readChecked) {
          readChecked = true;
          return {
            content: '',
            toolCalls: [{ name: 'bureau__assets-read', arguments: { assetId } }],
          };
        }
        if (!dispatchChecked) {
          expect(parsedResult(context)).toEqual({ status: 'not-found' });
          dispatchChecked = true;
          return {
            content: '',
            toolCalls: [
              {
                name: 'bureau__child-runs-dispatch',
                arguments: { agent: 'worker', input: 'inspect', assets: [assetId] },
              },
            ],
          };
        }
        expect(parsedResult(context)).toMatchObject({
          status: 'refused',
          reason: 'An asset reference is unavailable.',
        });
        return { content: 'service denied', toolCalls: [] };
      },
    });
    const shared = await bureau.assets!.admit(
      {
        source: { kind: 'inline', bytes: new TextEncoder().encode('private') },
        readers: [service],
      },
      { id: owner },
    );
    await shared.work.result();
    assetId = shared.assetId;
    const plain = await bureau.assets!.inspect(shared.assetId, { id: service });
    expect(plain.authorization).toEqual({ access: 'reader' });
    const resolved = await bureau.assets!.resolve({ assetId: shared.assetId }, { id: service });
    expect(resolved.content.kind).toBe('bytes');
    const task = await bureau.tasks.start('parent', 'service asset denial', { principal: service });
    const result = await task.result();
    expect(result.content).toBe('service denied');
    expect(await bureau.children.list(task.id)).toEqual([]);
  });

  it('publishes through the registered tool, serves the owner over HTTP, and resolves an asset in a child transcript', async () => {
    let published: string | undefined;
    let dispatched = false;
    let childUser: unknown;
    let childSources: unknown;
    const { bureau, handler } = await open({
      parentTools: '[bureau:assets-publish, bureau:child-runs-dispatch]',
      children: '[worker]',
      approval: 'bureau:assets-publish=never,bureau:child-runs-dispatch=never',
      child: async (context) => {
        childUser = context.conversation
          .getMessages()
          .find((message) => message.role === 'user')?.content;
        childSources = context.resolvedSources;
        return { content: 'child done', toolCalls: [] };
      },
      parent: async (context) => {
        if (lastResult(context) === undefined) {
          return {
            content: '',
            toolCalls: [
              {
                name: 'bureau__assets-publish',
                arguments: {
                  base64: base64Of(pdfBytes(1)),
                  mediaType: 'application/pdf',
                  fileName: 'payload.pdf',
                },
              },
            ],
          };
        }
        if (!dispatched) {
          const result = parsedResult(context) as { status?: string; assetId?: string };
          expect(result.status).toBe('ok');
          published = result.assetId;
          dispatched = true;
          return {
            content: '',
            toolCalls: [
              {
                name: 'bureau__child-runs-dispatch',
                arguments: { agent: 'worker', input: 'inspect', assets: [published] },
              },
            ],
          };
        }
        return { content: 'parent done', toolCalls: [] };
      },
    });
    const task = await bureau.tasks.start('parent', 'publish and delegate', {
      principal: 'api-key:alice',
    });
    const result = await task.result();
    expect(result.content).toBe('parent done');
    expect(published).toBeString();

    const response = await handler(
      new Request(`http://localhost/jsonrpc`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...as('alice-assets-key') },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'bureau.assets.get',
          params: { assetId: published },
        }),
      }),
    );
    expect(response.status).toBe(200);
    const metadata = (await response.json()) as { result?: Record<string, unknown> };
    expect(metadata).toMatchObject({
      result: { assetId: published, mediaType: 'application/pdf', fileName: 'payload.pdf' },
    });

    const childRunId = result.steps[1]?.results[0]?.content as {
      child?: { childRunId?: string };
    };
    expect(childRunId.child?.childRunId).toBeString();
    await bureau.children.wait({
      parentRunId: task.id,
      childRunId: childRunId.child!.childRunId!,
      principal: 'api-key:alice',
    });
    expect(childUser).toEqual([
      { type: 'text', text: 'inspect' },
      {
        type: 'document',
        mimeType: 'application/pdf',
        name: 'payload.pdf',
        source: { kind: 'managed-asset', assetId: published, revision: 2 },
      },
    ]);
    expect(childSources).toBeInstanceOf(Map);
    expect([...((childSources ?? new Map()) as Map<string, unknown>).values()]).toEqual([
      expect.objectContaining({
        outcome: 'resolved',
        source: {
          kind: 'inline',
          data: base64Of(pdfBytes(1)),
          encoding: 'base64',
        },
      }),
    ]);
  });

  it('lets a child publish an asset, name it in final text, and lets the parent read it', async () => {
    const childFinished = Promise.withResolvers<void>();
    let dispatched = false;
    let waited = false;
    let read = false;
    let childAssetId: string | undefined;
    let childRunId: string | undefined;
    const { bureau } = await open({
      parentTools: '[bureau:child-runs-dispatch, bureau:child-runs-get, bureau:assets-read]',
      childTools: '[bureau:assets-publish]',
      children: '[worker]',
      approval: 'bureau:child-runs-dispatch=never',
      childApproval: 'bureau:assets-publish=never',
      child: async (context) => {
        if (lastResult(context) === undefined) {
          return {
            content: '',
            toolCalls: [
              {
                name: 'bureau__assets-publish',
                arguments: { text: 'from child', mediaType: 'text/plain' },
              },
            ],
          };
        }
        const result = parsedResult(context) as { status?: string; assetId?: string };
        expect(result.status).toBe('ok');
        childAssetId = result.assetId;
        childFinished.resolve();
        if (childAssetId === undefined) throw new Error('expected the child asset id');
        return { content: childAssetId, toolCalls: [] };
      },
      parent: async (context) => {
        if (!dispatched) {
          dispatched = true;
          return {
            content: '',
            toolCalls: [
              {
                name: 'bureau__child-runs-dispatch',
                arguments: { agent: 'worker', input: 'publish' },
              },
            ],
          };
        }
        if (!waited) {
          waited = true;
          await childFinished.promise;
          const dispatch = parsedResult(context) as {
            outcome?: string;
            child?: { childRunId?: string };
          };
          expect(dispatch.outcome).toBe('started');
          childRunId = dispatch.child?.childRunId;
          return {
            content: '',
            toolCalls: [
              {
                name: 'bureau__child-runs-get',
                arguments: { childRunId: dispatch.child?.childRunId },
              },
            ],
          };
        }
        if (!read) {
          const settled = parsedResult(context) as {
            status?: string;
            child?: { status?: string; outcome?: { content?: string } };
          };
          if (settled.child?.status !== 'completed') {
            return {
              content: '',
              toolCalls: [{ name: 'bureau__child-runs-get', arguments: { childRunId } }],
            };
          }
          read = true;
          const assetId = settled.child.outcome?.content;
          expect(assetId).toBeString();
          return {
            content: '',
            toolCalls: [{ name: 'bureau__assets-read', arguments: { assetId } }],
          };
        }
        expect(parsedResult(context)).toMatchObject({ status: 'ok', content: 'from child' });
        return { content: 'parent read child asset', toolCalls: [] };
      },
    });
    const task = await bureau.tasks.start('parent', 'child publishes', {
      principal: 'api-key:alice',
    });
    const result = await task.result();
    expect(result.content).toBe('parent read child asset');
    expect(childAssetId).toBeString();
  });
});
