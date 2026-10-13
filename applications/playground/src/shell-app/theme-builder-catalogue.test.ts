import { describe, expect, it } from 'bun:test';

import { TOKEN_REGISTRY } from '@lostgradient/cinder';

import {
  CATALOGUE_GROUPS,
  catalogueRowByPath,
  catalogueRows,
  filterRows,
  firstFoundationPath,
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
});
