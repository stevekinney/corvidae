import { BUREAU_SCOPES, type WorkspaceMembership } from '@lostgradient/bureau';
import { definePlugin, type PluginSetupContext } from '@lostgradient/interborough-plugin';
import { createAgent, createDefaultRuntimeServices } from '@lostgradient/operative';
import { createDemoPlugin } from '@lostgradient/plugin-demo';
import {
  openPostgresTestDatabase,
  requireOpenedPostgresTestDatabase,
} from '@lostgradient/testing/postgres-server';
import { createS3TestServer } from '@lostgradient/testing/s3-server';
import { waitUntil } from '@lostgradient/testing/wait-until';
import { AUTHORIZATION_SCOPES, principalFromApiKey } from '@lostgradient/weft';
import { afterAll, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

import { pluginsWithEnabledDemo } from './demo-plugin.test-support.ts';
import { processEnvironment } from './environment-configuration.ts';
import { createHostMutationContext } from './host-mutation-context.ts';
import { startHost, type Host } from './host.ts';
import {
  compileRemoteReplacement,
  createFreshDatabaseUrl,
  createLostAcknowledgementProxy,
  remoteEnvironment,
  runRemoteReplacement,
} from './remote-backends.test-support.ts';
import { startOAuthMcpServer } from './tool-source-servers.test-support.ts';
import { localWorkspaceMembership } from './workspace-principal.ts';
import { secretService } from './workspace-secret-service.test-support.ts';

const database = await openPostgresTestDatabase();
requireOpenedPostgresTestDatabase(database);
afterAll(async () => {
  await database?.[Symbol.asyncDispose]();
});

const remoteConformance = await (async () => {
  const server = createS3TestServer();
  const proxy = createLostAcknowledgementProxy(server);
  await using secrets = await secretService();
  const client = secrets.client();
  const root = await mkdtemp(join(tmpdir(), 'remote-conformance-'));
  const firstHome = join(root, 'first-home');
  const secondHome = join(root, 'second-home');
  const otherHome = join(root, 'other-home');
  const firstScratch = join(root, 'first-scratch');
  const secondScratch = join(root, 'second-scratch');
  const application = join(root, 'read-only-application');
  await Promise.all([
    mkdir(firstHome),
    mkdir(secondHome),
    mkdir(otherHome),
    mkdir(firstScratch),
    mkdir(secondScratch),
  ]);
  expect(await readdir(firstHome)).toEqual([]);
  expect(await readdir(secondHome)).toEqual([]);
  await Bun.write(join(firstScratch, 'temporary-work'), 'disposable test scratch');
  await Bun.write(join(application, 'index.html'), '<!doctype html><title>Fixture</title>');
  const url = await createFreshDatabaseUrl(database);
  const prefix = `conformance/${crypto.randomUUID()}`;
  server.put(`${prefix}/deployment-id`, `${client.workspaceId}\n`);
  const base = { ...remoteEnvironment(url, server, prefix), S3_ENDPOINT: proxy.endpoint };
  const contexts: PluginSetupContext[] = [];
  const hosts: Host[] = [];
  const plugin = {
    source: 'package' as const,
    location: '@fixture/remote-integration',
    descriptor: definePlugin({
      name: 'remote-integration',
      version: '1.0.0',
      description: 'Remote conformance fixture.',
      configuration: z.object({
        left: z.string().default('initial'),
        right: z.string().default('initial'),
      }),
      secrets: ['shared-secret'],
      setup(context) {
        contexts.push(context);
        return {};
      },
    }),
  };
  const demo = pluginsWithEnabledDemo().find((entry) => entry.descriptor.name === 'demo');
  if (demo === undefined) throw new Error('The demo plugin fixture is unavailable');
  const anthropic = pluginsWithEnabledDemo().find((entry) => entry.descriptor.name === 'anthropic');
  if (anthropic === undefined) throw new Error('The provider plugin fixture is unavailable');
  const unseededDemo = {
    ...demo,
    descriptor: { ...createDemoPlugin({ seedOnStart: false }), enabledByDefault: true },
  };
  const plugins = [plugin, unseededDemo, anthropic];
  async function start(
    home: string,
    environment = base,
    index = 0,
    members?: Map<string, WorkspaceMembership>,
  ) {
    const currentClient = secrets.client(index);
    const runtime = createDefaultRuntimeServices();
    const host = await startHost({
      environment: {
        ...environment,
        INTERBOROUGH_HOME: home,
        TMPDIR: home === firstHome ? firstScratch : secondScratch,
      },
      workspaceId: currentClient.workspaceId,
      ...(members === undefined
        ? {}
        : {
            workspaceAuthentication: {
              authentication: {
                resolveApiKeyPrincipal: async (key: string) =>
                  principalFromApiKey({
                    subject: key,
                    scopes: [...AUTHORIZATION_SCOPES, ...BUREAU_SCOPES],
                  }),
              },
              workspace: {
                workspaceId: currentClient.workspaceId,
                resolveMembership: async ({ subject }: { subject: string | undefined }) =>
                  members.get(subject ?? '') ?? null,
                resolveOwnerMembership: async (owner: string) =>
                  [...members.values()].find((entry) => entry.owner === owner) ?? null,
              },
            },
          }),
      secretProvider: () => secrets.client(index).secretProvider,
      runtime: {
        ...runtime,
        identifiers: {
          next: (kind) => (kind === 'asset' ? 'shared-asset' : runtime.identifiers.next(kind)),
        },
      },
      writableConfiguration: true,
      buildDirectory: application,
      port: 0,
      log: () => {},
      plugins,
      extraAgents: {
        agents: {
          shared: createAgent({
            name: 'shared',
            generate: async () => ({ content: 'remote-result', toolCalls: [] }),
          }),
        },
      },
    });
    hosts.push(host);
    return host;
  }
  async function rpc(host: Host, method: string, params: Record<string, unknown>) {
    const response = await fetch(new URL('/bureau/jsonrpc', host.url), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).not.toContain('"error"');
    return body;
  }
  try {
    const executable = await compileRemoteReplacement(application);
    await chmod(executable, 0o555);
    await chmod(application, 0o555);
    const first = await start(firstHome);
    const snapshot = await first.plugins.snapshot();
    const response = await fetch(
      new URL('/host/plugins/remote-integration/secrets/shared-secret', first.url),
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json', origin: first.url.origin },
        body: JSON.stringify({
          value: 'remote-secret-sentinel',
          operationId: 'shared-operation',
          expectedRevision: snapshot.configurationRevision,
        }),
      },
    );
    expect(response.status).toBe(200);
    const providerRevision = await first.plugins.snapshot();
    expect(providerRevision.configurationRevision).not.toBe(snapshot.configurationRevision);
    const connected = await fetch(new URL('/host/providers/anthropic', first.url), {
      method: 'PUT',
      headers: { 'content-type': 'application/json', origin: first.url.origin },
      body: JSON.stringify({
        apiKey: 'remote-provider-secret',
        models: ['sonnet'],
        operationId: 'provider-operation',
        expectedRevision: providerRevision.configurationRevision,
      }),
    });
    expect(connected.status).toBe(200);
    const committed = await first.plugins.snapshot();
    const configuration = server.objects().get(`${prefix}/configuration.json`);
    if (configuration === undefined) throw new Error('Missing committed configuration');
    const savedBindings = (
      JSON.parse(new TextDecoder().decode(configuration)) as {
        secretBindings: Record<string, string>;
      }
    ).secretBindings;
    expect(typeof savedBindings['anthropic-api-key']).toBe('string');
    expect(await client.secretProvider.readVersion(savedBindings['anthropic-api-key']!)).toBe(
      'remote-provider-secret',
    );
    const agent = await first.bureau.agents.create('shared-file-agent', {
      model: 'anthropic/sonnet',
      instructions: 'Original remote agent instructions.',
    });
    await first.bureau.agents.update(
      'shared-file-agent',
      { model: 'anthropic/sonnet', instructions: 'Edited remote agent instructions.' },
      { expectedHash: agent.hash },
    );
    const workflow = await first.bureau.workflows!.create('shared-workflow', {
      agent: 'shared',
      trigger: { kind: 'schedule', spec: '1h' },
      steps: [
        {
          kind: 'activity',
          handler: 'agent',
          input: { agent: 'shared', message: 'remote-workflow-sentinel' },
        },
      ],
    });
    expect(workflow.id).toBe('shared-workflow');
    await first.bureau.workflows!.update(
      'shared-workflow',
      {
        agent: 'shared',
        trigger: { kind: 'schedule', spec: '2h' },
        steps: [
          {
            kind: 'activity',
            handler: 'agent',
            input: { agent: 'shared', message: 'edited-workflow-sentinel' },
          },
        ],
      },
      { expectedHash: workflow.hash },
    );
    const chat = await fetch(new URL('/bureau/ag-ui/agents/shared/run', first.url), {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify({
        threadId: 'shared-session',
        runId: crypto.randomUUID(),
        messages: [{ id: 'shared-message', role: 'user', content: 'remote-chat-sentinel' }],
        tools: [],
        context: [],
        state: {},
        forwardedProps: {},
      }),
    });
    expect(chat.status).toBe(200);
    expect(await chat.text()).toContain('remote-result');
    const assets = first.bureau.assets;
    if (assets === undefined) throw new Error('Remote assets are unavailable');
    const admitted = await assets.admit(
      {
        source: { kind: 'inline', bytes: new TextEncoder().encode('remote-asset-sentinel') },
        declaredMediaType: 'text/plain',
      },
      { id: 'anonymous:local' },
    );
    await admitted.work.result();
    const memory = await rpc(first, 'bureau.memory.remember', {
      agentId: 'shared',
      content: 'remote-memory-sentinel',
    });
    expect(memory).toContain('remote-memory-sentinel');
    await first.bureau.plugins.ready();
    const parked = await first.bureau.tasks.start(
      'demo:request-human-input',
      'Choose an environment',
    );
    await waitUntil(
      () => first.bureau.reviews.list().some((review) => review.runId === parked.id),
      {
        message: 'the first host to park the durable run',
      },
    );
    await first.close();
    hosts.pop();
    expect(await readdir(firstScratch)).toEqual(['temporary-work']);
    await rm(firstScratch, { recursive: true });
    await mkdir(firstScratch);
    const resultFile = join(secondScratch, 'replacement-result.json');
    await runRemoteReplacement(executable, {
      ...base,
      PATH: processEnvironment()['PATH'] ?? '',
      INTERBOROUGH_HOME: secondHome,
      TMPDIR: secondScratch,
      FIXTURE_WORKSPACE: client.workspaceId,
      FIXTURE_SECRET_ENDPOINT: secrets.endpoint.toString(),
      FIXTURE_APPLICATION: application,
      FIXTURE_PARKED_RUN: parked.id,
      FIXTURE_RESULT: resultFile,
    });
    const applicationStatus = await stat(application);
    const executableStatus = await stat(executable);
    expect(applicationStatus.mode & 0o222).toBe(0);
    expect(executableStatus.mode & 0o222).toBe(0);
    expect(await readdir(secondScratch)).toEqual(['replacement-result.json']);
    const resultText = await Bun.file(resultFile).text();
    expect(resultText).not.toContain('remote-secret-sentinel');
    expect(resultText).not.toContain('remote-provider-secret');
    const replacement = JSON.parse(resultText) as Record<string, unknown>;
    expect(replacement).toEqual({
      workspaceId: first.workspaceId,
      configurationRevision: committed.configurationRevision,
      temporaryDirectory: secondScratch,
      secretMatches: true,
      agentMatches: true,
      workflowMatches: true,
      contextMatches: true,
      memoryMatches: true,
      assetMatches: true,
    });
    await rm(resultFile);
    let second = await start(secondHome);
    expect(second.workspaceId).toBe(first.workspaceId);
    const recoveredSnapshot = await second.plugins.snapshot();
    expect(recoveredSnapshot.configurationRevision).toBe(committed.configurationRevision);
    const recoveredConfiguration = server.objects().get(`${prefix}/configuration.json`);
    if (recoveredConfiguration === undefined) throw new Error('Missing recovered configuration');
    const recoveredBindings = (
      JSON.parse(new TextDecoder().decode(recoveredConfiguration)) as {
        secretBindings: Record<string, string>;
      }
    ).secretBindings;
    expect(recoveredBindings).toEqual(savedBindings);
    expect(await client.secretProvider.readVersion(recoveredBindings['anthropic-api-key']!)).toBe(
      'remote-provider-secret',
    );
    expect(await contexts.at(-1)!.secrets.get('shared-secret')).toBe('remote-secret-sentinel');
    const recoveredWorkflow = await second.bureau.workflows!.get('shared-workflow');
    const recoveredAgent = await second.bureau.agents.read('shared-file-agent');
    const recoveredContext = await second.bureau.contexts.get('shared-session');
    expect(recoveredWorkflow?.id).toBe('shared-workflow');
    expect(JSON.stringify(recoveredWorkflow)).toContain('edited-workflow-sentinel');
    expect(JSON.stringify(recoveredAgent)).toContain('Edited remote agent instructions.');
    expect(recoveredContext?.id).toBe('shared-session');
    const recovered = await second.bureau.assets!.resolve(
      { assetId: admitted.assetId },
      { id: 'anonymous:local' },
    );
    expect(recovered.content.kind).toBe('bytes');
    if (recovered.content.kind !== 'bytes') throw new Error('Expected persisted asset bytes');
    expect(new TextDecoder().decode(recovered.content.bytes)).toBe('remote-asset-sentinel');
    expect(await rpc(second, 'bureau.memory.list', { agentId: 'shared' })).toContain(
      'remote-memory-sentinel',
    );
    const recoveredRun = await second.bureau.tasks.workflow(parked.id);
    expect(recoveredRun?.status).toBe('completed');
    expect(await readdir(firstHome)).toEqual([]);
    expect(await readdir(secondHome)).toEqual([]);
    let concurrent = await start(firstHome);
    const secondSnapshot = await second.plugins.snapshot();
    const concurrentSnapshot = await concurrent.plugins.snapshot();
    const revision = secondSnapshot.configurationRevision;
    expect(concurrentSnapshot.configurationRevision).toBe(revision);
    const write = (host: Host, operationId: string, value: string) =>
      fetch(new URL('/host/plugins/remote-integration/secrets/shared-secret', host.url), {
        method: 'PUT',
        headers: { 'content-type': 'application/json', origin: host.url.origin },
        body: JSON.stringify({ value, operationId, expectedRevision: revision }),
      });
    const outcomes = await Promise.all([
      write(second, 'concurrent-a', 'remote-candidate-a'),
      write(concurrent, 'concurrent-b', 'remote-candidate-b'),
    ]);
    expect(
      outcomes.map((outcome) => outcome.status).toSorted((left, right) => left - right),
    ).toEqual([200, 409]);
    const winner = outcomes[0].status === 200 ? 'remote-candidate-a' : 'remote-candidate-b';
    expect(await contexts.at(-1)!.secrets.get('shared-secret')).toBe(winner);
    expect(await contexts.at(-2)!.secrets.get('shared-secret')).toBe(winner);
    const beforeLostAck = await second.plugins.snapshot();
    const writesBeforeLostAck = proxy.writes();
    proxy.arm();
    const reconciled = await fetch(
      new URL('/host/plugins/remote-integration/secrets/shared-secret', second.url),
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json', origin: second.url.origin },
        body: JSON.stringify({
          value: 'acknowledged-after-read',
          operationId: 'lost-ack',
          expectedRevision: beforeLostAck.configurationRevision,
        }),
      },
    );
    expect(reconciled.status).toBe(200);
    expect(proxy.lost()).toBe(1);
    expect(proxy.writes() - writesBeforeLostAck).toBe(1);
    expect(await contexts.at(-1)!.secrets.get('shared-secret')).toBe('acknowledged-after-read');
    expect(await contexts.at(-2)!.secrets.get('shared-secret')).toBe('acknowledged-after-read');
    const beforeSuperseded = await second.plugins.snapshot();
    const writesBeforeSuperseded = proxy.writes();
    proxy.arm(async () => {
      const fresh = await concurrent.plugins.snapshot();
      const competing = await fetch(
        new URL('/host/plugins/remote-integration/secrets/shared-secret', concurrent.url),
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json', origin: concurrent.url.origin },
          body: JSON.stringify({
            value: 'newer-winner',
            operationId: 'newer-operation',
            expectedRevision: fresh.configurationRevision,
          }),
        },
      );
      expect(competing.status).toBe(200);
    });
    const uncertain = await fetch(
      new URL('/host/plugins/remote-integration/secrets/shared-secret', second.url),
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json', origin: second.url.origin },
        body: JSON.stringify({
          value: 'superseded-secret',
          operationId: 'superseded-operation',
          expectedRevision: beforeSuperseded.configurationRevision,
        }),
      },
    );
    expect(uncertain.status).toBe(503);
    expect(proxy.lost()).toBe(2);
    expect(proxy.writes() - writesBeforeSuperseded).toBe(2);
    const operations = await client.secretProvider.listOperations();
    const directory = localWorkspaceMembership(client.workspaceId);
    const identity = await directory.resolveMembership({
      method: 'unauthenticated-local',
      subject: undefined,
    });
    if (identity === null) throw new Error('The local owner is unavailable');
    const mutation = createHostMutationContext(
      identity,
      {
        operationId: 'superseded-operation',
        expectedRevision: beforeSuperseded.configurationRevision,
      },
      async () => identity,
    );
    const operationId = mutation.operationIdFor(
      'plugin-secret',
      JSON.stringify(['remote-integration', 'shared-secret']),
    );
    const unknown = operations.find((operation) => operation.id === operationId);
    expect(unknown?.state).toBe('unknown');
    if (unknown === undefined) throw new Error('The superseded operation was not recorded');
    const reclaimed = await client.secretProvider.reclaim(unknown.reference).then(
      () => true,
      () => false,
    );
    expect(reclaimed).toBe(false);
    const writesBeforeRetry = proxy.writes();
    const retry = await fetch(
      new URL('/host/plugins/remote-integration/secrets/shared-secret', second.url),
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json', origin: second.url.origin },
        body: JSON.stringify({
          value: 'superseded-secret',
          operationId: 'superseded-operation',
          expectedRevision: beforeSuperseded.configurationRevision,
        }),
      },
    );
    expect([409, 503]).toContain(retry.status);
    expect(proxy.writes()).toBe(writesBeforeRetry);
    expect(await contexts.at(-1)!.secrets.get('shared-secret')).toBe('newer-winner');
    expect(await contexts.at(-2)!.secrets.get('shared-secret')).toBe('newer-winner');
    const beforeConfiguration = await second.plugins.snapshot();
    const configurationRevision = beforeConfiguration.configurationRevision;
    const update = (
      host: Host,
      operationId: string,
      configuration: { left: string; right: string },
    ) =>
      fetch(new URL('/host/plugins/remote-integration', host.url), {
        method: 'PUT',
        headers: { 'content-type': 'application/json', origin: host.url.origin },
        body: JSON.stringify({
          operationId,
          expectedRevision: configurationRevision,
          configuration,
        }),
      });
    const configurationOutcomes = await Promise.all([
      update(second, 'configuration-left', { left: 'changed', right: 'initial' }),
      update(concurrent, 'configuration-right', { left: 'initial', right: 'changed' }),
    ]);
    expect(
      configurationOutcomes.map((outcome) => outcome.status).toSorted((a, b) => a - b),
    ).toEqual([200, 409]);
    const updatedConfiguration = server.objects().get(`${prefix}/configuration.json`);
    if (updatedConfiguration === undefined) throw new Error('Missing updated configuration');
    const updatedDocument = JSON.parse(new TextDecoder().decode(updatedConfiguration)) as {
      plugins: Record<string, { configuration: { left: string; right: string } }>;
      secretBindings: Record<string, string>;
    };
    expect(updatedDocument.plugins['remote-integration']?.configuration).toEqual(
      configurationOutcomes[0].status === 200
        ? { left: 'changed', right: 'initial' }
        : { left: 'initial', right: 'changed' },
    );
    expect(updatedDocument.secretBindings['anthropic-api-key']).toBe(
      savedBindings['anthropic-api-key'],
    );
    const oauth = await startOAuthMcpServer();
    try {
      await second.toolSources.connect({
        id: 'shared-oauth',
        principal: 'anonymous:local',
        source: {
          id: 'shared-oauth',
          kind: 'mcp',
          transport: { type: 'http', url: `${oauth.origin}/`, authentication: { type: 'oauth' } },
        },
      });
      const sourceSnapshot = await fetch(new URL('/host/tool-sources', second.url));
      const { configurationRevision } = (await sourceSnapshot.json()) as {
        configurationRevision: string | null;
      };
      const authorize = await fetch(
        new URL('/host/tool-sources/shared-oauth/authorize', second.url),
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: second.url.origin },
          body: JSON.stringify({
            operationId: 'shared-oauth-start',
            expectedRevision: configurationRevision,
          }),
        },
      );
      expect(authorize.status).toBe(200);
      const { authorizationUrl } = (await authorize.json()) as { authorizationUrl: string };
      const redirect = await fetch(authorizationUrl, { redirect: 'manual' });
      const callback = redirect.headers.get('location');
      if (callback === null) throw new Error('OAuth fixture did not supply a callback');
      const alternate = new URL(callback);
      alternate.host = concurrent.url.host;
      const callbacks = await Promise.all([fetch(callback), fetch(alternate)]);
      expect(
        callbacks.map((response) => response.status).toSorted((left, right) => left - right),
      ).toEqual([200, 400]);
      expect(oauth.issuedAccessTokens).toHaveLength(1);
      const expiredToken = oauth.issuedAccessTokens[0];
      const expiredAttemptsBefore = oauth.authorizations.filter(
        (header) => header === `Bearer ${expiredToken}`,
      ).length;
      oauth.expireAccessTokens();
      await second.close();
      await concurrent.close();
      hosts.splice(hosts.indexOf(second), 1);
      hosts.splice(hosts.indexOf(concurrent), 1);
      [second, concurrent] = await Promise.all([start(secondHome), start(firstHome)]);
      expect(
        oauth.authorizations.filter((header) => header === `Bearer ${expiredToken}`).length -
          expiredAttemptsBefore,
      ).toBeGreaterThanOrEqual(2);
      expect(oauth.refreshRequests).toHaveLength(1);
      expect(oauth.issuedAccessTokens).toHaveLength(2);
      const standings = await Promise.all([
        second.toolSources.snapshot(),
        concurrent.toolSources.snapshot(),
      ]);
      expect(
        standings.some((standing) =>
          standing.sources.some(
            (source) => source.id === 'shared-oauth' && source.state === 'loaded',
          ),
        ),
      ).toBe(true);
    } finally {
      await oauth.stop();
    }
    const otherClient = secrets.client(1);
    const otherPrefix = `conformance/${crypto.randomUUID()}`;
    server.put(`${otherPrefix}/deployment-id`, `${otherClient.workspaceId}\n`);
    const otherEnvironment = {
      ...remoteEnvironment(await createFreshDatabaseUrl(database), server, otherPrefix),
      S3_ENDPOINT: proxy.endpoint,
    };
    const other = await start(otherHome, otherEnvironment, 1);
    expect(other.workspaceId).not.toBe(second.workspaceId);
    expect(await other.bureau.contexts.get('shared-session')).toBeUndefined();
    const otherWorkflow = await other.bureau.workflows!.create('shared-workflow', {
      agent: 'shared',
      trigger: { kind: 'schedule', spec: '1h' },
      steps: [
        {
          kind: 'activity',
          handler: 'agent',
          input: { agent: 'shared', message: 'other-workspace-workflow' },
        },
      ],
    });
    expect(otherWorkflow.id).toBe('shared-workflow');
    const otherChat = await fetch(new URL('/bureau/ag-ui/agents/shared/run', other.url), {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify({
        threadId: 'shared-session',
        runId: crypto.randomUUID(),
        messages: [{ id: 'shared-message', role: 'user', content: 'other-workspace-chat' }],
        tools: [],
        context: [],
        state: {},
        forwardedProps: {},
      }),
    });
    expect(await otherChat.text()).toContain('remote-result');
    const otherContext = await other.bureau.contexts.get('shared-session');
    expect(otherContext?.id).toBe('shared-session');
    expect(await rpc(other, 'bureau.memory.list', { agentId: 'shared' })).not.toContain(
      'remote-memory-sentinel',
    );
    expect(await rpc(second, 'bureau.memory.list', { agentId: 'shared' })).toContain(
      'remote-memory-sentinel',
    );
    const otherSnapshot = await other.plugins.snapshot();
    const otherWrite = await fetch(
      new URL('/host/plugins/remote-integration/secrets/shared-secret', other.url),
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json', origin: other.url.origin },
        body: JSON.stringify({
          value: 'other-workspace-secret',
          operationId: 'shared-operation',
          expectedRevision: otherSnapshot.configurationRevision,
        }),
      },
    );
    expect(otherWrite.status).toBe(200);
    expect(await contexts.at(-1)!.secrets.get('shared-secret')).toBe('other-workspace-secret');
    expect(await contexts.at(-2)!.secrets.get('shared-secret')).toBe('newer-winner');
    const otherAsset = await other.bureau.assets!.admit(
      {
        source: { kind: 'inline', bytes: new TextEncoder().encode('other-asset-sentinel') },
        declaredMediaType: 'text/plain',
      },
      { id: 'anonymous:local' },
    );
    await otherAsset.work.result();
    expect(otherAsset.assetId).toBe(admitted.assetId);
    const otherContent = await other.bureau.assets!.resolve(
      { assetId: admitted.assetId },
      { id: 'anonymous:local' },
    );
    if (otherContent.content.kind !== 'bytes')
      throw new Error('Expected other workspace asset bytes');
    expect(new TextDecoder().decode(otherContent.content.bytes)).toBe('other-asset-sentinel');
    const memberDirectory = (workspaceId: string) =>
      new Map<string, WorkspaceMembership>(
        ['alice', 'bob', 'admin'].map((actorId) => [
          actorId,
          {
            version: 1,
            workspaceId,
            actorId,
            actorKind: 'user',
            owner: `${workspaceId}:${actorId}`,
            membershipRevision: 'fixture-1',
            capabilities:
              actorId === 'admin' ? ['workspace:use', 'workspace:manage'] : ['workspace:use'],
          },
        ]),
      );
    const firstMembers = memberDirectory(client.workspaceId);
    const otherMembers = memberDirectory(otherClient.workspaceId);
    const authenticatedFirst = await start(firstHome, base, 0, firstMembers);
    const authenticatedOther = await start(otherHome, otherEnvironment, 1, otherMembers);
    const authenticatedCall = async (
      host: Host,
      actor: string,
      method: string,
      params: Record<string, unknown>,
    ) => {
      const response = await fetch(new URL('/bureau/jsonrpc', host.url), {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': actor },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      return { status: response.status, body: await response.text() };
    };
    for (const [host, sentinel] of [
      [authenticatedFirst, 'first-remote-private'],
      [authenticatedOther, 'other-remote-private'],
    ] as const) {
      const written = await authenticatedCall(host, 'alice', 'bureau.memory.remember', {
        agentId: 'shared',
        content: sentinel,
      });
      expect(written.body).toContain(sentinel);
      for (const actor of ['bob', 'admin']) {
        const read = await authenticatedCall(host, actor, 'bureau.memory.list', {
          agentId: 'shared',
        });
        expect(read.status).toBe(200);
        expect(read.body).not.toContain(sentinel);
      }
    }
    firstMembers.delete('alice');
    const revoked = await authenticatedCall(authenticatedFirst, 'alice', 'bureau.memory.list', {
      agentId: 'shared',
    });
    expect(revoked.status).toBe(403);
    const stillMember = await authenticatedCall(authenticatedOther, 'alice', 'bureau.memory.list', {
      agentId: 'shared',
    });
    expect(stillMember.body).toContain('other-remote-private');
    expect(stillMember.body).not.toContain('first-remote-private');
    expect(await readdir(otherHome)).toEqual([]);
    expect(await readdir(firstScratch)).toEqual([]);
    expect(await readdir(secondScratch)).toEqual([]);
  } finally {
    for (const host of hosts) await host.close();
    await proxy.stop();
    await server.stop();
    await chmod(application, 0o755);
    await rm(root, { recursive: true, force: true });
  }
  return true;
})();

test('a replacement remote host recovers a committed integration and workflow from shared services', () => {
  expect(remoteConformance).toBe(true);
});
