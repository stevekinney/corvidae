import { createOperationRegistry, principalFromApiKey } from '@lostgradient/backchannel';
import { executeOperation, snapshotOperationCatalog } from '@lostgradient/backchannel/internals';
import { createTool, createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { operationsFromToolbox } from './index.ts';

describe('toolbox projection', () => {
  it('fails closed if a toolbox unexpectedly reports an interruption', async () => {
    const tool = createTool({
      namespace: 'equipment',
      version: '1.0.0',
      name: 'lookup',
      description: 'Lookup',
      input: z.object({}),
      execute: async () => ({}),
    });
    const original = createToolbox([tool]);
    const toolbox = new Proxy(original, {
      get(target, property, receiver) {
        if (property === 'execute') return async () => ({ outcome: 'action_required' });
        return Reflect.get(target, property, receiver);
      },
    });
    const operations = operationsFromToolbox(
      toolbox,
      [
        {
          tool: tool.id,
          name: 'equipment.lookup',
          scopes: ['inventory.equipment:read'],
          outputSchema: z.object({}),
          mcpExposable: true,
          behavior: { kind: 'read' },
        },
      ],
      {
        requestContext: () => ({
          authority: {
            principalId: 'alice',
            tenantId: 'tenant',
            ownerId: 'owner',
            capabilities: [],
            authorizationRevision: '1',
          },
        }),
      },
    );
    const registry = createOperationRegistry(operations);
    const result = await executeOperation(
      'equipment.lookup',
      {},
      {
        registry,
        host: {},
        transport: 'jsonRpcHttp',
        principal: principalFromApiKey({ subject: 'alice', scopes: ['inventory.equipment:read'] }),
      },
    );
    expect(result).toMatchObject({ ok: false, fault: { code: 'EngineFailure' } });
  });

  it('refuses opaque hooks and built-in approval without invoking a policy or tool', () => {
    let calls = 0;
    const input = z.object({ assetId: z.string() });
    const selectionBase = {
      name: 'equipment.lookup',
      scopes: ['inventory.equipment:read'] as const,
      outputSchema: z.object({ assetId: z.string() }),
      mcpExposable: true,
      behavior: { kind: 'read', key: ['assetId'] } as const,
    };
    const options = {
      requestContext: () => ({
        authority: {
          principalId: 'alice',
          tenantId: 'tenant',
          ownerId: 'owner',
          capabilities: [],
          authorizationRevision: '1',
        },
      }),
    };
    for (const hook of ['beforeAdmission', 'beforeExecute'] as const) {
      for (const layer of ['tool', 'toolbox'] as const) {
        const policy = {
          [hook]: () => {
            calls += 1;
            return {
              status:
                hook === 'beforeAdmission' ? ('needs_input' as const) : ('needs_approval' as const),
            };
          },
        };
        const tool = createTool({
          namespace: 'equipment',
          version: '1.0.0',
          name: 'lookup',
          description: 'Find an asset',
          input,
          metadata: { readOnly: true },
          ...(layer === 'tool' ? { policy } : {}),
          execute: async (value) => {
            calls += 1;
            return value;
          },
        });
        const toolbox = createToolbox([tool], layer === 'toolbox' ? { policy } : {});
        expect(() =>
          operationsFromToolbox(toolbox, [{ ...selectionBase, tool: tool.id }], options),
        ).toThrow('equipment.lookup');
      }
    }
    const tool = createTool({
      namespace: 'equipment',
      version: '1.0.0',
      name: 'lookup',
      description: 'Find an asset',
      input,
      metadata: { readOnly: true },
      execute: async (value) => {
        calls += 1;
        return value;
      },
    });
    expect(() =>
      operationsFromToolbox(
        createToolbox([tool], { approvalPolicy: { mode: 'always' } }),
        [{ ...selectionBase, tool: tool.id }],
        options,
      ),
    ).toThrow('equipment.lookup');
    expect(
      operationsFromToolbox(
        createToolbox([tool], { approvalPolicy: { mode: 'never' } }),
        [{ ...selectionBase, tool: tool.id }],
        options,
      ),
    ).toHaveLength(1);
    expect(calls).toBe(0);
  });

  it('keeps the projection out of the browser client graph', async () => {
    const build = await Bun.build({
      entrypoints: [`${import.meta.dir}/../../backchannel/src/client/index.ts`],
      target: 'browser',
      metafile: true,
    });
    expect(build.success).toBe(true);
    expect(
      Object.keys(build.metafile?.inputs ?? {}).some((path) =>
        path.includes('backchannel-armorer'),
      ),
    ).toBe(false);
  });

  it('propagates cancellation while a tool is running', async () => {
    const controller = new AbortController();
    let sawAbort = false;
    const tool = createTool({
      namespace: 'equipment',
      version: '1.0.0',
      name: 'wait',
      description: 'Wait for cancellation',
      input: z.object({}),
      execute: async (_, context) => {
        const aborted = new Promise<void>((resolve) =>
          context.signal?.addEventListener(
            'abort',
            () => {
              sawAbort = true;
              resolve();
            },
            { once: true },
          ),
        );
        controller.abort();
        await aborted;
        return {};
      },
    });
    const toolbox = createToolbox([tool]);
    const operations = operationsFromToolbox(
      toolbox,
      [
        {
          tool: tool.id,
          name: 'equipment.wait',
          scopes: ['inventory.equipment:read'],
          outputSchema: z.object({}),
          mcpExposable: true,
          behavior: { kind: 'read' },
        },
      ],
      {
        requestContext: () => ({
          authority: {
            principalId: 'alice',
            tenantId: 'tenant',
            ownerId: 'owner',
            capabilities: [],
            authorizationRevision: '1',
          },
        }),
      },
    );
    const registry = createOperationRegistry(operations);
    await executeOperation(
      'equipment.wait',
      {},
      {
        registry,
        host: {},
        transport: 'jsonRpcHttp',
        principal: principalFromApiKey({ subject: 'alice', scopes: ['inventory.equipment:read'] }),
        signal: controller.signal,
      },
    );
    expect(sawAbort).toBe(true);
  });

  it('validates output and returns a declared tool fault', async () => {
    const invalid = createTool({
      namespace: 'equipment',
      version: '1.0.0',
      name: 'invalid',
      description: 'Invalid result',
      input: z.object({}),
      execute: async () => ({ name: 7 }),
    });
    const fails = createTool({
      namespace: 'equipment',
      version: '1.0.0',
      name: 'fails',
      description: 'Fail',
      input: z.object({}),
      execute: async () => {
        throw new Error('tool failed');
      },
    });
    const common = {
      scopes: ['inventory.equipment:read'] as const,
      outputSchema: z.object({ name: z.string() }),
      mcpExposable: true,
      behavior: { kind: 'read' } as const,
    };
    const operations = operationsFromToolbox(
      createToolbox([invalid, fails]),
      [
        { ...common, name: 'equipment.invalid', tool: invalid.id },
        {
          ...common,
          name: 'equipment.fails',
          tool: fails.id,
          producibleFaults: ['Conflict'],
          fault: () => ({ code: 'Conflict', message: 'Tool failed', data: { reason: 'declared' } }),
        },
      ],
      {
        requestContext: () => ({
          authority: {
            principalId: 'alice',
            tenantId: 'tenant',
            ownerId: 'owner',
            capabilities: [],
            authorizationRevision: '1',
          },
        }),
      },
    );
    const registry = createOperationRegistry(operations);
    const context = {
      registry,
      host: {},
      transport: 'jsonRpcHttp' as const,
      principal: principalFromApiKey({ subject: 'alice', scopes: ['inventory.equipment:read'] }),
    };
    const invalidResult = await executeOperation('equipment.invalid', {}, context);
    expect(invalidResult.ok).toBe(false);
    const faultResult = await executeOperation('equipment.fails', {}, context);
    expect(faultResult).toMatchObject({
      ok: false,
      fault: { code: 'Conflict', data: { reason: 'declared' } },
    });
  });

  it('only invokes a permitted rename and declares its invalidation', async () => {
    let calls = 0;
    const lookup = createTool({
      namespace: 'equipment',
      version: '1.0.0',
      name: 'lookup',
      description: 'Find an asset',
      input: z.object({ assetId: z.string() }),
      execute: async ({ assetId }) => ({ assetId, name: 'Camera' }),
    });
    const rename = createTool({
      namespace: 'equipment',
      version: '1.0.0',
      name: 'rename',
      description: 'Rename an asset',
      input: z.object({ assetId: z.string(), name: z.string() }),
      metadata: { mutates: true },
      execute: async (input) => {
        calls += 1;
        return input;
      },
    });
    const outputSchema = z.object({ assetId: z.string(), name: z.string() });
    const toolbox = createToolbox([lookup, rename]);
    let validations = 0;
    toolbox.addEventListener('validate-success', () => {
      validations += 1;
    });
    const operations = operationsFromToolbox(
      toolbox,
      [
        {
          tool: lookup.id,
          name: 'equipment.lookup',
          scopes: ['inventory.equipment:read'],
          outputSchema,
          mcpExposable: true,
          behavior: { kind: 'read', key: ['assetId'] },
        },
        {
          tool: rename.id,
          name: 'equipment.rename',
          scopes: ['inventory.equipment:write'],
          outputSchema,
          mcpExposable: true,
          behavior: { kind: 'command', invalidates: ['equipment.lookup'] },
        },
      ],
      {
        requestContext: (principal) => ({
          authority: {
            principalId: ('subject' in principal ? principal.subject : undefined) ?? '',
            tenantId: 'tenant',
            ownerId: 'owner',
            capabilities: [],
            authorizationRevision: '1',
          },
        }),
      },
    );
    const registry = createOperationRegistry(operations);
    const operation = registry.get('equipment.rename')!;
    const input = { assetId: 'CAM-7', name: 'Studio camera' };
    const context = { registry, host: {}, transport: 'jsonRpcHttp' as const };
    const denied = await operation.dispatch(input, {
      ...context,
      principal: principalFromApiKey({
        subject: 'reader',
        scopes: ['inventory.equipment:read'],
      }),
    });
    expect(denied.ok).toBe(false);
    expect(calls).toBe(0);
    const allowed = await operation.dispatch(input, {
      ...context,
      principal: principalFromApiKey({
        subject: 'editor',
        scopes: ['inventory.equipment:write'],
      }),
    });
    expect(allowed.ok).toBe(true);
    expect(calls).toBe(1);
    expect(validations).toBe(1);
    const snapshot = snapshotOperationCatalog({ operations: registry.list(), restBindings: [] });
    expect(
      snapshot.operations.find((entry) => entry.name === 'equipment.rename')?.behavior,
    ).toEqual({ kind: 'command', invalidates: ['equipment.lookup'] });
  });

  it('rejects missing versions and duplicate public names at construction', () => {
    const tool = createTool({
      namespace: 'equipment',
      version: '1.0.0',
      name: 'lookup',
      description: 'Find an asset',
      input: z.object({ assetId: z.string() }),
      execute: async ({ assetId }) => ({ assetId }),
    });
    const toolbox = createToolbox([tool]);
    const selection = {
      tool: tool.id,
      name: 'equipment.lookup',
      scopes: ['inventory.equipment:read'] as const,
      outputSchema: z.object({ assetId: z.string() }),
      mcpExposable: true,
      behavior: { kind: 'read', key: ['assetId'] } as const,
    };
    const options = {
      requestContext: () => ({
        authority: {
          principalId: 'alice',
          tenantId: 'tenant',
          ownerId: 'owner',
          capabilities: [],
          authorizationRevision: '1',
        },
      }),
    };
    expect(() =>
      operationsFromToolbox(toolbox, [{ ...selection, tool: 'equipment:lookup@2.0.0' }], options),
    ).toThrow('equipment.lookup');
    expect(() => operationsFromToolbox(toolbox, [selection, selection], options)).toThrow(
      'equipment.lookup',
    );
    const mismatch = createTool({
      namespace: 'equipment',
      version: '1.0.0',
      name: 'mismatch',
      description: 'Mismatched schema',
      input: z.object({ assetId: z.string() }),
      inputSchema: {
        type: 'object',
        properties: { assetId: { type: 'number' } },
        required: ['assetId'],
      },
      execute: async (value) => value,
    });
    expect(() =>
      operationsFromToolbox(
        createToolbox([mismatch]),
        [{ ...selection, tool: mismatch.id }],
        options,
      ),
    ).toThrow('equipment.lookup');
    const standard = createTool({
      namespace: 'equipment',
      version: '1.0.0',
      name: 'standard',
      description: 'Standard Schema input',
      input: {
        '~standard': { version: 1, vendor: 'fixture', validate: (value: unknown) => ({ value }) },
      },
      inputSchema: { type: 'object' },
      execute: async (value) => value,
    });
    expect(() =>
      operationsFromToolbox(
        createToolbox([standard]),
        [{ ...selection, tool: standard.id }],
        options,
      ),
    ).toThrow('equipment.lookup');
  });

  it('dispatches a selected pinned tool with the verified subject and signal', async () => {
    let calls = 0;
    let subject: string | undefined;
    let receivedSignal: AbortSignal | undefined;
    const tool = createTool({
      namespace: 'equipment',
      version: '1.0.0',
      name: 'lookup',
      description: 'Find an asset',
      input: z.object({ assetId: z.string().min(1) }),
      metadata: { readOnly: true },
      execute: async ({ assetId }, context) => {
        calls += 1;
        subject = context.requestContext?.authority.principalId;
        receivedSignal = context.signal;
        return { assetId, name: 'Camera' };
      },
    });
    const operations = operationsFromToolbox(
      createToolbox([tool]),
      [
        {
          tool: tool.id,
          name: 'equipment.lookup',
          scopes: ['inventory.equipment:read'],
          outputSchema: z.object({ assetId: z.string(), name: z.string() }),
          mcpExposable: true,
          behavior: { kind: 'read', key: ['assetId'] },
        },
      ],
      {
        requestContext: (principal) => ({
          authority: {
            principalId: ('subject' in principal ? principal.subject : undefined) ?? '',
            tenantId: 'tenant',
            ownerId: 'owner',
            capabilities: [],
            authorizationRevision: '1',
          },
        }),
      },
    );
    const operation = operations[0]!;
    const registry = createOperationRegistry(operations);
    const snapshot = snapshotOperationCatalog({ operations: registry.list(), restBindings: [] });
    expect(snapshot.operations[0]).toMatchObject({
      name: 'equipment.lookup',
      mcpExposable: true,
      behavior: { kind: 'read', key: ['assetId'] },
      access: { kind: 'scoped', scopes: ['inventory.equipment:read'] },
      outputSchema: {
        type: 'object',
        properties: { assetId: { type: 'string' }, name: { type: 'string' } },
      },
    });
    const controller = new AbortController();
    const principal = principalFromApiKey({
      subject: 'alice',
      scopes: ['inventory.equipment:read'],
    });
    const result = await operation.dispatch(
      { assetId: 'CAM-7' },
      {
        registry,
        principal,
        host: {},
        transport: 'jsonRpcHttp',
        signal: controller.signal,
      },
    );
    expect(result).toEqual({ ok: true, value: { assetId: 'CAM-7', name: 'Camera' } });
    expect(calls).toBe(1);
    expect(subject).toBe('alice');
    expect(receivedSignal).toBeDefined();
    const denied = await operation.dispatch(
      { assetId: 'CAM-7' },
      {
        registry,
        principal: principalFromApiKey({ subject: 'bob', scopes: [] }),
        host: {},
        transport: 'jsonRpcHttp',
      },
    );
    expect(denied.ok).toBe(false);
    expect(calls).toBe(1);
  });
});
