/**
 * The token catalogue, built from the runtime's authoring catalogue: one row per public
 * token, grouped Foundations, then Semantic, then Components, then Source. The shell reads
 * `catalogueRows`, `rowsInGroup`, `filterRows`, `filterRowsBy`, `firstFoundationPath`, and
 * `catalogueRowByPath`; every count here is derived from the runtime's data, never hardcoded.
 *
 * Values are not part of a row: Shipped and Draft values depend on the active context and
 * the draft, so the controller supplies them by CSS property.
 */

import {
  AUTHORING_CATALOGUE,
  PROFILES,
  type AuthoringRecord,
  type ProfileDefinition,
} from '@lostgradient/cinder/tokens/runtime';

export const CATALOGUE_GROUPS = [
  { id: 'foundations', label: 'Foundations' },
  { id: 'semantic', label: 'Semantic' },
  { id: 'components', label: 'Components' },
  { id: 'source', label: 'Source' },
] as const;

export type CatalogueGroupId = (typeof CATALOGUE_GROUPS)[number]['id'];

export type CatalogueRow = {
  /** The dotted corpus path, the stable token identity. */
  path: string;
  /** A friendly name derived from the path. */
  name: string;
  cssProperty: string;
  /** The effective DTCG type, or `unknown` when the corpus declares none. */
  type: string;
  /** `light and dark` for a theme-aware token, `all contexts` otherwise. */
  context: string;
  group: CatalogueGroupId;
  description: string;
  component: string | null;
  themeAware: boolean;
  /** How the token may be edited: its DTCG value, a trusted recipe, or CSS only. */
  edit: AuthoringRecord['disposition']['edit'];
  /** The shipped CSS value of a CSS-only token. */
  shippedCssValue: string | undefined;
  /** Token paths the shipped value aliases; empty for a literal. */
  aliases: readonly string[];
  /** Public properties a trusted recipe reads. */
  recipeInputs: readonly string[];
  profile: ProfileDefinition | undefined;
};

function groupOf(record: AuthoringRecord): CatalogueGroupId {
  if (record.component !== null) return 'components';
  return record.category === 'color' ? 'semantic' : 'foundations';
}

function friendlyName(path: string): string {
  const words = path.replaceAll('.', ' ').replaceAll('-', ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function rowOf(record: AuthoringRecord): CatalogueRow {
  const provenance = record.variants[0]?.provenance;
  return {
    path: record.path,
    name: friendlyName(record.path),
    cssProperty: record.cssProperty,
    type: provenance?.effectiveType.type ?? 'unknown',
    context: record.themeAware ? 'light and dark' : 'all contexts',
    group: groupOf(record),
    description: record.description === 'unknown' ? '' : record.description,
    component: record.component,
    themeAware: record.themeAware,
    edit: record.disposition.edit,
    shippedCssValue: record.disposition.cssValue,
    aliases: record.variants.flatMap((variant) => variant.provenance.inputs.aliases),
    recipeInputs: provenance?.inputs.recipes.map((input) => input.path) ?? [],
    profile: PROFILES[record.profile],
  };
}

/** Every public token as a catalogue row, in the authoring catalogue's stable order. */
export const catalogueRows: readonly CatalogueRow[] = AUTHORING_CATALOGUE.records.map(rowOf);

export function rowsInGroup(group: CatalogueGroupId): readonly CatalogueRow[] {
  return catalogueRows.filter((row) => row.group === group);
}

/** Case-insensitive match over the friendly label, path, CSS property, type, and component. */
export function filterRows(rows: readonly CatalogueRow[], query: string): readonly CatalogueRow[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return rows;
  return rows.filter((row) =>
    [row.name, row.path, row.cssProperty, row.type, row.component ?? ''].some((field) =>
      field.toLowerCase().includes(needle),
    ),
  );
}

export type CatalogueFilters = { changed: boolean; alias: boolean; recipe: boolean };
export const NO_FILTERS: CatalogueFilters = { changed: false, alias: false, recipe: false };

/** Narrow rows by the toggled filters; each active filter must hold. */
export function filterRowsBy(
  rows: readonly CatalogueRow[],
  filters: CatalogueFilters,
  changedPaths: ReadonlySet<string>,
): readonly CatalogueRow[] {
  if (!filters.changed && !filters.alias && !filters.recipe) return rows;
  return rows.filter(
    (row) =>
      (!filters.changed || changedPaths.has(row.path)) &&
      (!filters.alias || row.aliases.length > 0) &&
      (!filters.recipe || row.edit === 'recipe'),
  );
}

/** The initial editor selection: the first foundation token in source order. */
export function firstFoundationPath(): string | null {
  return rowsInGroup('foundations')[0]?.path ?? null;
}

export function catalogueRowByPath(path: string | null): CatalogueRow | undefined {
  return path === null ? undefined : catalogueRows.find((row) => row.path === path);
}
