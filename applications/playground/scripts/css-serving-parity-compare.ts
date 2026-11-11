/**
 * The comparison half of `css-serving-parity.ts`: pure functions over recorded stylesheets, so the
 * rules for "equal" are unit-tested without starting a server.
 *
 * A record holds, per serving mode, every stylesheet a browser would fetch (by URL) and its bytes.
 * Two records are equal when:
 *
 * - every **leaf** stylesheet (no `@import`, not a bundled output) is byte-identical at the same
 *   URL, and
 * - every **aggregator** (a stylesheet with `@import`s) and every **bundled output**
 *   (`/playground-styles/*`) has the same flattened content, computed with `css-fingerprint.ts`'s
 *   flattening, and an aggregator leads to the same set of leaf URLs.
 *
 * A specifier-only rewrite of an aggregator (`./x.css` to `/styles/x.css`, or the static export's
 * `/assets/<digest>/` prefix) changes neither the flattened content nor the leaf set, so it passes.
 */

import {
  flattenStylesheet,
  ruleLines,
  ruleMultiset,
  serializeFlattened,
  type FlattenedStylesheet,
  type ImportResolver,
} from '../../../components/cinder/scripts/css-fingerprint.ts';

/** The two ways the playground serves a stylesheet. */
export type ServingMode = 'dev' | 'static';

export const SERVING_MODES: readonly ServingMode[] = ['dev', 'static'];

/** Every stylesheet one serving mode exposes. */
export type StylesheetRecord = {
  /** The stylesheets pages link, plus the target of the `/styles.css` redirect, by URL. */
  entries: string[];
  /** Every stylesheet a browser would fetch, by URL, with its text. */
  files: Map<string, string>;
  /** URLs that were requested and could not be read (the mode does not serve them). */
  missing: string[];
};

export type ParityRecord = Record<ServingMode, StylesheetRecord>;

/** Rule-level difference between two versions of one stylesheet. */
export type RuleDifference = {
  removed: string[];
  added: string[];
  /** The same rules, in a different cascade order. */
  reordered: boolean;
};

export type Difference =
  | { mode: ServingMode; url: string; kind: 'url-removed' | 'url-added' }
  | { mode: ServingMode; url: string; kind: 'leaf-bytes'; rules: RuleDifference }
  | { mode: ServingMode; url: string; kind: 'bundled-output'; rules: RuleDifference }
  | { mode: ServingMode; url: string; kind: 'aggregator-content'; rules: RuleDifference }
  | {
      mode: ServingMode;
      url: string;
      kind: 'aggregator-leaves';
      removedLeaves: string[];
      addedLeaves: string[];
    };

const ORIGIN = 'https://parity.local';

/** A static export prefixes every asset with `/assets/<sha256>/`; the prefix is not the stylesheet's identity. */
const STATIC_ASSET_PREFIX = /^\/assets\/[0-9a-f]{64}(?=\/)/;

/** The URL a stylesheet is recorded under: the path alone, without a query or a static-export prefix. */
export function normalizeStylesheetUrl(url: string): string {
  return new URL(url, ORIGIN).pathname.replace(STATIC_ASSET_PREFIX, '');
}

/** Resolves an `@import` against the importing URL, within one record's files. */
export function recordResolver(files: ReadonlyMap<string, string>): ImportResolver {
  return (specifier, importerUrl) => {
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(specifier)) return undefined;
    const url = normalizeStylesheetUrl(new URL(specifier, `${ORIGIN}${importerUrl}`).pathname);
    const source = files.get(url);
    return source === undefined ? undefined : { id: url, source };
  };
}

function flatten(url: string, files: ReadonlyMap<string, string>): FlattenedStylesheet {
  return flattenStylesheet({ id: url, source: files.get(url) ?? '' }, recordResolver(files));
}

/** Whether `url` is a stylesheet the playground bundles itself rather than serves from a file. */
export function isBundledOutput(url: string): boolean {
  return url.startsWith('/playground-styles/');
}

function subtract(from: readonly string[], remove: readonly string[]): string[] {
  const counts = new Map<string, number>();
  for (const line of remove) counts.set(line, (counts.get(line) ?? 0) + 1);
  const kept: string[] = [];
  for (const line of from) {
    const remaining = counts.get(line) ?? 0;
    if (remaining > 0) counts.set(line, remaining - 1);
    else kept.push(line);
  }
  return kept;
}

function ruleDifference(before: FlattenedStylesheet, after: FlattenedStylesheet): RuleDifference {
  const beforeRules = ruleMultiset(before.nodes);
  const afterRules = ruleMultiset(after.nodes);
  const removed = subtract(beforeRules, afterRules);
  const added = subtract(afterRules, beforeRules);
  const reordered =
    removed.length === 0 &&
    added.length === 0 &&
    ruleLines(before.nodes).join('\n') !== ruleLines(after.nodes).join('\n');
  return { removed, added, reordered };
}

function compareUrl(
  mode: ServingMode,
  url: string,
  before: StylesheetRecord,
  after: StylesheetRecord,
): Difference[] {
  const beforeFlat = flatten(url, before.files);
  const afterFlat = flatten(url, after.files);
  const aggregator = (flat: FlattenedStylesheet): boolean => !flat.leaves.includes(url);
  const sameContent = serializeFlattened(beforeFlat.nodes) === serializeFlattened(afterFlat.nodes);

  if (isBundledOutput(url)) {
    return sameContent
      ? []
      : [{ mode, url, kind: 'bundled-output', rules: ruleDifference(beforeFlat, afterFlat) }];
  }
  if (aggregator(beforeFlat) || aggregator(afterFlat)) {
    const differences: Difference[] = [];
    if (!sameContent) {
      differences.push({
        mode,
        url,
        kind: 'aggregator-content',
        rules: ruleDifference(beforeFlat, afterFlat),
      });
    }
    const removedLeaves = beforeFlat.leaves.filter((leaf) => !afterFlat.leaves.includes(leaf));
    const addedLeaves = afterFlat.leaves.filter((leaf) => !beforeFlat.leaves.includes(leaf));
    if (removedLeaves.length > 0 || addedLeaves.length > 0) {
      differences.push({ mode, url, kind: 'aggregator-leaves', removedLeaves, addedLeaves });
    }
    return differences;
  }
  return before.files.get(url) === after.files.get(url)
    ? []
    : [{ mode, url, kind: 'leaf-bytes', rules: ruleDifference(beforeFlat, afterFlat) }];
}

/** Every difference between two records of one serving mode; none means the modes serve equal CSS. */
export function compareStylesheetRecords(
  mode: ServingMode,
  before: StylesheetRecord,
  after: StylesheetRecord,
): Difference[] {
  const urls = [...new Set([...before.files.keys(), ...after.files.keys()])].toSorted();
  return urls.flatMap((url): Difference[] => {
    if (!after.files.has(url)) return [{ mode, url, kind: 'url-removed' }];
    if (!before.files.has(url)) return [{ mode, url, kind: 'url-added' }];
    return compareUrl(mode, url, before, after);
  });
}

/** Every difference between two records, across both serving modes. */
export function compareRecords(before: ParityRecord, after: ParityRecord): Difference[] {
  return SERVING_MODES.flatMap((mode) => compareStylesheetRecords(mode, before[mode], after[mode]));
}

function describeRules(rules: RuleDifference): string[] {
  return [
    ...rules.removed.map((line) => `      - ${line}`),
    ...rules.added.map((line) => `      + ${line}`),
    ...(rules.reordered ? ['      (same rules, different cascade order)'] : []),
  ];
}

/** A readable report of the differences, grouped by mode; empty text when there are none. */
export function formatDifferences(differences: readonly Difference[]): string {
  const lines: string[] = [];
  for (const difference of differences) {
    lines.push(`[${difference.mode}] ${difference.kind} ${difference.url}`);
    if ('rules' in difference) lines.push(...describeRules(difference.rules));
    if (difference.kind === 'aggregator-leaves') {
      lines.push(...difference.removedLeaves.map((leaf) => `      - leaf ${leaf}`));
      lines.push(...difference.addedLeaves.map((leaf) => `      + leaf ${leaf}`));
    }
  }
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
}
