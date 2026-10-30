import { describe, expect, test } from 'bun:test';

import {
  applyComposerFormat,
  composerShortcutFormat,
  highlightComposerMarkdown,
  type ComposerMarkdownSegment,
} from './composer-markdown.ts';

function joined(segments: ComposerMarkdownSegment[]): string {
  return segments.map((segment) => segment.text).join('');
}

function styled(source: string): [string, string][] {
  return highlightComposerMarkdown(source)
    .filter((segment) => segment.kind !== 'text')
    .map((segment) => [segment.kind, segment.text]);
}

describe('highlightComposerMarkdown', () => {
  test('dims markers and styles emphasis, strong, code, and links', () => {
    expect(styled('Hello *world* and `code` and **Bold** and a [link](https://x.test)')).toEqual([
      ['marker', '*'],
      ['emphasis', 'world'],
      ['marker', '*'],
      ['marker', '`'],
      ['code', 'code'],
      ['marker', '`'],
      ['marker', '**'],
      ['strong', 'Bold'],
      ['marker', '**'],
      ['marker', '['],
      ['link', 'link'],
      ['marker', '](https://x.test)'],
    ]);
  });

  test('marks list items, bulleted and numbered', () => {
    expect(styled('- one\n  * two\n3. three')).toEqual([
      ['list-marker', '- '],
      ['list-marker', '* '],
      ['list-marker', '3. '],
    ]);
  });

  test('leaves code contents and snake_case words alone', () => {
    expect(styled('`*not emphasis*` snake_case_name')).toEqual([
      ['marker', '`'],
      ['code', '*not emphasis*'],
      ['marker', '`'],
    ]);
  });

  test('joins back to the exact source, so the backdrop lines up', () => {
    for (const source of [
      '',
      '\n',
      'plain',
      '- a *b* `c`\n\n**d** [e](f) _g_ __h__\n',
      'unclosed *star and `tick',
      '1) x\t\n  - y',
    ]) {
      expect(joined(highlightComposerMarkdown(source))).toBe(source);
    }
  });
});

describe('applyComposerFormat', () => {
  test('wraps a selection and keeps it selected', () => {
    expect(applyComposerFormat('say hi now', 4, 6, 'bold')).toEqual({
      start: 4,
      end: 6,
      text: '**hi**',
      selectionStart: 6,
      selectionEnd: 8,
    });
    expect(applyComposerFormat('say hi now', 4, 6, 'italic').text).toBe('*hi*');
    expect(applyComposerFormat('say hi now', 4, 6, 'code').text).toBe('`hi`');
  });

  test('unwraps a selection that is already wrapped', () => {
    expect(applyComposerFormat('say **hi** now', 6, 8, 'bold')).toEqual({
      start: 4,
      end: 10,
      text: 'hi',
      selectionStart: 4,
      selectionEnd: 6,
    });
  });

  test('puts the caret between new markers when nothing is selected', () => {
    expect(applyComposerFormat('ab', 1, 1, 'bold')).toMatchObject({
      text: '****',
      selectionStart: 3,
      selectionEnd: 3,
    });
  });

  test('turns a selection into a link and selects the URL placeholder', () => {
    const edit = applyComposerFormat('see docs', 4, 8, 'link');
    expect(edit.text).toBe('[docs](url)');
    expect('see [docs](url)'.slice(edit.selectionStart, edit.selectionEnd)).toBe('url');
    expect(applyComposerFormat('', 0, 0, 'link')).toMatchObject({
      text: '[](url)',
      selectionStart: 1,
    });
  });

  test('toggles list markers on every selected line', () => {
    const value = 'one\ntwo\nthree';
    const listed = applyComposerFormat(value, 1, 5, 'list');
    expect(listed).toMatchObject({ start: 0, end: 7, text: '- one\n- two' });
    const unlisted = applyComposerFormat('- one\n- two', 3, 7, 'list');
    expect(unlisted.text).toBe('one\ntwo');
  });

  test('lists an empty first line when the caret is at offset zero', () => {
    expect(applyComposerFormat('\none', 0, 0, 'list')).toEqual({
      start: 0,
      end: 0,
      text: '- ',
      selectionStart: 2,
      selectionEnd: 2,
    });
  });
});

describe('composerShortcutFormat', () => {
  function key(init: KeyboardEventInit): KeyboardEvent {
    return new KeyboardEvent('keydown', init);
  }

  test('maps Cmd or Ctrl with B, I, E, and K', () => {
    expect(composerShortcutFormat(key({ key: 'b', metaKey: true }))).toBe('bold');
    expect(composerShortcutFormat(key({ key: 'I', ctrlKey: true }))).toBe('italic');
    expect(composerShortcutFormat(key({ key: 'e', metaKey: true }))).toBe('code');
    expect(composerShortcutFormat(key({ key: 'k', ctrlKey: true }))).toBe('link');
  });

  test('ignores other keys and extra modifiers', () => {
    expect(composerShortcutFormat(key({ key: 'b' }))).toBeUndefined();
    expect(
      composerShortcutFormat(key({ key: 'b', metaKey: true, shiftKey: true })),
    ).toBeUndefined();
    expect(composerShortcutFormat(key({ key: 'z', metaKey: true }))).toBeUndefined();
    expect(composerShortcutFormat(key({ key: 'constructor', metaKey: true }))).toBeUndefined();
  });
});
