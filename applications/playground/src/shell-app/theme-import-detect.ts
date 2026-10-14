/**
 * Recognizing foreign shapes for diagnosis only (COR-486, R5). A recognized shape is reported
 * as an unsupported profile with what was seen; it is never called invalid DTCG, never
 * converted, and no document it references is fetched. Recognition makes no brand or
 * standards claim: it names the structure that was inspected.
 */

import type { JsonObject } from './theme-draft-types.ts';

const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export type Recognition = {
  profile: 'resolver' | 'acronis' | 'spectrum' | 'json5' | 'dtcg-dialect';
  headline: string;
  detail: string;
  axes: string[];
  unsupported: string[];
};

/** Visit every object in a parsed value, iteratively. */
function someObject(value: unknown, test: (node: JsonObject) => boolean): boolean {
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const node = stack.pop();
    if (Array.isArray(node)) stack.push(...node);
    else if (isObject(node)) {
      if (test(node)) return true;
      stack.push(...Object.values(node));
    }
  }
  return false;
}

/** A DTCG 2025.10 resolver document: `resolutionOrder`, with sets and modifiers. */
export function recognizeResolver(value: unknown): Recognition | null {
  if (!isObject(value) || !Array.isArray(value['resolutionOrder'])) return null;
  const modifiers = isObject(value['modifiers']) ? Object.keys(value['modifiers']) : [];
  const sets = isObject(value['sets']) ? Object.keys(value['sets']) : [];
  const unsupported = [
    'A standalone resolver. The builder reads a resolver only inside a Cinder Theme v1 envelope.',
  ];
  const extra = modifiers.filter((name) => name !== 'theme' && name !== 'motion');
  if (extra.length > 0) {
    unsupported.push(`Axes outside the Cinder profile: ${extra.join(', ')}.`);
  }
  if (typeof value['version'] === 'string')
    unsupported.push(`Resolver version ${value['version']}.`);
  unsupported.push(`Resolution order with ${value['resolutionOrder'].length} entries.`);
  if (sets.length > 0) unsupported.push(`Sets: ${sets.join(', ')}.`);
  return {
    profile: 'resolver',
    headline: 'Recognized a DTCG resolver document, which is an unsupported profile',
    detail:
      'This looks like a resolver (version, sets, modifiers and resolutionOrder). It is valid structure, not an error. The Cinder profile has exactly the theme and motion axes, and a resolver arrives only inside a Cinder Theme v1 envelope. Nothing it references was fetched, no default was chosen, and nothing was flattened.',
    axes: modifiers,
    unsupported,
  };
}

/** Acronis-style records: a token with `values` and `platforms`. */
export function recognizeAcronis(value: unknown): Recognition | null {
  if (!someObject(value, (node) => 'values' in node && 'platforms' in node)) return null;
  return {
    profile: 'acronis',
    headline: 'Recognized records with values and platforms, an unsupported profile',
    detail:
      'Tokens here carry a values map and a platforms list. That is a different structure from a DTCG token with a $value, so it is not imported or converted. Download the file unchanged to keep it.',
    axes: ['platforms'],
    unsupported: ['Per-token values maps.', 'Per-token platforms lists.'],
  };
}

const SPECTRUM_SCHEMA = /spectrum-tokens|token-types\/(?:alias|color-set|scale-set|system-set)/i;

/** Spectrum-style cascade records: a token whose `sets` map holds per-set values. */
export function recognizeSpectrum(value: unknown): Recognition | null {
  const found = someObject(value, (node) => {
    const sets = node['sets'];
    if (
      isObject(sets) &&
      Object.values(sets).some((entry) => isObject(entry) && 'value' in entry)
    ) {
      return true;
    }
    return typeof node['$schema'] === 'string' && SPECTRUM_SCHEMA.test(node['$schema']);
  });
  if (!found) return null;
  const setNames = new Set<string>();
  someObject(value, (node) => {
    if (isObject(node['sets'])) Object.keys(node['sets']).forEach((name) => setNames.add(name));
    return false;
  });
  return {
    profile: 'spectrum',
    headline: 'Recognized cascade records with per-set values, an unsupported profile',
    detail:
      'Tokens here resolve through named sets (a cascade) instead of a DTCG resolver. That is not a Cinder axis, so nothing was chosen on your behalf and nothing was flattened. Download the file unchanged to keep it.',
    axes: [...setNames],
    unsupported: ['Cascade sets on individual tokens.'],
  };
}

/** Text that is not strict JSON but looks like JSON5: comments, trailing commas, quotes, bare keys. */
export function recognizeJson5(text: string): Recognition | null {
  const signs: string[] = [];
  if (/(^|\s)\/\/.*$/m.test(text) || /\/\*[\s\S]*?\*\//.test(text)) signs.push('comments');
  if (/,\s*[}\]]/.test(text)) signs.push('trailing commas');
  if (/(^|[{,\s])'[^'\n]*'\s*:/.test(text)) signs.push('single-quoted keys');
  if (/[{,]\s*[A-Za-z_$][\w$]*\s*:/.test(text)) signs.push('unquoted keys');
  if (signs.length === 0) return null;
  return {
    profile: 'json5',
    headline: 'Recognized JSON5-style syntax, an unsupported profile',
    detail: `The file is not strict JSON, and it uses ${signs.join(', ')}. Imports are read as strict JSON only and never evaluated as code. Remove the extra syntax, or download the file unchanged.`,
    axes: [],
    unsupported: signs.map((sign) => `JSON5 ${sign}.`),
  };
}

const FORMAT_SCHEMA = /^https:\/\/www\.designtokens\.org\/schemas\/2025\.10\/format\.json$/;

/** A `$schema` that names a different DTCG draft than the one the builder validates against. */
export function recognizeSchemaDialect(value: unknown): Recognition | null {
  if (!isObject(value)) return null;
  const schema = value['$schema'];
  if (typeof schema !== 'string' || FORMAT_SCHEMA.test(schema)) return null;
  return {
    profile: 'dtcg-dialect',
    headline: 'Recognized a different token schema, an unsupported profile',
    detail: `The document names the schema ${schema}. The builder validates only the DTCG 2025.10 format, so this is not imported and is not called invalid. The schema URL was not fetched.`,
    axes: [],
    unsupported: [`Schema ${schema}.`],
  };
}

/** The first recognized shape of a strictly parsed value, or `null`. */
export function recognizeParsed(value: unknown): Recognition | null {
  return (
    recognizeResolver(value) ??
    recognizeAcronis(value) ??
    recognizeSpectrum(value) ??
    recognizeSchemaDialect(value)
  );
}
