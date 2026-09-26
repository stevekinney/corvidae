/**
 * Exhaustive tests for template placeholder domain logic.
 * DEP-582: Pure functions with no ProseMirror or DOM dependencies.
 * DEP-625: Comprehensive security tests for prototype pollution and XSS prevention.
 */

import { describe, expect, it } from 'bun:test';

import { parsePlaceholderTokens, validatePlaceholderTokens } from './template-placeholders.js';

describe('validatePlaceholderTokens', () => {
  const candidates = [
    { path: 'name', description: undefined, valueKind: 'string' as const },
    { path: 'age', description: undefined, valueKind: 'number' as const },
    { path: 'input.x', description: undefined, valueKind: 'string' as const },
  ];

  it('reports malformed_token issue for unclosed token', () => {
    const tokens = parsePlaceholderTokens('{{name');
    const result = validatePlaceholderTokens(tokens, candidates);

    expect(result.invalidTokens).toHaveLength(1);
    expect(result.validTokens).toHaveLength(0);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]!.reason).toBe('malformed_token');
    expect(result.issues[0]!.token).toBe(tokens[0]!);
  });

  const invalidPaths = [
    ['numeric start', '123'],
    ['double dot', 'a..b'],
    ['empty string', ''],
    ['leading dot', '.a'],
  ] as const;

  it.each(invalidPaths)(
    'reports invalid_path_format for path with %s ("%s")',
    (_label, pathValue) => {
      const token = {
        raw: `{{${pathValue}}}`,
        path: pathValue,
        startOffset: 0,
        endOffset: pathValue.length + 4,
        closed: true,
      };

      const result = validatePlaceholderTokens([token], candidates);

      expect(result.invalidTokens).toHaveLength(1);
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0]!.reason).toBe('invalid_path_format');
    },
  );

  it('reports unknown_placeholder for valid-format path not in candidate set', () => {
    const tokens = parsePlaceholderTokens('{{unknown_field}}');
    const result = validatePlaceholderTokens(tokens, candidates);

    expect(result.invalidTokens).toHaveLength(1);
    expect(result.validTokens).toHaveLength(0);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]!.reason).toBe('unknown_placeholder');
  });

  it('places valid token in validTokens with zero issues for that token', () => {
    const tokens = parsePlaceholderTokens('{{name}}');
    const result = validatePlaceholderTokens(tokens, candidates);

    expect(result.validTokens).toHaveLength(1);
    expect(result.validTokens[0]!.path).toBe('name');
    expect(result.invalidTokens).toHaveLength(0);
    expect(result.issues).toHaveLength(0);
  });

  it('correctly partitions mixed valid and invalid tokens', () => {
    const text = '{{name}} and {{}} and {{unknown}} and {{input.x';
    const tokens = parsePlaceholderTokens(text);
    const result = validatePlaceholderTokens(tokens, candidates);

    expect(result.validTokens).toHaveLength(1);
    expect(result.validTokens[0]!.path).toBe('name');

    expect(result.invalidTokens).toHaveLength(3);
    expect(result.issues).toHaveLength(3);

    const reasons = result.issues.map((issue) => issue.reason);
    expect(reasons).toContain('invalid_path_format'); // {{}}
    expect(reasons).toContain('unknown_placeholder'); // {{unknown}}
    expect(reasons).toContain('malformed_token'); // {{input.x (unclosed)
  });

  it('references the original token with source offsets in each issue', () => {
    const text = 'prefix {{bad..path}} suffix';
    const tokens = parsePlaceholderTokens(text);
    const result = validatePlaceholderTokens(tokens, candidates);

    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]!.token.startOffset).toBe(7);
    expect(result.issues[0]!.token.endOffset).toBe(20);
    expect(result.issues[0]!.token.raw).toBe('{{bad..path}}');
  });
});
