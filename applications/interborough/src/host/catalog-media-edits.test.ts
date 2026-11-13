/**
 * COR-2413 — a catalog edit may lower a row's media limits and per-request part counts, and never
 * raise them. Stored edits without the fields load unchanged.
 */
import { createModelCatalog } from '@lostgradient/operative';
import { describe, expect, test } from 'bun:test';

import { parseCatalogEdits } from './catalog-edits.ts';
import { ProviderConfigurationError } from './provider-configuration-error.ts';
import { contributedFixtures } from './provider-fixtures.test-support.ts';
import { selectCatalogRows } from './providers.ts';

const PATH = '/home/interborough/configuration.json';
const ALL = new Set(['anthropic', 'openai', 'gemini']);
const NONE: ReadonlyMap<string, readonly string[]> = new Map();
const seed = createModelCatalog().descriptors.find(
  (row) => row.provider === 'anthropic' && row.model === 'claude-sonnet-5',
);

function rowsWith(catalog: readonly unknown[]) {
  return selectCatalogRows({
    configuration: { catalog: parseCatalogEdits(catalog, PATH) },
    allowlists: NONE,
    path: PATH,
    available: ALL,
    providers: contributedFixtures(['anthropic']),
  });
}

function refusal(run: () => unknown): ProviderConfigurationError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ProviderConfigurationError);
    return error as ProviderConfigurationError;
  }
  throw new Error('Expected the edit to be refused.');
}

const sonnet = (edit: Record<string, unknown>) => ({
  provider: 'anthropic',
  model: 'sonnet',
  ...edit,
});

describe('the media fields of a catalog edit', () => {
  test('lower the row’s own limit and leave the rest of the row alone', () => {
    if (seed === undefined) throw new Error('The seed has no anthropic row.');
    const rows = rowsWith([
      sonnet({
        mediaLimits: [{ scope: 'per-part', modality: 'image', maxBytes: 1024 }],
        mediaCounts: [{ modality: 'image', maxPerRequest: 4 }],
      }),
    ]);
    const edited = rows.find((row) => row.model === seed.model);
    expect(edited?.mediaLimits).toEqual([{ scope: 'per-part', modality: 'image', maxBytes: 1024 }]);
    expect(edited?.mediaCounts).toEqual([{ modality: 'image', maxPerRequest: 4 }]);
    expect(edited?.modalities).toEqual(seed.modalities);
  });

  test('may state a limit the row does not, which only narrows it', () => {
    const rows = rowsWith([
      sonnet({ mediaLimits: [{ scope: 'aggregate', modality: 'image', maxBytes: 4096 }] }),
    ]);
    expect(rows.find((row) => row.model === seed?.model)?.mediaLimits).toEqual([
      ...(seed?.mediaLimits ?? []),
      { scope: 'aggregate', modality: 'image', maxBytes: 4096 },
    ]);
  });

  test('refuse a limit above the seed row’s, naming the field and never the value', () => {
    const failure = refusal(() =>
      rowsWith([
        sonnet({
          mediaLimits: [{ scope: 'per-part', modality: 'image', maxBytes: 99_999_999 }],
        }),
      ]),
    );
    expect(failure.message).toContain('catalog[0].mediaLimits[0].maxBytes');
    expect(failure.message).not.toContain('99999999');
  });

  test('refuse a part count above the seed row’s', () => {
    const failure = refusal(() =>
      rowsWith([sonnet({ mediaCounts: [{ modality: 'image', maxPerRequest: 100_000 }] })]),
    );
    expect(failure.message).toContain('catalog[0].mediaCounts[0].maxPerRequest');
  });

  test('refuse a limit above the base row’s on an added row', () => {
    const failure = refusal(() =>
      rowsWith([
        {
          provider: 'anthropic',
          model: 'sonnet-next',
          basedOn: 'sonnet',
          mediaLimits: [{ scope: 'per-part', modality: 'image', maxBytes: 99_999_999 }],
        },
      ]),
    );
    expect(failure.message).toContain('catalog[0].mediaLimits[0].maxBytes');
  });

  test('refuse an unknown field, a bad scope, an empty entry, and a repeated limit', () => {
    const parse = (mediaLimits: unknown) =>
      refusal(() => parseCatalogEdits([sonnet({ mediaLimits })], PATH)).message;
    expect(
      parse([{ scope: 'per-part', modality: 'image', maxBytes: 1, maxMegabytes: 1 }]),
    ).toContain('catalog[0].mediaLimits[0].maxMegabytes');
    expect(parse([{ scope: 'each', modality: 'image', maxBytes: 1 }])).toContain(
      'mediaLimits[0].scope',
    );
    expect(parse([{ scope: 'per-part', modality: 'image' }])).toContain('mediaLimits[0]');
    expect(parse([{ scope: 'per-part', modality: 'image', maxBytes: 0 }])).toContain(
      'mediaLimits[0].maxBytes',
    );
    expect(
      parse([
        { scope: 'per-part', modality: 'image', maxBytes: 1 },
        { scope: 'per-part', modality: 'image', maxPixels: 1 },
      ]),
    ).toContain('mediaLimits[1]');
    expect(
      refusal(() => parseCatalogEdits([sonnet({ mediaCounts: [{ modality: 'image' }] })], PATH))
        .message,
    ).toContain('mediaCounts[0].maxPerRequest');
  });
});

describe('stored catalog edits without the media fields', () => {
  /** An edit file as written before the media fields existed. */
  const stored = [
    { provider: 'anthropic', model: 'haiku', off: true },
    {
      provider: 'anthropic',
      model: 'sonnet',
      contextWindowTokens: 150_000,
      maxOutputTokens: 8_000,
    },
    { provider: 'anthropic', model: 'sonnet-next', basedOn: 'sonnet' },
  ];

  test('parse to exactly what they say', () => {
    expect(parseCatalogEdits(stored, PATH)).toEqual(stored);
  });

  test('leave every row’s media limits as the seed states them', () => {
    const rows = rowsWith(stored);
    for (const row of rows) {
      const origin = createModelCatalog().descriptors.find(
        (candidate) =>
          candidate.provider === row.provider &&
          (candidate.model === row.model || row.model === 'sonnet-next'),
      );
      expect(row.mediaLimits).toEqual(origin?.mediaLimits ?? []);
      expect(row.mediaCounts).toEqual(origin?.mediaCounts ?? []);
    }
  });
});
