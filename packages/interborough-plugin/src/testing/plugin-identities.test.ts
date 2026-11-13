import {
  type BackendDescriptor,
  createModelCatalog,
  type DecisionKind,
} from '@lostgradient/operative';
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

  describe('a provider (COR-2158)', () => {
    const [first] = createModelCatalog().descriptors;
    if (first === undefined) throw new Error('Expected the seed catalog to hold rows.');
    const seed: BackendDescriptor = first;

    function providerPlugin(
      options: {
        readonly version?: string;
        readonly kinds?: readonly DecisionKind[];
        readonly only?: boolean;
      } = {},
    ) {
      const row: BackendDescriptor = {
        ...seed,
        provider: 'judge',
        model: 'oracle',
        aliases: [],
        ...(options.kinds === undefined
          ? {}
          : { decisions: { kinds: options.kinds, only: options.only ?? true } }),
      };
      return definePlugin({
        ...base,
        setup: () => ({
          providers: [
            {
              name: 'judge',
              decide: () => ({
                name: 'judge',
                kinds: new Set(),
                decide: async () => ({}) as never,
              }),
              rows: [row],
              ...(options.version === undefined ? {} : { version: options.version }),
            },
          ],
        }),
      });
    }

    const providerEntry = async (plugin: ReturnType<typeof providerPlugin>) => {
      const { entries } = await pluginIdentities(plugin);
      const found = entries.find(({ kind }) => kind === 'provider');
      if (found === undefined) throw new Error('Expected a provider entry.');
      return found;
    };

    test('lists the provider with a digest, and with the plugin version when it declares none', async () => {
      const entry = await providerEntry(providerPlugin({ kinds: ['boolean'] }));
      expect(entry).toMatchObject({ id: 'example:judge', version: '1.2.0' });
      expect(entry.schema).toStartWith('sha256:');
    });

    test('changes the digest when the provider version changes', async () => {
      const first = await providerEntry(providerPlugin({ version: '1.0.0', kinds: ['boolean'] }));
      const second = await providerEntry(providerPlugin({ version: '1.1.0', kinds: ['boolean'] }));
      expect(first.version).toBe('1.0.0');
      expect(second.schema).not.toBe(first.schema);
    });

    test('changes the digest when a row’s native decision kinds change, in any order', async () => {
      const first = await providerEntry(providerPlugin({ kinds: ['boolean', 'choice'] }));
      const reordered = await providerEntry(providerPlugin({ kinds: ['choice', 'boolean'] }));
      const widened = await providerEntry(
        providerPlugin({ kinds: ['boolean', 'choice', 'scale'] }),
      );
      const dropped = await providerEntry(providerPlugin());
      expect(reordered.schema).toBe(first.schema);
      expect(widened.schema).not.toBe(first.schema);
      expect(dropped.schema).not.toBe(first.schema);
    });

    test('changes the digest when a row stops being decision-only', async () => {
      const only = await providerEntry(providerPlugin({ kinds: ['boolean'], only: true }));
      const both = await providerEntry(providerPlugin({ kinds: ['boolean'], only: false }));
      expect(both.schema).not.toBe(only.schema);
    });
  });

  test('includes trigger kinds and hook actions by their configuration schema', async () => {
    const plugin = definePlugin({
      ...base,
      setup: () => ({
        triggers: [
          {
            name: 'poll',
            description: 'Polls',
            configuration: z.object({ every: z.string() }),
            start: async () => () => {},
          },
        ],
        reactions: [
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
      'reaction example:post 2.0.0',
      'trigger example:poll 1.2.0',
    ]);
  });

  test('lists each guardrail as a guardrail whose id records its family', async () => {
    const plugin = definePlugin({
      ...base,
      setup: () => ({
        guardrails: {
          input: [
            {
              name: 'no-secrets',
              description: 'Flags secrets.',
              detect: async () => ({ safe: true }),
            } as never,
          ],
          output: [
            {
              // An entry with an action of its own is listed by its guardrail's name (COR-2104).
              guardrail: {
                name: 'no-forbidden',
                description: 'Flags forbidden words.',
                validate: async () => ({ valid: true, confidence: 0, category: 'x' }),
              },
              action: 'warn',
            },
          ],
          tools: [
            {
              name: 'refund-cap',
              description: 'Caps refunds.',
              action: 'block',
              validate: async () => ({ valid: true, confidence: 0, category: 'x' }),
            },
          ],
          // One detector can serve two families under one name: the family is in the identity.
          memory: [
            {
              name: 'no-secrets',
              description: 'Flags secrets.',
              detect: async () => ({ safe: true }),
            } as never,
            {
              name: 'recall-only',
              description: 'Flags recalled secrets.',
              gates: ['recall'],
              detect: async () => ({ safe: true }),
            } as never,
          ],
        },
      }),
    });
    const { entries } = await pluginIdentities(plugin);
    expect(entries.map(({ kind, id, version, schema }) => ({ kind, id, version, schema }))).toEqual(
      [
        { kind: 'configuration', id: 'example', version: '1.2.0', schema: expect.any(String) },
        { kind: 'guardrail', id: 'example:input/no-secrets', version: '1.2.0', schema: null },
        { kind: 'guardrail', id: 'example:memory/no-secrets', version: '1.2.0', schema: null },
        { kind: 'guardrail', id: 'example:memory/recall-only', version: '1.2.0', schema: null },
        { kind: 'guardrail', id: 'example:output/no-forbidden', version: '1.2.0', schema: null },
        { kind: 'guardrail', id: 'example:tools/refund-cap', version: '1.2.0', schema: null },
      ],
    );
  });

  test('records a guardrail factory with its configuration schema (COR-2118)', async () => {
    const factory = (threshold: number) => ({
      name: 'grounding',
      description: 'Flags unsupported claims.',
      configuration: z.object({ threshold: z.number().default(threshold) }),
      create: () => ({
        name: 'grounding',
        validate: async () => ({ valid: true, confidence: 0, category: 'x' }),
      }),
    });
    const identitiesWith = async (threshold: number) => {
      const identities = await pluginIdentities(
        definePlugin({
          ...base,
          setup: () => ({ guardrails: { output: [factory(threshold)] } }),
        }),
      );
      return identities.entries.find(({ id }) => id === 'example:output/grounding');
    };
    const entry = await identitiesWith(0.8);
    expect(entry).toEqual({
      kind: 'guardrail',
      id: 'example:output/grounding',
      version: '1.2.0',
      schema: schemaDigest(z.object({ threshold: z.number().default(0.8) })),
    });
    // The digest moves with the schema, so a changed contract is a changed identity.
    const moved = await identitiesWith(0.5);
    expect(moved?.schema).not.toBe(entry?.schema);
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
