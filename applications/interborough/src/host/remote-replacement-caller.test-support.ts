/** A compiled replacement host for remote persistence conformance. */
import { definePlugin } from '@lostgradient/interborough-plugin';
import { createAgent, createDefaultRuntimeServices } from '@lostgradient/operative';
import anthropic from '@lostgradient/plugin-anthropic';
import { createDemoPlugin, HUMAN_INPUT_SIGNAL } from '@lostgradient/plugin-demo';
import { waitUntil } from '@lostgradient/testing/wait-until';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { processEnvironment } from './environment-configuration.ts';
import { startHost } from './host.ts';
import { secretServiceClient } from './workspace-secret-service.test-support.ts';

const environment = processEnvironment();
function required(key: string): string {
  const value = environment[key];
  if (value === undefined) throw new Error(`Missing fixture input ${key}`);
  return value;
}
const workspaceId = required('FIXTURE_WORKSPACE');
const secretProvider = secretServiceClient(
  new URL(required('FIXTURE_SECRET_ENDPOINT')),
  workspaceId,
).secretProvider;
const runtime = createDefaultRuntimeServices();
let secret: (() => Promise<string | undefined>) | undefined;
const host = await startHost({
  environment,
  workspaceId,
  secretProvider: () => secretProvider,
  writableConfiguration: true,
  buildDirectory: required('FIXTURE_APPLICATION'),
  port: 0,
  log: () => {},
  runtime: {
    ...runtime,
    identifiers: {
      next: (kind) => (kind === 'asset' ? 'shared-asset' : runtime.identifiers.next(kind)),
    },
  },
  plugins: [
    {
      source: 'package',
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
          secret = () => context.secrets.get('shared-secret');
          return {};
        },
      }),
    },
    {
      source: 'package',
      location: '@lostgradient/plugin-demo',
      descriptor: { ...createDemoPlugin({ seedOnStart: false }), enabled: true },
    },
    { source: 'package', location: '@lostgradient/plugin-anthropic', descriptor: anthropic },
  ],
  extraAgents: {
    agents: {
      shared: createAgent({
        name: 'shared',
        generate: async () => ({ content: 'remote-result', toolCalls: [] }),
      }),
    },
  },
});
try {
  const parked = required('FIXTURE_PARKED_RUN');
  await waitUntil(() => host.bureau.reviews.list().some((review) => review.runId === parked), {
    message: 'replacement host to recover review',
  });
  const review = host.bureau.reviews.list().find((item) => item.runId === parked);
  if (review?.kind !== 'human-wait' || review.signalName !== HUMAN_INPUT_SIGNAL)
    throw new Error('Missing recovered review');
  const snapshot = await host.plugins.snapshot();
  const agent = await host.bureau.agents.read('shared-file-agent');
  const workflow = await host.bureau.workflows!.get('shared-workflow');
  const context = await host.bureau.contexts.get('shared-session');
  const asset = await host.bureau.assets!.resolve(
    { assetId: 'shared-asset' },
    { id: 'anonymous:local' },
  );
  const memory = await fetch(new URL('/bureau/jsonrpc', host.url), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'bureau.memory.list',
      params: { agentId: 'shared' },
    }),
  });
  if (memory.status !== 200) throw new Error('Replacement could not read memory');
  const memoryText = await memory.text();
  const report = {
    workspaceId: host.workspaceId,
    configurationRevision: snapshot.configurationRevision,
    temporaryDirectory: tmpdir(),
    secretMatches: (await secret?.()) === 'remote-secret-sentinel',
    agentMatches: JSON.stringify(agent).includes('Edited remote agent instructions.'),
    workflowMatches: JSON.stringify(workflow).includes('edited-workflow-sentinel'),
    contextMatches: context?.id === 'shared-session',
    memoryMatches: memoryText.includes('remote-memory-sentinel'),
    assetMatches:
      asset.content.kind === 'bytes' &&
      new TextDecoder().decode(asset.content.bytes) === 'remote-asset-sentinel',
  };
  await host.bureau.reviews.resolve({
    id: review.id,
    decision: 'approve',
    principal: 'anonymous:local',
    payload: { environment: 'staging' },
  });
  await waitUntil(
    async () => {
      const run = await host.bureau.tasks.workflow(parked);
      return run?.status === 'completed';
    },
    { message: 'replacement host to complete review' },
  );
  await Bun.write(required('FIXTURE_RESULT'), JSON.stringify(report));
} finally {
  await host.close();
}
