import { afterEach, describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { deriveWorkflowDefinitionRevision } from '../../core/engine/definition-revision.ts';
import { getInternals } from '../../core/engine/internals.ts';
import { buildRegistrySnapshot } from '../../core/registry-snapshot.ts';
import { workflowSource } from '../../core/source/index.ts';
import { query, signal, update, workflow, type WorkflowDefinition } from '../../core/types.ts';
import { registerWorkflowDocuments } from '../../document-workflow/register.ts';
import { waitForCondition } from '../../testing/fake-timers.test-support.ts';
import { throwingRejectionOf } from '../../testing/promise-outcome.test-support.ts';
import { handleRequest } from '../handler.ts';
import { generateOpenApiDocument } from '../openapi.ts';
import { generateOpenRpcDocument } from '../openrpc.ts';
import { createOperationRegistry, executeOperation } from '../operation-catalog.ts';
import { principalFromApiKey } from '../principal.ts';
import { createLiveOperationRegistry } from '../rest-bindings.ts';
import {
  listWorkflowDefinitionsOperation,
  listWorkflowDefinitionsRestBinding,
} from './list-workflow-definitions.ts';
import {
  assertOperationRejectsUnauthenticated,
  createOperationTestEngine,
  systemReadAuthContext,
} from './operation-registry-test-helpers.test-support.ts';

const registry = createOperationRegistry([listWorkflowDefinitionsOperation]);
const requestOptions = {
  operationRegistry: registry,
  restBindings: [listWorkflowDefinitionsRestBinding],
};

function trivial(name: string, description?: string): WorkflowDefinition {
  return workflow({ name, ...(description === undefined ? {} : { description }) }).execute(
    async function* () {
      return name;
    },
  );
}

async function sourceFor(definition: WorkflowDefinition, load = async () => ({ w: definition })) {
  return workflowSource(
    {
      name: definition.name,
      location: `./${definition.name}.ts`,
      exportName: 'w',
      revision: await deriveWorkflowDefinitionRevision(definition),
    },
    load,
  );
}

async function listDefinitions(engine: unknown, query = ''): Promise<Record<string, unknown>> {
  const response = await handleRequest(
    new Request(`http://localhost/v1/registry/definitions${query}`),
    engine as never,
    { ...requestOptions, ...systemReadAuthContext() },
  );
  expect(response.status).toBe(200);
  return (await response.json()) as Record<string, unknown>;
}

describe('weft.workflows.definitions.list: GET /v1/registry/definitions', () => {
  let engine: ReturnType<typeof createOperationTestEngine> | undefined;

  afterEach(() => {
    engine?.[Symbol.dispose]();
    engine = undefined;
  });

  it('lists a code type as ready with its contract summary', async () => {
    engine = createOperationTestEngine();
    engine.register(
      workflow({
        name: 'orders',
        version: '2.1.0',
        description: 'Process an order',
        tags: ['billing', 'orders'],
        inputSchema: z.object({ orderId: z.string() }),
      })
        .signals({ approve: signal('approve'), cancel: signal('cancel') })
        .updates({ amend: update('amend') })
        .queries({ status: query('status', { outputSchema: z.string() }) })
        .execute(async function* () {
          return 'done';
        }),
    );

    const body = (await listDefinitions(engine)) as { definitions: Record<string, unknown>[] };

    expect(body.definitions).toEqual([
      {
        name: 'orders',
        origin: 'code',
        state: 'ready',
        lastFailureCategory: null,
        revision: expect.stringMatching(/^sha256:/),
        workflowVersion: '2.1.0',
        description: 'Process an order',
        tags: ['billing', 'orders'],
        signals: ['approve', 'cancel'],
        updates: ['amend'],
        queries: ['status'],
      },
    ]);
  });

  it('lists a source registered after an instance has started as idle, then ready once preloaded', async () => {
    engine = createOperationTestEngine();
    engine.register(trivial('code-first'));
    const handle = await engine.start('code-first', null);
    await handle.result();
    const definition = trivial('late-source', 'Registered late');
    let loads = 0;
    const late = await sourceFor(definition, async () => {
      loads += 1;
      return { w: definition };
    });
    engine.registerSource(late);

    const idle = (await listDefinitions(engine)) as { definitions: Record<string, unknown>[] };
    const idleEntry = idle.definitions.find((entry) => entry['name'] === 'late-source');
    expect(idleEntry).toEqual({
      name: 'late-source',
      origin: 'source',
      state: 'idle',
      lastFailureCategory: null,
      revision: late.descriptor.revision,
      workflowVersion: null,
      description: null,
      tags: null,
      signals: null,
      updates: null,
      queries: null,
    });
    expect(loads).toBe(0);

    await engine.workflows.preload('late-source', late.descriptor.revision);
    const ready = (await listDefinitions(engine)) as { definitions: Record<string, unknown>[] };
    const readyEntry = ready.definitions.find((entry) => entry['name'] === 'late-source');
    expect(readyEntry).toEqual({
      name: 'late-source',
      origin: 'source',
      state: 'ready',
      lastFailureCategory: null,
      revision: late.descriptor.revision,
      workflowVersion: '0.0.0',
      description: 'Registered late',
      tags: [],
      signals: [],
      updates: [],
      queries: [],
    });
  });

  it('reports a failed source with its failure category and no contract', async () => {
    engine = createOperationTestEngine();
    const definition = trivial('broken');
    const broken = await sourceFor(definition, async () => {
      throw new Error('secret loader path');
    });
    engine.registerSource(broken);
    expect(
      await throwingRejectionOf(engine.workflows.preload('broken', broken.descriptor.revision)),
    ).toThrow();

    const body = (await listDefinitions(engine)) as { definitions: Record<string, unknown>[] };

    expect(body.definitions).toEqual([
      expect.objectContaining({
        name: 'broken',
        state: 'failed',
        lastFailureCategory: expect.stringMatching(
          /^(application|timeout|cancellation|resource|system)$/,
        ),
        workflowVersion: null,
      }),
    ]);
    expect(JSON.stringify(body)).not.toContain('secret loader path');
  });

  it('reports a source whose only waiter gave up but whose load finished as ready, with its contract', async () => {
    engine = createOperationTestEngine();
    const definition = trivial('orphaned', 'Loaded after its waiter left');
    const release = Promise.withResolvers<void>();
    const orphaned = await sourceFor(definition, async () => {
      await release.promise;
      return { w: definition };
    });
    engine.registerSource(orphaned);
    const waiter = new AbortController();
    const preload = engine.workflows.preload('orphaned', orphaned.descriptor.revision, {
      signal: waiter.signal,
    });
    await waitForCondition(
      async () => getInternals(engine!).sources.diagnostics.get('orphaned')?.size === 1,
      { label: 'orphaned load to start' },
    );
    waiter.abort();
    expect(await throwingRejectionOf(preload)).toThrow();
    release.resolve();
    await waitForCondition(
      async () => getInternals(engine!).sources.resolved.get('orphaned')?.size === 1,
      { label: 'orphaned load to finish' },
    );
    const diagnostic = getInternals(engine).sources.diagnostics.get('orphaned');
    expect(diagnostic?.get(orphaned.descriptor.revision)?.state).toBe('cancelled');

    const body = (await listDefinitions(engine)) as { definitions: Record<string, unknown>[] };

    expect(body.definitions).toEqual([
      expect.objectContaining({
        name: 'orphaned',
        state: 'ready',
        description: 'Loaded after its waiter left',
        workflowVersion: '0.0.0',
      }),
    ]);
  });

  it('names the active revision of a source with several registered revisions, and null when none is active', async () => {
    engine = createOperationTestEngine();
    const first = await sourceFor(trivial('multi', 'first'));
    const second = await sourceFor(trivial('multi', 'second'));
    engine.registerSource(first);
    engine.registerSource(second);

    const ambiguous = (await listDefinitions(engine)) as { definitions: Record<string, unknown>[] };
    expect(ambiguous.definitions).toEqual([
      expect.objectContaining({ name: 'multi', state: 'idle', revision: null }),
    ]);

    await engine.workflows.preload('multi', second.descriptor.revision);
    await engine.workflows.activate('multi', second.descriptor.revision);
    const active = (await listDefinitions(engine)) as { definitions: Record<string, unknown>[] };
    expect(active.definitions).toEqual([
      expect.objectContaining({
        name: 'multi',
        state: 'ready',
        revision: second.descriptor.revision,
        description: 'second',
      }),
    ]);
  });

  it('lists a document-registered type with the document version', async () => {
    engine = createOperationTestEngine();
    const [registered] = await registerWorkflowDocuments(
      engine,
      {
        activities: { notify: ({ input }) => input },
        triggerKinds: { manual: () => undefined },
      },
      {
        active: [
          {
            name: 'daily-digest',
            trigger: { kind: 'manual' },
            steps: [{ kind: 'activity', handler: 'notify' }],
          },
        ],
      },
    );

    const body = (await listDefinitions(engine)) as { definitions: Record<string, unknown>[] };

    expect(body.definitions).toEqual([
      expect.objectContaining({
        name: 'daily-digest',
        origin: 'source',
        state: 'ready',
        revision: registered!.revision,
        workflowVersion: registered!.workflowVersion,
      }),
    ]);
  });

  it('leaves weft.system.registry unchanged: it still excludes source types', async () => {
    engine = createOperationTestEngine();
    engine.register(trivial('eager'));
    const lazy = await sourceFor(trivial('lazy'));
    engine.registerSource(lazy);
    await engine.workflows.preload('lazy', lazy.descriptor.revision);

    const snapshot = await buildRegistrySnapshot(engine);

    expect(snapshot.workflows.map((manifest) => manifest.name)).toEqual(['eager']);
  });

  it('orders by name and pages with limit, offset, and nextOffset', async () => {
    engine = createOperationTestEngine();
    engine.register(trivial('charlie'));
    engine.registerSource(await sourceFor(trivial('alpha')));
    engine.register(trivial('bravo'));

    const first = await listDefinitions(engine, '?limit=2');
    expect((first['definitions'] as { name: string }[]).map((entry) => entry.name)).toEqual([
      'alpha',
      'bravo',
    ]);
    expect(first['nextOffset']).toBe(2);

    const second = await listDefinitions(engine, '?limit=2&offset=2');
    expect((second['definitions'] as { name: string }[]).map((entry) => entry.name)).toEqual([
      'charlie',
    ]);
    expect(second).not.toHaveProperty('nextOffset');
  });

  it('returns an empty page for an engine with no workflow types', async () => {
    engine = createOperationTestEngine();

    expect(await listDefinitions(engine)).toEqual({ definitions: [] });
  });

  it('rejects invalid pagination', async () => {
    engine = createOperationTestEngine();
    for (const query of [
      'limit=0',
      'limit=1001',
      'limit=1.5',
      'limit=nope',
      'offset=-1',
      'offset=nope',
    ]) {
      const response = await handleRequest(
        new Request(`http://localhost/v1/registry/definitions?${query}`),
        engine,
        { ...requestOptions, ...systemReadAuthContext() },
      );
      expect(response.status).toBe(400);
    }
  });

  it('refuses a host that is not a concrete engine', async () => {
    const result = await executeOperation(
      'weft.workflows.definitions.list',
      {},
      {
        principal: principalFromApiKey({ subject: 'reader', scopes: ['system:read'] }),
        host: {},
        transport: 'jsonRpcStdio',
        registry,
      },
    );

    expect(result.ok).toBe(false);
  });

  it('has no owner or author field anywhere in its output', () => {
    const entry = listWorkflowDefinitionsOperation.outputSchema.shape.definitions.element.shape;

    expect(Object.keys(entry).filter((key) => /owner|author/i.test(key))).toEqual([]);
    expect(Object.keys(entry)).toContain('origin');
  });

  it('is readable with system:read or workflows:read and refuses a caller with neither', async () => {
    engine = createOperationTestEngine();
    for (const scope of ['system:read', 'workflows:read'] as const) {
      const result = await executeOperation(
        'weft.workflows.definitions.list',
        {},
        {
          principal: principalFromApiKey({ subject: 'reader', scopes: [scope] }),
          host: engine,
          transport: 'jsonRpcStdio',
          registry,
        },
      );
      expect(result.ok).toBe(true);
    }
    await assertOperationRejectsUnauthenticated({
      operationName: 'weft.workflows.definitions.list',
      engine,
      liveRegistry: createLiveOperationRegistry(),
    });
    const forbidden = await executeOperation(
      'weft.workflows.definitions.list',
      {},
      {
        principal: principalFromApiKey({ subject: 'other', scopes: ['workflows:write'] }),
        host: engine,
        transport: 'jsonRpcStdio',
        registry: createLiveOperationRegistry(),
      },
    );
    expect(forbidden.ok).toBe(false);
    if (forbidden.ok) throw new Error('expected rejection');
    expect(forbidden.fault.code).toBe('Forbidden');
  });

  it('appears in the OpenRPC document and the REST surface', () => {
    const live = createLiveOperationRegistry();
    const rpc = generateOpenRpcDocument({ registry: live, transports: ['http'] }) as {
      methods: { name: string }[];
    };
    const openApi = generateOpenApiDocument() as { paths: Record<string, unknown> };

    expect(rpc.methods.map((method) => method.name)).toContain('weft.workflows.definitions.list');
    expect(Object.keys(openApi.paths)).toContain('/api/v1/registry/definitions');
    expect(live.get('weft.workflows.definitions.list')?.mcpExposable).toBe(false);
  });
});
