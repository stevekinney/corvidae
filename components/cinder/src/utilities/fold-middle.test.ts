import { describe, expect, it } from 'bun:test';

import { planFold, summarizeFoldedNames } from './fold-middle.ts';

const rows = (count: number): number[] => Array.from({ length: count }, (_, index) => index);

describe('planFold', () => {
  it('returns every row when fewer than two would hide', () => {
    for (const count of [0, 1, 3, 6, 7]) {
      const plan = planFold(rows(count));
      expect(plan.every((entry) => entry.kind === 'item')).toBe(true);
      expect(plan).toHaveLength(count);
    }
  });

  it('folds the middle from eight rows: the first 3 and last 3 stay', () => {
    const plan = planFold(rows(8));
    expect(plan.map((entry) => entry.kind)).toEqual([
      'item',
      'item',
      'item',
      'group',
      'item',
      'item',
      'item',
    ]);
    const group = plan[3];
    expect(group?.kind === 'group' && group.items).toEqual([3, 4]);
  });

  it('counts 3 + 24 + 3 for thirty rows', () => {
    const plan = planFold(rows(30));
    const group = plan.find((entry) => entry.kind === 'group');
    expect(group?.kind === 'group' && group.items).toHaveLength(24);
    expect(plan.filter((entry) => entry.kind === 'item')).toHaveLength(6);
  });

  it('keeps pinned rows visible and splits the middle into groups that count only what they hide', () => {
    const plan = planFold(rows(30), { isPinned: (item) => item === 13 });
    const sizes = plan.map((entry) => (entry.kind === 'group' ? entry.items.length : 0));
    expect(sizes.filter((size) => size > 0)).toEqual([10, 13]);
    expect(plan.filter((entry) => entry.kind === 'item').map((entry) => entry.index)).toEqual([
      0, 1, 2, 13, 27, 28, 29,
    ]);
  });

  it('shows a lone row between two pinned rows rather than hiding it behind a control', () => {
    const plan = planFold(rows(12), { isPinned: (item) => item === 4 || item === 6 });
    const hidden = plan.filter((entry) => entry.kind === 'group');
    expect(hidden).toHaveLength(1);
    expect(plan.some((entry) => entry.kind === 'item' && entry.index === 5)).toBe(true);
  });

  it('takes the number of rows to keep at the end from options', () => {
    const plan = planFold(rows(12), { last: 0, first: 3 });
    expect(plan.at(-1)?.kind).toBe('group');
  });
});

describe('summarizeFoldedNames', () => {
  const repeat = (name: string, count: number): string[] =>
    Array.from({ length: count }, () => name);

  it('lists the names that appear most and counts the rest as others', () => {
    const names = [
      ...repeat('Lookup order', 10),
      ...repeat('Check inventory', 4),
      ...repeat('Lookup customer', 4),
      'Read policy',
      ...repeat('Search orders', 2),
      ...repeat('Draft email', 2),
      'Update ticket',
    ];
    expect(summarizeFoldedNames(names)).toBe(
      'Lookup order ×10, Check inventory ×4, Lookup customer ×4, 6 others',
    );
  });

  it('leaves out the count of a name that appears once and the others when none are left', () => {
    expect(
      summarizeFoldedNames([...repeat('Lookup order', 6), 'Read policy', 'Check inventory']),
    ).toBe('Lookup order ×6, Read policy, Check inventory');
    expect(summarizeFoldedNames(repeat('Lookup order', 2))).toBe('Lookup order ×2');
  });

  it('breaks a tie by the order the names first appeared in', () => {
    expect(
      summarizeFoldedNames([...repeat('Check inventory', 4), ...repeat('Lookup customer', 4)]),
    ).toBe('Check inventory ×4, Lookup customer ×4');
  });

  it('says one other in the singular', () => {
    expect(summarizeFoldedNames(['a', 'a', 'b', 'b', 'c', 'c', 'd'])).toBe(
      'a ×2, b ×2, c ×2, 1 other',
    );
  });
});
