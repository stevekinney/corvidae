import { openBungalow } from '@lostgradient/bungalow';
import { BUREAU_SCOPES, type WorkspaceMembership } from '@lostgradient/bureau';
import {
  WORKSPACE_CONFORMANCE_GROUPS,
  WORKSPACE_MOUNT_CONFORMANCE,
} from '@lostgradient/bureau/testing';
import { definePlugin, type PluginSetupContext } from '@lostgradient/interborough-plugin';
import { createAgent, createDefaultRuntimeServices, stopWhen } from '@lostgradient/operative';
import anthropic from '@lostgradient/plugin-anthropic';
import { waitUntil } from '@lostgradient/testing/wait-until';
import {
  AUTHORIZATION_SCOPES,
  createLiveOperationRegistry,
  decode,
  KEYS,
  principalFromApiKey,
} from '@lostgradient/weft';
import { createTool, createToolbox } from 'armorer';
import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';

import { startHost, type Host } from './host.ts';
import {
  exerciseAdministratorRoutes,
  exerciseEngineRelay,
} from './workspace-host-routes.test-support.ts';

const hosts: Host[] = [];
const homes: string[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

async function workspace(name: string, members: readonly string[]) {
  const home = await mkdtemp(join(tmpdir(), 'workspace-conformance-'));
  homes.push(home);
  const applicationEntry = join(home, 'fixture-panel.ts');
  const bungalow = await openBungalow({
    name: 'interborough',
    environment: { INTERBOROUGH_HOME: home },
  });
  const workspaceId = bungalow.workspaceId;
  await bungalow.deploymentSecrets.write('shared-secret', `${name}-secret`);
  bungalow.close();
  await Bun.write(applicationEntry, "document.body.textContent = 'shared-panel-fixture';");
  await Bun.write(
    join(home, 'index.html'),
    '<!doctype html><title>Workspace fixture shell</title>',
  );
  const directory = new Map<string, WorkspaceMembership>(
    members.map((actorId) => [
      actorId,
      {
        version: 1,
        workspaceId,
        actorId,
        actorKind: 'user',
        owner: `${name}:${actorId}`,
        membershipRevision: 'revision-1',
        capabilities:
          actorId === 'admin' ? ['workspace:use', 'workspace:manage'] : ['workspace:use'],
      },
    ]),
  );
  const runtime = createDefaultRuntimeServices();
  const scheduleEffects: { count: number; authorities: unknown[] } = { count: 0, authorities: [] };
  const privilegedEffects = { count: 0 };
  const providerStarted = Promise.withResolvers<void>();
  const releaseProvider = Promise.withResolvers<void>();
  let pluginContext: PluginSetupContext | undefined;
  async function restart() {
    let calls = 0;
    const host = await startHost({
      environment: { INTERBOROUGH_HOME: home },
      buildDirectory: home,
      workspaceId,
      port: 0,
      plugins: [
        {
          source: 'package',
          location: '@fixture/shared-integration',
          descriptor: definePlugin({
            name: 'shared-integration',
            version: '1.0.0',
            description: 'Conformance integration.',
            configuration: z.object({ label: z.string().default('initial') }),
            secrets: ['shared-secret'],
            setup: (context) => {
              pluginContext = context;
              return {
                panels: [
                  {
                    name: 'fixture-panel',
                    title: 'Fixture panel',
                    uri: 'ui://fixture/shared-panel/v1',
                    entry: pathToFileURL(applicationEntry),
                    allowedTools: ['bureau.tasks.inspect'],
                    opensFromTool: 'bureau.tasks.inspect',
                  },
                ],
              };
            },
          }),
        },
        { source: 'package', location: '@lostgradient/plugin-anthropic', descriptor: anthropic },
      ],
      runtime: {
        ...runtime,
        identifiers: {
          next: (kind) => (kind === 'asset' ? 'shared-asset' : runtime.identifiers.next(kind)),
        },
      },
      extraAgents: {
        agents: {
          shared: createAgent({
            name: 'shared',
            generate: async () => ({ content: `${name}-private-result`, toolCalls: [] }),
          }),
          waiting: createAgent({
            name: 'waiting',
            generate: async () => {
              calls += 1;
              return calls === 1
                ? {
                    content: '',
                    toolCalls: [
                      {
                        id: 'private-question',
                        name: 'requestHumanInput',
                        arguments: { signalName: 'answer', prompt: 'private-review-sentinel' },
                      },
                    ],
                  }
                : { content: 'review-completed', toolCalls: [] };
            },
            stopWhen: [stopWhen.toolCalled('requestHumanInput'), stopWhen.noToolCalls()],
          }),
          delayed: createAgent({
            name: 'delayed',
            generate: async () => {
              providerStarted.resolve();
              await releaseProvider.promise;
              return {
                content: '',
                toolCalls: [{ id: 'delayed-effect', name: 'privileged-effect', arguments: {} }],
              };
            },
            toolbox: createToolbox([
              createTool({
                name: 'privileged-effect',
                description: 'Records an effect only after current authority is checked.',
                input: z.object({}),
                execute: async () => {
                  privilegedEffects.count += 1;
                  return { recorded: true };
                },
              }),
            ]),
            stopWhen: stopWhen.toolCalled('privileged-effect'),
          }),
          scheduled: createAgent({
            name: 'scheduled',
            generate: async () => {
              scheduleEffects.count += 1;
              return {
                content: '',
                toolCalls: [{ id: 'record-authority', name: 'record-authority', arguments: {} }],
              };
            },
            toolbox: createToolbox([
              createTool({
                name: 'record-authority',
                description: 'Records the authority of the dispatched scheduled step.',
                input: z.object({}),
                execute: async (_input, context) => {
                  scheduleEffects.authorities.push(context.requestContext?.authority.workspace);
                  return { recorded: true };
                },
              }),
            ]),
            stopWhen: stopWhen.toolCalled('record-authority'),
          }),
        },
      },
      workspaceAuthentication: {
        authentication: {
          resolveApiKeyPrincipal: async (key) =>
            principalFromApiKey({
              subject: key,
              scopes: [...AUTHORIZATION_SCOPES, ...BUREAU_SCOPES],
            }),
        },
        workspace: {
          workspaceId,
          resolveMembership: async ({ subject }) => directory.get(subject ?? '') ?? null,
          resolveOwnerMembership: async (owner) =>
            [...directory.values()].find((entry) => entry.owner === owner) ?? null,
        },
      },
    });
    hosts.push(host);
    return host;
  }
  const host = await restart();
  return {
    host,
    restart,
    directory,
    workspaceId,
    pluginContext,
    scheduleEffects,
    privilegedEffects,
    providerStarted,
    releaseProvider,
  };
}

async function call(host: Host, actor: string, method: string, params: unknown) {
  const response = await fetch(new URL('/bureau/jsonrpc', host.url), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': actor },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return { status: response.status, text: await response.text() };
}

test('two authenticated workspaces share definition names without sharing private tasks', async () => {
  const a = await workspace('workspace-a', ['alice', 'bob', 'grantee', 'admin']);
  const b = await workspace('workspace-b', ['alice', 'admin']);
  const foreignMember = b.directory.get('alice');
  if (foreignMember === undefined) throw new Error('Expected the foreign workspace member');
  a.directory.set('foreign', foreignMember);
  expect(a.workspaceId).not.toBe(b.workspaceId);
  const aRoutes = a.host.routeInventory;
  const bRoutes = b.host.routeInventory;
  expect(aRoutes).toEqual(bRoutes);
  expect(new Set(aRoutes.map((entry) => entry.key)).size).toBe(aRoutes.length);
  const bureau = aRoutes.find((entry) => entry.key === '* /bureau/*');
  if (bureau?.children === undefined) throw new Error('Bureau inventory is missing');
  const operations = WORKSPACE_CONFORMANCE_GROUPS.flatMap((group) =>
    group.operations.map(([name]) => name),
  );
  expect(
    bureau.children
      .filter((entry) => entry.kind === 'operation')
      .map((entry) => entry.key)
      .toSorted(),
  ).toEqual(operations.toSorted());
  expect(
    bureau.children
      .filter((entry) => entry.kind === 'mount')
      .map((entry) => entry.key)
      .toSorted(),
  ).toEqual(
    Object.values(WORKSPACE_MOUNT_CONFORMANCE)
      .filter((entry) => entry.key !== WORKSPACE_MOUNT_CONFORMANCE.contributed.key)
      .map((entry) => entry.key)
      .toSorted(),
  );
  expect(aRoutes.every((entry) => entry.resourceClass !== null || entry.delegated)).toBe(true);
  const engine = aRoutes.find((entry) => entry.key === '* engine-proxy');
  if (engine?.children === undefined) throw new Error('Engine inventory is missing');
  expect(engine.children.map((entry) => entry.key).toSorted()).toEqual(
    createLiveOperationRegistry()
      .list()
      .map((operation) => operation.name)
      .toSorted(),
  );
  expect(engine.children.every((entry) => entry.workspaceClass === 'deployment-operator')).toBe(
    true,
  );
  const deploymentRoutes = aRoutes.filter(
    (entry) => entry.resourceClass === 'deployment-operator' && !entry.delegated,
  );
  expect(deploymentRoutes.length).toBeGreaterThan(0);
  const deploymentWitnesses = new Set<string>();
  for (const entry of deploymentRoutes) {
    const [method, path] = entry.key.split(' ');
    if (method === undefined || path === undefined)
      throw new Error(`The deployment route needs a concrete fixture: ${entry.key}`);
    const concretePath = path.replace(/:[a-zA-Z]+/g, 'fixture-resource');
    for (const actor of ['alice', 'bob', 'admin', 'grantee', 'foreign', 'removed']) {
      const response = await fetch(new URL(concretePath, a.host.url), {
        method,
        headers: { 'x-api-key': actor, origin: a.host.url.origin },
      });
      const text = await response.text();
      expect(response.status).toBe(403);
      if (actor === 'foreign' || actor === 'removed')
        expect(text).toBe('Workspace membership required');
      else expect(text).not.toBe('Workspace membership required');
      expect(text).not.toContain('workspace-a-private');
      deploymentWitnesses.add(`${entry.key}:${actor}`);
    }
  }
  expect(deploymentWitnesses.size).toBe(deploymentRoutes.length * 6);

  const encoder = new TextEncoder();
  for (const [fixture, name] of [
    [a, 'workspace-a'],
    [b, 'workspace-b'],
  ] as const) {
    expect(await fixture.pluginContext!.secrets.get('shared-secret')).toBe(`${name}-secret`);
    const workflow = await fixture.host.bureau.workflows!.create('shared-workflow', {
      agent: 'shared',
      trigger: { kind: 'schedule', spec: '1h' },
      steps: [
        {
          kind: 'activity',
          handler: 'agent',
          input: { agent: 'shared', message: `${name}-workflow` },
        },
      ],
    });
    expect(workflow.id).toBe('shared-workflow');
    const assets = fixture.host.bureau.assets;
    if (assets === undefined) throw new Error('Workspace assets were not composed');
    const admission = await assets.admit(
      {
        source: { kind: 'inline', bytes: encoder.encode(`${name}-asset`) },
        declaredMediaType: 'text/plain',
      },
      { id: `${name}:alice` },
    );
    await admission.work.result();
    expect(admission.assetId).toBe('shared-asset');
    const chat = await fetch(new URL('/bureau/ag-ui/agents/shared/run', fixture.host.url), {
      method: 'POST',
      headers: {
        'x-api-key': 'alice',
        'content-type': 'application/json',
        accept: 'text/event-stream',
      },
      body: JSON.stringify({
        threadId: 'shared-session',
        runId: crypto.randomUUID(),
        messages: [{ id: 'shared-message', role: 'user', content: `${name}-private-chat` }],
        tools: [],
        context: [],
        state: {},
        forwardedProps: {},
      }),
    });
    expect(chat.status).toBe(200);
    const text = await chat.text();
    expect(text).toContain(`${name}-private-result`);
    const memory = await call(fixture.host, 'alice', 'bureau.memory.remember', {
      agentId: 'shared',
      content: `${name}-private-memory`,
    });
    expect(memory.status).toBe(200);
    expect(memory.text).toContain(`${name}-private-memory`);
  }
  for (const [fixture, name, other] of [
    [a, 'workspace-a', 'workspace-b'],
    [b, 'workspace-b', 'workspace-a'],
  ] as const) {
    const asset = await fixture.host.bureau.assets!.resolve(
      { assetId: 'shared-asset' },
      { id: `${name}:alice` },
    );
    expect(asset.content.kind).toBe('bytes');
    if (asset.content.kind !== 'bytes') throw new Error('Expected stored asset bytes');
    expect(new TextDecoder().decode(asset.content.bytes)).toBe(`${name}-asset`);
    const context = await call(fixture.host, 'alice', 'bureau.contexts.get', {
      contextId: 'shared-session',
    });
    expect(context.text).toContain('shared-session');
    expect(context.text).not.toContain(`${other}-private-chat`);
    const administrator = await call(fixture.host, 'admin', 'bureau.contexts.get', {
      contextId: 'shared-session',
    });
    expect(administrator.text).toContain('NotFound');
    expect(administrator.text).not.toContain(`${name}-private-chat`);
    const ownerMemory = await call(fixture.host, 'alice', 'bureau.memory.list', {
      agentId: 'shared',
    });
    expect(ownerMemory.text).toContain(`${name}-private-memory`);
    expect(ownerMemory.text).not.toContain(`${other}-private-memory`);
    for (const actor of name === 'workspace-a' ? ['bob', 'admin'] : ['admin']) {
      for (const [method, parameters] of [
        ['bureau.memory.list', { agentId: 'shared' }],
        ['bureau.memory.search', { agentId: 'shared', query: 'private-memory' }],
        ['bureau.contexts.list', {}],
      ] as const) {
        const listing = await call(fixture.host, actor, method, parameters);
        expect(listing.status).toBe(200);
        expect(listing.text).not.toContain(`${name}-private-memory`);
        expect(listing.text).not.toContain(`${name}-private-chat`);
        expect(listing.text).not.toContain(`${other}-private-memory`);
      }
    }
  }
  await exerciseEngineRelay(a.host);
  const taskA = await a.host.bureau.tasks.start('shared', 'workspace-a-private-input', {
    principal: 'workspace-a:alice',
  });
  const taskB = await b.host.bureau.tasks.start('shared', 'workspace-b-private-input', {
    principal: 'workspace-b:alice',
  });
  await Promise.all([taskA.result(), taskB.result()]);
  const administratorWitnesses = await exerciseAdministratorRoutes(a.host, a.directory);
  const memberRoutes = aRoutes.filter(
    (entry) => entry.resourceClass === 'member-shared-read' && !entry.delegated,
  );
  expect(memberRoutes.length).toBeGreaterThan(0);
  const memberWitnesses = new Set<string>();
  for (const entry of memberRoutes) {
    const [method, path] = entry.key.split(' ');
    if (method !== 'GET' || path === undefined)
      throw new Error(`The shared route needs a fixture: ${entry.key}`);
    const concretePath = path
      .replace(':name', 'shared-integration')
      .replace(':app', 'fixture-panel');
    for (const actor of ['alice', 'bob', 'admin', 'grantee', 'foreign', 'removed']) {
      const response = await fetch(new URL(concretePath, a.host.url), {
        headers: { 'x-api-key': actor, origin: a.host.url.origin },
      });
      const text = await response.text();
      if (actor === 'foreign' || actor === 'removed') {
        expect(response.status).toBe(403);
        expect(text).toBe('Workspace membership required');
      } else expect(response.status).toBe(200);
      expect(text).not.toContain('workspace-a-private-input');
      expect(text).not.toContain('workspace-b-private-input');
      expect(text).not.toContain('workspace-a-secret');
      expect(text).not.toContain('workspace-b-secret');
      memberWitnesses.add(`${entry.key}:${actor}`);
    }
  }
  expect(memberWitnesses.size).toBe(memberRoutes.length * 6);
  const publicWitnesses: string[] = [];
  for (const entry of aRoutes.filter((route) => route.resourceClass === 'public-discovery')) {
    const path = entry.key
      .slice('GET '.length)
      .replace(/:[a-zA-Z]+/g, 'fixture-resource')
      .replace('*', 'missing-fixture');
    const response = await fetch(new URL(path, a.host.url), { headers: { accept: 'text/html' } });
    const text = await response.text();
    if (entry.key === 'GET /assets/*') expect(response.status).toBe(404);
    else {
      expect(response.status).toBe(200);
      expect(text).toContain('Workspace fixture shell');
    }
    expect(text).not.toContain('workspace-a-private-input');
    expect(text).not.toContain('workspace-b-private-input');
    publicWitnesses.push(entry.key);
  }

  const privateRoutes = aRoutes.filter(
    (entry) => entry.resourceClass === 'private-owned' && !entry.delegated,
  );
  expect(privateRoutes.map((entry) => entry.key).toSorted()).toEqual(
    ['GET /api/v1/principal', 'POST /host/plugins/:name/apps/:app/tool-calls'].toSorted(),
  );
  const hostProjectionConformance = new Map<string, string>();
  for (const entry of deploymentRoutes)
    hostProjectionConformance.set(
      `host:${entry.key}`,
      'six workspace actors denied before the deployment serializer',
    );
  for (const entry of memberRoutes)
    hostProjectionConformance.set(
      `host:${entry.key}`,
      'six actor responses exclude seeded private tasks and credentials',
    );
  for (const key of administratorWitnesses)
    hostProjectionConformance.set(
      `host:${key}`,
      key === 'GET /host/oauth/callback/:id'
        ? 'forged, revoked, completed and replayed state checked'
        : 'six actor responses exclude seeded private tasks and credentials',
    );
  for (const entry of privateRoutes)
    hostProjectionConformance.set(
      `host:${entry.key}`,
      'six actors exercise current identity or an owned task through the panel',
    );
  for (const key of publicWitnesses)
    hostProjectionConformance.set(
      `host:${key}`,
      'static shell or asset response excludes seeded private task data',
    );
  hostProjectionConformance.set(
    'host:* /bureau/*',
    'delegated Bureau operations and mounts have separate producer witnesses',
  );
  hostProjectionConformance.set(
    'host:* engine-proxy',
    'every registered engine operation is denied to workspace actors and WebSocket controls subscribe locally',
  );
  expect([...hostProjectionConformance.keys()].toSorted()).toEqual(
    aRoutes.map((entry) => `host:${entry.key}`).toSorted(),
  );
  for (const actor of ['alice', 'bob', 'admin', 'grantee', 'foreign', 'removed']) {
    const principal = await fetch(new URL('/api/v1/principal', a.host.url), {
      headers: { 'x-api-key': actor },
    });
    const principalText = await principal.text();
    const callResponse = await fetch(
      new URL('/host/plugins/shared-integration/apps/fixture-panel/tool-calls', a.host.url),
      {
        method: 'POST',
        headers: {
          'x-api-key': actor,
          origin: a.host.url.origin,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ name: 'bureau.tasks.inspect', arguments: { taskId: taskA.id } }),
      },
    );
    const callText = await callResponse.text();
    if (actor === 'foreign' || actor === 'removed') {
      expect(principal.status).toBe(403);
      expect(principalText).toBe('Workspace membership required');
      expect(callResponse.status).toBe(403);
      expect(callText).toBe('Workspace membership required');
    } else {
      expect(principal.status).toBe(200);
      expect(JSON.parse(principalText)).toMatchObject({
        workspace: { owner: `workspace-a:${actor}` },
      });
      expect(callResponse.status).toBe(200);
      const result = JSON.parse(callText) as {
        isError?: boolean;
        structuredContent?: { code?: string };
      };
      if (actor === 'alice') expect(result.isError).not.toBe(true);
      else expect(result).toMatchObject({ isError: true, structuredContent: { code: 'NotFound' } });
    }
    if (actor !== 'alice') expect(callText).not.toContain('workspace-a-private-input');
  }
  const parked = await a.host.bureau.tasks.start('waiting', 'private-review-input', {
    principal: 'workspace-a:alice',
  });
  await waitUntil(() => a.host.bureau.reviews.list().some((review) => review.runId === parked.id), {
    message: 'the owner review to park',
  });
  const review = a.host.bureau.reviews.list().find((item) => item.runId === parked.id);
  if (review === undefined) throw new Error('Expected the owner review');
  const schedule = await a.host.bureau.schedules.create({
    agentName: 'scheduled',
    input: 'shared automation',
    spec: '24h',
    principal: 'workspace-a:alice',
  });
  if (schedule === undefined) throw new Error('Expected an owner schedule');
  for (const fixture of [a, b]) {
    const response = await call(fixture.host, 'alice', 'bureau.agents.list', {});
    expect(response.status).toBe(200);
    expect(response.text).toContain('shared');
  }
  const owner = await call(a.host, 'alice', 'bureau.tasks.get', { taskId: taskA.id });
  expect(owner.status).toBe(200);
  expect(owner.text).toContain(taskA.id);
  for (const actor of ['bob', 'admin']) {
    const denied = await call(a.host, actor, 'bureau.tasks.get', { taskId: taskA.id });
    expect(denied.text).toContain('NotFound');
    expect(denied.text).not.toContain('workspace-a-private-input');
  }
  const foreign = await call(b.host, 'alice', 'bureau.tasks.get', { taskId: taskA.id });
  expect(foreign.text).toContain('NotFound');
  expect(foreign.text).not.toContain('workspace-a-private-input');
  const foreignStream = await fetch(
    new URL(
      `/bureau/v1/subscriptions/bureau.tasks.events?taskId=${encodeURIComponent(taskA.id)}`,
      b.host.url,
    ),
    { headers: { 'x-api-key': 'alice', accept: 'text/event-stream' } },
  );
  expect(foreignStream.status).toBe(404);
  expect(await foreignStream.text()).not.toContain('workspace-a-private-input');
  const removed = await call(b.host, 'bob', 'bureau.tasks.list', {});
  expect(removed.status).toBe(403);
  expect(removed.text).not.toContain('workspace-b-private-input');
  const previous = a.directory.get('alice')!;
  const delayed = await a.host.bureau.tasks.start('delayed', 'private-delayed-input', {
    principal: 'workspace-a:alice',
  });
  await a.providerStarted.promise;
  a.directory.delete('alice');
  a.releaseProvider.resolve();
  await delayed.result();
  expect(a.privilegedEffects.count).toBe(0);
  const effectsBeforeRemoval = a.scheduleEffects.count;
  await a.host.bureau.maintain();
  const paused = await a.host.bureau.schedules.get(schedule.id);
  expect(paused?.status).toBe('paused');
  if (paused === undefined || paused === null) throw new Error('The owner schedule is missing');
  const deniedFire = await a.host.bureau.schedules.runNow(schedule.id);
  if (deniedFire?.outcome !== 'started') throw new Error('Expected the held fire to be recorded');
  await waitUntil(
    async () => {
      const run = await a.host.bureau.tasks.workflow(deniedFire.workflowId);
      return run?.status === 'failed' || run?.status === 'completed';
    },
    { message: 'the removed owner fire to settle' },
  );
  expect(a.scheduleEffects.count).toBe(effectsBeforeRemoval);
  expect(a.scheduleEffects.authorities).toEqual([]);
  const afterRemoval = await call(a.host, 'alice', 'bureau.tasks.get', { taskId: taskA.id });
  expect(afterRemoval.status).toBe(403);
  expect(afterRemoval.text).not.toContain('workspace-a-private-input');
  const deniedReview = await call(a.host, 'alice', 'bureau.reviews.resolve', {
    id: review.id,
    decision: 'approve',
    payload: { answer: 'private-answer-sentinel' },
  });
  expect(deniedReview.status).toBe(403);
  expect(a.host.bureau.reviews.list().some((item) => item.id === review.id)).toBe(true);
  const reconnect = await fetch(
    new URL(
      `/bureau/v1/subscriptions/bureau.tasks.events?taskId=${encodeURIComponent(taskA.id)}`,
      a.host.url,
    ),
    { headers: { 'x-api-key': 'alice', accept: 'text/event-stream' } },
  );
  expect(reconnect.status).toBe(403);
  expect(await reconnect.text()).not.toContain('workspace-a-private-input');
  await a.host.bureau.schedules.reassign(schedule.id, {
    administrator: 'workspace-a:admin',
    targetOwner: 'workspace-a:bob',
    expectedRevision: paused.revision,
  });
  const reassigned = await a.host.bureau.schedules.get(schedule.id);
  expect(reassigned?.status).toBe('paused');
  const durableEngine = a.host.bureau.durableEngine();
  if (durableEngine === undefined) throw new Error('Expected the durable engine');
  const scheduleBytes = await durableEngine.storage.get(KEYS.schedule(schedule.id));
  if (scheduleBytes === null || scheduleBytes === undefined)
    throw new Error('The reassigned schedule was not stored');
  expect(decode(scheduleBytes)).toMatchObject({
    input: { workspaceAuthority: { actorId: 'bob', authorizingOwner: 'workspace-a:bob' } },
  });
  await a.host.bureau.schedules.resume(schedule.id);
  const permittedFire = await a.host.bureau.schedules.runNow(schedule.id);
  expect(permittedFire?.outcome).toBe('started');
  await waitUntil(() => a.scheduleEffects.authorities.length > 0, {
    message: 'the reassigned schedule to run',
  });
  expect(a.scheduleEffects.authorities).toEqual([
    expect.objectContaining({
      workspaceId: a.workspaceId,
      actorId: 'bob',
      authorizingOwner: 'workspace-a:bob',
    }),
  ]);
  const bobHistory = await call(a.host, 'bob', 'bureau.contexts.get', {
    contextId: 'shared-session',
  });
  expect(bobHistory.text).toContain('NotFound');
  const bobMemory = await call(a.host, 'bob', 'bureau.memory.list', { agentId: 'shared' });
  expect(bobMemory.text).not.toContain('workspace-a-private-memory');
  const unaffected = await call(b.host, 'alice', 'bureau.tasks.get', { taskId: taskB.id });
  expect(unaffected.text).toContain(taskB.id);
  await a.host.close();
  hosts.splice(hosts.indexOf(a.host), 1);
  const restarted = await a.restart();
  const stillRemoved = await call(restarted, 'alice', 'bureau.tasks.get', { taskId: taskA.id });
  expect(stillRemoved.status).toBe(403);
  a.directory.set('alice', previous);
  const restored = await call(restarted, 'alice', 'bureau.tasks.get', { taskId: taskA.id });
  expect(restored.text).toContain(taskA.id);
  const restoredMemory = await call(restarted, 'alice', 'bureau.memory.list', {
    agentId: 'shared',
  });
  expect(restoredMemory.text).toContain('workspace-a-private-memory');
});
