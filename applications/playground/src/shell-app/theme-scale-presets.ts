/**
 * Scale presets for spacing and radius (COR-489, R5). A preset is a multiplier proposal over a
 * Cinder scale: it reads the immutable embedded base's literal values, multiplies each member,
 * and offers the result as ordinary source overrides in the chosen scope. Nothing here is a
 * density modifier; applying a proposal is one `replace` transaction and never edits the base.
 *
 * Membership comes from the catalogue's explicit `scale` metadata. Units, zeros and aliases
 * are preserved: only literal members are written, and every alias or recipe that reads a
 * member is listed as an affected dependent, never silently detached. Locked members cannot be
 * selected, and an existing explicit override is replaced only when its row is selected.
 */

import { AUTHORING_CATALOGUE } from '@lostgradient/cinder/tokens/runtime';

import { catalogueRowByPath, catalogueRows } from './theme-builder-catalogue.ts';
import {
  contextId,
  editableState,
  emptyOverrides,
  type EditableState,
  type JsonObject,
  type JsonValue,
  type OverrideScope,
  type ThemeContextId,
  type ThemeEnvelope,
} from './theme-draft-types.ts';
import { getNode, jsonEquals, setNode } from './theme-override-tree.ts';
import type { ThemePreviewContext } from './theme-preview-message.ts';
import { buildThemeSources } from './theme-runtime-evaluator.ts';
import { isAliasValue, literalValueOf, overrideValue, sourcePathOf } from './theme-token-edit.ts';

export type ScalePresetId = 'compact' | 'standard' | 'comfortable';

export const SCALE_PRESETS: readonly { id: ScalePresetId; label: string; factor: number }[] = [
  { id: 'compact', label: 'Compact', factor: 0.75 },
  { id: 'standard', label: 'Standard', factor: 1 },
  { id: 'comfortable', label: 'Comfortable', factor: 1.25 },
];

export const MAX_MULTIPLIER = 4;

/** The scales a preset can adjust, with the label of the control group. */
export const PRESET_SCALES: readonly { scale: string; label: string }[] = [
  { scale: 'spacing', label: 'Spacing' },
  { scale: 'radius', label: 'Radius' },
];

export const scaleMembers = (scale: string): readonly string[] =>
  AUTHORING_CATALOGUE.scales[scale] ?? [];

/** A multiplier is a finite number from 0 to 4; anything else is named, never clamped. */
export function parseMultiplier(
  text: string,
): { ok: true; factor: number } | { ok: false; message: string } {
  const trimmed = text.trim();
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(trimmed)) {
    return { ok: false, message: 'Enter a number from 0 to 4.' };
  }
  const factor = Number(trimmed);
  if (!Number.isFinite(factor) || factor < 0 || factor > MAX_MULTIPLIER) {
    return { ok: false, message: `A multiplier is a finite number from 0 to ${MAX_MULTIPLIER}.` };
  }
  return { ok: true, factor };
}

export type Dimension = { value: number; unit: string };
export type RowStatus = 'new' | 'overridden' | 'applied' | 'locked';

export type ProposalRow = {
  path: string;
  name: string;
  cssProperty: string;
  base: Dimension;
  proposed: Dimension;
  status: RowStatus;
  /** The explicit override at the proposal's scope, when there is one. */
  existing: JsonValue | undefined;
  /** Later layers of the active context that keep overriding this member. */
  laterLayers: readonly OverrideScope[];
  selectable: boolean;
  /** Rows that need no decision start selected: no override to replace, not locked. */
  selectedByDefault: boolean;
};

export type SkippedMember = { path: string; kind: 'alias' | 'recipe' };

export type Proposal = {
  scale: string;
  factor: number;
  presetId: ScalePresetId | null;
  scope: OverrideScope;
  context: ThemeContextId;
  baseDigest: string;
  draftRevision: number;
  rows: readonly ProposalRow[];
  /** Aliases and recipes that read a member and follow it; they are never written. */
  dependents: { aliases: readonly string[]; recipes: readonly string[] };
  /** Aliases and recipes inside the scale's group that are not literal members. */
  skipped: readonly SkippedMember[];
};

const round = (value: number): number => Number((value * 1_000_000).toFixed(0)) / 1_000_000;

export function scaleDimension(base: Dimension, factor: number): Dimension {
  return { value: round(base.value * factor), unit: base.unit };
}

function isDimension(value: JsonValue | undefined): value is { value: number; unit: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    typeof value['value'] === 'number' &&
    typeof value['unit'] === 'string'
  );
}

const dimensionValue = (dimension: Dimension): JsonObject => ({
  value: dimension.value,
  unit: dimension.unit,
});

/** The envelope with every override removed: what the embedded base alone says. */
const baselineOf = (envelope: ThemeEnvelope): ThemeEnvelope => {
  const { locked: _locked, ...rest } = envelope;
  return { ...rest, overrides: emptyOverrides(), cssOverrides: {} };
};

/**
 * A member's literal in the base for a scope. The shared scope reads the base set sources
 * alone; a color-mode or motion scope reads the base layers of the active context, in the
 * resolver's own precedence.
 */
export function baseDimension(
  envelope: ThemeEnvelope,
  scope: OverrideScope,
  context: ThemePreviewContext,
  path: string,
): Dimension | undefined {
  const baseline = baselineOf(envelope);
  if (scope !== 'shared') {
    const value = literalValueOf(baseline, context, path);
    return isDimension(value) ? { value: value.value, unit: value.unit } : undefined;
  }
  const sources = buildThemeSources(baseline, 0);
  const resolver = sources.resolver as {
    sets: Record<string, { sources: Array<{ $ref: string }> }>;
    resolutionOrder: Array<{ $ref: string }>;
  };
  const documents = sources.documents as Record<string, JsonObject>;
  let current = path;
  for (let hops = 0; hops < 12; hops += 1) {
    let value: JsonValue | undefined;
    for (const { $ref } of resolver.resolutionOrder) {
      if (!$ref.startsWith('#/sets/')) continue;
      for (const source of resolver.sets[$ref.slice('#/sets/'.length)]?.sources ?? []) {
        const document = documents[source.$ref];
        if (document === undefined) continue;
        const node = getNode(document, sourcePathOf(baseline, current));
        if (typeof node === 'object' && node !== null && !Array.isArray(node) && '$value' in node) {
          value = node['$value'];
        }
      }
    }
    if (!isAliasValue(value))
      return isDimension(value) ? { value: value.value, unit: value.unit } : undefined;
    current = value.slice(1, -1);
  }
  return undefined;
}

const MODE_SCOPES: readonly OverrideScope[] = [
  'shared',
  'light',
  'dark',
  'reduced',
  'forcedReduced',
];

/** The override documents that apply after `scope` in the active context, in precedence order. */
function laterScopes(scope: OverrideScope, context: ThemePreviewContext): OverrideScope[] {
  const applicable: OverrideScope[] = ['shared', context.colorMode];
  if (context.motion === 'reduced') applicable.push('reduced');
  if (context.motion === 'forced-reduced-motion') applicable.push('forcedReduced');
  const index = applicable.indexOf(scope);
  return index < 0
    ? []
    : applicable.slice(index + 1).filter((entry) => MODE_SCOPES.includes(entry));
}

/** Every alias and recipe that reads any of `paths`, directly or through other aliases. */
export function dependentsOf(paths: readonly string[]): {
  aliases: string[];
  recipes: string[];
} {
  const reached = new Set<string>(paths);
  const aliases: string[] = [];
  const recipes: string[] = [];
  const queue = [...paths];
  while (queue.length > 0) {
    const source = queue.shift()!;
    for (const row of catalogueRows) {
      if (reached.has(row.path)) continue;
      const viaAlias = row.aliases.includes(source);
      const viaRecipe = row.recipeInputs.includes(source);
      if (!viaAlias && !viaRecipe) continue;
      reached.add(row.path);
      if (row.edit === 'recipe' || (viaRecipe && !viaAlias)) recipes.push(row.path);
      else aliases.push(row.path);
      queue.push(row.path);
    }
  }
  return { aliases, recipes };
}

/** Aliases and recipes living in the scale's own group: followers, not members. */
function skippedMembers(scale: string): SkippedMember[] {
  const members = new Set(scaleMembers(scale));
  const group = [...members][0]?.split('.')[0];
  if (group === undefined) return [];
  return catalogueRows
    .filter((row) => row.path.startsWith(`${group}.`) && !members.has(row.path))
    .map((row) => ({ path: row.path, kind: row.edit === 'recipe' ? 'recipe' : 'alias' }));
}

export type ProposalInput = {
  envelope: ThemeEnvelope;
  draftRevision: number;
  context: ThemePreviewContext;
  scope: OverrideScope;
  scale: string;
  factor: number;
};

/** The proposal for one scale, scope and multiplier. Pure: the same inputs give the same rows. */
export function buildProposal(input: ProposalInput): Proposal {
  const { envelope, context, scope, scale, factor } = input;
  const locked = new Set(envelope.locked ?? []);
  const later = (path: string) =>
    laterScopes(scope, context).filter(
      (entry) => overrideValue(envelope, entry, path) !== undefined,
    );
  const rows: ProposalRow[] = [];
  for (const path of scaleMembers(scale)) {
    const base = baseDimension(envelope, scope, context, path);
    const row = catalogueRowByPath(path);
    if (base === undefined || row === undefined) continue;
    const proposed = scaleDimension(base, factor);
    const existing = overrideValue(envelope, scope, path);
    const status: RowStatus = locked.has(path)
      ? 'locked'
      : existing === undefined
        ? 'new'
        : jsonEquals(existing, dimensionValue(proposed))
          ? 'applied'
          : 'overridden';
    rows.push({
      path,
      name: row.name,
      cssProperty: row.cssProperty,
      base,
      proposed,
      status,
      existing,
      laterLayers: later(path),
      selectable: status !== 'locked',
      selectedByDefault: status === 'new' || status === 'applied',
    });
  }
  const preset = SCALE_PRESETS.find((entry) => entry.factor === factor);
  return {
    scale,
    factor,
    presetId: preset?.id ?? null,
    scope,
    context: contextId(context),
    baseDigest: envelope.base.sourceDigest,
    draftRevision: input.draftRevision,
    rows,
    dependents: dependentsOf(rows.map((row) => row.path)),
    skipped: skippedMembers(scale),
  };
}

/** A proposal applies only to the base, scope, context and revision it was computed from. */
export function proposalIsStale(
  proposal: Proposal,
  envelope: ThemeEnvelope,
  draftRevision: number,
  context: ThemePreviewContext,
  scope: OverrideScope | null,
): boolean {
  return (
    proposal.baseDigest !== envelope.base.sourceDigest ||
    proposal.draftRevision !== draftRevision ||
    proposal.context !== contextId(context) ||
    proposal.scope !== scope
  );
}

/** The paths a selection may contain: selectable rows only. Locked rows are dropped. */
export function selectableSelection(proposal: Proposal, selected: Iterable<string>): string[] {
  const wanted = new Set(selected);
  return proposal.rows
    .filter((row) => row.selectable && wanted.has(row.path))
    .map((row) => row.path);
}

/**
 * The editable state with the selected rows written at the proposal's scope. A written node
 * keeps the metadata of the override already there and states its `$type`. Writing the values
 * already present returns an equal state, which commits as no change and adds no history entry.
 */
export function applyProposal(
  envelope: ThemeEnvelope,
  proposal: Proposal,
  selected: Iterable<string>,
): EditableState {
  const state = editableState(envelope);
  let tree = state.overrides[proposal.scope];
  for (const path of selectableSelection(proposal, selected)) {
    const row = proposal.rows.find((entry) => entry.path === path)!;
    const sourcePath = sourcePathOf(envelope, path);
    const existing = getNode(tree, sourcePath);
    const base: JsonObject =
      typeof existing === 'object' && existing !== null && !Array.isArray(existing) ? existing : {};
    tree = setNode(tree, sourcePath, {
      ...base,
      ...('$type' in base ? {} : { $type: 'dimension' }),
      $value: dimensionValue(row.proposed),
    });
  }
  return { ...state, overrides: { ...state.overrides, [proposal.scope]: tree } };
}

/**
 * The named preset a scale currently shows in a scope: every member overridden with exactly
 * that preset's values. A partial selection, a custom multiplier or a mix is not a preset.
 */
export function activePreset(
  envelope: ThemeEnvelope,
  context: ThemePreviewContext,
  scope: OverrideScope,
  scale: string,
): ScalePresetId | null {
  for (const preset of SCALE_PRESETS) {
    const proposal = buildProposal({
      envelope,
      draftRevision: 0,
      context,
      scope,
      scale,
      factor: preset.factor,
    });
    if (proposal.rows.length > 0 && proposal.rows.every((row) => row.status === 'applied')) {
      return preset.id;
    }
  }
  return null;
}
