import { describe, expect, test } from 'bun:test';

import { TokenValidationError } from './types.ts';
import { resolutionOrderTarget, validateResolverDocument } from './validate-resolver.ts';
import { validateTokenDocumentSchema } from './validate-schema.ts';
import { validateTokenDocument } from './validate-tokens.ts';
import { assertValidResolverDocument } from './validate.ts';

/** The path-addressed reasons a validator reports for `run`, or a failure if it reports none. */
function issuesOf(run: () => void): Array<{ path: string; reason: string }> {
  try {
    run();
  } catch (error) {
    if (error instanceof TokenValidationError) return error.issues;
    throw error;
  }
  throw new Error('expected the validator to report issues');
}

const order = [{ $ref: '#/sets/shared' }];
const sets = { shared: { sources: [{ $ref: 'shared.tokens.json' }] } };

describe('the semantic token validator, run without the schema gate', () => {
  test('reports an unknown $type on a group or token', () => {
    const issues = issuesOf(() =>
      validateTokenDocument({ $type: 'bogus', a: { $value: 1 } }, 'doc.json'),
    );
    expect(issues).toContainEqual({ path: 'doc.json', reason: 'unknown $type "bogus"' });
  });

  test('reports a $root that is not a token object', () => {
    const issues = issuesOf(() => validateTokenDocument({ group: { $root: 'nope' } }));
    expect(issues).toContainEqual({
      path: '$.group.$root',
      reason: '$root must be a token object',
    });
  });

  test('reports a child that is neither a token nor a group', () => {
    const issues = issuesOf(() => validateTokenDocument({ $type: 'number', a: 'not an object' }));
    expect(issues).toContainEqual({ path: '$.a', reason: 'token or group must be an object' });
  });

  test('reports a composite member that is missing', () => {
    const issues = issuesOf(() =>
      validateTokenDocument({ shadow: { $type: 'shadow', $value: {} } }),
    );
    expect(issues.map((issue) => issue.reason)).toContain('composite value must include color');
  });

  test('reports a shadow layer that is not an object', () => {
    const issues = issuesOf(() =>
      validateTokenDocument({ shadow: { $type: 'shadow', $value: [1] } }),
    );
    expect(issues).toContainEqual({ path: '$.shadow.0', reason: 'shadow must be an object' });
  });

  test('reports a gradient stop that is not an object', () => {
    const issues = issuesOf(() =>
      validateTokenDocument({ ramp: { $type: 'gradient', $value: [1, 2] } }),
    );
    expect(issues).toContainEqual({
      path: '$.ramp.0',
      reason: 'gradient stop must be an object',
    });
  });
});

describe('the semantic token validator, group and token metadata', () => {
  const reasonsOf = (document: Record<string, unknown>) =>
    issuesOf(() => validateTokenDocument(document)).map((issue) => issue.reason);

  test('reports a $schema that is not a string, or that is not on the document root', () => {
    expect(reasonsOf({ $schema: 7, a: { $type: 'number', $value: 1 } })).toContain(
      '$schema must be a root-level string URI',
    );
    expect(
      reasonsOf({
        group: { $schema: 'https://example.com/schema.json', a: { $type: 'number', $value: 1 } },
      }),
    ).toContain('$schema must be a root-level string URI');
  });

  test('reports a $description that is not a string', () => {
    expect(reasonsOf({ $description: 7, a: { $type: 'number', $value: 1 } })).toContain(
      '$description must be a string',
    );
  });

  test('reports a $deprecated that is neither a boolean nor a string', () => {
    expect(reasonsOf({ a: { $type: 'number', $value: 1, $deprecated: 7 } })).toContain(
      '$deprecated must be a boolean or string',
    );
  });

  test('reports an $extensions key that is not a vendor name', () => {
    expect(
      reasonsOf({ a: { $type: 'number', $value: 1, $extensions: { 'not a vendor': true } } }),
    ).toContain('$extensions key not a vendor is not a vendor name');
  });
});

describe('the semantic token validator, composite values', () => {
  const dimension = (value: number) => ({ value, unit: 'px' });
  const reasonsOf = (token: Record<string, unknown>) =>
    issuesOf(() => validateTokenDocument({ token })).map((issue) => issue.reason);

  test('reports a negative stroke dash length', () => {
    expect(
      reasonsOf({
        $type: 'strokeStyle',
        $value: { dashArray: [dimension(-1)], lineCap: 'round' },
      }),
    ).toContain('stroke dash length must be non-negative');
  });

  test('reports a typography value with no line height', () => {
    expect(
      reasonsOf({
        $type: 'typography',
        $value: {
          fontFamily: 'Inter',
          fontSize: dimension(16),
          fontWeight: 400,
          letterSpacing: dimension(0),
        },
      }),
    ).toContain('composite value must include lineHeight');
  });

  test('reports a negative typography font size', () => {
    expect(
      reasonsOf({
        $type: 'typography',
        $value: {
          fontFamily: 'Inter',
          fontSize: dimension(-16),
          fontWeight: 400,
          letterSpacing: dimension(0),
          lineHeight: 1.5,
        },
      }),
    ).toContain('typography fontSize must be non-negative');
  });

  test('reports a negative border width', () => {
    expect(
      reasonsOf({
        $type: 'border',
        $value: {
          color: { colorSpace: 'srgb', components: [0, 0, 0] },
          width: dimension(-1),
          style: 'solid',
        },
      }),
    ).toContain('border width must be non-negative');
  });

  test('reports a transition that is not an object', () => {
    expect(reasonsOf({ $type: 'transition', $value: 5 })).toContain(
      'transition must include duration, delay, and timingFunction',
    );
  });
});

describe('the resolver reference parser', () => {
  test('refuses a name that carries an unknown ~ escape or ends in a bare ~', () => {
    expect(resolutionOrderTarget('#/sets/bad~2name')).toBeUndefined();
    expect(resolutionOrderTarget('#/sets/trailing~')).toBeUndefined();
    expect(resolutionOrderTarget('#/sets/a~1b~0c')).toEqual({ kind: 'sets', name: 'a/b~c' });
  });
});

describe('the schema gate over a document with arrays where groups belong', () => {
  test('rejects an array in place of a group, naming its path', () => {
    const issues = issuesOf(() =>
      validateTokenDocumentSchema({ group: { list: [{ $value: 1 }] } }, 'doc.json'),
    );
    expect(issues.map((issue) => issue.path)).toContain('doc.json.group.list');
  });
});

describe('the semantic resolver validator, run without the schema gate', () => {
  test('reports a modifier with no contexts object', () => {
    const issues = issuesOf(() =>
      validateResolverDocument({
        version: '2025.10',
        sets,
        modifiers: { theme: 1 },
        resolutionOrder: order,
      }),
    );
    expect(issues).toContainEqual({
      path: '$.modifiers.theme',
      reason: 'modifier must have a contexts object',
    });
  });

  test('reports a resolver whose version is not 2025.10', () => {
    const issues = issuesOf(() =>
      validateResolverDocument({
        version: '2024.01',
        sets,
        modifiers: {},
        resolutionOrder: order,
      }),
    );
    expect(issues).toContainEqual({
      path: '$.version',
      reason: 'resolver version must be 2025.10',
    });
  });

  test('reports a resolution order entry that is not a $ref object', () => {
    const issues = issuesOf(() =>
      validateResolverDocument({
        version: '2025.10',
        sets,
        modifiers: {},
        resolutionOrder: [...order, 1],
      }),
    );
    expect(issues).toContainEqual({
      path: '$.resolutionOrder.1',
      reason: 'resolutionOrder entry must be a $ref object',
    });
  });

  test('assertValidResolverDocument rejects a resolver that omits its sets or modifiers', () => {
    expect(
      issuesOf(() =>
        assertValidResolverDocument({ version: '2025.10', modifiers: {}, resolutionOrder: order }),
      ),
    ).toEqual([
      { path: '$', reason: 'resolver must contain version, sets, modifiers, and resolutionOrder' },
    ]);
  });
});

describe('the schema gate over a failing lookup', () => {
  test('lets a failure that is not a validation error through unchanged', () => {
    const failure = new Error('source lookup failed');
    const sources = new Map<object, string>();
    sources.get = () => {
      throw failure;
    };
    let thrown: unknown;
    try {
      validateTokenDocumentSchema({ a: { $type: 'number', $value: 1 } }, 'doc.json', [], sources);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBe(failure);
  });
});
