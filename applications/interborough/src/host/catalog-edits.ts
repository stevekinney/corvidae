/**
 * The catalog edits in `configuration.json`: a person turns a model off, corrects its price or
 * limits, or adds a row the built-in list lacks. They sit beside `plugins`:
 *
 * ```json
 * {
 *   "plugins": { "openai": { "configuration": { "models": ["gpt-4.1"] } } },
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
 * copies, and may set its own price and limits. A built-in row is edited once, whatever name
 * the edits use for it. A price edit keeps the row's long-context rates unless it names them. A message about an edit names the field, never a
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
  /**
   * The rates for a request whose input is long. Left out, the row keeps the rates it has, so a
   * price edit never drops them; an object replaces them; `null` removes them.
   */
  readonly longContext?: CatalogLongContextPricing | null;
};

/** The rates that replace the two prices for a request whose input exceeds `inputTokensAbove` tokens. */
export type CatalogLongContextPricing = {
  /** The input size above which these rates apply. */
  readonly inputTokensAbove: number;
  /** The price of a million input tokens at that size. */
  readonly inputPerMillionTokens: number;
  /** The price of a million output tokens at that size. */
  readonly outputPerMillionTokens: number;
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
const PRICING_FIELDS = [
  'inputPerMillionTokens',
  'outputPerMillionTokens',
  'currency',
  'longContext',
] as const;
const LONG_CONTEXT_FIELDS = [
  'inputTokensAbove',
  'inputPerMillionTokens',
  'outputPerMillionTokens',
] as const;

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

function parseLongContext(value: unknown, path: string, field: string): CatalogLongContextPricing {
  if (!isPlainObject(value))
    throw problem(path, field, 'expected an object, or null to remove it.');
  for (const key of Object.keys(value)) {
    if (!(LONG_CONTEXT_FIELDS as readonly string[]).includes(key)) {
      throw problem(path, `${field}.${key}`, 'not a known field.');
    }
  }
  return {
    inputTokensAbove: positiveInteger(value['inputTokensAbove'], path, `${field}.inputTokensAbove`),
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
  };
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
    ...(value['longContext'] === undefined
      ? {}
      : {
          longContext:
            value['longContext'] === null
              ? null
              : parseLongContext(value['longContext'], path, `${field}.longContext`),
        }),
  };
}

/**
 * Parse the `catalog` list of `configuration.json`. `providerNames`, when given, are the providers an
 * edit may name. Two edits for one provider and model are refused, so the list says one thing about a row.
 */
export function parseCatalogEdits(
  value: unknown,
  path: string,
  providerNames?: readonly string[],
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
    if (providerNames !== undefined && !providerNames.includes(provider)) {
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
  /**
   * Whether the provider's allowlist keeps the added row `model`. An added row has no alias, so
   * the allowlist names it by its model. Defaults to keeping every added row.
   */
  readonly keepsAdded?: (provider: string, model: string) => boolean;
};

/** The row's price with the edit's rates over it; the long-context rates stay unless the edit names them. */
function patchedPricing(
  row: BackendDescriptor,
  edit: CatalogPricing,
): BackendDescriptor['pricing'] {
  const { longContext: editedLongContext, ...rates } = edit;
  const { longContext: keptLongContext, ...kept } = row.pricing ?? {};
  const longContext = editedLongContext === undefined ? keptLongContext : editedLongContext;
  return {
    ...kept,
    ...rates,
    ...(longContext === null || longContext === undefined
      ? {}
      : { longContext: { ...longContext } }),
  };
}

function patched(row: BackendDescriptor, edit: CatalogEdit): BackendDescriptor {
  return {
    ...row,
    ...(edit.off === true ? { availability: 'unavailable' as const } : {}),
    ...(edit.pricing === undefined ? {} : { pricing: patchedPricing(row, edit.pricing) }),
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
 * appended after the others when its provider has a key and its allowlist, if it has one, names it. Every edit is checked either way, so a
 * stale edit fails before the provider's key appears.
 */
export function applyCatalogEdits(input: CatalogEditInput): BackendDescriptor[] {
  const rows = [...input.selected];
  // The built-in rows already edited, by provider and model, whatever name the edit used. Two
  // names for one row (`claude-haiku-4-5` and `haiku`) would otherwise pass for two rows.
  const edited = new Set<string>();
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
      const identity = JSON.stringify([builtIn.provider, builtIn.model]);
      if (edited.has(identity)) {
        throw problem(
          input.path,
          `${field}.model`,
          'a second edit for a model an earlier edit already names, under another name.',
        );
      }
      edited.add(identity);
      const next = patched(builtIn, edit);
      assertLimits(next, input.path, `${field}.maxOutputTokens`);
      // Found by provider and model, because an earlier edit may have replaced the row. A row
      // that is not there was left out: its provider has no key, or the allowlist excludes it.
      const position = rows.findIndex(
        (row) => row.provider === builtIn.provider && row.model === builtIn.model,
      );
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
    if (
      input.available.has(edit.provider) &&
      (input.keepsAdded?.(edit.provider, edit.model) ?? true)
    ) {
      rows.push(added);
    }
  });
  return rows;
}
