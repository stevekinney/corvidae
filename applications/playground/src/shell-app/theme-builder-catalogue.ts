/**
 * A minimal token catalogue over the public registry, enough for the workbench shell to
 * show a category, filter it, and hold a selection. The token runtime and the editors
 * replace this (COR-491, COR-489): the shell reads only `catalogueRows`, `rowsInGroup`,
 * `filterRows`, and `firstFoundationPath`, so a richer source slots in behind them.
 *
 * Every count here is derived from the registry; nothing hardcodes how many tokens exist.
 */

import { TOKEN_REGISTRY, type TokenRegistryEntry } from '@lostgradient/cinder';

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
  type: string;
  /** `light and dark` for a theme-aware token, `all contexts` otherwise. */
  context: string;
  group: CatalogueGroupId;
  description: string;
};

function groupOf(entry: TokenRegistryEntry): CatalogueGroupId {
  if (entry.component !== undefined) return 'components';
  return entry.category === 'color' ? 'semantic' : 'foundations';
}

function friendlyName(path: string): string {
  const words = path.replaceAll('.', ' ').replaceAll('-', ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Every public token as a catalogue row, in the registry's stable source order. */
export const catalogueRows: readonly CatalogueRow[] = TOKEN_REGISTRY.entries
  .filter((entry) => entry.public)
  .map((entry) => ({
    path: entry.path,
    name: friendlyName(entry.path),
    cssProperty: entry.cssProperty,
    type: entry.category ?? 'other',
    context: entry.themeAware ? 'light and dark' : 'all contexts',
    group: groupOf(entry),
    description: entry.description ?? '',
  }));

export function rowsInGroup(group: CatalogueGroupId): readonly CatalogueRow[] {
  return catalogueRows.filter((row) => row.group === group);
}

/** Case-insensitive match over the name, path, CSS property, and type. */
export function filterRows(rows: readonly CatalogueRow[], query: string): readonly CatalogueRow[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return rows;
  return rows.filter((row) =>
    [row.name, row.path, row.cssProperty, row.type].some((field) =>
      field.toLowerCase().includes(needle),
    ),
  );
}

/** The initial editor selection: the first foundation token in source order. */
export function firstFoundationPath(): string | null {
  return rowsInGroup('foundations')[0]?.path ?? null;
}

export function catalogueRowByPath(path: string | null): CatalogueRow | undefined {
  return path === null ? undefined : catalogueRows.find((row) => row.path === path);
}
