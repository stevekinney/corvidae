import { openBungalow } from '@lostgradient/bungalow';
import { definePlugin, type PluginSetupContext } from '@lostgradient/interborough-plugin';
import { createAgent, createDefaultRuntimeServices, stopWhen } from '@lostgradient/operative';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startHost, type Host } from './host.ts';

const homes: string[] = [];
const hosts: Host[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

describe('workspace runtime identity', () => {
  test('keeps the workspace memory tenant stable while runtime instances change', async () => {
    const home = await mkdtemp(join(tmpdir(), 'interborough-workspace-'));
    homes.push(home);

    const first = await startHost({ environment: { INTERBOROUGH_HOME: home }, port: 0 });
    hosts.push(first);
    expect(first.workspaceId).toBe(first.deploymentId);
    expect(first.bureau.id).toBe(first.workspaceId);
    const firstRuntime = first.runtimeInstanceId;
    await first.close();
    hosts.splice(hosts.indexOf(first), 1);

    const second = await startHost({ environment: { INTERBOROUGH_HOME: home }, port: 0 });
    hosts.push(second);
    expect(second.workspaceId).toBe(first.workspaceId);
    expect(second.bureau.id).toBe(first.bureau.id);
    expect(second.runtimeInstanceId).not.toBe(firstRuntime);
  });

  test('keeps two homes isolated when names overlap, and closing B leaves A usable', async () => {
    const homeA = await mkdtemp(join(tmpdir(), 'interborough-workspace-a-'));
    const homeB = await mkdtemp(join(tmpdir(), 'interborough-workspace-b-'));
    homes.push(homeA, homeB);
    const contexts = new Map<string, PluginSetupContext>();
    async function start(home: string, sentinel: string) {
      const environment = { INTERBOROUGH_HOME: home };
      using bungalow = await openBungalow({ name: 'interborough', environment });
      bungalow.writeSecret('probe-key', sentinel);
      const agents = bungalow.content('agents');
      if (agents.kind !== 'directory') throw new Error('Expected a local content root');
      await Bun.write(
        join(agents.path, 'researcher.md'),
        `---\nname: ${sentinel}\nmodel: anthropic/sonnet\n---\n${sentinel}\n`,
      );
      bungalow.close();
      const runtime = createDefaultRuntimeServices();
      return startHost({
        environment,
        port: 0,
        log: () => undefined,
        runtime: {
          ...runtime,
          identifiers: {
            next: (kind) => (kind === 'asset' ? 'shared-asset' : runtime.identifiers.next(kind)),
          },
        },
        extraAgents: {
          agents: {
            writer: createAgent({
              name: 'writer',
              generate: async () => ({ content: sentinel, toolCalls: [] }),
              stopWhen: stopWhen.noToolCalls(),
            }),
          },
        },
        plugins: [
          {
            source: 'package',
            location: '@fixture/probe',
            descriptor: definePlugin({
              name: 'probe',
              version: '1.0.0',
              description: 'Workspace resource probe.',
              secrets: ['probe-key'],
              setup: (context) => {
                contexts.set(home, context);
                return {};
              },
            }),
          },
        ],
      });
    }
    const [hostA, hostB] = await Promise.all([
      start(homeA, 'Home A evidence'),
      start(homeB, 'Home B evidence'),
    ]);
    hosts.push(hostA, hostB);

    expect(hostA.workspaceId).not.toBe(hostB.workspaceId);
    expect(hostA.database).not.toEqual(hostB.database);
    expect(hostA.bureau.id).not.toBe(hostB.bureau.id);

    async function chat(host: Host, threadId = 'shared-session') {
      const response = await fetch(new URL('/bureau/ag-ui/agents/writer/run', host.url), {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
        body: JSON.stringify({
          threadId,
          runId: crypto.randomUUID(),
          messages: [{ id: 'user-1', role: 'user', content: 'Identify this home.' }],
          tools: [],
          context: [],
          state: {},
          forwardedProps: {},
        }),
      });
      expect(response.status).toBe(200);
      return response.text();
    }
    const encoder = new TextEncoder();
    const principal = { id: 'anonymous:local' };
    for (const [home, host, sentinel] of [
      [homeA, hostA, 'Home A evidence'],
      [homeB, hostB, 'Home B evidence'],
    ] as const) {
      const context = contexts.get(home)!;
      expect(context).toBeDefined();
      expect(host.bureau.agents.list().find((agent) => agent.id === 'researcher')).toMatchObject({
        source: 'file',
        name: sentinel,
      });
      expect(await context.secrets.get('probe-key')).toBe(sentinel);
      await context.storage.put('shared-key', encoder.encode(sentinel));
      expect(await chat(host)).toContain(sentinel);
      const workflow = await host.bureau.workflows!.create('shared-workflow', {
        agent: 'writer',
        trigger: { kind: 'schedule', spec: '1h' },
        steps: [
          { kind: 'activity', handler: 'agent', input: { agent: 'writer', message: sentinel } },
        ],
      });
      expect(workflow.id).toBe('shared-workflow');
      const assets = host.bureau.assets;
      if (assets === undefined) throw new Error('Workspace assets were not composed');
      expect(assets.durability).toBe('durable');
      const admission = await assets.admit(
        {
          source: { kind: 'inline', bytes: encoder.encode(sentinel) },
          declaredMediaType: 'text/plain',
        },
        principal,
      );
      await admission.work.result();
      expect(admission.assetId).toBe('shared-asset');
    }

    async function verify(host: Host, home: string, sentinel: string, other: string) {
      expect(
        new TextDecoder().decode(
          (await contexts.get(home)!.storage.get('shared-key')) ?? undefined,
        ),
      ).toBe(sentinel);
      const assets = host.bureau.assets;
      if (assets === undefined) throw new Error('Workspace assets were not composed');
      const asset = await assets.resolve({ assetId: 'shared-asset' }, principal);
      expect(asset.content.kind).toBe('bytes');
      if (asset.content.kind !== 'bytes') throw new Error('Expected stored bytes');
      expect(new TextDecoder().decode(asset.content.bytes)).toBe(sentinel);
      const workflow = await Bun.file(join(home, 'workflows', 'shared-workflow.json')).text();
      expect(workflow).toContain(sentinel);
      expect(workflow).not.toContain(other);
      const response = await fetch(new URL('/bureau/jsonrpc', host.url), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'bureau.memory.list',
          params: { agentId: 'writer' },
        }),
      });
      const memories = await response.text();
      expect(memories).toContain('shared-session');
      expect(memories).toContain(sentinel);
      expect(memories).not.toContain(other);
    }
    await verify(hostA, homeA, 'Home A evidence', 'Home B evidence');
    await verify(hostB, homeB, 'Home B evidence', 'Home A evidence');

    await hostB.close();
    hosts.splice(hosts.indexOf(hostB), 1);
    expect(hostA.bureau.lifecycle).toBe('ready');
    expect(hostA.bureau.id).toBe(hostA.workspaceId);
    await verify(hostA, homeA, 'Home A evidence', 'Home B evidence');
    expect(await chat(hostA, 'after-closing-b')).toContain('Home A evidence');
  });
});
