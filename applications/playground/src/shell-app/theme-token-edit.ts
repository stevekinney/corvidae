/**
 * The pure rules of the generic token value editor (COR-490, COR-261): which override scope an
 * edit targets, how the `$value` text becomes a DTCG source node, what the field shows for the
 * current override or the shipped literal, and how an alias or recipe is replaced with a
 * literal. The typed editors that replace the field per type (COR-489, COR-263, COR-488) reuse
 * these rules.
 */

import { profileRangeViolation } from '@lostgradient/cinder/tokens/runtime';

import type { CatalogueRow } from './theme-builder-catalogue.ts';
import {
  contextId,
  type JsonObject,
  type JsonValue,
  type OverrideScope,
  type ThemeEnvelope,
} from './theme-draft-types.ts';
import type { DraftEdit } from './theme-draft.ts';
import { getNode } from './theme-override-tree.ts';
import type { ThemePreviewContext } from './theme-preview-message.ts';
import { themePreviewValueProblem } from './theme-preview-message.ts';
import { buildThemeSources } from './theme-runtime-evaluator.ts';

export type EditScope = 'shared' | 'color-mode' | 'motion-mode';

export const SCOPE_LABELS: Record<EditScope, string> = {
  shared: 'Shared (all modes)',
  'color-mode': 'Current color mode',
  'motion-mode': 'Current motion mode',
};

/** Theme-aware tokens default to the color mode; everything else is shared. */
export function defaultScope(row: CatalogueRow): EditScope {
  return row.themeAware ? 'color-mode' : 'shared';
}

/** The override document an edit scope writes in the given context, or `null`. */
export function overrideScopeFor(
  scope: EditScope,
  context: ThemePreviewContext,
): OverrideScope | null {
  if (scope === 'shared') return 'shared';
  if (scope === 'color-mode') return context.colorMode;
  if (context.motion === 'reduced') return 'reduced';
  return context.motion === 'forced-reduced-motion' ? 'forcedReduced' : null;
}

export function scopeOptions(
  context: ThemePreviewContext,
): Array<{ value: EditScope; label: string; disabled: boolean }> {
  const colorLabel = `${SCOPE_LABELS['color-mode']} (${context.colorMode})`;
  const motionLabel =
    context.motion === 'default'
      ? `${SCOPE_LABELS['motion-mode']} (default motion has no overrides)`
      : `${SCOPE_LABELS['motion-mode']} (${context.motion})`;
  return [
    { value: 'shared', label: SCOPE_LABELS.shared, disabled: false },
    { value: 'color-mode', label: colorLabel, disabled: false },
    { value: 'motion-mode', label: motionLabel, disabled: context.motion === 'default' },
  ];
}

// --- value text -------------------------------------------------------------------------

const ALIAS_TEXT = /^\{[^{}"]+\}$/;

export const isAliasValue = (value: JsonValue | undefined): value is string =>
  typeof value === 'string' && ALIAS_TEXT.test(value);

/** The field text for a `$value`: strings verbatim, structures as compact JSON. */
export function valueToText(value: JsonValue): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

export type ParsedValue = { ok: true; value: JsonValue } | { ok: false; message: string };

/**
 * Field text to a `$value`. An alias (`{a.b}`) is a string; text that starts like JSON
 * (`{`, `[`, `"`) must parse; a number or boolean parses as itself; anything else is a
 * string, such as a color name.
 */
export function parseValueText(text: string): ParsedValue {
  const trimmed = text.trim();
  if (trimmed === '') return { ok: false, message: 'Enter a value.' };
  if (ALIAS_TEXT.test(trimmed)) return { ok: true, value: trimmed };
  if (/^[{["]/.test(trimmed)) {
    try {
      return { ok: true, value: JSON.parse(trimmed) as JsonValue };
    } catch {
      return {
        ok: false,
        message: 'Not valid JSON. Write the value as DTCG, for example {"value": 4, "unit": "px"}.',
      };
    }
  }
  if (/^(-?\d+(\.\d+)?([eE][+-]?\d+)?|true|false|null)$/.test(trimmed)) {
    return { ok: true, value: JSON.parse(trimmed) as JsonValue };
  }
  return { ok: true, value: trimmed };
}

// --- reading the current literal ----------------------------------------------------------

type ResolverShape = {
  sets: Record<string, { sources: Array<{ $ref: string }> }>;
  modifiers: Record<string, { contexts: Record<string, Array<{ $ref: string }>> }>;
  resolutionOrder: Array<{ $ref: string }>;
};

/** The documents of one context, lowest precedence first. */
function layerDocuments(envelope: ThemeEnvelope, context: ThemePreviewContext): JsonObject[] {
  const sources = buildThemeSources(envelope, 0);
  const resolver = sources.resolver as ResolverShape;
  const values: Record<string, string> = { theme: context.colorMode, motion: context.motion };
  const documents = sources.documents as Record<string, JsonObject>;
  const refs: string[] = [];
  for (const { $ref } of resolver.resolutionOrder) {
    const [, kind, name] = $ref.split('/');
    if (name === undefined) continue;
    const list =
      kind === 'sets'
        ? resolver.sets[name]?.sources
        : resolver.modifiers[name]?.contexts[values[name] ?? ''];
    for (const source of list ?? []) refs.push(source.$ref);
  }
  return refs.flatMap((ref) => (documents[ref] === undefined ? [] : [documents[ref]]));
}

/**
 * The literal `$value` a token resolves to in a context, following alias chains through the
 * merged documents. Used to seed "Replace with literal" and to show the shipped literal.
 */
export function literalValueOf(
  envelope: ThemeEnvelope,
  context: ThemePreviewContext,
  path: string,
): JsonValue | undefined {
  const documents = layerDocuments(envelope, context);
  let current = path;
  for (let hops = 0; hops < 12; hops += 1) {
    let value: JsonValue | undefined;
    for (const document of documents) {
      const node = getNode(document, current);
      if (typeof node === 'object' && node !== null && !Array.isArray(node) && '$value' in node) {
        value = node['$value'];
      }
    }
    if (!isAliasValue(value)) return value;
    current = value.slice(1, -1);
  }
  return undefined;
}

/** The `$value` text the field starts with for one scope of one token. */
export function initialValueText(
  row: CatalogueRow,
  envelope: ThemeEnvelope,
  context: ThemePreviewContext,
  scope: OverrideScope | null,
): string {
  if (row.edit === 'css-only') {
    return envelope.cssOverrides[row.path]?.[contextId(context)] ?? row.shippedCssValue ?? '';
  }
  const overridden = scope === null ? undefined : overrideValue(envelope, scope, row.path);
  if (overridden !== undefined) return valueToText(overridden);
  const literal = literalValueOf(envelope, context, row.path);
  return literal === undefined ? '' : valueToText(literal);
}

export function overrideValue(
  envelope: ThemeEnvelope,
  scope: OverrideScope,
  path: string,
): JsonValue | undefined {
  const node = getNode(envelope.overrides[scope], path);
  return typeof node === 'object' && node !== null && !Array.isArray(node)
    ? node['$value']
    : undefined;
}

export type EditorMode = 'literal' | 'alias' | 'recipe' | 'css-only';

/** What kind of value the token has in the draft, which decides how it is edited. */
export function editorMode(
  row: CatalogueRow,
  envelope: ThemeEnvelope,
  scope: OverrideScope | null,
): EditorMode {
  if (row.edit === 'css-only') return 'css-only';
  const overridden = scope === null ? undefined : overrideValue(envelope, scope, row.path);
  if (overridden !== undefined) return isAliasValue(overridden) ? 'alias' : 'literal';
  if (row.aliases.length > 0) return 'alias';
  return row.edit === 'recipe' ? 'recipe' : 'literal';
}

// --- building the edit --------------------------------------------------------------------

/** The usage contract's numeric range for a literal, or `undefined` when it holds. */
export function usageViolation(row: CatalogueRow, value: JsonValue): string | undefined {
  const range = row.profile?.range;
  if (row.profile === undefined || range === undefined || isAliasValue(value)) return undefined;
  const part =
    range.part === 'dimension.value' || range.part === 'duration.value'
      ? typeof value === 'object' && value !== null && !Array.isArray(value)
        ? value['value']
        : undefined
      : value;
  if (typeof part !== 'number' && typeof part !== 'string') return undefined;
  const problem = profileRangeViolation(row.profile, part);
  return problem === undefined ? undefined : `${row.path} ${problem}.`;
}

export type BuiltEdit = { ok: true; edit: DraftEdit } | { ok: false; message: string };

/**
 * The draft edit for `text` applied to a token. A literal keeps the metadata of the override
 * already there and always states its `$type`, so an override does not depend on the type
 * another document supplies. A CSS-only token edits `cssOverrides` and never a fake `$value`.
 */
export function buildEdit(
  row: CatalogueRow,
  envelope: ThemeEnvelope,
  context: ThemePreviewContext,
  scope: OverrideScope | null,
  text: string,
): BuiltEdit {
  if (row.edit === 'css-only') {
    const problem = themePreviewValueProblem(text.trim());
    if (problem !== null) return { ok: false, message: `Not a plain CSS value: ${problem}.` };
    return {
      ok: true,
      edit: {
        kind: 'set-css-override',
        path: row.path,
        context: contextId(context),
        value: text.trim(),
      },
    };
  }
  if (scope === null) return { ok: false, message: 'Default motion has no overrides to edit.' };
  const parsed = parseValueText(text);
  if (!parsed.ok) return parsed;
  const violation = usageViolation(row, parsed.value);
  if (violation !== undefined) return { ok: false, message: violation };
  const existing = getNode(envelope.overrides[scope], row.path);
  const base: JsonObject =
    typeof existing === 'object' && existing !== null && !Array.isArray(existing) ? existing : {};
  const node: JsonObject = {
    ...base,
    ...(row.type === 'unknown' || '$type' in base ? {} : { $type: row.type }),
    $value: parsed.value,
  };
  return { ok: true, edit: { kind: 'set-override', scope, path: row.path, node } };
}
