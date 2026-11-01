/** Where a tool comes from, and how the picker groups and searches by it. */
import { describe, expect, test } from 'bun:test';

import { catalogFixture } from './bureau-stub.test-support.ts';
import { groupByOrigin, matchesSearch, originOf, type PickerTool } from './tool-sources.ts';

function tools(
  ...specs: readonly (Partial<PickerTool> & { readonly name: string })[]
): PickerTool[] {
  return [
    ...catalogFixture({
      tools: specs.map((spec) => ({
        description: `About ${spec.name}.`,
        shortDescription: null,
        ...spec,
      })),
    }).tools,
  ];
}

describe('originOf', () => {
  test('puts a Bureau tool with Bureau, whatever its name holds', () => {
    expect(originOf({ name: 'bureau:workflows-create', source: 'bureau' })).toEqual({
      key: 'bureau',
      kind: 'bureau',
      sourceId: undefined,
    });
    expect(originOf({ name: 'a__b', source: 'bureau' }).kind).toBe('bureau');
  });

  test('reads a saved source from the identifier before the first double underscore', () => {
    expect(originOf({ name: 'github__create_issue', source: 'host' })).toEqual({
      key: 'saved:github',
      kind: 'saved',
      sourceId: 'github',
    });
    expect(originOf({ name: 'github__repo__list', source: 'host' }).sourceId).toBe('github');
  });

  test('leaves a host tool with no source prefix with the host', () => {
    for (const name of ['lookup-order', 'snake_case_tool', '__leading', 'trailing__']) {
      expect(originOf({ name, source: 'host' })).toEqual({
        key: 'host',
        kind: 'host',
        sourceId: undefined,
      });
    }
  });
});

describe('groupByOrigin', () => {
  test('orders Bureau, the host, then saved sources by identifier, keeping the catalog order within a group', () => {
    const groups = groupByOrigin(
      tools(
        { name: 'petstore__get' },
        { name: 'zeta' },
        { name: 'github__b' },
        { name: 'bureau:x', source: 'bureau' },
        { name: 'github__a' },
        { name: 'alpha' },
      ),
    );
    expect(groups.map((group) => group.origin.key)).toEqual([
      'bureau',
      'host',
      'saved:github',
      'saved:petstore',
    ]);
    expect(groups.map((group) => group.tools.map((tool) => tool.name))).toEqual([
      ['bureau:x'],
      ['zeta', 'alpha'],
      ['github__b', 'github__a'],
      ['petstore__get'],
    ]);
  });

  test('lists no group for no tool', () => {
    expect(groupByOrigin([])).toEqual([]);
  });
});

describe('matchesSearch', () => {
  const [tool] = tools({
    name: 'github__create_issue',
    description: 'Open an issue.',
    shortDescription: 'Opens a ticket',
  });
  if (tool === undefined) throw new Error('expected a tool');

  test('matches every tool when the search is empty or blank', () => {
    expect(matchesSearch(tool, '')).toBe(true);
    expect(matchesSearch(tool, '   ')).toBe(true);
  });

  test('matches the name, either description or the source, ignoring case and surrounding space', () => {
    expect(matchesSearch(tool, ' CREATE_ISS ')).toBe(true);
    expect(matchesSearch(tool, 'open an')).toBe(true);
    expect(matchesSearch(tool, 'ticket')).toBe(true);
    expect(matchesSearch(tool, 'GitHub')).toBe(true);
    expect(matchesSearch(tool, 'petstore')).toBe(false);
  });
});
