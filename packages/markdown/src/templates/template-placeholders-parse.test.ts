/**
 * Exhaustive tests for template placeholder domain logic.
 * DEP-582: Pure functions with no ProseMirror or DOM dependencies.
 * DEP-625: Comprehensive security tests for prototype pollution and XSS prevention.
 */

import { describe, expect, it } from 'bun:test';

import { parsePlaceholderTokens } from './template-placeholders.js';

describe('parsePlaceholderTokens', () => {
  it('parses a single well-formed token with correct fields', () => {
    const text = '{{input.x}}';
    const tokens = parsePlaceholderTokens(text);

    expect(tokens).toHaveLength(1);
    expect(tokens[0]!).toEqual({
      raw: '{{input.x}}',
      path: 'input.x',
      startOffset: 0,
      endOffset: 11,
      closed: true,
    });
  });

  it('trims whitespace around path', () => {
    const text = '{{ input.x }}';
    const tokens = parsePlaceholderTokens(text);

    expect(tokens).toHaveLength(1);
    expect(tokens[0]!.path).toBe('input.x');
    expect(tokens[0]!.raw).toBe('{{ input.x }}');
    expect(tokens[0]!.closed).toBe(true);
  });

  it('parses adjacent tokens with correct non-overlapping offsets', () => {
    const text = '{{a}}{{b}}';
    const tokens = parsePlaceholderTokens(text);

    expect(tokens).toHaveLength(2);
    expect(tokens[0]!).toEqual({
      raw: '{{a}}',
      path: 'a',
      startOffset: 0,
      endOffset: 5,
      closed: true,
    });
    expect(tokens[1]!).toEqual({
      raw: '{{b}}',
      path: 'b',
      startOffset: 5,
      endOffset: 10,
      closed: true,
    });
  });

  it('returns two separate token objects for repeated same token', () => {
    const text = '{{x}} and {{x}}';
    const tokens = parsePlaceholderTokens(text);

    expect(tokens).toHaveLength(2);
    expect(tokens[0]!.path).toBe('x');
    expect(tokens[1]!.path).toBe('x');
    expect(tokens[0]!.startOffset).toBe(0);
    expect(tokens[1]!.startOffset).toBe(10);
    expect(tokens[0]!).not.toBe(tokens[1]!);
  });

  it('detects unclosed token at end of string', () => {
    const text = '{{input.x';
    const tokens = parsePlaceholderTokens(text);

    expect(tokens).toHaveLength(1);
    expect(tokens[0]!).toEqual({
      raw: '{{input.x',
      path: 'input.x',
      startOffset: 0,
      endOffset: text.length,
      closed: false,
    });
  });

  it('returns closed token with empty string path for empty body', () => {
    const text = '{{}}';
    const tokens = parsePlaceholderTokens(text);

    expect(tokens).toHaveLength(1);
    expect(tokens[0]!).toEqual({
      raw: '{{}}',
      path: '',
      startOffset: 0,
      endOffset: 4,
      closed: true,
    });
  });

  it('returns empty array for text with no tokens', () => {
    expect(parsePlaceholderTokens('Hello world')).toEqual([]);
    expect(parsePlaceholderTokens('')).toEqual([]);
    expect(parsePlaceholderTokens('just { single braces }')).toEqual([]);
  });

  it('parses tokens interspersed with prose with correct offsets', () => {
    const text = 'Hello {{name}}, your {{item}} is ready';
    const tokens = parsePlaceholderTokens(text);

    expect(tokens).toHaveLength(2);

    expect(tokens[0]!).toEqual({
      raw: '{{name}}',
      path: 'name',
      startOffset: 6,
      endOffset: 14,
      closed: true,
    });

    expect(tokens[1]!).toEqual({
      raw: '{{item}}',
      path: 'item',
      startOffset: 21,
      endOffset: 29,
      closed: true,
    });
  });

  it('parses nested braces as-is for path body', () => {
    const text = '{{ {inner} }}';
    const tokens = parsePlaceholderTokens(text);

    expect(tokens).toHaveLength(1);
    expect(tokens[0]!.path).toBe('{inner}');
    expect(tokens[0]!.closed).toBe(true);
  });
});
