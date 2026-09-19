import { describe, expect, test } from 'bun:test';
import { collectEntries, type CorpusEntry } from './corpus.ts';
import { assertUniqueCssProperties } from './css-support.ts';
import { mergeAndExpandExtends } from './resolve.ts';
function entry(
  path: string,
  cssProperty: string | undefined,
  value: unknown = { value: 1, unit: 'rem' },
): [string, CorpusEntry] {
  return [
    path,
    {
      path,
      value,
      type: 'dimension',
      description: undefined,
      cssProperty,
      cssRecipe: undefined,
    },
  ];
}

function entriesForGroup(group: Parameters<typeof collectEntries>[0]) {
  const into = new Map<string, CorpusEntry>();
  collectEntries(group, '', undefined, into);
  return into;
}

function entriesForDocuments(documents: Parameters<typeof mergeAndExpandExtends>[0]) {
  const into = new Map<string, CorpusEntry>();
  collectEntries(mergeAndExpandExtends(documents), '', undefined, into);
  return into;
}

describe('CIN-29 review round 5', () => {
  test('G1: one cssProperty claimed with conflicting values is rejected, not silently cascaded', () => {
    // tokens:validate cannot catch this -- the mapping lives in vendor extension data, which
    // the DTCG schema treats as free-form. Undetected, CSS keeps whichever declaration lands
    // last while the resolved snapshots go on exposing both token paths.
    const conflicting = new Map<string, CorpusEntry>([
      entry('space.one', '--test-space', { value: 1, unit: 'rem' }),
      entry('space.uno', '--test-space', { value: 2, unit: 'rem' }),
    ]);
    expect(() => assertUniqueCssProperties(conflicting)).toThrow(
      /--test-space is claimed with conflicting values by space\.one, space\.uno/,
    );
  });

  test('G1: one cssProperty shared with an IDENTICAL value is allowed', () => {
    // $extends inheritance legitimately produces two paths for one property -- the extending
    // group inherits members verbatim, extension metadata included -- and they emit the same
    // declaration twice, which is redundant but harmless. Flagging it would break E3.
    const inherited = new Map<string, CorpusEntry>([
      entry('foundation.swatch', '--test-swatch', { value: 1, unit: 'rem' }),
      entry('themed.swatch', '--test-swatch', { value: 1, unit: 'rem' }),
    ]);
    expect(() => assertUniqueCssProperties(inherited)).not.toThrow();
  });

  test('G1: distinct mappings pass, and tokens without a cssProperty are ignored', () => {
    const distinct = new Map<string, CorpusEntry>([
      entry('space.one', '--test-space-one'),
      entry('space.two', '--test-space-two'),
    ]);
    expect(() => assertUniqueCssProperties(distinct)).not.toThrow();

    const untracked = new Map<string, CorpusEntry>([entry('a', undefined), entry('b', undefined)]);
    expect(() => assertUniqueCssProperties(untracked)).not.toThrow();
  });
});

describe('CIN-30 review round 11: group $deprecated inherits like $type', () => {
  // DTCG makes `$deprecated` inheritable the way `$type` is, and the flattened
  // corpus keeps no group records -- so without carrying it down, a deprecated
  // group's children were all reported `deprecated: undefined` and registry
  // consumers would surface them as current.
  test('a child with no $deprecated inherits its group state', () => {
    const entries = entriesForGroup({
      legacy: {
        $type: 'dimension',
        $deprecated: 'Use space.* instead.',
        gutter: { $value: { value: 1, unit: 'rem' } },
        inner: {
          nested: { $value: { value: 2, unit: 'rem' } },
        },
      },
    });

    expect(entries.get('legacy.gutter')?.deprecated).toBe('Use space.* instead.');
    // Inheritance reaches through an intermediate group, not just direct children.
    expect(entries.get('legacy.inner.nested')?.deprecated).toBe('Use space.* instead.');
  });

  test("a child's own $deprecated wins over the group's", () => {
    const entries = entriesForGroup({
      legacy: {
        $type: 'dimension',
        $deprecated: 'Group reason.',
        gutter: { $value: { value: 1, unit: 'rem' }, $deprecated: 'Token reason.' },
      },
    });

    expect(entries.get('legacy.gutter')?.deprecated).toBe('Token reason.');
  });

  // `false` on a nested group is a real value, not an absence: it un-deprecates
  // that subtree. Merging with `||` instead of `??` would silently ignore it.
  test('a nested group can un-deprecate itself with $deprecated: false', () => {
    const entries = entriesForGroup({
      legacy: {
        $type: 'dimension',
        $deprecated: true,
        kept: {
          $deprecated: false,
          gutter: { $value: { value: 1, unit: 'rem' } },
        },
        dropped: { $value: { value: 2, unit: 'rem' } },
      },
    });

    expect(entries.get('legacy.kept.gutter')?.deprecated).toBe(false);
    expect(entries.get('legacy.dropped')?.deprecated).toBe(true);
  });

  test('a $root token inherits its own group state', () => {
    const entries = entriesForGroup({
      legacy: {
        $type: 'dimension',
        $deprecated: 'Gone soon.',
        $root: { $value: { value: 1, unit: 'rem' } },
      },
    });

    expect(entries.get('legacy')?.deprecated).toBe('Gone soon.');
  });

  test('an undeprecated group still yields undefined, not false', () => {
    const entries = entriesForGroup({
      space: { $type: 'dimension', gutter: { $value: { value: 1, unit: 'rem' } } },
    });

    expect(entries.get('space.gutter')?.deprecated).toBeUndefined();
  });
});

describe('CIN-471: $deprecated carries through $extends expansion', () => {
  // `mergeAndExpandExtends` (via `resolveExtends`) already copies an extended
  // group's members and `$type` into the group that extends it; before this
  // fix it dropped `$deprecated`, so a group extending a deprecated group
  // came out looking current -- registry consumers had no way to know.
  test('a group extending a $deprecated group yields deprecated descendants', () => {
    const entries = entriesForDocuments([
      {
        legacy: { $type: 'dimension', $deprecated: 'Use space.* instead.', gutter: { $value: 1 } },
        derived: { $extends: '{legacy}' },
      },
    ]);

    expect(entries.get('derived.gutter')?.deprecated).toBe('Use space.* instead.');
  });

  test("a descendant's own $deprecated wins over the extended group's", () => {
    const entries = entriesForDocuments([
      {
        legacy: {
          $type: 'dimension',
          $deprecated: 'Group reason.',
          gutter: { $value: 1 },
        },
        derived: {
          $extends: '{legacy}',
          gutter: { $value: 2, $deprecated: 'Token reason.' },
        },
      },
    ]);

    expect(entries.get('derived.gutter')?.deprecated).toBe('Token reason.');
  });

  // `$deprecated: false` is a real value, not an absence -- it un-deprecates a
  // subtree even beneath a deprecated `$extends` target, the same "??" rule
  // `collectEntries` already applies to ordinary group nesting.
  test('a descendant under a $deprecated: false group inside a deprecated extend target is not deprecated', () => {
    const entries = entriesForDocuments([
      {
        legacy: {
          $type: 'dimension',
          $deprecated: true,
          kept: { $deprecated: false, gutter: { $value: 1 } },
        },
        derived: { $extends: '{legacy}' },
      },
    ]);

    expect(entries.get('derived.kept.gutter')?.deprecated).toBe(false);
  });

  // Guards `group.$deprecated === undefined` rather than unconditionally
  // taking the extended group's value: an extending group that declares its
  // OWN $deprecated (including the real value `false`) must keep it, not
  // have it overwritten by what it extends.
  test('an extending group keeps its own $deprecated: false over a deprecated extend target', () => {
    const entries = entriesForDocuments([
      {
        legacy: { $type: 'dimension', $deprecated: true, gutter: { $value: 1 } },
        derived: { $extends: '{legacy}', $deprecated: false, other: { $value: 2 } },
      },
    ]);

    expect(entries.get('derived.gutter')?.deprecated).toBe(false);
    expect(entries.get('derived.other')?.deprecated).toBe(false);
  });

  // Regression: `resolveExtends` read the extended group's OWN `$deprecated`
  // property directly, which is `undefined` for a group that only inherits
  // deprecation from an ANCESTOR (via ordinary nesting, not $extends) --
  // ancestor-to-descendant propagation for ordinary nesting happens later, in
  // `collectEntries` at generation time, well after `$extends` has already
  // run. A group extending such a target lost the deprecation entirely, even
  // though every token under the target is itself effectively deprecated by
  // the time generation walks it.
  test('a group extending a target that only inherits $deprecated from an ancestor is deprecated too', () => {
    const entries = entriesForDocuments([
      {
        outer: {
          $type: 'dimension',
          $deprecated: 'Use space.* instead.',
          base: { gutter: { $value: 1 } },
        },
        derived: { $extends: '{outer.base}' },
      },
    ]);

    expect(entries.get('outer.base.gutter')?.deprecated).toBe('Use space.* instead.');
    expect(entries.get('derived.gutter')?.deprecated).toBe('Use space.* instead.');
  });

  test('a nested $extends target in the lookup scope preserves inherited deprecation when shadowed', () => {
    // `mergeAndExpandExtends(ownDocuments, lookupDocuments)` is how theme/motion
    // override contexts extend a foundation group -- here "outer.base" exists only
    // in the lookup scope and inherits $deprecated from the lookup scope's own
    // "outer". The override document ALSO declares its own non-deprecated "outer"
    // (a sibling override, not itself extending anything), which collectGroups loads
    // AFTER the lookup scope and so shadows it in the merged groups map.
    // effectiveGroupDeprecated then walks the OVERRIDING "outer", not the lookup
    const into = new Map<string, CorpusEntry>();
    collectEntries(
      mergeAndExpandExtends(
        [{ outer: { other: { $value: 1 } }, derived: { $extends: '{outer.base}' } }],
        [
          {
            outer: {
              $type: 'dimension',
              $deprecated: 'Use space.* instead.',
              base: { gutter: { $value: 1 } },
            },
          },
        ],
      ),
      '',
      undefined,
      into,
    );

    expect(into.get('derived.gutter')?.deprecated).toBe('Use space.* instead.');
  });

  test('ancestor extension order does not change inherited deprecation', () => {
    // "derived" (declared first) extends "outer.child" -- a plain nested
    // group with no $extends of its own. "outer" (declared second) extends
    // "legacy", which is where the real deprecation reason lives. Because
    // resolveExtends processes groups in `groups.keys()` order (collectGroups's
    // traversal order, which follows document declaration order), "derived"
    // is resolved BEFORE "outer" -- effectiveGroupDeprecated walks up from
    // "outer.child" through the not-yet-expanded "outer" (still undefined)
    // to the document root's declared $deprecated: false, and caches that.
    // Once "outer" is later expanded and gains "Legacy reason.", "derived"'s
    const entries = entriesForDocuments([
      {
        $deprecated: false,
        derived: { $extends: '{outer.child}' },
        outer: { $extends: '{legacy}', child: { grandchild: { $value: 1 } } },
        legacy: { $deprecated: 'Legacy reason.', marker: { $value: true } },
      },
    ]);

    expect(entries.get('derived.grandchild')?.deprecated).toBe('Legacy reason.');
  });
});
