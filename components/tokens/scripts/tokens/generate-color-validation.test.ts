import { describe, expect, test } from 'bun:test';
import { type CorpusEntry } from '../../src/tokens/runtime/corpus.ts';
import { resolveAlias } from '../../src/tokens/runtime/value-color.ts';
describe('CIN-469 finding 4: a $root JSON Pointer alias normalizes like a group.base one', () => {
  // Mirrors resolve.test.ts's "resolves a property-level JSON Pointer through a
  // group's $root token" and "resolves #/$root/$value against the document-level
  // $root" fixtures (lines 77-78 and 86-87) -- both forms tokens:validate accepts.
  test("#/group/$root/$value resolves against the group's own path", () => {
    const baseIndex = new Map<string, CorpusEntry>([
      [
        'group',
        {
          path: 'group',
          value: 1,
          type: 'number',
          description: undefined,
          cssProperty: '--test-group-root',
          cssRecipe: undefined,
        },
      ],
    ]);
    expect(resolveAlias('#/group/$root/$value', baseIndex)).toBe('var(--test-group-root)');
  });

  test('#/$root/$value resolves against the document-level root (empty path)', () => {
    const baseIndex = new Map<string, CorpusEntry>([
      [
        '',
        {
          path: '',
          value: 1,
          type: 'number',
          description: undefined,
          cssProperty: '--test-document-root',
          cssRecipe: undefined,
        },
      ],
    ]);
    expect(resolveAlias('#/$root/$value', baseIndex)).toBe('var(--test-document-root)');
  });

  test('a bare #/group/$root (no trailing /$value) resolves the same way as the /$value form', () => {
    // resolve.ts's own resolveReference extracts $value for a bare
    // `#/group/$root` too -- "a bare `#/group/$root` alias names the root
    // token's whole identity and must extract $value, exactly like the
    // ordinary whole-token case" (see resolve.ts's comment on this exact
    // redirect, and resolve.test.ts's "resolves a $ref alias that targets a
    // group root token", which asserts `$ref: '#/group/$root'` resolves
    // successfully). `wholeTokenIndexPath` matches that: both forms
    // normalize to the same indexed path.
    const baseIndex = new Map<string, CorpusEntry>([
      [
        'group',
        {
          path: 'group',
          value: 1,
          type: 'number',
          description: undefined,
          cssProperty: '--test-group-root',
          cssRecipe: undefined,
        },
      ],
    ]);
    expect(resolveAlias('#/group/$root', baseIndex)).toBe('var(--test-group-root)');
  });
});
