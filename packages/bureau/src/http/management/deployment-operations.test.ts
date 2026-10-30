import { createAgent, createMockGenerate } from '@lostgradient/operative';
import { describe, expect, it } from 'bun:test';

import { waitForCondition } from '../../test';
import { BUREAU_HANDLER_OPERATIONS } from '../create-bureau-handler.ts';
import { describeOperations, OPERATION_SCHEMA_VERSION } from './deployment-operations.ts';
import { openBureau, rpc, type OpenedBureau } from './management-fixtures.test-support.ts';

async function withBureau<T>(
  options: Parameters<typeof openBureau>[0],
  body: (opened: OpenedBureau) => Promise<T>,
): Promise<T> {
  const opened = await openBureau(options);
  try {
    return await body(opened);
  } finally {
    await opened.dispose();
  }
}

const writer = createAgent({
  name: 'Writer',
  description: 'Drafts documents',
  generate: createMockGenerate([]),
});
const hidden = createAgent({ name: 'hidden', generate: createMockGenerate([]) });
const unnamed = createAgent({ generate: createMockGenerate([]) });

describe('weft.system.principal', () => {
  it('reports the caller’s own principal and scopes, sorted, from Weft’s own operation', async () => {
    await withBureau({}, async ({ handler }) => {
      const alice = await rpc(handler, 'weft.system.principal', {}, 'alice-key');
      const reader = await rpc(handler, 'weft.system.principal', {}, 'tasks-reader-key');

      expect(alice.result).toEqual({ method: 'api-key', subject: 'alice', scopes: [] });
      expect(reader.result).toMatchObject({ method: 'api-key', subject: 'tasks-reader' });
      expect(reader.result?.['scopes']).toContain('bureau.tasks:read');
      const scopes = reader.result?.['scopes'] as string[];
      expect(scopes).toEqual(scopes.toSorted());
    });
  });

  it('answers a request with no credential with the authentication fault, as every operation does', async () => {
    await withBureau({}, async ({ handler }) => {
      const response = await handler(
        new Request('http://localhost/jsonrpc', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'weft.system.principal',
            params: {},
          }),
        }),
      );
      expect(response.status).toBe(401);
    });
  });
});

describe('bureau.deployment.get', () => {
  it('requires only authentication and returns exactly its five keys', async () => {
    await withBureau({ id: 'deployment-one' }, async ({ handler }) => {
      const body = await rpc(handler, 'bureau.deployment.get', {}, 'alice-key');

      expect(Object.keys(body.result ?? {}).toSorted()).toEqual([
        'agents',
        'id',
        'operations',
        'recovery',
        'state',
      ]);
      expect(body.result).toMatchObject({
        id: 'deployment-one',
        state: 'ready',
        agents: ['default'],
      });
    });
  });

  it('lists every served operation with its kind and schema version, and nothing is missing', async () => {
    await withBureau({}, async ({ handler }) => {
      const body = await rpc(handler, 'bureau.deployment.get', {}, 'alice-key');
      const operations = body.result?.['operations'] as Array<{
        name: string;
        kind: string;
        schemaVersion: number;
      }>;

      expect(operations.map((operation) => operation.name).toSorted()).toEqual(
        BUREAU_HANDLER_OPERATIONS.map((operation) => operation.name).toSorted(),
      );
      const kinds = Object.fromEntries(
        operations.map((operation) => [operation.name, operation.kind]),
      );
      expect(kinds).toMatchObject({
        'weft.system.principal': 'query',
        'bureau.deployment.get': 'query',
        'bureau.tasks.list': 'query',
        'bureau.tasks.cancel': 'command',
        'bureau.tasks.respond': 'command',
        'bureau.contexts.delete': 'command',
        'bureau.contexts.input': 'command',
        'bureau.tasks.events': 'subscription',
        'bureau.events': 'subscription',
      });
      expect(
        operations.every((operation) => operation.schemaVersion === OPERATION_SCHEMA_VERSION),
      ).toBe(true);
    });
  });

  it('describes a subscription, a destructive operation and a read by what they are', () => {
    expect(
      describeOperations([
        { name: 'a', destructive: false },
        { name: 'b', destructive: true },
        { name: 'c', kind: 'subscription', destructive: false },
        { name: 'd', kind: 'stream', destructive: false },
      ]).map((operation) => operation.kind),
    ).toEqual(['query', 'command', 'subscription', 'subscription']);
  });

  it('reports a recovery that did not need to run, and the agents by name', async () => {
    await withBureau({ agents: { writer, hidden }, a2aAgents: ['writer'] }, async ({ handler }) => {
      const body = await rpc(handler, 'bureau.deployment.get', {}, 'alice-key');

      expect(body.result?.['agents']).toEqual(['writer', 'hidden', 'default']);
      expect(body.result?.['recovery']).toEqual({
        status: expect.stringMatching(/^(clean|not-applicable)$/) as unknown,
        failedRunCount: 0,
      });
    });
  });

  it('reports draining while shutdown waits for a run, and the deployment as ready before', async () => {
    const opened = await openBureau({});
    try {
      const run = await opened.bureau.tasks.start('default', 'hold', {
        principal: 'api-key:alice',
      });
      await waitForCondition(
        () => opened.bureau.tasks.detail(run.id)?.status === 'running',
        'running',
      );
      const before = await rpc(opened.handler, 'bureau.deployment.get', {}, 'alice-key');
      const shutdown = opened.bureau.shutdown({ policy: 'drain' });
      try {
        await waitForCondition(() => opened.bureau.lifecycle === 'draining', 'never draining');

        const during = await rpc(opened.handler, 'bureau.deployment.get', {}, 'alice-key');

        expect(before.result?.['state']).toBe('ready');
        expect(during.result?.['state']).toBe('draining');
      } finally {
        await opened.bureau.tasks.cancel(run.id);
        await shutdown;
      }
    } finally {
      await opened.dispose();
    }
  });

  it('exposes no configuration beyond those keys: the response carries no storage or credential setting', async () => {
    await withBureau({ id: 'deployment-two' }, async ({ handler }) => {
      const body = await rpc(handler, 'bureau.deployment.get', {}, 'alice-key');
      const text = JSON.stringify(body);

      // The storage setting would serialize as the quoted string `"memory"`; the operation names
      // `bureau.memory.*` legitimately contain the word.
      for (const leaked of [
        '"memory"',
        'sqlite',
        '"durable"',
        'resolveApiKeyPrincipal',
        'alice-key',
      ]) {
        expect(text).not.toContain(leaked);
      }
    });
  });
});

describe('bureau.agents.list', () => {
  it('requires only authentication and lists every agent with name, display name, description, revision and A2A opt-in', async () => {
    await withBureau(
      { agents: { writer, 'plain-agent': unnamed }, a2aAgents: ['writer'] },
      async ({ handler }) => {
        const body = await rpc(handler, 'bureau.agents.list', {}, 'alice-key');

        expect(body.result).toEqual({
          agents: [
            {
              name: 'writer',
              displayName: 'Writer',
              description: 'Drafts documents',
              definitionRevision: expect.any(Number) as unknown,
              kind: 'code',
              a2a: true,
              media: null,
              tools: [],
            },
            {
              name: 'plain-agent',
              displayName: 'plain-agent',
              description: null,
              definitionRevision: expect.any(Number) as unknown,
              kind: 'code',
              a2a: false,
              media: null,
              tools: [],
            },
            {
              name: 'default',
              displayName: 'default',
              description: null,
              definitionRevision: expect.any(Number) as unknown,
              kind: 'code',
              a2a: false,
              media: null,
              tools: [],
            },
          ],
        });
        // The Agent Card URL is dropped until A2A arrives.
        expect(JSON.stringify(body)).not.toMatch(/https?:|agent-card/);
      },
    );
  });

  it('lists an agent outside the A2A allowlist to a caller with no scope, with a2a false', async () => {
    await withBureau({ agents: { writer } }, async ({ handler }) => {
      const body = await rpc(handler, 'bureau.agents.list', {}, 'bob-key');
      const agents = (body.result?.['agents'] ?? []) as Array<{ name: string; a2a: boolean }>;
      const listed = agents.map((agent) => [agent.name, agent.a2a]);
      expect(listed).toEqual([
        ['writer', false],
        ['default', false],
      ]);
    });
  });
});
