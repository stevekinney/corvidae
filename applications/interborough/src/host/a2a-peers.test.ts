import { resolveProviderGenerate } from '@lostgradient/bureau';
import { createAgent, stopWhen } from '@lostgradient/operative';
import { createEgressPolicy } from '@lostgradient/weft/a2a';
import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { waitUntil } from '@lostgradient/testing/wait-until';
import {
  createA2APeerTools,
  parseA2APeersConfiguration,
  readA2APeersConfiguration,
} from './a2a-peers.ts';
import { startHost, type Host, type HostOptions } from './host.ts';
import { ProviderConfigurationError } from './provider-configuration-error.ts';
import { writeProviderHome } from './stub-provider.ts';

describe('configured A2A peers', () => {
  test('parses valid peers and optional bearer secret names', () => {
    expect(
      parseA2APeersConfiguration(
        [
          {
            id: 'research',
            description: 'Research peer',
            url: 'https://peer.example/a2a',
            bearerSecret: 'peer-token',
          },
        ],
        '/home/configuration.json',
      ),
    ).toEqual([
      {
        id: 'research',
        description: 'Research peer',
        url: 'https://peer.example/a2a',
        bearerSecret: 'peer-token',
      },
    ]);
  });

  test('rejects malformed and duplicate entries at startup', () => {
    const invalid = () =>
      parseA2APeersConfiguration(
        [{ id: 'research', description: 'Research peer', url: 'not a URL' }],
        '/home/configuration.json',
      );
    expect(invalid).toThrow(ProviderConfigurationError);
    expect(() =>
      parseA2APeersConfiguration(
        [
          { id: 'research', description: 'One', url: 'https://one.example' },
          { id: 'research', description: 'Two', url: 'https://two.example' },
        ],
        '/home/configuration.json',
      ),
    ).toThrow('another peer has this identifier');
  });

  test('reads the optional configuration key without changing other settings', () => {
    expect(
      readA2APeersConfiguration('{"plugins":{},"a2aPeers":[]}', '/home/configuration.json'),
    ).toEqual([]);
    expect(readA2APeersConfiguration(undefined, '/home/configuration.json')).toEqual([]);
  });

  test('does not expose unknown or ungranted peers', () => {
    const warnings: string[] = [];
    const tools = createA2APeerTools({
      peers: [
        { id: 'known', description: 'Known peer.', url: 'https://peer.example/a2a' },
        {
          id: 'secret-peer',
          description: 'Secret peer.',
          url: 'https://secret.example/a2a',
          bearerSecret: 'missing-secret',
        },
      ],
      readSecret: () => undefined,
      peerCalls: { read: async () => undefined, write: async () => undefined },
      warn: (message) => warnings.push(message),
    });
    expect(Object.keys(tools)).toEqual(['a2a-peer:known']);
    expect(tools['a2a-peer:unknown']).toBeUndefined();
    expect(warnings).toContain(
      'Configured A2A peer "secret-peer" was omitted because its bearer secret is missing.',
    );
  });

  test('blocks egress before making a peer request', async () => {
    const tools = createA2APeerTools({
      peers: [{ id: 'blocked', description: 'Blocked peer.', url: 'http://127.0.0.1:9/a2a' }],
      readSecret: () => undefined,
      peerCalls: { read: async () => undefined, write: async () => undefined },
      egressPolicy: createEgressPolicy({ allowInsecureHttp: true, allowlist: [] }),
      warn: () => undefined,
    });
    const tool = tools['a2a-peer:blocked'];
    if (tool === undefined) throw new Error('blocked peer tool was not created');
    const error = await (
      tool as unknown as { rawExecute: (input: unknown, context: unknown) => Promise<unknown> }
    )
      .rawExecute({ message: 'do not send' }, {})
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'egress-denied' });
  });
});

describe('configured A2A peer approval', () => {
  test('parks approval, then sends through the real peer host once', async () => {
    const homes: string[] = [];
    const hosts: Host[] = [];
    try {
      const peerHome = await mkdtemp(join(tmpdir(), 'interborough-peer-'));
      homes.push(peerHome);
      let sends = 0;
      const peer = await startHost({
        environment: { INTERBOROUGH_HOME: peerHome },
        port: 0,
        extraAgents: {
          agents: {
            peer: createAgent({
              name: 'peer',
              description: 'A peer.',
              generate: async () => {
                sends += 1;
                return { content: 'peer result', toolCalls: [] };
              },
              stopWhen: stopWhen.noToolCalls(),
            }),
          },
        },
        a2aAgents: ['peer'],
      });
      hosts.push(peer);

      const callerHome = await mkdtemp(join(tmpdir(), 'interborough-caller-'));
      homes.push(callerHome);
      await writeProviderHome(callerHome);
      await mkdir(join(callerHome, 'agents'), { recursive: true });
      await writeFile(
        join(callerHome, 'agents', 'caller.md'),
        '---\nname: Caller\nmodel: anthropic/sonnet\ntools: [a2a-peer:peer]\n---\nDelegate the work.\n',
      );
      const configurationPath = join(callerHome, 'configuration.json');
      const configuration = JSON.parse(await readFile(configurationPath, 'utf8')) as Record<
        string,
        unknown
      >;
      configuration['a2aPeers'] = [
        {
          id: 'peer',
          description: 'Start work.',
          url: new URL('/bureau/a2a/peer', peer.url).href,
        },
      ];
      await writeFile(configurationPath, JSON.stringify(configuration));
      const client = {
        messages: {
          create: async (request: unknown) => ({
            id: 'caller-message',
            type: 'message',
            role: 'assistant',
            model: 'claude-sonnet-5',
            content: JSON.stringify(request).includes('tool_result')
              ? [{ type: 'text', text: 'caller received peer result' }]
              : [
                  {
                    type: 'tool_use',
                    id: 'peer-call-1',
                    name: 'a2a-peer:peer',
                    input: { message: 'start work' },
                  },
                ],
            stop_reason: JSON.stringify(request).includes('tool_result') ? 'end_turn' : 'tool_use',
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
        },
      };
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
      const caller = await startHost({
        environment: { INTERBOROUGH_HOME: callerHome },
        port: 0,
        resolveProviderGenerate: resolver,
        a2aPeerEgressPolicy: createEgressPolicy({
          allowlist: [`127.0.0.1:${peer.url.port}`],
          allowInsecureHttp: true,
        }),
      });
      hosts.push(caller);
      const task = await caller.bureau.tasks.start('caller', 'Delegate the work.', {
        principal: 'anonymous:local',
      });
      await waitUntil(
        () => caller.bureau.reviews.list().some((review) => review.runId === task.id),
        {
          message: 'peer approval',
        },
      );
      expect(sends).toBe(0);
      const review = caller.bureau.reviews.list().find((candidate) => candidate.runId === task.id);
      if (review === undefined) throw new Error('peer approval was not recorded');
      await caller.bureau.reviews.resolve({
        id: review.id,
        decision: 'approve',
        principal: 'anonymous:local',
      });
      const result = await caller.bureau.tasks.wait(task.id);
      expect(sends).toBe(1);
      expect(result?.status).toBe('completed');
    } finally {
      for (const host of hosts.reverse()) await host.close();
      for (const home of homes) await rm(home, { recursive: true, force: true });
    }
  });

  test('rejects a parked approval after restart when the peer destination changes', async () => {
    const homes: string[] = [];
    const hosts: Host[] = [];
    try {
      const peerHomeA = await mkdtemp(join(tmpdir(), 'interborough-peer-a-'));
      const peerHomeB = await mkdtemp(join(tmpdir(), 'interborough-peer-b-'));
      homes.push(peerHomeA, peerHomeB);
      let sendsB = 0;
      const peerA = await startHost({
        environment: { INTERBOROUGH_HOME: peerHomeA },
        port: 0,
        extraAgents: {
          agents: {
            peer: createAgent({
              name: 'peer',
              description: 'Peer A.',
              generate: async () => ({ content: 'A', toolCalls: [] }),
              stopWhen: stopWhen.noToolCalls(),
            }),
          },
        },
        a2aAgents: ['peer'],
      });
      const peerB = await startHost({
        environment: { INTERBOROUGH_HOME: peerHomeB },
        port: 0,
        extraAgents: {
          agents: {
            peer: createAgent({
              name: 'peer',
              description: 'Peer B.',
              generate: async () => {
                sendsB += 1;
                return { content: 'B', toolCalls: [] };
              },
              stopWhen: stopWhen.noToolCalls(),
            }),
          },
        },
        a2aAgents: ['peer'],
      });
      hosts.push(peerA, peerB);

      const callerHome = await mkdtemp(join(tmpdir(), 'interborough-caller-restart-'));
      homes.push(callerHome);
      await writeProviderHome(callerHome);
      await mkdir(join(callerHome, 'agents'), { recursive: true });
      await writeFile(
        join(callerHome, 'agents', 'caller.md'),
        '---\nname: Caller\nmodel: anthropic/sonnet\ntools: [a2a-peer:peer]\n---\nDelegate the work.\n',
      );
      const configurationPath = join(callerHome, 'configuration.json');
      const writeConfiguration = async (peer: Host) => {
        const configuration = JSON.parse(await readFile(configurationPath, 'utf8')) as Record<
          string,
          unknown
        >;
        configuration['a2aPeers'] = [
          {
            id: 'peer',
            description: 'Start work.',
            url: new URL('/bureau/a2a/peer', peer.url).href,
          },
        ];
        await writeFile(configurationPath, JSON.stringify(configuration));
      };
      await writeConfiguration(peerA);
      const client = {
        messages: {
          create: async () => ({
            id: 'caller-message',
            type: 'message',
            role: 'assistant',
            model: 'claude-sonnet-5',
            content: [
              {
                type: 'tool_use',
                id: 'peer-call-1',
                name: 'a2a-peer:peer',
                input: { message: 'start' },
              },
            ],
            stop_reason: 'tool_use',
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
        },
      };
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
      const startCaller = () =>
        startHost({
          environment: { INTERBOROUGH_HOME: callerHome },
          port: 0,
          resolveProviderGenerate: resolver,
          a2aPeerEgressPolicy: createEgressPolicy({
            allowInsecureHttp: true,
            allowlist: [`127.0.0.1:${peerA.url.port}`, `127.0.0.1:${peerB.url.port}`],
          }),
        });
      const first = await startCaller();
      hosts.push(first);
      const task = await first.bureau.tasks.start('caller', 'Delegate the work.', {
        principal: 'anonymous:local',
      });
      await waitUntil(
        () => first.bureau.reviews.list().some((review) => review.runId === task.id),
        {
          message: 'peer approval before restart',
        },
      );
      const firstReview = first.bureau.reviews.list().find((review) => review.runId === task.id);
      if (firstReview === undefined) throw new Error('peer approval was not recorded');
      await first.close();
      hosts.splice(hosts.indexOf(first), 1);
      await writeConfiguration(peerB);
      const second = await startCaller();
      hosts.push(second);
      await waitUntil(
        async () => {
          const workflow = await second.bureau.tasks.workflow(task.id);
          return workflow?.status !== 'running';
        },
        { message: 'changed peer approval rejection' },
      );
      expect(second.bureau.reviews.list()).toEqual([]);
      expect(sendsB).toBe(0);
    } finally {
      for (const host of hosts.reverse()) await host.close();
      for (const home of homes) await rm(home, { recursive: true, force: true });
    }
  });
});
