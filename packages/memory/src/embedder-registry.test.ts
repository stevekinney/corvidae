import type { Embedder } from 'armorer/testing';
import { describe, expect, it } from 'bun:test';

import {
  createEmbedderRegistry,
  EmbedderRegistryError,
  HASHING_EMBEDDER_ID,
  HASHING_EMBEDDER_MODEL,
} from './embedder-registry';
import { createHashingEmbedder, HASHING_EMBEDDER_DIMENSION } from './hashing-embedder';

const constant =
  (value: number): Embedder =>
  (texts) =>
    texts.map(() => [value]);

describe('createEmbedderRegistry (COR-1875)', () => {
  it('embeds with the hashing embedder when two are contributed and none is selected', async () => {
    const registry = createEmbedderRegistry([
      { id: 'alpha', embedder: constant(1), dimension: 1, model: 'alpha-model' },
      { id: 'beta', embedder: constant(2), dimension: 1, model: 'beta-model' },
    ]);
    expect(registry.ids).toEqual([HASHING_EMBEDDER_ID, 'alpha', 'beta']);
    const text = 'the user prefers aisle seats';
    expect(await registry.resolve()([text])).toEqual(await createHashingEmbedder()([text]));
    expect(await registry.resolve(undefined)([text])).toEqual(
      await createHashingEmbedder()([text]),
    );
  });

  it('resolves a contributed embedder only when it is selected by id', async () => {
    const registry = createEmbedderRegistry([
      { id: 'alpha', embedder: constant(1), dimension: 1, model: 'alpha-model' },
    ]);
    expect(await registry.resolve('alpha')(['x'])).toEqual([[1]]);
    expect(await registry.resolve(HASHING_EMBEDDER_ID)(['x'])).toEqual(
      await createHashingEmbedder()(['x']),
    );
  });

  it('refuses an unregistered id, naming what is registered', () => {
    const registry = createEmbedderRegistry([
      { id: 'alpha', embedder: constant(1), dimension: 1, model: 'alpha-model' },
    ]);
    expect(() => registry.resolve('gamma')).toThrow(/"gamma".*hashing, alpha/);
    expect(() => registry.resolve('constructor')).toThrow(EmbedderRegistryError);
  });

  it('refuses a blank id, a repeated id, and a contribution under the hashing id', () => {
    const embedder = constant(1);
    const model = 'm';
    expect(() => createEmbedderRegistry([{ id: ' ', embedder, dimension: 1, model }])).toThrow(
      EmbedderRegistryError,
    );
    expect(() =>
      createEmbedderRegistry([
        { id: 'alpha', embedder, dimension: 1, model },
        { id: 'alpha', embedder, dimension: 1, model },
      ]),
    ).toThrow(/alpha/);
    expect(() =>
      createEmbedderRegistry([{ id: HASHING_EMBEDDER_ID, embedder, dimension: 1, model }]),
    ).toThrow(/built-in hashing/);
  });
});

describe('embedder registry dimension and availability (COR-1898)', () => {
  it('describes each id with its dimension, model and its availability as it is now', () => {
    let availability: 'available' | 'needs-setup' = 'needs-setup';
    const registry = createEmbedderRegistry([
      {
        id: 'remote',
        embedder: constant(1),
        dimension: 8,
        model: 'remote-model',
        availability: () => availability,
      },
    ]);
    expect(registry.describe(HASHING_EMBEDDER_ID)).toEqual({
      id: HASHING_EMBEDDER_ID,
      dimension: HASHING_EMBEDDER_DIMENSION,
      model: HASHING_EMBEDDER_MODEL,
      availability: 'available',
    });
    expect(registry.describe('remote')).toEqual({
      id: 'remote',
      dimension: 8,
      model: 'remote-model',
      availability: 'needs-setup',
    });
    availability = 'available';
    expect(registry.describe('remote')?.availability).toBe('available');
    expect(registry.describe('constructor')).toBeUndefined();
  });

  it('refuses a dimension that is not a positive integer', () => {
    for (const dimension of [0, -1, 1.5, Number.NaN]) {
      expect(() =>
        createEmbedderRegistry([{ id: 'alpha', embedder: constant(1), dimension, model: 'm' }]),
      ).toThrow(EmbedderRegistryError);
    }
  });
});

describe('embedder registry model (COR-2184)', () => {
  it('refuses a blank model, and one that is not a string', () => {
    for (const model of ['', '   ', undefined, 7]) {
      expect(() =>
        createEmbedderRegistry([
          { id: 'alpha', embedder: constant(1), dimension: 1, model: model as string },
        ]),
      ).toThrow(/needs a non-blank model/);
    }
  });

  it('registers the hashing embedder with the model "hashing"', () => {
    expect(HASHING_EMBEDDER_MODEL).toBe('hashing');
    expect(createEmbedderRegistry().describe(HASHING_EMBEDDER_ID)?.model).toBe('hashing');
  });
});
