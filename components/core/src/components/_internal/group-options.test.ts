import { describe, expect, test } from 'bun:test';

import { groupOptions, hasGroupedOptions } from './group-options.ts';

type Item = { id: string; group?: string };
const groupOf = (item: Item): string | undefined => item.group;

describe('groupOptions', () => {
  test('puts ungrouped options first, then groups in order of first appearance', () => {
    const items: Item[] = [
      { id: 'a', group: 'Recent' },
      { id: 'b' },
      { id: 'c', group: 'Built in' },
      { id: 'd', group: 'Recent' },
    ];
    const { ordered, sections } = groupOptions(items, groupOf);
    expect(ordered.map((item) => item.id)).toEqual(['b', 'a', 'd', 'c']);
    expect(sections.map((section) => section.group)).toEqual([undefined, 'Recent', 'Built in']);
    expect(sections.map((section) => section.members.length)).toEqual([1, 2, 1]);
  });

  test('member indexes continue across sections and match the flat order', () => {
    const items: Item[] = [{ id: 'a', group: 'X' }, { id: 'b' }, { id: 'c', group: 'X' }];
    const { ordered, sections } = groupOptions(items, groupOf);
    const flat = sections.flatMap((section) => section.members);
    expect(flat.map((member) => member.index)).toEqual([0, 1, 2]);
    expect(flat.map((member) => member.option)).toEqual(ordered);
  });

  test('treats blank and whitespace-only groups as ungrouped and trims names', () => {
    const items: Item[] = [
      { id: 'a', group: '' },
      { id: 'b', group: '   ' },
      { id: 'c', group: ' G ' },
    ];
    const { sections } = groupOptions(items, groupOf);
    expect(sections.map((section) => section.group)).toEqual([undefined, 'G']);
    expect(sections[0]?.members.map((member) => member.option.id)).toEqual(['a', 'b']);
  });

  test('yields no sections for an empty list and gives sections sequential indexes', () => {
    expect(groupOptions([], groupOf)).toEqual({ ordered: [], sections: [] });
    const { sections } = groupOptions(
      [
        { id: 'a', group: 'X' },
        { id: 'b', group: 'Y' },
      ],
      groupOf,
    );
    expect(sections.map((section) => section.sectionIndex)).toEqual([0, 1]);
  });

  test('does not treat inherited object keys as group names', () => {
    const { sections } = groupOptions([{ id: 'a', group: 'constructor' }], groupOf);
    expect(sections.map((section) => section.group)).toEqual(['constructor']);
  });
});

describe('hasGroupedOptions', () => {
  test('is true only when some option has a non-blank group', () => {
    expect(hasGroupedOptions([{ id: 'a' }, { id: 'b', group: '  ' }], groupOf)).toBe(false);
    expect(hasGroupedOptions([{ id: 'a' }, { id: 'b', group: 'G' }], groupOf)).toBe(true);
  });
});
