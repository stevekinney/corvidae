/// <reference lib="dom" />
import { afterEach, describe, expect, test } from 'bun:test';

import { isComponentSearchShortcut } from './component-search-shortcut.ts';

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

  test('accepts the shortcut while a checkbox, radio, range, or button input has focus', () => {
    for (const type of ['checkbox', 'radio', 'range', 'button']) {
      document.body.innerHTML = `<input type="${type}">`;
      (document.body.firstElementChild as HTMLElement).focus();
      expect(isComponentSearchShortcut(press({ key: 'k', metaKey: true }), document)).toBe(true);
    }
  });

  test('ignores the shortcut while an editor inside a shadow root has focus', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = host.attachShadow({ mode: 'open' });
    const editor = document.createElement('textarea');
    root.append(editor);
    editor.focus();
    expect(isComponentSearchShortcut(press({ key: 'k', metaKey: true }), document)).toBe(false);
  });

  test('accepts the shortcut while a non-editable control inside a shadow root has focus', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = host.attachShadow({ mode: 'open' });
    const button = document.createElement('button');
    root.append(button);
    button.focus();
    expect(isComponentSearchShortcut(press({ key: 'k', metaKey: true }), document)).toBe(true);
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
