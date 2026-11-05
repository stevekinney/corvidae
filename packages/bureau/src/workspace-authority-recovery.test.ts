import { Conversation } from 'conversationalist';
import {
  createTool,
  createToolbox,
  readRunWorkspaceAuthority,
  type ToolRequestContext,
} from 'armorer';
import { z } from 'zod';
import { createRuntimeComposition } from './runtime-composition.ts';
import { withAddedTools } from './toolbox-additions.ts';
import { describe, expect, it } from 'bun:test';
import type { WorkspaceMembership } from './http/workspace-principal.ts';
import {
  captureRunWorkspaceAuthority,
  recoverRunWorkspaceAuthority,
  validateRunWorkspaceAuthority,
} from './run-authority.ts';

function directory() {
  let membership: WorkspaceMembership | null = {
    version: 1,
    workspaceId: 'workspace-a',
    actorId: 'actor-a',
    actorKind: 'user',
    owner: 'owner-a',
    membershipRevision: 'opaque-z',
    capabilities: ['workspace:use'],
  };
  return {
    workspace: {
      workspaceId: 'workspace-a',
      resolveMembership: async () => null,
      resolveOwnerMembership: async () => membership,
    },
    set(value: WorkspaceMembership | null) {
      membership = value;
    },
    get() {
      return membership!;
    },
  };
}

describe('durable workspace run authority', () => {
  it('captures immutable non-secret actor authority separately from run ownership', async () => {
    const source = directory();
    const record = await captureRunWorkspaceAuthority(source.workspace, 'owner-a');
    if (record === undefined) throw new Error('Fixture membership missing');
    expect(record).toEqual({
      version: 1,
      workspaceId: 'workspace-a',
      actorId: 'actor-a',
      authorizingOwner: 'owner-a',
      membershipRevision: 'opaque-z',
    });
    expect(Object.isFrozen(record)).toBe(true);
    expect(readRunWorkspaceAuthority(JSON.parse(JSON.stringify(record)))).toEqual(record);
  });

  it('reevaluates current membership and returns its opaque revision without ordering', async () => {
    const source = directory();
    const record = await captureRunWorkspaceAuthority(source.workspace, 'owner-a');
    if (record === undefined) throw new Error('Fixture membership missing');
    source.set({ ...source.get(), membershipRevision: 'opaque-a' });
    expect(await validateRunWorkspaceAuthority(source.workspace, record)).toEqual({
      ...record,
      membershipRevision: 'opaque-a',
    });
    source.set(null);
    expect(await validateRunWorkspaceAuthority(source.workspace, record)).toBeUndefined();
  });

  it('refuses a changed actor, workspace, capability, malformed record, and unavailable resolver', async () => {
    const source = directory();
    const member = source.get();
    const record = await captureRunWorkspaceAuthority(source.workspace, 'owner-a');
    if (record === undefined) throw new Error('Fixture membership missing');
    for (const change of [
      { actorId: 'replacement' },
      { workspaceId: 'workspace-b' },
      { capabilities: [] },
    ]) {
      source.set({ ...member, ...change });
      expect(await validateRunWorkspaceAuthority(source.workspace, record)).toBeUndefined();
    }
    expect(
      await validateRunWorkspaceAuthority(
        {
          workspaceId: 'workspace-a',
          resolveOwnerMembership: async () => {
            throw new Error('private directory detail');
          },
        },
        record,
      ),
    ).toBeUndefined();
    for (const value of [
      null,
      {},
      { ...record, version: 2 },
      { ...record, actorId: '' },
      { ...record, credentials: 'must-not-persist' },
    ]) {
      expect(readRunWorkspaceAuthority(value)).toBeUndefined();
    }
    expect(await validateRunWorkspaceAuthority(source.workspace, undefined)).toBeUndefined();
  });
});

it('recovers only an explicitly configured local owner when old authority is absent', async () => {
  const workspace = {
    workspaceId: 'local-workspace',
    resolveOwnerMembership: async (owner: string) => ({
      version: 1 as const,
      workspaceId: 'local-workspace',
      actorId: 'local-actor',
      actorKind: 'local' as const,
      owner,
      membershipRevision: 'static',
      capabilities: ['workspace:use' as const, 'workspace:manage' as const],
    }),
  };
  expect(await recoverRunWorkspaceAuthority(workspace, undefined, 'anonymous:local')).toMatchObject(
    { actorId: 'local-actor' },
  );
  expect(await recoverRunWorkspaceAuthority(workspace, undefined, 'remote-owner')).toBeUndefined();
  expect(await recoverRunWorkspaceAuthority(workspace, undefined, undefined)).toBeUndefined();
  expect(
    await recoverRunWorkspaceAuthority(workspace, { version: 9 }, 'anonymous:local'),
  ).toBeUndefined();
});

it('guards every registered tool including later contributions at the actual callback boundary', async () => {
  const source = directory();
  const authority = await captureRunWorkspaceAuthority(source.workspace, 'owner-a');
  if (authority === undefined) throw new Error('Fixture membership missing');
  const context: ToolRequestContext = {
    authority: {
      principalId: 'owner-a',
      ownerId: 'owner-a',
      tenantId: 'workspace-a',
      authorizationRevision: 'bureau:1',
      capabilities: ['tools:execute'],
      workspace: authority,
    },
  };
  let effects = 0;
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const probe = (name: string) =>
    createTool({
      name,
      description: 'Protected contribution',
      input: z.object({}),
      policy: {
        beforeExecute: async () => {
          entered.resolve();
          await release.promise;
          return { allow: true };
        },
      },
      execute: async () => {
        effects++;
        return 'private result';
      },
    });
  const runtime = await createRuntimeComposition({
    workspace: source.workspace,
    generate: async () => ({ content: 'done', toolCalls: [] }),
    toolbox: createToolbox([probe('private_read')]),
  });
  const run = await runtime.createRunRuntime({
    sessionId: 'session',
    runId: 'run',
    message: 'test',
    requestContext: context,
  });
  const toolbox = withAddedTools(run.toolbox, createToolbox([probe('plugin_contribution')]));
  const pending = toolbox
    .tools()
    .map((tool, index) => toolbox.execute({ id: `call-${index}`, name: tool.name, arguments: {} }));
  await entered.promise;
  source.set(null);
  release.resolve();
  const results = await Promise.all(pending);
  expect(results.length).toBeGreaterThanOrEqual(2);
  expect(results.every((result) => result.outcome === 'error')).toBe(true);
  expect(effects).toBe(0);
});

it('settles an already admitted provider effect but refuses the next request after removal', async () => {
  const source = directory();
  const authority = await captureRunWorkspaceAuthority(source.workspace, 'owner-a');
  if (authority === undefined) throw new Error('Fixture membership missing');
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let calls = 0;
  const runtime = await createRuntimeComposition({
    workspace: source.workspace,
    generate: async () => {
      calls++;
      entered.resolve();
      await release.promise;
      return { content: 'committed effect', toolCalls: [] };
    },
    toolbox: createToolbox([]),
  });
  const run = await runtime.createRunRuntime({
    sessionId: 'session',
    runId: 'run',
    message: 'test',
    requestContext: {
      authority: {
        principalId: 'owner-a',
        ownerId: 'owner-a',
        tenantId: 'workspace-a',
        authorizationRevision: 'bureau:1',
        capabilities: ['tools:execute'],
        workspace: authority,
      },
    },
  });
  const input = { conversation: new Conversation(), step: 0, toolbox: run.toolbox };
  const first = run.generate(input);
  await entered.promise;
  source.set(null);
  release.resolve();
  expect(await first).toMatchObject({ content: 'committed effect' });
  const denied = await run.generate(input).then(
    () => null,
    (error: unknown) => error,
  );
  expect(denied).toBeInstanceOf(Error);
  expect(calls).toBe(1);
});
