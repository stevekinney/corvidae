/**
 * Exhaustive tests for template placeholder domain logic.
 * DEP-582: Pure functions with no ProseMirror or DOM dependencies.
 * DEP-625: Comprehensive security tests for prototype pollution and XSS prevention.
 */

import { describe, expect, it } from 'bun:test';

import { resolveTemplatePlaceholders } from './template-placeholders.js';

describe('resolveTemplatePlaceholders', () => {
  it('resolves string value', () => {
    const result = resolveTemplatePlaceholders('{{ input.x }}', { input: { x: 'hello' } });

    expect(result.text).toBe('hello');
    expect(result.issues).toHaveLength(0);
  });

  it('resolves number value', () => {
    const result = resolveTemplatePlaceholders('{{count}}', { count: 42 });

    expect(result.text).toBe('42');
  });

  it('resolves boolean value', () => {
    const result = resolveTemplatePlaceholders('{{flag}}', { flag: true });

    expect(result.text).toBe('true');
  });

  it('resolves object value as JSON', () => {
    const result = resolveTemplatePlaceholders('{{input}}', { input: { x: 'hello', y: 1 } });

    expect(result.text).toBe('{"x":"hello","y":1}');
  });

  it('resolves array value as comma-separated items', () => {
    const result = resolveTemplatePlaceholders('{{tags}}', { tags: ['a', 'b', 3] });

    expect(result.text).toBe('a, b, 3');
  });

  it('handles array with null and object items per item-coercion rules', () => {
    const result = resolveTemplatePlaceholders('{{items}}', {
      items: [null, { key: 'value' }, undefined, 'text'],
    });

    expect(result.text).toBe(', {"key":"value"}, , text');
  });

  it('coerces function items in arrays to empty string (consistent with top-level behavior)', () => {
    // String(fn) emits the function source code; that is inconsistent with the
    // documented contract that function values resolve to ''.
    const result = resolveTemplatePlaceholders('{{items}}', {
      items: ['a', () => 'hello', 'b'],
    });

    expect(result.text).toBe('a, , b');
  });

  it('coerces symbol items in arrays to empty string (consistent with top-level behavior)', () => {
    // String(sym) emits "Symbol(...)"; that is inconsistent with the documented
    // contract that symbol values resolve to ''.
    const result = resolveTemplatePlaceholders('{{items}}', {
      items: ['a', Symbol('test'), 'b'],
    });

    expect(result.text).toBe('a, , b');
  });

  it('resolves null value to empty string', () => {
    const result = resolveTemplatePlaceholders('{{field}}', { field: null });

    expect(result.text).toBe('');
  });

  it('resolves undefined / missing path to empty string', () => {
    const result = resolveTemplatePlaceholders('{{missing}}', {});

    expect(result.text).toBe('');
  });

  it('resolves bigint value', () => {
    const result = resolveTemplatePlaceholders('{{big}}', { big: BigInt(42) });

    expect(result.text).toBe('42');
  });

  it('preserves unclosed tokens in output text unmodified', () => {
    const text = 'Hello {{name}} and {{unclosed';
    const result = resolveTemplatePlaceholders(text, { name: 'World' });

    expect(result.text).toBe('Hello World and {{unclosed');
  });

  it('reports unknown_placeholder issues when candidatePaths is provided', () => {
    const result = resolveTemplatePlaceholders('{{unknown}}', {}, ['name', 'age']);

    expect(result.text).toBe('');
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]!.reason).toBe('unknown_placeholder');
  });

  it('replaces unknown paths with empty string without issues when candidatePaths is omitted', () => {
    const result = resolveTemplatePlaceholders('{{unknown}}', {});

    expect(result.text).toBe('');
    expect(result.issues).toHaveLength(0);
  });

  it('resolves multiple tokens in same text correctly via reverse-order iteration', () => {
    const text = '{{greeting}} {{name}}, you have {{count}} items.';
    const result = resolveTemplatePlaceholders(text, {
      greeting: 'Hello',
      name: 'Alice',
      count: 5,
    });

    expect(result.text).toBe('Hello Alice, you have 5 items.');
  });

  it('does not mutate the input values object', () => {
    const values = { name: 'Alice', nested: { x: 1 } };
    const valuesCopy = JSON.parse(JSON.stringify(values));

    resolveTemplatePlaceholders('{{name}} {{nested}}', values);

    expect(values).toEqual(valuesCopy);
  });

  it('resolves inherited prototype property names to empty string, not the inherited function', () => {
    // Without the Object.hasOwn guard, paths like "constructor" or "toString"
    // traverse the prototype chain and return the inherited function. JSON.stringify
    // coerces a function to undefined, producing the literal text "undefined" rather
    // than the expected empty string.
    const result = resolveTemplatePlaceholders('{{constructor}}', {});
    expect(result.text).toBe('');
  });

  it('resolves nested prototype property names to empty string', () => {
    const result = resolveTemplatePlaceholders('{{a.toString}}', { a: {} });
    expect(result.text).toBe('');
  });

  it('resolves function value to empty string (not the literal text "undefined")', () => {
    // JSON.stringify returns undefined for function values, which string
    // concatenation coerces to the literal text "undefined". The function/symbol
    // guard in formatValueForReplacement must intercept before JSON.stringify.
    const result = resolveTemplatePlaceholders('{{fn}}', { fn: () => 'hello' });
    expect(result.text).toBe('');
  });

  it('resolves symbol value to empty string (not the literal text "undefined")', () => {
    const result = resolveTemplatePlaceholders('{{sym}}', { sym: Symbol('test') });
    expect(result.text).toBe('');
  });

  it('reports issues in forward document order when multiple unknown tokens appear', () => {
    // resolveTemplatePlaceholders iterates tokens in reverse for correct string
    // splicing, but issues must be returned in forward document order to match
    // the ordering produced by validatePlaceholderTokens.
    const result = resolveTemplatePlaceholders('{{alpha}} and {{beta}} and {{gamma}}', {}, [
      'name',
    ]);

    expect(result.issues).toHaveLength(3);
    expect(result.issues[0]!.token.path).toBe('alpha');
    expect(result.issues[1]!.token.path).toBe('beta');
    expect(result.issues[2]!.token.path).toBe('gamma');

    // Verify by startOffset, not just path
    const offsets = result.issues.map((issue) => issue.token.startOffset);
    expect(offsets).toEqual(offsets.toSorted((a, b) => a - b));
  });
});
