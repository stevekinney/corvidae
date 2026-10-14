/**
 * Turning a validated DTCG token document into a candidate draft state (COR-486). The
 * document is laid over the open theme's shared overrides: tokens at known public paths
 * override those tokens, and every other token is an unbound Source token that keeps its
 * source and emits no CSS. Applying never edits the Cinder base.
 */

import { buildThemeSources, validateThemeSources } from '@lostgradient/cinder/tokens/runtime';

import type { EditableState, JsonObject, ThemeEnvelope } from './theme-draft-types.ts';
import { forEachToken, isRegistryPath } from './theme-import-safety.ts';
import type { ImportFinding, PreflightFact } from './theme-import-types.ts';

const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isTokenNode = (node: JsonObject): boolean => '$value' in node || '$ref' in node;

/** Deep-merge `incoming` over `base`: groups merge, a token node is replaced whole. */
export function mergeTrees(base: JsonObject, incoming: JsonObject): JsonObject {
  const merged: JsonObject = { ...base };
  for (const [key, value] of Object.entries(incoming)) {
    const existing = merged[key];
    merged[key] =
      isObject(existing) && isObject(value) && !isTokenNode(existing) && !isTokenNode(value)
        ? mergeTrees(existing, value)
        : value;
  }
  return merged;
}

/** The document without its `$schema` pointer, which names the format and is not token data. */
export function overlayTree(document: JsonObject): JsonObject {
  const { $schema: _schema, ...rest } = document;
  return rest;
}

export type OverlayCensus = {
  targets: number;
  sourceTokens: number;
  references: number;
  extensions: number;
};

/** What the document contains, for the preflight summary. */
export function censusOf(tree: JsonObject): OverlayCensus {
  const census: OverlayCensus = { targets: 0, sourceTokens: 0, references: 0, extensions: 0 };
  forEachToken(tree, (path, node) => {
    if (isRegistryPath(path)) census.targets += 1;
    else census.sourceTokens += 1;
    if (isObject(node['$extensions'])) census.extensions += 1;
    if ('$ref' in node || JSON.stringify(node['$value'] ?? null).includes('"{')) {
      census.references += 1;
    }
  });
  return census;
}

export function censusFacts(census: OverlayCensus): PreflightFact[] {
  return [
    { label: 'Known Cinder tokens', value: String(census.targets) },
    {
      label: 'Source tokens (kept, no CSS)',
      value: String(census.sourceTokens),
    },
    { label: 'Tokens with references', value: String(census.references) },
    { label: 'Tokens with extensions (kept inert)', value: String(census.extensions) },
  ];
}

export type Overlay =
  | { ok: true; state: EditableState; envelope: ThemeEnvelope }
  | { ok: false; findings: ImportFinding[] };

/** Lay a document over the open theme and let the runtime validate every context. */
export function overlayDocument(current: ThemeEnvelope, document: JsonObject): Overlay {
  const state: EditableState = {
    overrides: {
      ...current.overrides,
      shared: mergeTrees(current.overrides.shared, overlayTree(document)),
    },
    cssOverrides: current.cssOverrides,
  };
  const envelope: ThemeEnvelope = { ...current, ...state };
  const findings = runtimeFindings(envelope);
  return findings.length > 0 ? { ok: false, findings } : { ok: true, state, envelope };
}

/** The runtime's diagnostics for a candidate, as path-addressed findings. */
export function runtimeFindings(envelope: ThemeEnvelope): ImportFinding[] {
  const { diagnostics } = validateThemeSources(buildThemeSources(envelope, 0));
  return diagnostics.map((diagnostic) => ({
    code: /reference|not found|unresolved|cycle/i.test(diagnostic.reason)
      ? ('unresolved-reference' as const)
      : ('invalid-source' as const),
    path: diagnostic.path,
    message:
      diagnostic.context === undefined
        ? diagnostic.reason
        : `${diagnostic.reason} (${diagnostic.context})`,
  }));
}
