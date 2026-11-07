/** How a change to one catalog row becomes the list of edits the host stores. */
import { describe, expect, test } from 'bun:test';

import type { CatalogEdit, ProviderModel } from '../../../lib/host-providers.ts';
import {
  allowlistExcludes,
  editOf,
  namesExistingRow,
  previewRows,
  withAddedRow,
  withModelOff,
  withRowFields,
} from './catalog-changes.ts';

const SONNET: ProviderModel = {
  provider: 'anthropic',
  model: 'claude-sonnet-5',
  aliases: ['sonnet'],
  contextWindowTokens: 200_000,
  maxOutputTokens: 64_000,
  streaming: true,
  tools: true,
  structuredOutput: true,
  images: true,
  pricing: { inputPerMillionTokens: 3, outputPerMillionTokens: 15, currency: 'USD' },
  off: false,
};
const HAIKU: ProviderModel = {
  ...SONNET,
  model: 'claude-haiku-4-5',
  aliases: ['haiku'],
  contextWindowTokens: 100_000,
  maxOutputTokens: 8_000,
};
const UNPRICED: ProviderModel = { ...HAIKU, model: 'gpt-x', provider: 'openai', aliases: [] };
delete (UNPRICED as { pricing?: unknown }).pricing;

const FIELDS = {
  contextWindowTokens: 200_000,
  maxOutputTokens: 64_000,
  inputPerMillionTokens: 3,
  outputPerMillionTokens: 15,
};
const CACHED_SONNET: ProviderModel = {
  ...SONNET,
  pricing: {
    ...SONNET.pricing!,
    cacheReadPerMillionTokens: 0.2,
    cacheWritePerMillionTokens: 2.5,
    longContext: {
      inputTokensAbove: 100_000,
      inputPerMillionTokens: 5,
      outputPerMillionTokens: 25,
      cacheReadPerMillionTokens: 0.5,
      cacheWritePerMillionTokens: 6.25,
    },
  },
};

describe('withModelOff', () => {
  test('adds an edit under the model name, and leaves the argument alone', () => {
    const before: CatalogEdit[] = [];
    expect(withModelOff(before, SONNET, true)).toEqual([
      { provider: 'anthropic', model: 'claude-sonnet-5', off: true },
    ]);
    expect(before).toEqual([]);
  });

  test('finds the row’s edit by an alias, and keeps what else it says', () => {
    const edits: CatalogEdit[] = [
      { provider: 'anthropic', model: 'sonnet', maxOutputTokens: 4_000 },
    ];
    expect(withModelOff(edits, SONNET, true)).toEqual([
      { provider: 'anthropic', model: 'sonnet', maxOutputTokens: 4_000, off: true },
    ]);
  });

  test('drops the edit when turning a model back on leaves it saying nothing', () => {
    const edits: CatalogEdit[] = [
      { provider: 'anthropic', model: 'haiku', off: true },
      { provider: 'openai', model: 'gpt-x', off: true },
    ];
    expect(withModelOff(edits, HAIKU, false)).toEqual([
      { provider: 'openai', model: 'gpt-x', off: true },
    ]);
  });

  test('keeps an edit that still sets something when the model is turned back on', () => {
    const edits: CatalogEdit[] = [
      { provider: 'anthropic', model: 'sonnet', off: true, contextWindowTokens: 1_000 },
    ];
    expect(withModelOff(edits, SONNET, false)).toEqual([
      { provider: 'anthropic', model: 'sonnet', contextWindowTokens: 1_000 },
    ]);
  });

  test('leaves a row that is on and has no edit without one', () => {
    expect(withModelOff([], SONNET, false)).toEqual([]);
  });

  test('keeps an added row’s edit when it is turned back on, because it still names its base', () => {
    const edits: CatalogEdit[] = [
      { provider: 'anthropic', model: 'claude-next', basedOn: 'sonnet', off: true },
    ];
    const row = { ...SONNET, model: 'claude-next', aliases: [] };
    expect(withModelOff(edits, row, false)).toEqual([
      { provider: 'anthropic', model: 'claude-next', basedOn: 'sonnet' },
    ]);
  });
});

describe('withRowFields', () => {
  test('writes nothing for a row whose values were not touched', () => {
    expect(withRowFields([], SONNET, FIELDS)).toEqual([]);
  });

  test('writes only what differs from the row', () => {
    expect(withRowFields([], SONNET, { ...FIELDS, contextWindowTokens: 100_000 })).toEqual([
      { provider: 'anthropic', model: 'claude-sonnet-5', contextWindowTokens: 100_000 },
    ]);
  });

  test('writes the price as a pair with the row’s currency', () => {
    expect(withRowFields([], SONNET, { ...FIELDS, outputPerMillionTokens: 20 })).toEqual([
      {
        provider: 'anthropic',
        model: 'claude-sonnet-5',
        pricing: { inputPerMillionTokens: 3, outputPerMillionTokens: 20, currency: 'USD' },
      },
    ]);
  });

  test('prices a row that had no price in dollars', () => {
    const edits = withRowFields([], UNPRICED, {
      contextWindowTokens: 100_000,
      maxOutputTokens: 8_000,
      inputPerMillionTokens: 1,
      outputPerMillionTokens: 2,
    });
    expect(edits[0]?.pricing).toEqual({
      inputPerMillionTokens: 1,
      outputPerMillionTokens: 2,
      currency: 'USD',
    });
  });

  test('keeps an edit’s other fields, and the long-context rates it names', () => {
    const longContext = {
      inputTokensAbove: 200_000,
      inputPerMillionTokens: 6,
      outputPerMillionTokens: 22,
    };
    const edits: CatalogEdit[] = [
      {
        provider: 'anthropic',
        model: 'sonnet',
        off: true,
        pricing: {
          inputPerMillionTokens: 3,
          outputPerMillionTokens: 15,
          currency: 'EUR',
          longContext,
        },
      },
    ];
    expect(withRowFields(edits, SONNET, { ...FIELDS, inputPerMillionTokens: 4 })).toEqual([
      {
        provider: 'anthropic',
        model: 'sonnet',
        off: true,
        pricing: {
          inputPerMillionTokens: 4,
          outputPerMillionTokens: 15,
          currency: 'EUR',
          longContext,
        },
      },
    ]);
  });

  test('keeps writing a field its edit already sets, even when it returns to the row’s value', () => {
    const edits: CatalogEdit[] = [
      { provider: 'anthropic', model: 'sonnet', maxOutputTokens: 4_000 },
    ];
    expect(withRowFields(edits, SONNET, FIELDS)[0]?.maxOutputTokens).toBe(64_000);
  });

  test('preserves row cache rates when an ordinary price edit starts without an existing edit', () => {
    expect(withRowFields([], CACHED_SONNET, { ...FIELDS, outputPerMillionTokens: 20 })).toEqual([
      {
        provider: 'anthropic',
        model: 'claude-sonnet-5',
        pricing: {
          inputPerMillionTokens: 3,
          outputPerMillionTokens: 20,
          currency: 'USD',
          cacheReadPerMillionTokens: 0.2,
          cacheWritePerMillionTokens: 2.5,
          longContext: CACHED_SONNET.pricing?.longContext,
        },
      },
    ]);
  });

  test('preserves explicit tier removal when ordinary prices change', () => {
    const edits: CatalogEdit[] = [
      {
        provider: 'anthropic',
        model: 'claude-sonnet-5',
        pricing: {
          inputPerMillionTokens: 3,
          outputPerMillionTokens: 10,
          currency: 'USD',
          longContext: null,
        },
      },
    ];

    expect(withRowFields(edits, CACHED_SONNET, { ...FIELDS, outputPerMillionTokens: 20 })).toEqual([
      {
        provider: 'anthropic',
        model: 'claude-sonnet-5',
        pricing: {
          inputPerMillionTokens: 3,
          outputPerMillionTokens: 20,
          currency: 'USD',
          cacheReadPerMillionTokens: 0.2,
          cacheWritePerMillionTokens: 2.5,
          longContext: null,
        },
      },
    ]);
  });

  test('preserves explicit tier removal when context limits change', () => {
    const edits: CatalogEdit[] = [
      {
        provider: 'anthropic',
        model: 'claude-sonnet-5',
        pricing: {
          inputPerMillionTokens: 3,
          outputPerMillionTokens: 10,
          currency: 'USD',
          longContext: null,
        },
      },
    ];

    expect(
      withRowFields(edits, CACHED_SONNET, {
        ...FIELDS,
        contextWindowTokens: CACHED_SONNET.contextWindowTokens + 1,
      }),
    ).toEqual([
      {
        provider: 'anthropic',
        model: 'claude-sonnet-5',
        contextWindowTokens: CACHED_SONNET.contextWindowTokens + 1,
        pricing: {
          inputPerMillionTokens: 3,
          outputPerMillionTokens: 15,
          currency: 'USD',
          cacheReadPerMillionTokens: 0.2,
          cacheWritePerMillionTokens: 2.5,
          longContext: null,
        },
      },
    ]);
  });
});

describe('withAddedRow', () => {
  test('appends a row based on a current model, with its limits and price', () => {
    const edits: CatalogEdit[] = [{ provider: 'anthropic', model: 'haiku', off: true }];
    expect(
      withAddedRow(edits, {
        ...FIELDS,
        provider: 'anthropic',
        model: 'claude-next',
        basedOn: 'claude-sonnet-5',
      }),
    ).toEqual([
      { provider: 'anthropic', model: 'haiku', off: true },
      {
        provider: 'anthropic',
        model: 'claude-next',
        basedOn: 'claude-sonnet-5',
        contextWindowTokens: 200_000,
        maxOutputTokens: 64_000,
        pricing: { inputPerMillionTokens: 3, outputPerMillionTokens: 15, currency: 'USD' },
      },
    ]);
  });
});

describe('previewRows with an allowlist', () => {
  const added = { provider: 'anthropic', model: 'claude-next', basedOn: 'sonnet' };

  test('shows no row for an added model its provider’s allowlist leaves out', () => {
    const providers = [{ name: 'anthropic', configured: true, hasKey: true, models: ['sonnet'] }];
    expect(previewRows([SONNET], [added], providers).map((row) => row.model)).toEqual([
      'claude-sonnet-5',
    ]);
    expect(allowlistExcludes(providers, 'anthropic', 'claude-next')).toBe(true);
    expect(allowlistExcludes(providers, 'anthropic', 'sonnet')).toBe(false);
  });

  test('shows the row when the provider has no allowlist', () => {
    const providers = [{ name: 'anthropic', configured: true, hasKey: true }];
    expect(previewRows([SONNET], [added], providers)).toHaveLength(2);
    expect(allowlistExcludes(providers, 'anthropic', 'claude-next')).toBe(false);
  });
});

describe('previewRows with a saved off edit', () => {
  test('follows the working edits: saved off, on, then off again', () => {
    const saved = { ...SONNET, off: true };
    const savedEdit = { provider: 'anthropic', model: 'sonnet', off: true };
    const on = withModelOff([savedEdit], saved, false);
    expect(previewRows([saved], on)[0]?.off).toBe(false);
    const off = withModelOff(on, saved, true);
    expect(previewRows([saved], off)[0]?.off).toBe(true);
  });
});

describe('previewRows with cache pricing', () => {
  test('keeps row-owned cache rates when a legacy edit replaces only long-context prices', () => {
    const rows = previewRows(
      [CACHED_SONNET],
      [
        {
          provider: 'anthropic',
          model: 'sonnet',
          pricing: {
            inputPerMillionTokens: 4,
            outputPerMillionTokens: 20,
            currency: 'USD',
            longContext: {
              inputTokensAbove: 50_000,
              inputPerMillionTokens: 6,
              outputPerMillionTokens: 30,
            },
          },
        },
      ],
    );
    expect(rows[0]?.pricing).toEqual({
      inputPerMillionTokens: 4,
      outputPerMillionTokens: 20,
      currency: 'USD',
      cacheReadPerMillionTokens: 0.2,
      cacheWritePerMillionTokens: 2.5,
      longContext: {
        inputTokensAbove: 50_000,
        inputPerMillionTokens: 6,
        outputPerMillionTokens: 30,
        cacheReadPerMillionTokens: 0.5,
        cacheWritePerMillionTokens: 6.25,
      },
    });
  });

  test('removes a tier in effective previews while preserving its persisted null marker', () => {
    const removed: CatalogEdit = {
      provider: 'anthropic',
      model: 'sonnet',
      pricing: {
        inputPerMillionTokens: 3,
        outputPerMillionTokens: 15,
        currency: 'USD',
        longContext: null,
      },
    };
    expect(previewRows([CACHED_SONNET], [removed])[0]?.pricing?.longContext).toBeUndefined();

    const ordinaryWithRemoval = withRowFields([removed], CACHED_SONNET, {
      ...FIELDS,
      outputPerMillionTokens: 20,
    });
    const contextWithRemoval = withRowFields([removed], CACHED_SONNET, {
      ...FIELDS,
      contextWindowTokens: CACHED_SONNET.contextWindowTokens + 1,
    });
    expect(ordinaryWithRemoval[0]?.pricing?.longContext).toBeNull();
    expect(contextWithRemoval[0]?.pricing?.longContext).toBeNull();
    expect(
      previewRows([CACHED_SONNET], ordinaryWithRemoval)[0]?.pricing?.longContext,
    ).toBeUndefined();
    expect(
      previewRows([CACHED_SONNET], contextWithRemoval)[0]?.pricing?.longContext,
    ).toBeUndefined();
  });
});

describe('previewRows', () => {
  test('lays the edits over the rows, so an unsaved switch already shows', () => {
    const rows = previewRows(
      [SONNET, HAIKU],
      [
        { provider: 'anthropic', model: 'haiku', off: true },
        {
          provider: 'anthropic',
          model: 'sonnet',
          contextWindowTokens: 1_000,
          maxOutputTokens: 500,
        },
      ],
    );
    expect(rows.map((row) => [row.model, row.off, row.contextWindowTokens, row.added])).toEqual([
      ['claude-sonnet-5', false, 1_000, false],
      ['claude-haiku-4-5', true, 100_000, false],
    ]);
  });

  test('turns a row on when its off edit is gone', () => {
    // The edits decide, not the snapshot's `off`: with none, the row is on.
    expect(previewRows([{ ...SONNET, off: true }], [])[0]?.off).toBe(false);
    expect(
      previewRows([{ ...SONNET, off: true }], [{ provider: 'anthropic', model: 'sonnet' }])[0]?.off,
    ).toBe(false);
  });

  test('adds a row an edit names, copying its base’s abilities, and marks it added', () => {
    const rows = previewRows(
      [SONNET],
      [{ provider: 'anthropic', model: 'claude-next', basedOn: 'sonnet', maxOutputTokens: 4_000 }],
    );
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({
      model: 'claude-next',
      aliases: [],
      added: true,
      tools: true,
      maxOutputTokens: 4_000,
      contextWindowTokens: 200_000,
    });
  });

  test('marks a saved added row as added, and skips an added row whose base is not offered', () => {
    const saved = { ...SONNET, model: 'claude-next', aliases: [] };
    const edits: CatalogEdit[] = [
      { provider: 'anthropic', model: 'claude-next', basedOn: 'sonnet' },
      { provider: 'openai', model: 'gpt-next', basedOn: 'gpt-x' },
    ];
    const rows = previewRows([SONNET, saved], edits);
    expect(rows.map((row) => [row.model, row.added])).toEqual([
      ['claude-sonnet-5', false],
      ['claude-next', true],
    ]);
  });
});

describe('editOf and namesExistingRow', () => {
  test('match a row by its model or an alias, within its provider', () => {
    expect(editOf([{ provider: 'openai', model: 'sonnet' }], SONNET)).toBeUndefined();
    expect(
      editOf([{ provider: 'anthropic', model: 'claude-sonnet-5', off: true }], SONNET)?.off,
    ).toBe(true);
    expect(namesExistingRow([SONNET], 'anthropic', 'sonnet')).toBe(true);
    expect(namesExistingRow([SONNET], 'anthropic', 'claude-sonnet-5')).toBe(true);
    expect(namesExistingRow([SONNET], 'openai', 'sonnet')).toBe(false);
  });
});
