import { describe, expect, test } from 'bun:test';

import type { ToolPickerItem } from './tool-picker.types.ts';
import {
  buildSections,
  chosenCount,
  isSelectable,
  matchesQuery,
  orderChosen,
} from './tool-picker.utilities.ts';

const items: ToolPickerItem[] = [
  {
    value: 'a',
    label: 'List issues',
    code: 'list_issues',
    description: 'Lists issues',
    group: 'GitHub',
  },
  { value: 'b', label: 'Lookup order', code: 'lookup-order', group: 'Built in' },
  { value: 'c', label: 'Create issue', group: 'GitHub', description: 'Opens an issue' },
  { value: 'd', label: 'Release notes', suffix: 'Skill', group: 'Skills', selectable: false },
];

describe('buildSections', () => {
  test('lists the named groups first, in order, then any other in order of first appearance', () => {
    const sections = buildSections(items, [
      { name: 'Built in' },
      { name: 'Skills', note: 'follow' },
    ]);
    expect(sections.map((section) => section.name)).toEqual(['Built in', 'Skills', 'GitHub']);
    expect(sections[1]?.note).toBe('follow');
  });

  test('keeps the order of items within a group and leaves out a group with no item', () => {
    const sections = buildSections(items, [{ name: 'Empty' }]);
    expect(sections.map((section) => section.name)).toEqual(['GitHub', 'Built in', 'Skills']);
    expect(sections[0]?.items.map((item) => item.value)).toEqual(['a', 'c']);
  });

  test('a group named twice is one group', () => {
    expect(buildSections(items, [{ name: 'GitHub' }, { name: 'GitHub' }])).toHaveLength(3);
  });
});

describe('matchesQuery', () => {
  test('an empty search matches everything', () => {
    expect(items.every((item) => matchesQuery(item, '   '))).toBe(true);
  });

  test('matches the name, identifier, suffix and description, ignoring case', () => {
    expect(matchesQuery(items[0]!, 'LIST_ISSUES')).toBe(true);
    expect(matchesQuery(items[0]!, 'lists')).toBe(true);
    expect(matchesQuery(items[3]!, 'skill')).toBe(true);
    expect(matchesQuery(items[1]!, 'order')).toBe(true);
  });

  test('every word has to match somewhere on the item', () => {
    expect(matchesQuery(items[2]!, 'create opens')).toBe(true);
    expect(matchesQuery(items[2]!, 'create refund')).toBe(false);
  });
});

describe('selection helpers', () => {
  test('an item is selectable unless it says otherwise', () => {
    expect(isSelectable(items[0]!)).toBe(true);
    expect(isSelectable(items[3]!)).toBe(false);
  });

  test('chosenCount counts only the chosen items that can be chosen', () => {
    const [github] = buildSections(items, undefined);
    expect(chosenCount(github!, new Set(['a', 'zzz']))).toBe(1);
    const skills = buildSections(items, undefined).find((section) => section.name === 'Skills')!;
    expect(chosenCount(skills, new Set(['d']))).toBe(0);
  });

  test('orderChosen follows the order of items and keeps a choice no item names', () => {
    expect(orderChosen(items, new Set(['c', 'a', 'gone', 'd']), ['gone', 'a', 'c'])).toEqual([
      'a',
      'c',
      'gone',
    ]);
  });

  test('orderChosen drops a previous value the person cleared', () => {
    expect(orderChosen(items, new Set(['a']), ['gone', 'a'])).toEqual(['a']);
  });
});
