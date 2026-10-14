/// <reference lib="dom" />
import { afterEach, describe, expect, test } from 'bun:test';

import {
  isComponentSearchShortcut,
  navigateToComponent,
  rankComponents,
} from './component-search.ts';

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

describe('isComponentSearchShortcut', () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  function press(init: KeyboardEventInit): KeyboardEvent {
    return new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  }

  test('accepts Cmd+K and Ctrl+K in either letter case', () => {
    expect(isComponentSearchShortcut(press({ key: 'k', metaKey: true }), document)).toBe(true);
    expect(isComponentSearchShortcut(press({ key: 'k', ctrlKey: true }), document)).toBe(true);
    expect(isComponentSearchShortcut(press({ key: 'K', metaKey: true }), document)).toBe(true);
  });

  test('rejects K without a command modifier or with extra modifiers', () => {
    expect(isComponentSearchShortcut(press({ key: 'k' }), document)).toBe(false);
    expect(
      isComponentSearchShortcut(press({ key: 'k', metaKey: true, shiftKey: true }), document),
    ).toBe(false);
    expect(
      isComponentSearchShortcut(press({ key: 'k', ctrlKey: true, altKey: true }), document),
    ).toBe(false);
    expect(isComponentSearchShortcut(press({ key: 'j', metaKey: true }), document)).toBe(false);
  });

  test('ignores a held key so one press opens the palette once', () => {
    expect(
      isComponentSearchShortcut(press({ key: 'k', metaKey: true, repeat: true }), document),
    ).toBe(false);
  });

  test('ignores the shortcut during IME composition', () => {
    expect(
      isComponentSearchShortcut(press({ key: 'k', metaKey: true, isComposing: true }), document),
    ).toBe(false);
    expect(isComponentSearchShortcut(press({ key: 'Process', metaKey: true }), document)).toBe(
      false,
    );
  });

  test('ignores the shortcut while an editable control has focus', () => {
    for (const markup of [
      '<input type="text">',
      '<textarea></textarea>',
      '<select><option>a</option></select>',
      '<div contenteditable="true" tabindex="0"></div>',
    ]) {
      document.body.innerHTML = markup;
      const control = document.body.firstElementChild as HTMLElement;
      control.focus();
      expect(isComponentSearchShortcut(press({ key: 'k', metaKey: true }), document)).toBe(false);
    }
  });

  test('accepts the shortcut while a non-editable control has focus', () => {
    document.body.innerHTML = '<button type="button">Demo</button>';
    (document.body.firstElementChild as HTMLElement).focus();
    expect(isComponentSearchShortcut(press({ key: 'k', metaKey: true }), document)).toBe(true);
  });

  test('ignores the shortcut while a dialog is open', () => {
    document.body.innerHTML = '<dialog open><p>Demo</p></dialog>';
    expect(isComponentSearchShortcut(press({ key: 'k', metaKey: true }), document)).toBe(false);

    document.body.innerHTML = '<div role="dialog" aria-modal="true"><p>Demo</p></div>';
    expect(isComponentSearchShortcut(press({ key: 'k', metaKey: true }), document)).toBe(false);
  });

  test('a closed modal dialog does not block the shortcut', () => {
    document.body.innerHTML = '<dialog aria-modal="true"></dialog>';
    expect(isComponentSearchShortcut(press({ key: 'k', metaKey: true }), document)).toBe(true);
  });

  test('ignores an event another handler already claimed', () => {
    const event = press({ key: 'k', metaKey: true });
    event.preventDefault();
    expect(isComponentSearchShortcut(event, document)).toBe(false);
  });
});

describe('navigateToComponent', () => {
  test('performs a document navigation to the canonical href', () => {
    const assigned: string[] = [];
    const location = { assign: (href: string) => assigned.push(href) } as unknown as Location;
    navigateToComponent('/page/button', location);
    expect(assigned).toEqual(['/page/button']);
  });
});
