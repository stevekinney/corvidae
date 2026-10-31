import { createTool } from 'armorer';
import { describe, expect, test } from 'bun:test';
import { z } from 'zod';

import { definePlugin } from '../define-plugin.ts';
import { canonicalJson, pluginIdentities, schemaDigest } from './plugin-identities.ts';

const base = { name: 'example', version: '1.2.0', description: 'An example plugin.' };

function toolPlugin(input: z.ZodObject, version?: string) {
  return definePlugin({
    ...base,
    setup: () => ({
      tools: [
        createTool({
          name: 'lookup',
          description: 'Looks up',
          input,
          execute: async () => 'found',
          ...(version === undefined ? {} : { version }),
        }),
      ],
    }),
  });
}

describe('canonicalJson', () => {
  test('orders keys, so equal values serialize equally', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: undefined } })).toBe(
      '{"a":{"d":[2,{"y":2,"z":1}]},"b":1}',
    );
  });
});

describe('schemaDigest', () => {
  test('is equal for equal shapes and different for a changed shape', () => {
    const first = schemaDigest(z.object({ a: z.string(), b: z.number() }));
    expect(schemaDigest(z.object({ b: z.number(), a: z.string() }))).toBe(first);
    expect(schemaDigest(z.object({ a: z.string(), b: z.string() }))).not.toBe(first);
  });

  test('is null for no schema', () => {
    expect(schemaDigest(undefined)).toBeNull();
  });

  test('is the same on every run for a function default, whatever it returns', () => {
    let counter = 0;
    const schema = z.object({ id: z.string().default(() => String(++counter)) });
    const first = schemaDigest(schema);
    expect(schemaDigest(schema)).toBe(first);
    expect(schemaDigest(z.object({ id: z.string().default(() => crypto.randomUUID()) }))).toBe(
      first,
    );
    expect(first).not.toBe(schemaDigest(z.object({ id: z.string() })));
  });

  test('changes with a constant default', () => {
    expect(schemaDigest(z.object({ id: z.string().default('a') }))).not.toBe(
      schemaDigest(z.object({ id: z.string().default('b') })),
    );
  });

  test('refuses a schema whose output other than a default varies between runs', () => {
    let counter = 0;
    const field = z.string();
    z.globalRegistry.add(field, {
      get description() {
        return `run ${++counter}`;
      },
    });
    const schema = z.object({ id: field });
    expect(() => schemaDigest(schema)).toThrow(/differently on two runs at \.properties\.id/);
  });
});

/** A Standard Schema that is not Zod or Valibot, converting to the JSON Schema `shape` names. */
function customSchema(shape: Record<string, unknown>) {
  return {
    '~standard': {
      version: 1,
      vendor: 'custom',
      validate: (value: unknown) => ({ value }),
      jsonSchema: { input: () => shape, output: () => shape },
    },
  };
}

describe('schemaDigest over a Standard JSON Schema', () => {
  test('digests what the converter returns, not the implementation object', () => {
    const text = schemaDigest(customSchema({ type: 'string' }));
    expect(text).toStartWith('sha256:');
    expect(schemaDigest(customSchema({ type: 'string' }))).toBe(text);
    expect(schemaDigest(customSchema({ type: 'number' }))).not.toBe(text);
  });

  test('changes an activity digest when its converter changes', async () => {
    const identitiesOf = (shape: Record<string, unknown>) =>
      pluginIdentities(
        definePlugin({
          ...base,
          setup: () => ({
            activities: [
              { name: 'fetch', execute: async () => 1, inputSchema: customSchema(shape) } as never,
            ],
          }),
        }),
      );
    const before = await identitiesOf({ type: 'string' });
    const after = await identitiesOf({ type: 'number' });
    expect(after.entries.find(({ kind }) => kind === 'activity')?.schema).not.toBe(
      before.entries.find(({ kind }) => kind === 'activity')?.schema,
    );
  });
});

describe('pluginIdentities', () => {
  test('lists the configuration and each contribution with its version and digest', async () => {
    const identities = await pluginIdentities(toolPlugin(z.object({ id: z.string() })));
    expect(identities.plugin).toBe('example');
    expect(identities.version).toBe('1.2.0');
    expect(identities.entries.map(({ kind, id, version }) => ({ kind, id, version }))).toEqual([
      { kind: 'configuration', id: 'example', version: '1.2.0' },
      { kind: 'tool', id: 'example:lookup', version: '1.2.0' },
    ]);
    expect(identities.entries.every(({ schema }) => schema?.startsWith('sha256:'))).toBe(true);
  });

  test('uses a contribution own version over the plugin version', async () => {
    const identities = await pluginIdentities(toolPlugin(z.object({}), '3.0.0'));
    expect(identities.entries.find(({ kind }) => kind === 'tool')?.version).toBe('3.0.0');
  });

  test('changes a digest when a schema changes and leaves the rest alone', async () => {
    const before = await pluginIdentities(toolPlugin(z.object({ id: z.string() })));
    const after = await pluginIdentities(toolPlugin(z.object({ id: z.number() })));
    const [beforeConfiguration, beforeTool] = before.entries;
    const [afterConfiguration, afterTool] = after.entries;
    expect(afterConfiguration).toEqual(beforeConfiguration);
    expect(afterTool?.schema).not.toBe(beforeTool?.schema);
  });

  test('includes trigger kinds and hook actions by their configuration schema', async () => {
    const plugin = definePlugin({
      ...base,
      setup: () => ({
        triggerKinds: [
          {
            name: 'poll',
            description: 'Polls',
            configuration: z.object({ every: z.string() }),
            start: async () => () => {},
          },
        ],
        hookActionKinds: [
          {
            name: 'post',
            version: '2.0.0',
            description: 'Posts',
            configuration: z.object({ url: z.string() }),
            run: async () => {},
          },
        ],
      }),
    });
    const { entries } = await pluginIdentities(plugin);
    expect(entries.map(({ kind, id, version }) => `${kind} ${id} ${version}`)).toEqual([
      'configuration example 1.2.0',
      'hook-action example:post 2.0.0',
      'trigger-kind example:poll 1.2.0',
    ]);
  });

  test('lists each guardrail an agent file can name, by kind and id', async () => {
    const plugin = definePlugin({
      ...base,
      setup: () => ({
        guardrails: {
          inputDetectors: [{ name: 'no-secrets', detect: async () => ({ safe: true }) } as never],
          outputValidators: [
            {
              name: 'no-forbidden',
              validate: async () => ({ valid: true, confidence: 0, category: 'x' }),
            },
          ],
        },
      }),
    });
    const { entries } = await pluginIdentities(plugin);
    expect(entries.map(({ kind, id, version, schema }) => ({ kind, id, version, schema }))).toEqual(
      [
        { kind: 'configuration', id: 'example', version: '1.2.0', schema: expect.any(String) },
        { kind: 'input-guardrail', id: 'example:no-secrets', version: '1.2.0', schema: null },
        { kind: 'output-guardrail', id: 'example:no-forbidden', version: '1.2.0', schema: null },
      ],
    );
  });

  test('names the plugin when its configuration refuses an empty object', async () => {
    const plugin = definePlugin({ ...base, configuration: z.object({ key: z.string() }) });
    const error = await pluginIdentities(plugin).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(TypeError);
    expect((error as TypeError).message).toMatch(/"example".*configuration/);
  });
});
