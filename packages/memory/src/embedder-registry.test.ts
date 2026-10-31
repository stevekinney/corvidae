import type { Embedder } from 'armorer';
import { describe, expect, it } from 'bun:test';

import {
  createEmbedderRegistry,
  EmbedderRegistryError,
  HASHING_EMBEDDER_ID,
} from './embedder-registry';
import { createHashingEmbedder } from './hashing-embedder';

const constant =
  (value: number): Embedder =>
  (texts) =>
    texts.map(() => [value]);

describe('createEmbedderRegistry (COR-1875)', () => {
  it('embeds with the hashing embedder when two are contributed and none is selected', async () => {
    const registry = createEmbedderRegistry([
      { id: 'alpha', embedder: constant(1) },
      { id: 'beta', embedder: constant(2) },
    ]);
    expect(registry.ids).toEqual([HASHING_EMBEDDER_ID, 'alpha', 'beta']);
    const text = 'the user prefers aisle seats';
    expect(await registry.resolve()([text])).toEqual(await createHashingEmbedder()([text]));
    expect(await registry.resolve(undefined)([text])).toEqual(
      await createHashingEmbedder()([text]),
    );
  });

  it('resolves a contributed embedder only when it is selected by id', async () => {
    const registry = createEmbedderRegistry([{ id: 'alpha', embedder: constant(1) }]);
    expect(await registry.resolve('alpha')(['x'])).toEqual([[1]]);
    expect(await registry.resolve(HASHING_EMBEDDER_ID)(['x'])).toEqual(
      await createHashingEmbedder()(['x']),
    );
  });

  it('refuses an unregistered id, naming what is registered', () => {
    const registry = createEmbedderRegistry([{ id: 'alpha', embedder: constant(1) }]);
    expect(() => registry.resolve('gamma')).toThrow(/"gamma".*hashing, alpha/);
    expect(() => registry.resolve('constructor')).toThrow(EmbedderRegistryError);
  });

  it('refuses a blank id, a repeated id, and a contribution under the hashing id', () => {
    const embedder = constant(1);
    expect(() => createEmbedderRegistry([{ id: ' ', embedder }])).toThrow(EmbedderRegistryError);
    expect(() =>
      createEmbedderRegistry([
        { id: 'alpha', embedder },
        { id: 'alpha', embedder },
      ]),
    ).toThrow(/alpha/);
    expect(() => createEmbedderRegistry([{ id: HASHING_EMBEDDER_ID, embedder }])).toThrow(
      /built-in hashing/,
    );
  });
});
