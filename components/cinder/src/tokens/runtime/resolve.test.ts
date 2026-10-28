import { describe, expect, test } from 'bun:test';

import { resolveRefToken } from './resolve-references.ts';
import { getByPath, pointerSegments, type ResolvedTokens } from './resolve-shared.ts';
import { mergeAndExpandExtends, mergeDocuments, resolveDocuments } from './resolve.ts';
import { expandContextSources, expandSetSources } from './resolver-order.ts';
import type { ResolverDocument, TokenDocument } from './types.ts';
import { TokenValidationError } from './types.ts';

function reasonOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof TokenValidationError) return error.issues[0]!.reason;
    throw error;
  }
  throw new Error('expected a TokenValidationError');
}

function resolverWith(sourceRef: string): ResolverDocument {
  return {
    version: '2025.10',
    sets: { shared: { sources: [{ $ref: sourceRef }] } },
    modifiers: { theme: { contexts: { light: [{ $ref: sourceRef }] } } },
    resolutionOrder: [{ $ref: '#/sets/shared' }, { $ref: '#/modifiers/theme' }],
  };
}

describe('resolver-internal references', () => {
  test('a set source that is not a well-formed #/sets/<name> pointer is malformed', () => {
    expect(reasonOf(() => expandSetSources(resolverWith('#/nonsense'), 'shared'))).toBe(
      'malformed resolver-internal reference: #/nonsense',
    );
  });

  test('a modifier context source that is not a well-formed pointer is malformed', () => {
    expect(reasonOf(() => expandContextSources(resolverWith('#/nonsense'), 'theme', 'light'))).toBe(
      'malformed resolver-internal reference: #/nonsense',
    );
  });

  test('an unknown modifier context is named, not guessed', () => {
    expect(
      reasonOf(() => expandContextSources(resolverWith('a.tokens.json'), 'theme', 'dark')),
    ).toBe('resolver-internal reference names an unknown modifier context: dark');
    expect(
      reasonOf(() => expandContextSources(resolverWith('a.tokens.json'), 'nope', 'light')),
    ).toBe('resolver-internal reference names an unknown modifier context: light');
  });
});

describe('JSON Pointer reading', () => {
  test('a pointer with an invalid percent escape is reported', () => {
    expect(reasonOf(() => pointerSegments('#/a/%E0%A4%A'))).toBe(
      'JSON Pointer contains invalid percent encoding',
    );
  });

  test('walks into arrays by canonical index and refuses every other segment', () => {
    const value = { list: [{ name: 'first' }, { name: 'second' }] };
    expect(getByPath(value, ['list', '1', 'name'])).toBe('second');
    expect(getByPath(value, ['list', 'length'])).toBeUndefined();
    expect(getByPath(value, ['list', '01'])).toBeUndefined();
    expect(getByPath(value, ['list', '9'.repeat(400)])).toBeUndefined();
    expect(getByPath(value, ['list', '5', 'name'])).toBeUndefined();
  });
});

describe('document merging', () => {
  test('an override that does not restate $deprecated keeps the base token deprecated', () => {
    const merged = mergeDocuments([
      { size: { $type: 'number', $value: 1, $deprecated: 'use scale' } },
      { size: { $value: 2 } },
    ]);
    expect(merged['size']).toMatchObject({ $value: 2, $deprecated: 'use scale', $type: 'number' });
  });

  test('a nested group inherits an $extends it never declared, remembering where it was written', () => {
    const document: TokenDocument = {
      src: { t: { $type: 'number', $value: 1 } },
      base: { inner: { $extends: '{src}' } },
      derived: { $extends: '{base}', inner: { u: { $type: 'number', $value: 2 } } },
    };
    const origins = new Map<object, string>([[document, 'doc.tokens.json']]);
    const merged = mergeAndExpandExtends([document], [document], origins);
    const inner = (merged['derived'] as TokenDocument)['inner'] as TokenDocument;
    expect(Object.keys(inner)).toEqual(expect.arrayContaining(['u', 't']));
  });
});

describe('$extends', () => {
  test('merges a nested group the extended group also declares', () => {
    const merged = mergeAndExpandExtends(
      [
        {
          base: { inner: { t: { $type: 'number', $value: 1 } } },
          derived: { $extends: '{base}', inner: { u: { $type: 'number', $value: 2 } } },
        },
      ],
      [],
    );
    const inner = (merged['derived'] as TokenDocument)['inner'] as TokenDocument;
    expect(Object.keys(inner).toSorted()).toEqual(['t', 'u']);
  });

  test('merges groups nested two levels deep that both sides declare', () => {
    const merged = mergeAndExpandExtends(
      [
        {
          base: { outer: { inner: { t: { $type: 'number', $value: 1 } } } },
          derived: {
            $extends: '{base}',
            outer: { inner: { u: { $type: 'number', $value: 2 } } },
          },
        },
      ],
      [],
    );
    const outer = (merged['derived'] as TokenDocument)['outer'] as TokenDocument;
    expect(Object.keys((outer['inner'] as TokenDocument) ?? {}).toSorted()).toEqual(['t', 'u']);
  });

  test('refuses a group that extends a group nested inside itself', () => {
    expect(
      reasonOf(() =>
        mergeAndExpandExtends(
          [{ a: { $extends: '{a.inner}', inner: { t: { $type: 'number', $value: 1 } } } }],
          [],
        ),
      ),
    ).toBe('circular $extends reference');
  });

  test('a group that states its own $deprecated keeps it while it inherits members', () => {
    const merged = mergeAndExpandExtends(
      [
        {
          base: { x: { $type: 'number', $value: 1 } },
          derived: { $extends: '{base}', $deprecated: 'use base' },
        },
      ],
      [],
    );
    expect(merged['derived']).toMatchObject({ $deprecated: 'use base', x: { $value: 1 } });
  });

  test('refuses groups that extend each other', () => {
    expect(
      reasonOf(() =>
        mergeAndExpandExtends([{ a: { $extends: '{b}' }, b: { $extends: '{a}' } }], []),
      ),
    ).toBe('circular $extends reference');
  });
});

describe('$ref to document and $root metadata', () => {
  test('reads a metadata property of the document group', () => {
    expect(
      resolveDocuments([{ $description: 'hi', copy: { $type: 'string', $ref: '#/$description' } }]),
    ).toMatchObject({ copy: { $value: 'hi' } });
  });

  test('reads the $deprecated a group declares', () => {
    expect(
      resolveDocuments([
        {
          group: { $deprecated: 'use other', $type: 'number', a: { $value: 1 } },
          copy: { $type: 'string', $ref: '#/group/$deprecated' },
        },
      ]),
    ).toMatchObject({ copy: { $value: 'use other' } });
  });

  test('reports a document metadata property that is not there', () => {
    expect(
      reasonOf(() => resolveDocuments([{ copy: { $type: 'number', $ref: '#/$description' } }])),
    ).toBe(
      'unresolvable $ref "#/$description": reference target document group has no requested property',
    );
  });

  test('reports a $root property that is not there, including its raw $ref', () => {
    for (const property of ['$description', '$ref']) {
      expect(
        reasonOf(() =>
          resolveDocuments([
            {
              $root: { $type: 'number', $value: 1 },
              copy: { $type: 'number', $ref: `#/$root/${property}` },
            },
          ]),
        ),
      ).toBe(
        `unresolvable $ref "#/$root/${property}": reference target $root has no requested property`,
      );
    }
  });

  test('lets a failure that is not a validation error through unchanged', () => {
    const failure = new Error('token lookup failed');
    const tokens: ResolvedTokens = new Map();
    tokens.get = () => {
      throw failure;
    };
    let thrown: unknown;
    try {
      resolveRefToken(
        'copy',
        { $type: 'number', $ref: '{target}' },
        tokens,
        new Map(),
        new Set(),
        new Set(),
        new Map(),
        new Set(),
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBe(failure);
  });
});
