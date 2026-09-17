import { describe, expect, expectTypeOf, it } from 'bun:test';
import { z } from 'zod';
import { withContext } from '../src';

describe('withContext', () => {
  it('withContext injects values into the tool context', async () => {
    const tool = withContext(
      { workspaceId: 'ws-1', role: 'admin' },
      {
        name: 'ctx-tool',
        description: 'uses context',
        input: z.object({ value: z.string() }),
        async execute({ value }, context) {
          expect(context.workspaceId).toBe('ws-1');
          expect(context.role).toBe('admin');
          return `${value}-${context.role}`;
        },
      },
    );

    const result = await tool({ value: 'hello' });
    expect(result).toBe('hello-admin');
  });

  it('withContext supports currying for later reuse', async () => {
    const builder = withContext({ region: 'eu' });
    const tool = builder({
      name: 'regional',
      description: 'curries context',
      input: z.object({ n: z.number() }),
      async execute({ n }, context) {
        expect(context.region).toBe('eu');
        return `${context.region}-${n}`;
      },
    });

    const out = await tool({ n: 2 });
    expect(out).toBe('eu-2');
  });

  it('uses default object input when the direct factory omits its schema', async () => {
    const tool = withContext(
      { prefix: 'direct' },
      {
        name: 'default-direct',
        description: 'Uses the default schema',
        async execute(input, context) {
          expectTypeOf(input).toEqualTypeOf<Record<string, unknown>>();
          return { prefix: context.prefix, keys: Object.keys(input) };
        },
      },
    );
    expect(await tool({ value: 42 })).toEqual({ prefix: 'direct', keys: [] });
  });

  it('uses default object input with a reusable contextual factory', async () => {
    const builder = withContext({ prefix: 'curried' });
    const tool = builder({
      name: 'default-curried',
      description: 'Uses the default schema',
      async execute(input, context) {
        expectTypeOf(input).toEqualTypeOf<Record<string, unknown>>();
        return { prefix: context.prefix, keys: Object.keys(input) };
      },
    });
    expect(await tool({ value: 'retained' })).toEqual({ prefix: 'curried', keys: [] });
  });
});
