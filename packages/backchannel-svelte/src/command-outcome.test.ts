import {
  anonymousPrincipal,
  createOperationRegistry,
  defineOperation,
} from '@lostgradient/backchannel';
import { CatalogClientError, inProcessCatalogTransport } from '@lostgradient/backchannel/client';
import { throwingRejectionOf } from '@lostgradient/testing/promise-outcome';
import { QueryClient } from '@tanstack/svelte-query';
import { expect, it } from 'bun:test';
import { z } from 'zod';
import { createCatalogHost, createCommand } from './index.ts';

it('treats output validation after a committed effect as unknown and requires a fresh read', async () => {
  let effects = 0;
  const common = {
    mcpExposable: false,
    summary: 'test',
    tags: [],
    inputSchema: z.object({}),
    access: { kind: 'public' as const },
    transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
    unknownKeyPolicy: { http: 'reject' as const, jsonRpc: 'reject' as const },
  };
  const write = defineOperation({
    ...common,
    name: 'fixture.write',
    destructive: true,
    outputSchema: z.number(),
    invoke: async () => {
      effects++;
      return 'invalid' as unknown as number;
    },
  });
  const read = defineOperation({
    ...common,
    name: 'fixture.read',
    destructive: false,
    outputSchema: z.object({ effects: z.number() }),
    invoke: async () => ({ effects }),
  });
  const registry = createOperationRegistry([write, read]);
  const transport = inProcessCatalogTransport({
    registry,
    host: {},
    principal: anonymousPrincipal(),
  });
  const host = createCatalogHost({ scope: 'actor', cache: new QueryClient(), transport });
  const command = createCommand(host, 'fixture.write', ['fixture.read']);
  expect(await throwingRejectionOf(command.mutateAsync({}))).toThrow('outcome is unknown');
  expect(effects).toBe(1);
  expect(await throwingRejectionOf(command.mutateAsync({}))).toThrow('Reconcile');
  expect(effects).toBe(1);
  expect(await command.reconcile('fixture.read', {})).toEqual({ effects: 1 });
  expect(await throwingRejectionOf(command.mutateAsync({}))).toThrow('outcome is unknown');
  expect(effects).toBe(2);
});

it('treats method-not-found as unknown because a declared operation may emit that fault', async () => {
  let calls = 0;
  const host = createCatalogHost({
    scope: 'actor',
    cache: new QueryClient(),
    transport: async (name) => {
      calls++;
      throw new CatalogClientError(name, { code: -32601, message: 'Method not found' });
    },
  });
  const command = createCommand(host, 'fixture.missing', []);
  expect(await throwingRejectionOf(command.mutateAsync({}))).toThrow('outcome is unknown');
  expect(await throwingRejectionOf(command.mutateAsync({}))).toThrow('Reconcile');
  expect(calls).toBe(1);
});

it('treats an interrupted command transport as unknown without replaying it', async () => {
  let calls = 0;
  const host = createCatalogHost({
    scope: 'actor',
    cache: new QueryClient(),
    transport: async () => {
      calls++;
      throw new DOMException('interrupted', 'AbortError');
    },
  });
  const command = createCommand(host, 'fixture.write', []);
  expect(await throwingRejectionOf(command.mutateAsync({}))).toThrow('outcome is unknown');
  expect(await throwingRejectionOf(command.mutateAsync({}))).toThrow('Reconcile');
  expect(calls).toBe(1);
});
