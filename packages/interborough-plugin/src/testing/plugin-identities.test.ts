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
