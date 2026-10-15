/// <reference lib="dom" />
import { describe, expect, test } from 'bun:test';

import { navigateToComponent, rankComponents } from './component-search.ts';

const inventory = [
  'action-row',
  'alert',
  'alert-dialog',
  'button',
  'button-group',
  'icon-button',
  'json-schema-editor',
  'toggle-button',
];

function names(query: string, components: readonly string[] = inventory): string[] {
  return rankComponents(components, query).map((result) => result.name);
}

describe('rankComponents', () => {
  test('an empty or whitespace query lists every component in label order', () => {
    expect(names('')).toEqual([
      'action-row',
      'alert',
      'alert-dialog',
      'button',
      'button-group',
      'icon-button',
      'json-schema-editor',
      'toggle-button',
    ]);
    expect(names('   ')).toEqual(names(''));
  });

  test('ranks an exact match, then prefix matches, then substring matches', () => {
    expect(names('button')).toEqual(['button', 'button-group', 'icon-button', 'toggle-button']);
  });

  test('matches labels and slugs case-insensitively', () => {
    expect(names('ALERT D')).toEqual(['alert-dialog']);
    expect(names('Alert-Dialog')).toEqual(['alert-dialog']);
    expect(names('json schema')).toEqual(['json-schema-editor']);
  });

  test('an exact label match ranks in the exact tier', () => {
    expect(names('button group')).toEqual(['button-group']);
    expect(names('alert')).toEqual(['alert', 'alert-dialog']);
  });

  test('orders each tier by label, not by inventory order', () => {
    const shuffled = ['toggle-button', 'icon-button', 'button-group', 'button'];
    expect(names('button', shuffled)).toEqual([
      'button',
      'button-group',
      'icon-button',
      'toggle-button',
    ]);
  });

  test('lists each component once, at its best tier', () => {
    // "row" is a substring of the slug and the label; the result appears once.
    expect(names('row')).toEqual(['action-row']);
  });

  test('returns nothing when no label or slug matches', () => {
    expect(names('zebra')).toEqual([]);
  });

  test('every result carries its sidebar label and canonical documentation href', () => {
    expect(rankComponents(inventory, 'json')).toEqual([
      {
        name: 'json-schema-editor',
        label: 'JSON Schema Editor',
        href: '/page/json-schema-editor',
      },
    ]);
  });
});

describe('navigateToComponent', () => {
  test('performs a document navigation to the canonical href', () => {
    const assigned: string[] = [];
    const location = { assign: (href: string) => assigned.push(href) } as unknown as Location;
    navigateToComponent('/page/button', location, null);
    expect(assigned).toEqual(['/page/button']);
  });

  test('routes through the installed progressive navigation instead of assigning', () => {
    const assigned: string[] = [];
    const navigated: string[] = [];
    const location = { assign: (href: string) => assigned.push(href) } as unknown as Location;
    navigateToComponent('/page/button', location, {
      navigate: (href) => {
        navigated.push(href);
        return Promise.resolve();
      },
    });
    expect(navigated).toEqual(['/page/button']);
    expect(assigned).toEqual([]);
  });
});
