import { describe, expect, it } from 'bun:test';

import { TOKEN_REGISTRY } from '@lostgradient/cinder';

import {
  CATALOGUE_GROUPS,
  catalogueRowByPath,
  catalogueRows,
  filterRows,
  filterRowsBy,
  firstFoundationPath,
  NO_FILTERS,
  rowsInGroup,
} from './theme-builder-catalogue.ts';

describe('the token catalogue', () => {
  it('lists every public registry entry exactly once, in source order', () => {
    const publicEntries = TOKEN_REGISTRY.entries.filter((entry) => entry.public);
    expect(catalogueRows.map((row) => row.path)).toEqual(publicEntries.map((entry) => entry.path));
  });

  it('partitions the rows across the rail groups', () => {
    const total = CATALOGUE_GROUPS.reduce((sum, group) => sum + rowsInGroup(group.id).length, 0);
    expect(total).toBe(catalogueRows.length);
    expect(rowsInGroup('components').every((row) => row.cssProperty.startsWith('--cinder-'))).toBe(
      true,
    );
  });

  it('selects the first foundation token in source order', () => {
    const first = firstFoundationPath();
    expect(first).not.toBeNull();
    expect(rowsInGroup('foundations')[0]?.path).toBe(first!);
    expect(catalogueRowByPath(first)?.group).toBe('foundations');
  });

  it('filters radius tokens by name, path, property, or type', () => {
    const radius = filterRows(rowsInGroup('foundations'), 'radius');
    expect(radius.length).toBeGreaterThan(0);
    expect(
      radius.every((row) => `${row.path}${row.cssProperty}${row.type}`.includes('radius')),
    ).toBe(true);
    expect(filterRows(catalogueRows, '  ')).toBe(catalogueRows);
    expect(filterRows(catalogueRows, 'zzz-no-such-token')).toEqual([]);
  });

  it('orders the rail groups Foundations, Semantic, Components, Source', () => {
    expect(CATALOGUE_GROUPS.map((group) => group.id)).toEqual([
      'foundations',
      'semantic',
      'components',
      'source',
    ]);
    expect(rowsInGroup('source')).toEqual([]);
  });

  it('searches by component and by effective type', () => {
    const button = filterRows(catalogueRows, 'button');
    expect(button.some((row) => row.component === 'button')).toBe(true);
    const dimensions = filterRows(catalogueRows, 'dimension');
    expect(dimensions.length).toBeGreaterThan(0);
    expect(
      dimensions.every((row) => row.type === 'dimension' || row.name.includes('imension')),
    ).toBe(true);
  });

  it('filters changed, alias, and recipe tokens, all of which must hold', () => {
    const aliases = filterRowsBy(catalogueRows, { ...NO_FILTERS, alias: true }, new Set());
    expect(aliases.length).toBeGreaterThan(0);
    expect(aliases.every((row) => row.aliases.length > 0)).toBe(true);
    const recipes = filterRowsBy(catalogueRows, { ...NO_FILTERS, recipe: true }, new Set());
    expect(recipes.length).toBeGreaterThan(0);
    expect(recipes.every((row) => row.edit === 'recipe')).toBe(true);
    const first = catalogueRows[0]!.path;
    expect(
      filterRowsBy(catalogueRows, { ...NO_FILTERS, changed: true }, new Set([first])).map(
        (row) => row.path,
      ),
    ).toEqual([first]);
    expect(filterRowsBy(catalogueRows, NO_FILTERS, new Set())).toBe(catalogueRows);
  });
});
