import { describe, expect, test } from 'bun:test';

import {
  buildBaselineEntries,
  classifyReference,
  componentDirKey,
  componentOwnedPrefix,
  countByKey,
  defaultScanRoots,
  extractExamplesJsonSurfaces,
  extractStyleSurface,
  findDeclaredNames,
  findReferences,
  findRegressions,
  flagKey,
  isExamplesJsonPath,
  isTestPath,
  matchesPrefix,
  parseBaseline,
  parseGlobalTokens,
  readBaseline,
  scan,
  toPosixPath,
  tokenRegistryPath,
} from './check-component-css-token-usage.ts';

describe('parseGlobalTokens', () => {
  function registry(entries: ReadonlyArray<{ cssProperty: string; public: boolean }>): string {
    return JSON.stringify({ entries });
  }

  test('collects the public tokens the registry declares', () => {
    const tokens = parseGlobalTokens(
      registry([
        { cssProperty: '--cinder-space-4', public: true },
        { cssProperty: '--cinder-radius-md', public: true },
      ]),
    );
    expect(tokens.has('--cinder-space-4')).toBe(true);
    expect(tokens.has('--cinder-radius-md')).toBe(true);
  });

  // The distinction the old CSS scan could not make at all: a private token is
  // declared and emitted like any other, but it is not a global a component may
  // reference, so it must not count as one here.
  test('excludes a private token even though the registry lists it', () => {
    const tokens = parseGlobalTokens(
      registry([
        { cssProperty: '--cinder-accent-solid', public: true },
        { cssProperty: '--_cinder-internal-gap', public: false },
      ]),
    );
    expect(tokens.has('--cinder-accent-solid')).toBe(true);
    expect(tokens.has('--_cinder-internal-gap')).toBe(false);
  });

  test('an empty registry yields no globals rather than throwing', () => {
    expect(parseGlobalTokens(registry([])).size).toBe(0);
  });
});

describe('findReferences — var() reference extraction', () => {
  test('captures a simple reference with its line number', () => {
    const refs = findReferences('a\n.x { color: var(--cinder-accent-solid); }');
    expect(refs).toEqual([{ name: '--cinder-accent-solid', lineNumber: 2 }]);
  });

  test('captures BOTH names in a nested var() fallback', () => {
    const refs = findReferences(
      '.x { background: var(--cinder-toggle-track-off, var(--cinder-border-muted)); }',
    );
    expect(refs.map((r) => r.name)).toEqual(['--cinder-toggle-track-off', '--cinder-border-muted']);
  });

  test('captures private --_cinder references too (so they can be classified)', () => {
    const refs = findReferences('.x { color: var(--_cinder-internal); }');
    expect(refs.map((r) => r.name)).toEqual(['--_cinder-internal']);
  });

  test('ignores a non-cinder var()', () => {
    expect(findReferences('.x { color: var(--other-thing); }')).toEqual([]);
  });
});

describe('findDeclaredNames — what a component owns', () => {
  test('collects a CSS LHS declaration', () => {
    expect(
      findDeclaredNames('.x { --cinder-kanban-column-width: 18rem; }').has(
        '--cinder-kanban-column-width',
      ),
    ).toBe(true);
  });

  test('collects a JS setProperty name', () => {
    const declared = findDeclaredNames(
      "shell.style.setProperty('--cinder-toast-height', `${h}px`);",
    );
    expect(declared.has('--cinder-toast-height')).toBe(true);
  });

  test('does NOT collect a plain var() reference as declared', () => {
    expect(
      findDeclaredNames('.x { color: var(--cinder-accent-solid); }').has('--cinder-accent-solid'),
    ).toBe(false);
  });

  test('does NOT falsely collect a name that appears as a var() fallback', () => {
    // Regression: var(--cinder-a, --cinder-b: fallback) must not add --cinder-b
    // to the declared set. Without stripping var() before scanning, the naive
    // `--name:` pattern would match --cinder-b as a declaration.
    const declared = findDeclaredNames('.x { color: var(--cinder-a, --cinder-b: fallback); }');
    expect(declared.has('--cinder-b')).toBe(false);
    expect(declared.has('--cinder-a')).toBe(false); // also a reference, not a declaration
  });

  test('handles nested var() fallbacks', () => {
    const declared = findDeclaredNames(
      '.x { background: var(--cinder-x, var(--cinder-y, --cinder-z: 0)); }',
    );
    expect(declared.has('--cinder-z')).toBe(false);
  });
});

describe('componentOwnedPrefix / componentDirKey', () => {
  test('derives the prefix from the component directory', () => {
    expect(componentOwnedPrefix('src/components/color-picker/color-picker.css')).toBe(
      '--cinder-color-picker',
    );
    expect(componentDirKey('src/components/color-picker/color-picker.css')).toBe('color-picker');
  });

  test('returns null for a bare file with no component directory', () => {
    expect(componentOwnedPrefix('src/components/_sortable-item.svelte')).toBeNull();
    expect(componentDirKey('src/components/_sortable-item.svelte')).toBeNull();
  });
});

describe('matchesPrefix — hyphen-boundary safety', () => {
  test('matches exact and hyphen-extended names', () => {
    expect(matchesPrefix('--cinder-toast', '--cinder-toast')).toBe(true);
    expect(matchesPrefix('--cinder-toast-height', '--cinder-toast')).toBe(true);
  });

  test('does NOT match a different token that merely shares a leading substring', () => {
    // `--cinder-toast` must not own `--cinder-toaster-*` or `--cinder-toastx`.
    expect(matchesPrefix('--cinder-toaster-x', '--cinder-toast')).toBe(false);
    expect(matchesPrefix('--cinder-toastx', '--cinder-toast')).toBe(false);
  });
});

describe('classifyReference — the resolution model', () => {
  const globals = new Set(['--cinder-accent-solid', '--cinder-space-4']);

  test('private --_cinder-* is private', () => {
    expect(classifyReference('--_cinder-x', [], new Set(), globals)).toBe('private');
  });

  test('a declared global token is global', () => {
    expect(classifyReference('--cinder-accent-solid', [], new Set(), globals)).toBe('global');
  });

  test('a reference matching the file prefix is component-owned', () => {
    expect(
      classifyReference('--cinder-color-picker-hue', ['--cinder-color-picker'], new Set(), globals),
    ).toBe('component-owned');
  });

  test('a SHORTENED-prefix own var resolves via the declared set, not the dir prefix', () => {
    // toast-region/ dir → prefix --cinder-toast-region, but the var is --cinder-toast-height.
    // The prefix does NOT match; the declared set (collected from setProperty) does.
    expect(
      classifyReference('--cinder-toast-height', ['--cinder-toast-region'], new Set(), globals),
    ).toBe('unresolved');
    expect(
      classifyReference(
        '--cinder-toast-height',
        ['--cinder-toast-region'],
        new Set(['--cinder-toast-height']),
        globals,
      ),
    ).toBe('component-owned');
  });

  test('the surface/ collision: --cinder-surface-muted from a non-surface file is unresolved', () => {
    // feed.css owns --cinder-feed, NOT --cinder-surface. Even though a `surface/`
    // component dir exists, per-file-prefix means feed does not own surface-*.
    expect(classifyReference('--cinder-surface-muted', ['--cinder-feed'], new Set(), globals)).toBe(
      'unresolved',
    );
  });

  test('an unknown token is unresolved', () => {
    expect(classifyReference('--cinder-totally-fake', ['--cinder-x'], new Set(), globals)).toBe(
      'unresolved',
    );
  });
});

describe('toPosixPath / isTestPath', () => {
  test('toPosixPath converts backslashes', () => {
    expect(toPosixPath('a\\b')).toBe('a/b');
  });

  test('isTestPath matches test/spec, not real sources', () => {
    expect(isTestPath('x/x.test.ts')).toBe(true);
    expect(isTestPath('x/x.css')).toBe(false);
  });

  // COR-344: *.examples.json used to be excluded from BOTH the declaration and
  // reference passes via isTestPath. It is no longer a test path at all — it
  // is excluded from declarations only (isExamplesJsonPath, checked directly
  // in `scan`), so a stale reference inside one is no longer invisible.
  test('isTestPath no longer treats *.examples.json as a test path', () => {
    expect(isTestPath('x/x.examples.json')).toBe(false);
  });

  test('isExamplesJsonPath matches *.examples.json only', () => {
    expect(isExamplesJsonPath('x/x.examples.json')).toBe(true);
    expect(isExamplesJsonPath('x/x.example.json')).toBe(false);
    expect(isExamplesJsonPath('x/x.css')).toBe(false);
  });
});

describe('componentOwnedPrefix / componentDirKey — a non-default componentsPrefix', () => {
  // COR-344: chat and editor components live under `.../src/lib/components/`,
  // not Cinder's `src/components/`. The same ownership rule must apply there.
  test('resolves the owning prefix under a package-qualified components root', () => {
    expect(
      componentOwnedPrefix(
        'chat/src/lib/components/chat-navigation-rail/chat-navigation-rail.css',
        'chat/src/lib/components',
      ),
    ).toBe('--cinder-chat-navigation-rail');
    expect(
      componentDirKey(
        'chat/src/lib/components/chat-navigation-rail/chat-navigation-rail.css',
        'chat/src/lib/components',
      ),
    ).toBe('chat-navigation-rail');
  });

  test('a path outside the given componentsPrefix resolves to null', () => {
    expect(componentOwnedPrefix('chat/src/lib/chat.css', 'chat/src/lib/components')).toBeNull();
  });
});

describe('extractStyleSurface — inline style="…" attributes (COR-344)', () => {
  test('keeps a var() reference inside an inline style attribute', () => {
    const surface = extractStyleSurface(
      '<div style="border: 1px solid var(--cinder-border-subtle);">x</div>',
      true,
    );
    expect(findReferences(surface).map((r) => r.name)).toEqual(['--cinder-border-subtle']);
  });

  test('still keeps a <style> block reference alongside an inline one', () => {
    const source = [
      '<div style="color: var(--cinder-inline-only);">x</div>',
      '<style>',
      '  div { background: var(--cinder-block-only); }',
      '</style>',
    ].join('\n');
    const names = findReferences(extractStyleSurface(source, true)).map((r) => r.name);
    expect(names).toEqual(['--cinder-inline-only', '--cinder-block-only']);
  });

  test('does not treat a style:property={expr} directive as an inline style', () => {
    const surface = extractStyleSurface(
      '<div style:color={"var(--cinder-should-not-appear)"}>x</div>',
      true,
    );
    expect(findReferences(surface)).toEqual([]);
  });

  test('reports the inline reference on its own source line', () => {
    const source = 'line one\n<div style="color: var(--cinder-line-two);">x</div>';
    expect(findReferences(extractStyleSurface(source, true))).toEqual([
      { name: '--cinder-line-two', lineNumber: 2 },
    ]);
  });
});

describe('extractExamplesJsonSurfaces (COR-344)', () => {
  test('extracts each example code snippet, keyed by id', () => {
    const source = JSON.stringify({
      $schema: 'examples.schema.json',
      component: 'widget',
      import: '@lostgradient/widget',
      examples: [
        {
          id: 'basic',
          title: 't',
          description: 'd',
          code: '<div style="color: var(--cinder-a);">x</div>',
        },
        {
          id: 'other',
          title: 't',
          description: 'd',
          code: '<div style="color: var(--cinder-b);">x</div>',
        },
      ],
    });
    const surfaces = extractExamplesJsonSurfaces(source);
    expect(surfaces.map((s) => s.id)).toEqual(['basic', 'other']);
    expect(findReferences(surfaces[0]!.surface).map((r) => r.name)).toEqual(['--cinder-a']);
    expect(findReferences(surfaces[1]!.surface).map((r) => r.name)).toEqual(['--cinder-b']);
  });

  test('returns an empty array for malformed JSON rather than throwing', () => {
    expect(extractExamplesJsonSurfaces('{ not json')).toEqual([]);
  });

  test('returns an empty array when `examples` is missing or not an array', () => {
    expect(extractExamplesJsonSurfaces('{}')).toEqual([]);
    expect(extractExamplesJsonSurfaces('{ "examples": "nope" }')).toEqual([]);
  });
});

describe('workspace-wide gate (COR-344)', () => {
  // This is the actual CI/`bun run validate` gate: it scans the real,
  // committed workspace tree (Cinder + chat + editor +
  // browser-fixtures — see `defaultScanRoots`) and fails the moment any
  // `--cinder-*` reference is undeclared beyond what `token-usage-baseline.json`
  // already accepts. `check-component-css-token-usage.ts --strict` (the CLI
  // entry point, wired to `tokens:audit`) performs the identical scan +
  // regression check; this test is what makes that check run automatically
  // under `bun test` instead of requiring someone to remember to run it by hand.
  test('no --cinder-* reference is undeclared beyond the committed baseline', async () => {
    const globals = parseGlobalTokens(await Bun.file(tokenRegistryPath).text());
    const flags = await scan(globals, defaultScanRoots());
    const unresolved = flags.filter((flag) => flag.category === 'unresolved');
    const baseline = await readBaseline();
    const regressions = findRegressions(unresolved, baseline);
    expect(regressions).toEqual([]);
  });
});

describe('count-based baseline + regression detection (unresolved only)', () => {
  const flags = [
    { filePath: 'src/components/a/a.css', name: '--cinder-stale-one' },
    { filePath: 'src/components/a/a.css', name: '--cinder-stale-one' },
    { filePath: 'src/components/b/b.css', name: '--cinder-stale-two' },
  ];

  test('countByKey aggregates by file + name', () => {
    expect(
      countByKey(flags).get(
        flagKey({ filePath: 'src/components/a/a.css', name: '--cinder-stale-one' }),
      ),
    ).toBe(2);
  });

  test('buildBaselineEntries dedupes to one entry per key with the count', () => {
    const entries = buildBaselineEntries(flags);
    expect(entries).toHaveLength(2);
    expect(entries.find((e) => e.name === '--cinder-stale-one')?.allowedCount).toBe(2);
  });

  test('findRegressions flags a count above baseline (not vacuous)', () => {
    const baseline = parseBaseline(buildBaselineEntries(flags));
    const withExtra = [
      ...flags,
      { filePath: 'src/components/a/a.css', name: '--cinder-stale-one' },
    ];
    const regressions = findRegressions(withExtra, baseline);
    expect(regressions).toHaveLength(1);
    expect(regressions[0]).toMatchObject({ name: '--cinder-stale-one', allowed: 2, found: 3 });
  });

  test('findRegressions correctly recovers filePath and name from typed flags', () => {
    const baseline = parseBaseline([]);
    const regressions = findRegressions(
      [{ filePath: 'src/components/c/c.css', name: '--cinder-new' }],
      baseline,
    );
    expect(regressions[0]).toMatchObject({
      filePath: 'src/components/c/c.css',
      name: '--cinder-new',
      allowed: 0,
      found: 1,
    });
  });

  test('equal-to-baseline counts do not regress', () => {
    const baseline = parseBaseline(buildBaselineEntries(flags));
    expect(findRegressions(flags, baseline)).toEqual([]);
  });

  test('parseBaseline throws on malformed input', () => {
    expect(() => parseBaseline({})).toThrow();
    expect(() => parseBaseline([{ filePath: 'x' }])).toThrow();
  });
});
