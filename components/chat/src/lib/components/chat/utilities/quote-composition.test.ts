import { describe, expect, test } from 'bun:test';

import {
  MAX_QUOTE_LENGTH,
  composeQuotedContent,
  normalizeQuoteText,
  previewQuoteText,
} from './quote-composition.ts';

describe('composeQuotedContent', () => {
  test('returns the typed text untouched when there are no quotes', () => {
    expect(composeQuotedContent([], 'hello')).toBe('hello');
  });

  test('prefixes every line, including blank ones, with "> "', () => {
    expect(composeQuotedContent(['one\n\ntwo'], 'reply')).toBe('> one\n> \n> two\n\nreply');
  });

  test('separates quotes with one blank line and the typed text with one more', () => {
    expect(composeQuotedContent(['a', 'b\nc'], 'text')).toBe('> a\n\n> b\n> c\n\ntext');
  });

  test('treats CRLF and CR as line breaks', () => {
    expect(composeQuotedContent(['a\r\nb\rc'], 'x')).toBe('> a\n> b\n> c\n\nx');
  });
});

describe('normalizeQuoteText', () => {
  test('trims surrounding whitespace', () => {
    expect(normalizeQuoteText('  \n spaced \n ')).toBe('spaced');
  });

  test('returns an empty string for whitespace-only text', () => {
    expect(normalizeQuoteText(' \n\t ')).toBe('');
  });

  test('keeps text of exactly the maximum length', () => {
    const text = 'a'.repeat(MAX_QUOTE_LENGTH);
    expect(normalizeQuoteText(text)).toBe(text);
  });

  test('cuts longer text to 3,999 characters plus an ellipsis', () => {
    const result = normalizeQuoteText('a'.repeat(MAX_QUOTE_LENGTH + 1));
    expect(result).toBe(`${'a'.repeat(3999)}…`);
    expect(result).toHaveLength(MAX_QUOTE_LENGTH);
  });

  test('never leaves half of a surrogate pair before the ellipsis', () => {
    const text = `${'a'.repeat(3998)}😀${'b'.repeat(10)}`;
    const result = normalizeQuoteText(text);
    expect(result).toBe(`${'a'.repeat(3998)}…`);
  });
});

describe('previewQuoteText', () => {
  test('shows short text whole', () => {
    expect(previewQuoteText('short')).toBe('short');
  });

  test('shows the first 80 characters and an ellipsis for longer text', () => {
    expect(previewQuoteText(`${'a'.repeat(80)}b`)).toBe(`${'a'.repeat(80)}…`);
  });

  test('shows exactly 80 characters whole', () => {
    expect(previewQuoteText('a'.repeat(80))).toBe('a'.repeat(80));
  });

  test('flattens line breaks to spaces', () => {
    expect(previewQuoteText('one\ntwo\n\nthree')).toBe('one two three');
  });
});
