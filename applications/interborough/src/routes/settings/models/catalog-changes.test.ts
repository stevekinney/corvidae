/** How a change to one catalog row becomes the list of edits the host stores. */
import { describe, expect, test } from 'bun:test';

import type { CatalogEdit, ProviderModel } from '../../../lib/host-providers.ts';
import {
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
    expect(previewRows([{ ...SONNET, off: true }], [])[0]?.off).toBe(true);
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
