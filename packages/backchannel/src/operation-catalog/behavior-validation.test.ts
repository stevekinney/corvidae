import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { createOperationClientSources } from '../../scripts/generate-operation-client.ts';
import {
  snapshotOperationCatalog,
  stringifyCatalogSnapshot,
} from '../operation-catalog-snapshot.ts';
import type { OperationContext } from '../operation-catalog.ts';
import { createOperationRegistry, executeOperation } from '../operation-catalog.ts';
import { defineOperation } from '../operation-registry.ts';
import { anonymousPrincipal } from '../principal.ts';

const common = {
  summary: 'fixture',
  mcpExposable: true,
  destructive: false,
  access: { kind: 'public' } as const,
  transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: false, jsonRpcStdio: false },
  unknownKeyPolicy: { http: 'reject', jsonRpc: 'reject' } as const,
};

function fixture(prefix: string) {
  const read = defineOperation({
    ...common,
    name: `${prefix}.get`,
    inputSchema: z.object({
      id: z.string(),
      page: z.string().optional(),
      filter: z.string().optional(),
    }),
    outputSchema: z.object({
      id: z.string(),
      revision: z.number(),
      items: z.array(z.object({ id: z.string(), category: z.string() })),
      next: z.string().nullable(),
      total: z.number(),
    }),
    behavior: {
      kind: 'read',
      key: ['id'],
      cursor: 'next',
      pagination: {
        items: 'items',
        cursorInput: 'page',
        nextCursor: 'next',
        total: 'total',
        cursorFilters: ['filter'],
        itemKey: ['category', 'id'],
      },
    },
    invoke: async ({ input }) => ({ id: input.id, revision: 1, items: [], next: null, total: 0 }),
  });
  const command = defineOperation({
    ...common,
    name: `${prefix}.save`,
    inputSchema: z.object({ id: z.string(), revision: z.number(), request: z.string() }),
    outputSchema: z.object({ id: z.string() }),
    conflictReasonTokens: ['STALE'],
    behavior: {
      kind: 'command',
      invalidates: [`${prefix}.get`],
      observedInput: { read: `${prefix}.get`, when: {}, key: 'id', revision: 'revision' },
      conflictReasons: ['STALE'],
      replay: { key: 'request', resource: 'id', read: `${prefix}.get` },
      effects: { idempotent: true },
      responseDisposition: 'one-time',
    },
    invoke: async ({ input }) => ({ id: input.id }),
  });
  return [read, command] as const;
}

describe('declared operation behavior', () => {
  it('rejects incompatible cursor constraints and transforms nested in containers', () => {
    const [read] = fixture('sample');
    const incompatible = {
      ...read,
      inputSchema: z.object({ id: z.string(), page: z.enum(['a']), filter: z.string() }),
      outputSchema: z.object({
        id: z.string(),
        revision: z.number(),
        items: z.array(z.object({ id: z.string(), category: z.string() })),
        next: z.enum(['b']).nullable(),
        total: z.number(),
      }),
    };
    let transforms = 0;
    const transformed = {
      ...read,
      inputSchema: z.object({
        id: z.string(),
        page: z.string(),
        filter: z.string(),
        filters: z.record(
          z.string(),
          z.string().transform((value) => {
            transforms++;
            return value.trim();
          }),
        ),
      }),
    };
    expect(() => createOperationRegistry([incompatible])).toThrow(
      'pagination cursors are incompatible',
    );
    expect(() => createOperationRegistry([incompatible])).toThrow(
      'pagination cursors are incompatible',
    );
    expect(() => createOperationRegistry([transformed])).toThrow(
      'does not support schema transforms',
    );
    expect(() => createOperationRegistry([transformed])).toThrow(
      'does not support schema transforms',
    );
    expect(transforms).toBe(0);
    const nested = {
      ...read,
      inputSchema: z.object({
        id: z.string(),
        page: z.string(),
        filter: z.string(),
        nested: z.object({ items: z.tuple([z.string().trim()]) }),
      }),
    };
    expect(() => createOperationRegistry([nested])).toThrow('does not support schema transforms');
    const compatible = {
      ...read,
      inputSchema: z.object({
        id: z.string(),
        page: z.enum(['a', 'b']).optional(),
        filter: z.string(),
      }),
      outputSchema: z.object({
        id: z.string(),
        revision: z.number(),
        items: z.array(z.object({ id: z.string(), category: z.string() })),
        next: z.enum(['a', 'b']).nullable(),
        total: z.number(),
      }),
    };
    expect(() => createOperationRegistry([compatible])).not.toThrow();
    const unionEnd = {
      ...compatible,
      outputSchema: compatible.outputSchema.extend({
        next: z.union([z.enum(['b', 'a']), z.null()]),
      }),
    };
    expect(() => createOperationRegistry([unionEnd])).not.toThrow();
  });

  it('never executes discriminator refinements while checking an observed variant', () => {
    const [read, command] = fixture('sample');
    if (command.behavior?.kind !== 'command' || !command.behavior.observedInput)
      throw new Error('fixture behavior missing');
    let callbacks = 0;
    const observedRead = {
      ...read,
      outputSchema: read.outputSchema.extend({
        kind: z.literal('entry').refine(() => {
          callbacks++;
          return true;
        }),
      }),
    };
    const observedCommand = {
      ...command,
      behavior: {
        ...command.behavior,
        observedInput: { ...command.behavior.observedInput, when: { kind: 'entry' } },
      },
    };
    expect(() => createOperationRegistry([observedRead, observedCommand])).toThrow(
      'does not select one variant',
    );
    expect(callbacks).toBe(0);
  });
  it('round trips descriptors and deterministically generates without invoking a host', async () => {
    for (const prefix of ['equipment', 'inventory']) {
      const operations = fixture(prefix);
      const registry = createOperationRegistry(operations);
      const snapshot = JSON.parse(
        stringifyCatalogSnapshot(
          snapshotOperationCatalog({ operations: registry.list(), restBindings: [] }),
        ),
      );
      expect(
        snapshot.operations.map((operation: { behavior: unknown }) => operation.behavior),
      ).toEqual([
        {
          kind: 'read',
          key: ['id'],
          cursor: 'next',
          pagination: {
            items: 'items',
            cursorInput: 'page',
            nextCursor: 'next',
            total: 'total',
            cursorFilters: ['filter'],
            itemKey: ['category', 'id'],
          },
        },
        {
          kind: 'command',
          invalidates: [`${prefix}.get`],
          observedInput: { read: `${prefix}.get`, when: {}, key: 'id', revision: 'revision' },
          conflictReasons: ['STALE'],
          replay: { key: 'request', resource: 'id', read: `${prefix}.get` },
          effects: { idempotent: true },
          responseDisposition: 'one-time',
        },
      ]);
      expect(
        snapshot.operations.every((operation: { mcpExposable: boolean }) => operation.mcpExposable),
      ).toBe(true);
      const options = {
        packageName: '@example/catalog',
        serverName: 'Example',
        factoryName: 'createExample',
        outputDirectory: '.',
        format: async (source: string) => source,
      };
      const generated = await createOperationClientSources(snapshot, options);
      expect(generated).toEqual(await createOperationClientSources(snapshot, options));
      expect(generated.get('operation-behaviors.generated.ts')).toContain(
        '"responseDisposition": "one-time"',
      );
      for (const operation of operations) {
        const result = await executeOperation(
          operation.name,
          operation.name.endsWith('get') ? { id: 'a' } : { id: 'a', revision: 1, request: 'r' },
          { principal: anonymousPrincipal(), host: {}, transport: 'http-rest', registry },
        );
        expect(result.ok).toBe(true);
      }
    }
  });

  it('generates a different catalog and leaves undeclared behavior absent', async () => {
    let calls = 0;
    let hostCalls = 0;
    let serviceCalls = 0;
    const hostFactory = () => {
      hostCalls++;
      return {
        service: () => {
          serviceCalls++;
          return 'book';
        },
      };
    };
    const read = defineOperation({
      ...common,
      name: 'books.search',
      inputSchema: z.object({ query: z.string() }),
      outputSchema: z.object({ title: z.string() }),
      behavior: { kind: 'read', key: ['query'] },
      invoke: async ({
        host,
      }: OperationContext<{ query: string }, ReturnType<typeof hostFactory>>) => {
        calls++;
        return { title: host.service() };
      },
    });
    const plain = defineOperation({
      ...common,
      name: 'books.ping',
      inputSchema: z.object({}),
      outputSchema: z.string(),
      invoke: async () => {
        calls++;
        return 'pong';
      },
    });
    const command = defineOperation({
      ...common,
      name: 'books.rename',
      inputSchema: z.object({ title: z.string(), isbn: z.string() }),
      outputSchema: z.object({ isbn: z.string() }),
      behavior: { kind: 'command', invalidates: ['books.search'] },
      invoke: async ({ input }) => {
        calls++;
        return { isbn: input.isbn };
      },
    });
    const registry = createOperationRegistry([read, plain, command]);
    const snapshot = JSON.parse(
      stringifyCatalogSnapshot(
        snapshotOperationCatalog({ operations: registry.list(), restBindings: [] }),
      ),
    );
    expect(
      snapshot.operations.find((entry: { name: string }) => entry.name === 'books.search').behavior,
    ).toEqual({ kind: 'read', key: ['query'] });
    expect(
      snapshot.operations.find((entry: { name: string }) => entry.name === 'books.ping').behavior,
    ).toBeUndefined();
    expect(
      snapshot.operations.find((entry: { name: string }) => entry.name === 'books.rename').behavior,
    ).toEqual({ kind: 'command', invalidates: ['books.search'] });
    expect(
      snapshot.operations.find((entry: { name: string }) => entry.name === 'books.rename').behavior
        .replay,
    ).toBeUndefined();
    const options = {
      packageName: '@example/books',
      serverName: 'Books',
      factoryName: 'createBooks',
      outputDirectory: '.',
      format: async (source: string) => source,
    };
    const sources = await createOperationClientSources(snapshot, options);
    expect(sources).toEqual(await createOperationClientSources(snapshot, options));
    expect([...sources.values()].join('\n')).toContain("'books.ping'");
    expect(calls).toBe(0);
    expect(hostCalls).toBe(0);
    expect(serviceCalls).toBe(0);
    const searchResult = await executeOperation(
      'books.search',
      { query: 'x' },
      { principal: anonymousPrincipal(), host: hostFactory, transport: 'http-rest', registry },
    );
    expect(searchResult.ok).toBe(true);
    const renameResult = await executeOperation(
      'books.rename',
      { isbn: 'x', title: 'New' },
      { principal: anonymousPrincipal(), host: {}, transport: 'http-rest', registry },
    );
    expect(renameResult.ok).toBe(true);
    expect(hostCalls).toBe(1);
    expect(serviceCalls).toBe(1);
  });

  it('keeps the generated sources and browser client graph free of application runtimes', async () => {
    const registry = createOperationRegistry(fixture('equipment'));
    const snapshot = snapshotOperationCatalog({ operations: registry.list(), restBindings: [] });
    const sources = await createOperationClientSources(snapshot, {
      packageName: '@example/equipment',
      serverName: 'Equipment',
      factoryName: 'createEquipment',
      outputDirectory: '.',
      format: async (source) => source,
    });
    const paths: string[] = [];
    const result = await Bun.build({
      entrypoints: [new URL('../client/index.ts', import.meta.url).pathname],
      target: 'browser',
      plugins: [
        {
          name: 'record-graph',
          setup(build) {
            build.onLoad({ filter: /\.ts$/ }, async (args) => {
              paths.push(args.path);
              return { contents: await Bun.file(args.path).text(), loader: 'ts' };
            });
          },
        },
      ],
    });
    expect(result.success).toBe(true);
    expect(paths.length).toBeGreaterThan(1);
    expect([...paths, ...sources.values()].join('\n')).not.toMatch(
      /armorer|velveteen|svelte|applications\//i,
    );
  });

  it('rejects invalid references and shapes with deterministic diagnostics', () => {
    const [read, command] = fixture('sample');
    if (
      read.behavior?.kind !== 'read' ||
      command.behavior?.kind !== 'command' ||
      !read.behavior.pagination ||
      !command.behavior.observedInput
    )
      throw new Error('fixture behavior missing');
    const readBehavior = read.behavior;
    const commandBehavior = command.behavior;
    const cases = [
      { ...command, behavior: { ...commandBehavior, invalidates: ['sample.missing'] } },
      {
        ...command,
        behavior: {
          ...commandBehavior,
          observedInput: { ...commandBehavior.observedInput!, read: 'sample.missing' },
        },
      },
      {
        ...command,
        behavior: {
          ...commandBehavior,
          replay: { key: 'request', resource: 'id', read: 'sample.missing' },
        },
      },
      {
        ...command,
        behavior: {
          ...commandBehavior,
          observedInput: { ...commandBehavior.observedInput!, key: 'missing' },
        },
      },
      {
        ...command,
        behavior: {
          ...commandBehavior,
          observedInput: { ...commandBehavior.observedInput!, revision: 'missing' },
        },
      },
      { ...command, behavior: { ...commandBehavior, conflictReasons: ['UNKNOWN'] } },
      { ...command, behavior: { ...commandBehavior, pagination: readBehavior.pagination } },
      {
        ...read,
        behavior: { ...readBehavior, pagination: { ...readBehavior.pagination!, items: 'id' } },
      },
      {
        ...read,
        behavior: {
          ...readBehavior,
          pagination: { ...readBehavior.pagination!, cursorInput: 'id', nextCursor: 'total' },
        },
      },
      { ...read, destructive: true },
      {
        ...read,
        inputSchema: z.object({
          id: z.string().transform((value) => value),
          page: z.string(),
          filter: z.string(),
        }),
      },
    ];
    for (const candidate of cases) {
      const attempt = () =>
        createOperationRegistry(
          candidate.name === read.name ? [candidate, command] : [read, candidate],
        );
      let first = '';
      try {
        attempt();
      } catch (error) {
        first = String(error);
      }
      expect(first).not.toBe('');
      expect(() => attempt()).toThrow(first.replace(/^Error: /, ''));
    }
  });
});
