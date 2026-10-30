/**
 * The catalog edits in `configuration.json`: a person turns a model off, corrects its price or
 * limits, or adds a row the built-in list lacks. They sit beside `providers`:
 *
 * ```json
 * {
 *   "providers": { "openai": {} },
 *   "catalog": [
 *     { "provider": "openai", "model": "gpt-4.1", "off": true },
 *     { "provider": "openai", "model": "gpt-4.1-mini", "contextWindowTokens": 200000 },
 *     { "provider": "openai", "model": "gpt-next", "basedOn": "gpt-4.1" }
 *   ]
 * }
 * ```
 *
 * An edit that names a row of the provider's built-in list changes that row. One that does not is
 * an added row: it names `basedOn`, a current model of the same provider whose capabilities it
 * copies, and may set its own price and limits. A message about an edit names the field, never a
 * value.
 *
 * @module catalog-edits
 */

import type { BackendDescriptor } from '@lostgradient/operative';

import { ProviderConfigurationError } from './provider-configuration-error.ts';

/** The price of a model, per million tokens. */
export type CatalogPricing = {
  /** The price of a million input tokens. */
  readonly inputPerMillionTokens: number;
  /** The price of a million output tokens. */
  readonly outputPerMillionTokens: number;
  /** The currency both prices are in, such as `USD`. */
  readonly currency: string;
};

/** One edit to the catalog. `provider` and `model` identify the row; every other field is optional. */
export type CatalogEdit = {
  /** The provider of the row: `anthropic`, `openai`, or `gemini`. */
  readonly provider: string;
  /** The row's `model` or one of its aliases; for an added row, the new model's name. */
  readonly model: string;
  /** `true` keeps the row from agents and plans: it stays listed as `unavailable`. */
  readonly off?: boolean;
  /** Replaces the row's price. */
  readonly pricing?: CatalogPricing;
  /** Replaces the row's context window. */
  readonly contextWindowTokens?: number;
  /** Replaces the row's output limit. */
  readonly maxOutputTokens?: number;
  /** An added row only: a current model of the same provider whose capabilities it copies. */
  readonly basedOn?: string;
};

const EDIT_FIELDS = [
  'provider',
  'model',
  'off',
  'pricing',
  'contextWindowTokens',
  'maxOutputTokens',
  'basedOn',
] as const;
const PRICING_FIELDS = ['inputPerMillionTokens', 'outputPerMillionTokens', 'currency'] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function problem(path: string, field: string, message: string): ProviderConfigurationError {
  return new ProviderConfigurationError(path, field, message);
}

function nonEmptyText(value: unknown, path: string, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw problem(path, field, 'expected a non-empty name.');
  }
  return value;
}

function positiveInteger(value: unknown, path: string, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw problem(path, field, 'expected a positive whole number.');
  }
  return value;
}

function nonNegativeNumber(value: unknown, path: string, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw problem(path, field, 'expected a number that is not negative.');
  }
  return value;
}

function parsePricing(value: unknown, path: string, field: string): CatalogPricing {
  if (!isPlainObject(value)) throw problem(path, field, 'expected an object.');
  for (const key of Object.keys(value)) {
    if (!(PRICING_FIELDS as readonly string[]).includes(key)) {
      throw problem(path, `${field}.${key}`, 'not a known field.');
    }
  }
  return {
    inputPerMillionTokens: nonNegativeNumber(
      value['inputPerMillionTokens'],
      path,
      `${field}.inputPerMillionTokens`,
    ),
    outputPerMillionTokens: nonNegativeNumber(
      value['outputPerMillionTokens'],
      path,
      `${field}.outputPerMillionTokens`,
    ),
    currency: nonEmptyText(value['currency'], path, `${field}.currency`),
  };
}

/**
 * Parse the `catalog` list of `configuration.json`. `providerNames` are the providers an edit may
 * name. Two edits for one provider and model are refused, so the list says one thing about a row.
 */
export function parseCatalogEdits(
  value: unknown,
  path: string,
  providerNames: readonly string[],
): readonly CatalogEdit[] {
  if (!Array.isArray(value)) throw problem(path, 'catalog', 'expected a list of edits.');
  const seen = new Set<string>();
  return value.map((entry: unknown, index): CatalogEdit => {
    const field = `catalog[${index}]`;
    if (!isPlainObject(entry)) throw problem(path, field, 'expected an object.');
    for (const key of Object.keys(entry)) {
      if (!(EDIT_FIELDS as readonly string[]).includes(key)) {
        throw problem(path, `${field}.${key}`, 'not a known field.');
      }
    }
    const provider = nonEmptyText(entry['provider'], path, `${field}.provider`);
    if (!providerNames.includes(provider)) {
      throw problem(
        path,
        `${field}.provider`,
        `not a provider. Expected ${providerNames.join(', ')}.`,
      );
    }
    const model = nonEmptyText(entry['model'], path, `${field}.model`);
    const identity = JSON.stringify([provider, model]);
    if (seen.has(identity)) {
      throw problem(path, `${field}.model`, 'a second edit for a model the list already edits.');
    }
    seen.add(identity);
    const edit: {
      -readonly [Key in keyof CatalogEdit]: CatalogEdit[Key];
    } = { provider, model };
    if (entry['off'] !== undefined) {
      if (typeof entry['off'] !== 'boolean')
        throw problem(path, `${field}.off`, 'expected true or false.');
      edit.off = entry['off'];
    }
    if (entry['pricing'] !== undefined) {
      edit.pricing = parsePricing(entry['pricing'], path, `${field}.pricing`);
    }
    if (entry['contextWindowTokens'] !== undefined) {
      edit.contextWindowTokens = positiveInteger(
        entry['contextWindowTokens'],
        path,
        `${field}.contextWindowTokens`,
      );
    }
    if (entry['maxOutputTokens'] !== undefined) {
      edit.maxOutputTokens = positiveInteger(
        entry['maxOutputTokens'],
        path,
        `${field}.maxOutputTokens`,
      );
    }
    if (entry['basedOn'] !== undefined) {
      edit.basedOn = nonEmptyText(entry['basedOn'], path, `${field}.basedOn`);
    }
    return edit;
  });
}

/** What {@link applyCatalogEdits} reads: the rows chosen so far and the provider's full built-in list. */
export type CatalogEditInput = {
  /** The edits, in the order the configuration lists them. */
  readonly edits: readonly CatalogEdit[];
  /** Where the configuration lives, named in every message about it. */
  readonly path: string;
  /** The rows the providers selected, in order. */
  readonly selected: readonly BackendDescriptor[];
  /** The providers that have a key, so an edit to any other provider's row has nothing to change. */
  readonly available: ReadonlySet<string>;
  /** The built-in rows of a provider that a name may match, retired ones excluded. */
  readonly candidates: (provider: string) => readonly BackendDescriptor[];
  /** Whether a row is named by a model or an alias. */
  readonly matches: (row: BackendDescriptor, name: string) => boolean;
};

function patched(row: BackendDescriptor, edit: CatalogEdit): BackendDescriptor {
  return {
    ...row,
    ...(edit.off === true ? { availability: 'unavailable' as const } : {}),
    ...(edit.pricing === undefined ? {} : { pricing: { ...edit.pricing } }),
    ...(edit.contextWindowTokens === undefined
      ? {}
      : { contextWindowTokens: edit.contextWindowTokens }),
    ...(edit.maxOutputTokens === undefined ? {} : { maxOutputTokens: edit.maxOutputTokens }),
  };
}

function assertLimits(row: BackendDescriptor, path: string, field: string): void {
  if (row.maxOutputTokens > row.contextWindowTokens) {
    throw problem(path, field, 'the output limit is larger than the context window.');
  }
}

/**
 * The selected rows with the edits applied. An edit to a built-in row replaces that row where it
 * stands, when the provider has a key and the provider's allowlist kept it. An added row is
 * appended after the others when its provider has a key. Every edit is checked either way, so a
 * stale edit fails before the provider's key appears.
 */
export function applyCatalogEdits(input: CatalogEditInput): BackendDescriptor[] {
  const rows = [...input.selected];
  input.edits.forEach((edit, index) => {
    const field = `catalog[${index}]`;
    const candidates = input.candidates(edit.provider);
    const builtIn = candidates.find((row) => input.matches(row, edit.model));
    if (builtIn !== undefined) {
      if (edit.basedOn !== undefined) {
        throw problem(
          input.path,
          `${field}.basedOn`,
          'only an added row names a base. This edit changes a built-in model.',
        );
      }
      const next = patched(builtIn, edit);
      assertLimits(next, input.path, `${field}.maxOutputTokens`);
      const position = rows.indexOf(builtIn);
      if (position !== -1) rows[position] = next;
      return;
    }
    if (edit.basedOn === undefined) {
      throw problem(
        input.path,
        `${field}.model`,
        `the edit matches no current ${edit.provider} model, so it needs "basedOn" to add one. Its value is not repeated here.`,
      );
    }
    const base = candidates.find((row) => input.matches(row, edit.basedOn ?? ''));
    if (base === undefined) {
      throw problem(
        input.path,
        `${field}.basedOn`,
        `the entry matches no current ${edit.provider} model.`,
      );
    }
    const added = patched(
      { ...base, model: edit.model, aliases: [], lifecycle: base.lifecycle },
      edit,
    );
    assertLimits(added, input.path, `${field}.maxOutputTokens`);
    if (input.available.has(edit.provider)) rows.push(added);
  });
  return rows;
}
