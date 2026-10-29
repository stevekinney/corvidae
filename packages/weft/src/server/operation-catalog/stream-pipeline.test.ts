import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { defineOperation } from '../operation-registry.ts';
import { anonymousPrincipal } from '../principal.ts';
import { createOperationRegistry } from './registry.ts';
import {
  executeStream,
  executeSubscription,
  SubscriptionElementValidationError,
} from './stream-pipeline.ts';
import type { DispatchContext, OperationRegistry } from './types.ts';

const transports = {
  http: true,
  jsonRpcHttp: true,
  jsonRpcWebSocket: true,
  jsonRpcStdio: true,
};

function createContext(registry: OperationRegistry): DispatchContext {
  return { principal: anonymousPrincipal(), host: {}, transport: 'http-rest', registry };
}

function streamOperation(name: string, eventSchema: z.ZodType, invoke: () => Promise<never>) {
  return defineOperation({
    name,
    mcpExposable: false,
    destructive: false,
    summary: 'stream pipeline fixture',
    kind: 'stream',
    inputSchema: z.object({}),
    outputSchema: z.unknown(),
    eventSchema,
    access: { kind: 'public' },
    transports,
    unknownKeyPolicy: { http: 'reject', jsonRpc: 'reject' },
    invoke,
  });
}

describe('executeStream', () => {
  it('fails with an opaque EngineFailure when the operation returns something that is not iterable', async () => {
    const registry = createOperationRegistry([
      streamOperation('weft.test.notiterable', z.unknown(), async () => ({ chunk: 1 }) as never),
    ]);

    const result = await executeStream('weft.test.notiterable', {}, createContext(registry));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.fault).toEqual({ code: 'EngineFailure', message: 'internal error', data: {} });
    }
  });

  it('fails with an opaque EngineFailure when a hand-built registry hands back a stream without an eventSchema', async () => {
    const operation = streamOperation('weft.test.noschema', z.unknown(), async () => {
      throw new Error('must not be invoked');
    });
    const real = createOperationRegistry([operation]);
    const erased = real.get('weft.test.noschema')!;
    const registry: OperationRegistry = {
      get: (name) =>
        name === erased.name ? ({ ...erased, eventSchema: undefined } as never) : undefined,
      list: () => real.list(),
    };

    const result = await executeStream('weft.test.noschema', {}, createContext(registry));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.fault).toEqual({ code: 'EngineFailure', message: 'internal error', data: {} });
    }
  });

  it('turns an element schema that throws while parsing into a validation error, not a raw crash', async () => {
    const throwingSchema = z.unknown().transform(() => {
      throw new Error('schema exploded');
    });
    const registry = createOperationRegistry([
      streamOperation(
        'weft.test.throwingschema',
        throwingSchema,
        async () =>
          (async function* () {
            yield { chunk: 1 };
          })() as never,
      ),
    ]);

    const result = await executeStream('weft.test.throwingschema', {}, createContext(registry));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const iterator = result.value[Symbol.asyncIterator]();
    const rejection = await iterator.next().then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(rejection).toBeInstanceOf(SubscriptionElementValidationError);
    expect((rejection as SubscriptionElementValidationError).fault.code).toBe('EngineFailure');
  });
});

describe('executeSubscription', () => {
  it('rejects a subscription kind mismatch when the operation is a stream', async () => {
    const registry = createOperationRegistry([
      streamOperation('weft.test.wrongkind', z.unknown(), async () => ({}) as never),
    ]);

    const result = await executeSubscription('weft.test.wrongkind', {}, createContext(registry));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.fault.code).toBe('Unprocessable');
  });
});
