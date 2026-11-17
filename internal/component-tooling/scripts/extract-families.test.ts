import { throwingRejectionOf } from '@lostgradient/testing';
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { foundationImportViolations } from './check-foundation-imports.ts';
import {
  deriveFamilies,
  deriveFromRepository,
  readPackageTree,
  type DerivedFamilies,
  type FamilyRules,
} from './derive-families.ts';
import { exportNames } from './export-names.ts';
import {
  extractFamilies,
  formatKeepingImportOrder,
  sideEffectImports,
  readComponentsCssOrder,
  selectPackages,
  walkFiles,
  type Selection,
} from './extract-families.ts';
import { specifierFor, virtualPathFor } from './split-layout.ts';

const CORE = 'components/core';

const RULES: FamilyRules = {
  packageRoot: CORE,
  componentsDirectory: 'src/components',
  coreTestsDirectory: 'src/component-tests',
  families: [],
  moves: [
    {
      patterns: ['src/tokens/**', 'src/styles/tokens.css', 'scripts/tokens/**'],
      target: 'tokens',
    },
    { patterns: ['src/_internal/card-context.ts'], target: 'card' },
    {
      patterns: [
        'src/index.ts',
        'src/styles/index.css',
        'src/styles/components.css',
        'src/exports/**',
      ],
      target: 'core',
    },
    { patterns: ['src/utilities/**', 'src/styles/**'], target: 'foundation' },
  ],
};

const CORE_MANIFEST = {
  name: '@lostgradient/cinder',
  private: true,
  type: 'module',
  exports: {
    '.': { types: './.types/src/index.d.ts', svelte: './src/index.ts', default: './src/index.ts' },
    './tokens/runtime': {
      types: './.types/src/tokens/runtime/index.d.ts',
      svelte: './src/tokens/runtime/index.ts',
      default: './src/tokens/runtime/index.ts',
    },
  },
  scripts: {
    lint: 'oxlint src scripts && bun run tokens:check',
    'tokens:check': 'bun scripts/tokens/check.ts',
  },
  dependencies: { '@floating-ui/dom': 'catalog:', svelte: 'catalog:' },
  devDependencies: { '@testing-library/svelte': 'catalog:' },
};

/** A small Cinder: tokens, a foundation, two families (card uses button), and core. */
const TREE: Record<string, string> = {
  [`${CORE}/package.json`]: `${JSON.stringify(CORE_MANIFEST, null, 2)}\n`,
  [`${CORE}/tsconfig.json`]: '{ "include": ["src"] }\n',
  [`${CORE}/tsconfig.browser.json`]: '{ "include": ["src"] }\n',
  [`${CORE}/bunfig.toml`]: '[run]\nbun = true\n',
  [`${CORE}/inherited-key-reads-allowlist.json`]: `${JSON.stringify(
    {
      description: 'Allowed reads.',
      entries: [
        { file: 'src/index.ts', expression: 'a[b]', count: 1, reason: 'core' },
        { file: 'src/utilities/focus.ts', expression: 'c[d]', count: 1, reason: 'foundation' },
      ],
    },
    null,
    2,
  )}\n`,
  [`${CORE}/scripts/tokens/check.ts`]:
    "import { resolveTokens } from '../../src/tokens/runtime/index.ts';\n\nconsole.log(resolveTokens);\n",
  [`${CORE}/src/index.ts`]: [
    "import './styles/index.css';",
    '',
    "export { default as Button } from './components/button/index.ts';",
    "export type { ButtonProps } from './components/button/index.ts';",
    "export { default as Card } from './components/card/index.ts';",
    "export { focus } from './utilities/focus.ts';",
    "export * from './tokens/runtime/index.ts';",
    "export * from './exports/extra.ts';",
    '',
  ].join('\n'),
  [`${CORE}/src/exports/extra.ts`]: "export { cardContext } from '../_internal/card-context.ts';\n",
  // A core test that reads other packages' files from its own directory: by a template on it, by
  // literal segments joined to it, and by a relative string resolved on it.
  [`${CORE}/src/exports/anchored.test.ts`]: [
    'const partial = `${import.meta.dir}/../styles/components/_partial.css`;',
    "const runtime = join(import.meta.dir, '..', 'tokens', 'runtime', file);",
    "const card = resolve(dirname(fileURLToPath(import.meta.url)), '../components/card/card.css');",
    "const own = join(import.meta.dirname, 'extra.ts');",
    '',
  ].join('\n'),
  [`${CORE}/src/styles/index.css`]:
    "@import './tokens.css' layer(cinder.tokens);\n@import './foundation.css' layer(cinder.foundation);\n",
  [`${CORE}/src/styles/tokens.css`]: ':root { --cinder-red: red; }\n',
  [`${CORE}/src/styles/foundation.css`]: 'body { margin: 0; }\n',
  [`${CORE}/src/styles/components/_partial.css`]: '.partial { color: blue; }\n',
  [`${CORE}/src/styles/components.css`]: [
    '/* The component stylesheets. */',
    '',
    "@import './components/_partial.css';",
    "@import '../components/card/card-surface.css';",
    "@import '../components/button/button.css';",
    '',
    '/* Card sits after button. */',
    "@import '../components/card/card.css';",
    '',
  ].join('\n'),
  [`${CORE}/src/tokens/runtime/index.ts`]:
    'export const resolveTokens = 1;\nexport type TokenSet = string;\n',
  [`${CORE}/src/utilities/focus.ts`]:
    "import { resolveTokens } from '../tokens/runtime/index.ts';\n\nexport const focus = resolveTokens;\n",
  [`${CORE}/src/_internal/card-context.ts`]: 'export const cardContext = Symbol();\n',
  // A foundation test that reads card's stylesheet by path: core holds card when foundation
  // moves, card's own package once card moves.
  [`${CORE}/src/utilities/focus.test.ts`]: [
    "const css = new URL('../components/card/card.css', import.meta.url);",
    "const joined = join(packageRoot, 'src', 'components', 'card', 'card.css');",
    '',
  ].join('\n'),
  [`${CORE}/src/components/button/index.ts`]: [
    "import './button.css';",
    "import Button from './button.svelte';",
    '',
    'export default Button;',
    "export type { ButtonProps } from './button.types.ts';",
    '',
  ].join('\n'),
  [`${CORE}/src/components/button/button.types.ts`]:
    'export type ButtonProps = { label: string };\n',
  [`${CORE}/src/components/button/button.css`]: '.button { color: red; }\n',
  [`${CORE}/src/components/button/button.svelte`]: [
    '<script lang="ts">',
    "  import { computePosition } from '@floating-ui/dom';",
    "  import { focus } from '../../utilities/focus.ts';",
    '</script>',
    '',
  ].join('\n'),
  [`${CORE}/src/components/button/button.test.ts`]: [
    "import { render } from '@testing-library/svelte';",
    "import { readFileSync } from 'node:fs';",
    "import { join } from 'node:path';",
    '',
    "const css = readFileSync(join(import.meta.dir, '../../styles/components.css'), 'utf8');",
    "const packageRoot = join(import.meta.dir, '..', '..', '..');",
    "const all = readFileSync(join(packageRoot, 'src', 'styles', 'components.css'), 'utf8');",
    '',
  ].join('\n'),
  [`${CORE}/scripts/raw-color-baseline.json`]:
    '[\n  { "filePath": "src/components/button/button.css", "allowedCount": 1 },\n  { "filePath": "src/styles/components.css", "allowedCount": 1 }\n]\n',
  // An example imports what it shows from core's barrel; its family imports each from its package.
  [`${CORE}/src/components/card/examples/basic.example.svelte`]: [
    '<script lang="ts">',
    "  import { Button, Card, focus, type ButtonProps } from '@lostgradient/cinder';",
    '</script>',
    '',
  ].join('\n'),
  // The examples artifact copies each example's body, which follows the example's imports.
  [`${CORE}/src/components/card/card.examples.json`]: `${JSON.stringify(
    {
      examples: [
        {
          id: 'basic',
          code: [
            '<script lang="ts">',
            "  import { Button, Card, focus, type ButtonProps } from '@lostgradient/cinder';",
            '</script>',
            '',
          ].join('\n'),
        },
      ],
    },
    null,
    2,
  )}\n`,
  // A button test that needs core's barrel: the map gives it to core, which keeps it under
  // src/component-tests once every family has left.
  [`${CORE}/src/components/button/button-root.test.ts`]: [
    "import { Button } from '../../index.ts';",
    "import ButtonView from './button.svelte';",
    '',
  ].join('\n'),
  // A card test that mocks core's barrel with the modules it hands over: once card moves, each mock
  // names the module as card's own imports reach it, and core's name, no dependency of card, goes.
  [`${CORE}/src/components/card/card-mocks.test.ts`]: [
    "const buttonModule = await import('../button/index.ts');",
    "const { focus } = await import('../../utilities/focus.ts');",
    "const { default: Card } = await import('./card.svelte');",
    "mock.module('@lostgradient/cinder', () => buttonModule);",
    "mock.module('@lostgradient/cinder', () => ({ focus }));",
    "mock.module('@lostgradient/cinder', () => ({ default: Card }));",
    '',
  ].join('\n'),
  [`${CORE}/src/components/card/index.ts`]:
    "import './card.css';\nimport Card from './card.svelte';\n\nexport default Card;\n",
  [`${CORE}/src/components/card/card.css`]: '.card { color: green; }\n',
  // A README links a sibling component's README, which another package holds once both move.
  [`${CORE}/src/components/card/README.md`]:
    '# Card\n\nA card holds a [`Button`](../button/README.md#usage) and [notes](./notes.md).\n',
  [`${CORE}/src/components/button/README.md`]: '# Button\n\n## Usage\n',
  [`${CORE}/src/components/card/card-surface.css`]: '.card-surface { color: teal; }\n',
  [`${CORE}/src/components/card/card.svelte`]: [
    '<script lang="ts">',
    "  import Button from '../button/button.svelte';",
    "  import { cardContext } from '../../_internal/card-context.ts';",
    '</script>',
    '',
  ].join('\n'),
  // A layer-2 family whose fixture mounts card (layer 3): it waits for card.
  [`${CORE}/src/components/badge/badge.svelte`]:
    '<script lang="ts">\n  import { focus } from \'../../utilities/focus.ts\';\n</script>\n',
  [`${CORE}/src/components/badge/badge.fixture.svelte`]:
    '<script lang="ts">\n  import Card from \'../card/card.svelte\';\n</script>\n',
  [`${CORE}/scripts/design-system/build.ts`]: 'export const build = 1;\n',
  // Files no package holds that reach into core by relative paths.
  'components/chat/README.md': 'See [`Button`](../core/src/components/button/README.md#usage).\n',
  'components/chat/src/focus.test.ts':
    "const css = new URL('../../core/src/components/button/button.css', import.meta.url);\n",
  // A test outside the packages (a fixture suite's, which a test-file pattern takes for one) that
  // reaches core by segments from the repository: only a path that names core is core's.
  'scripts/browser-fixtures/tests/runtime.playwright.ts': [
    'const runtime = join(',
    '  import.meta.dirname,',
    "  '..',",
    "  'components',",
    "  'core',",
    "  'src',",
    "  'tokens',",
    "  'runtime',",
    "  'index.ts',",
    ');',
    "const own = join(fixtureRoot, 'src', 'tokens', 'runtime', 'index.ts');",
    '',
  ].join('\n'),
  'turbo.json':
    '{\n  "inputs": [\n        "$TURBO_ROOT$/components/core/scripts/**",\n        "$TURBO_ROOT$/scripts/**"\n  ]\n}\n',
  'scripts/check.ts': [
    "const button = 'components/core/src/components/button/button.css';",
    "const all = 'components/core/src/components';",
    "const tokens = 'components/core/scripts/tokens/check.ts';",
    "const runtime = join(root, 'components', 'core', 'src', 'tokens', 'runtime', 'index.ts');",
    "const sibling = join(cinderRoot, 'src', 'tokens', 'runtime');",
    "const single = join(cinderRoot, 'src/tokens/runtime/index.ts');",
    "const own = join(cinderRoot, 'src', 'styles', 'components.css');",
    'const inTokens = /\\/components\\/core\\/src\\/tokens\\//;',
    '// The token corpus under components/core/src/tokens/.',
    '',
  ].join('\n'),
};

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), 'extract-families-'));
  roots.push(root);
  for (const [path, text] of Object.entries(TREE)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

function snapshot(root: string): Record<string, string> {
  return Object.fromEntries(
    walkFiles(root, '.').map((path) => [path, readFileSync(join(root, path), 'utf8')]),
  );
}

const ORIGINAL = deriveFamilies(
  new Map(
    Object.entries(TREE)
      .filter(([path]) => path.startsWith(`${CORE}/src/`))
      .map(([path, text]) => [path.slice(CORE.length + 1), text]),
  ),
  RULES,
);

async function extract(root: string, selection: Selection) {
  return extractFamilies({ root, core: CORE, families: ORIGINAL, rules: RULES, selection });
}

const read = (root: string, path: string) => readFileSync(join(root, path), 'utf8');
const manifest = (root: string, name: string) =>
  JSON.parse(read(root, `components/${name}/package.json`)) as {
    exports: Record<string, unknown>;
    scripts: Record<string, string>;
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
  };

describe('the layout', () => {
  test('names a file of another package by specifier, and reads the specifier back', () => {
    const cases: [string, string, string[], string][] = [
      ['button', 'src/components/button/button.css', ['button'], '@lostgradient/button/button.css'],
      [
        'button',
        'src/components/button/button.svelte',
        ['button'],
        '@lostgradient/button/components/button/button.svelte',
      ],
      [
        'card',
        'src/_internal/card-context.ts',
        ['card'],
        '@lostgradient/card/_internal/card-context.ts',
      ],
      ['foundation', 'src/styles/foundation.css', [], '@lostgradient/foundation/foundation.css'],
      ['foundation', 'src/utilities/focus.ts', [], '@lostgradient/foundation/utilities/focus.ts'],
      ['tooling', 'src/schema-types.ts', [], '@lostgradient/component-tooling/schema-types'],
    ];
    for (const [name, path, components, specifier] of cases) {
      expect(specifierFor(name, path, components).specifier).toBe(specifier);
      expect(virtualPathFor(specifier)).toEqual({ name, path });
    }
    expect(specifierFor('card', 'src/_internal/card-context.ts', ['card']).exportKey).toBe(
      './_internal/card-context.ts',
    );
  });

  test('selects a layer by halves, dependencies first', () => {
    expect(ORIGINAL.layers).toEqual([
      ['tokens'],
      ['foundation'],
      ['badge', 'button'],
      ['card'],
      ['core'],
    ]);
    expect(selectPackages(ORIGINAL, { kind: 'all' })).toEqual([
      'tokens',
      'foundation',
      'badge',
      'button',
      'card',
    ]);
    expect(selectPackages(ORIGINAL, { kind: 'layer', layer: 0, half: 1 })).toEqual(['tokens']);
    expect(
      selectPackages(ORIGINAL, { kind: 'layer', layer: 2, half: 2 }, new Set(['tokens'])),
    ).toEqual(['foundation', 'button']);
  });

  test('reads the order of a components.css with its comments', () => {
    const order = readComponentsCssOrder(TREE[`${CORE}/src/styles/components.css`] ?? '');
    expect(order.imports).toEqual([
      { path: 'src/styles/components/_partial.css', comment: '/* The component stylesheets. */' },
      { path: 'src/components/card/card-surface.css' },
      { path: 'src/components/button/button.css' },
      { path: 'src/components/card/card.css', comment: '/* Card sits after button. */' },
    ]);
    // A comment right under an import (a generated region's end) keeps having no blank line.
    expect(
      readComponentsCssOrder("@import './a.css';\n/* end */\n\n@import './b.css';\n").imports,
    ).toEqual([
      { path: 'src/styles/a.css' },
      { path: 'src/styles/b.css', comment: '/* end */', tight: true },
    ]);
  });
});

describe('extract-families', () => {
  test('refuses a package whose dependency is still in core', async () => {
    const root = repository();
    expect(await throwingRejectionOf(extract(root, { kind: 'packages', names: ['card'] }))).toThrow(
      'card waits for button, which stays in core',
    );
  });

  test('defers a family whose fixture mounts a family of a higher layer', async () => {
    const root = repository();
    const result = await extract(root, { kind: 'layer', layer: 2 });
    expect(result.selected).toEqual(['tokens', 'foundation', 'button']);
    expect(result.warnings).toContain(
      'deferred: badge waits for card, which stays in core (src/components/badge/badge.fixture.svelte imports ../card/card.svelte).',
    );
    expect(existsSync(join(root, CORE, 'src/components/badge/badge.svelte'))).toBe(true);
    const next = await extract(root, { kind: 'layer', layer: 3 });
    expect(next.selected).toEqual(['badge', 'card']);
    expect(read(root, 'components/badge/src/components/badge/badge.fixture.svelte')).toContain(
      "from '@lostgradient/card/components/card/card.svelte'",
    );
    expect(manifest(root, 'badge').devDependencies['@lostgradient/card']).toBe('workspace:*');
  });

  test('a dry run writes nothing', async () => {
    const root = repository();
    const before = snapshot(root);
    const result = await extractFamilies({
      root,
      core: CORE,
      families: ORIGINAL,
      rules: RULES,
      selection: { kind: 'packages', names: ['tokens'] },
      dryRun: true,
    });
    expect(result.moves.length).toBe(3);
    expect(snapshot(root)).toEqual(before);
  });

  test('extracts tokens, then foundation, then every family, as the map places them', async () => {
    const root = repository();
    const namesBefore = exportNames(join(root, CORE, 'src/index.ts'));

    // Every reader of a moved path is rewritten, so the guard behind the rewrites finds none.
    const tokens = await extract(root, { kind: 'packages', names: ['tokens'] });
    expect(tokens.dead).toEqual([]);
    expect(existsSync(join(root, CORE, 'src/tokens'))).toBe(false);
    const anchored = `${CORE}/src/exports/anchored.test.ts`;
    // Segments stay segments, so a rule that reads their shape reads the same after the move.
    expect(read(root, anchored)).toContain(
      "join(import.meta.dir, '..', '..', '..', 'tokens', 'src', 'tokens', 'runtime', file)",
    );
    expect(read(root, 'scripts/browser-fixtures/tests/runtime.playwright.ts')).toContain(
      "'components',\n  'tokens', 'src',\n  'tokens',",
    );
    expect(read(root, 'scripts/browser-fixtures/tests/runtime.playwright.ts')).toContain(
      "join(fixtureRoot, 'src', 'tokens', 'runtime', 'index.ts')",
    );
    expect(read(root, 'components/tokens/src/tokens/runtime/index.ts')).toContain('resolveTokens');
    expect(read(root, 'components/tokens/scripts/tokens/check.ts')).toContain(
      "'../../src/tokens/runtime/index.ts'",
    );
    expect(manifest(root, 'tokens').scripts['tokens:check']).toBe('bun scripts/tokens/check.ts');
    expect(manifest(root, 'tokens').scripts['lint']).toContain('bun run tokens:check');
    expect(read(root, 'turbo.json')).toContain(
      '"$TURBO_ROOT$/components/core/scripts/**",\n        "$TURBO_ROOT$/components/tokens/scripts/**",\n        "$TURBO_ROOT$/scripts/**"',
    );
    expect(read(root, 'scripts/check.ts')).toContain(
      [
        "const runtime = join(root, 'components', 'tokens', 'src', 'tokens', 'runtime', 'index.ts');",
        "const sibling = join(cinderRoot, '..', 'tokens', 'src', 'tokens', 'runtime');",
        "const single = join(cinderRoot, '../tokens/src/tokens/runtime/index.ts');",
        "const own = join(cinderRoot, 'src', 'styles', 'components.css');",
        'const inTokens = /\\/components\\/tokens\\/src\\/tokens\\//;',
        '// The token corpus under components/tokens/src/tokens/.',
      ].join('\n'),
    );
    const coreAfterTokens = JSON.parse(read(root, `${CORE}/package.json`)) as {
      scripts: Record<string, string>;
      exports: Record<string, { default: string }>;
    };
    expect(coreAfterTokens.scripts).toEqual({ lint: 'oxlint src scripts' });
    expect(coreAfterTokens.exports['./tokens/runtime']?.default).toBe(
      './src/exports/tokens-runtime.ts',
    );
    expect(read(root, `${CORE}/src/exports/tokens-runtime.ts`)).toContain(
      "export * from '@lostgradient/tokens/tokens/runtime/index.ts';",
    );
    expect(read(root, `${CORE}/src/utilities/focus.ts`)).toContain(
      "from '@lostgradient/tokens/tokens/runtime/index.ts'",
    );
    expect(read(root, `${CORE}/src/styles/index.css`)).toContain(
      "@import '@lostgradient/tokens/tokens.css' layer(cinder.tokens);",
    );
    expect(read(root, `${CORE}/components-css-order.json`)).toContain(
      'src/components/card/card.css',
    );
    expect(read(root, 'scripts/check.ts')).toContain("'components/tokens/scripts/tokens/check.ts'");

    const foundation = await extract(root, { kind: 'packages', names: ['foundation'] });
    expect(foundation.dead).toEqual([]);
    expect(read(root, anchored)).toContain(
      '`${import.meta.dir}/../../../foundation/src/styles/components/_partial.css`',
    );
    expect(read(root, 'components/foundation/src/utilities/focus.ts')).toContain(
      "from '@lostgradient/tokens/tokens/runtime/index.ts'",
    );
    expect(read(root, 'components/foundation/inherited-key-reads-allowlist.json')).toContain(
      'src/utilities/focus.ts',
    );
    expect(read(root, `${CORE}/inherited-key-reads-allowlist.json`)).not.toContain('focus.ts');
    expect(manifest(root, 'foundation').dependencies['@lostgradient/tokens']).toBe('workspace:*');
    expect(manifest(root, 'foundation').scripts['lint']).toContain('check-foundation-imports.ts');
    const focusTest = 'components/foundation/src/utilities/focus.test.ts';
    expect(read(root, focusTest)).toContain("'../../../core/src/components/card/card.css'");
    expect(read(root, focusTest)).toContain("'..', 'core', 'src', 'components', 'card'");

    const families = await extract(root, { kind: 'all' });
    expect(families.dead).toEqual([]);
    expect(existsSync(join(root, CORE, 'src/components'))).toBe(false);
    expect(read(root, anchored)).toContain(
      "resolve(dirname(fileURLToPath(import.meta.url)), '../../../card/src/components/card/card.css')",
    );
    expect(read(root, anchored)).toContain("join(import.meta.dirname, 'extra.ts')");
    expect(read(root, 'components/card/src/components/card/examples/basic.example.svelte')).toBe(
      [
        '<script lang="ts">',
        "  import { Button, type ButtonProps } from '@lostgradient/button';",
        "import { Card } from '@lostgradient/card';",
        "import { focus } from '@lostgradient/foundation';",
        '</script>',
        '',
      ].join('\n'),
    );
    const artifact = JSON.parse(
      read(root, 'components/card/src/components/card/card.examples.json'),
    ) as { examples: { code: string }[] };
    expect(artifact.examples[0]?.code).toBe(
      read(root, 'components/card/src/components/card/examples/basic.example.svelte'),
    );
    // A baseline entry follows its file, named relative to core as the checks name it.
    expect(read(root, `${CORE}/scripts/raw-color-baseline.json`)).toBe(
      '[\n  { "filePath": "../button/src/components/button/button.css", "allowedCount": 1 },\n  { "filePath": "src/styles/components.css", "allowedCount": 1 }\n]\n',
    );
    expect(read(root, `${CORE}/src/component-tests/button/button-root.test.ts`)).toBe(
      [
        "import { Button } from '../../index.ts';",
        "import ButtonView from '@lostgradient/button/components/button/button.svelte';",
        '',
      ].join('\n'),
    );
    // The paths an earlier run pointed into core follow card into its package.
    expect(read(root, focusTest)).toContain("'../../../card/src/components/card/card.css'");
    expect(read(root, focusTest)).toContain("'..', 'card', 'src', 'components', 'card'");
    expect(read(root, 'components/button/src/components/button/button.svelte')).toContain(
      "from '@lostgradient/foundation/utilities/focus.ts'",
    );
    expect(read(root, 'components/card/src/components/card/card.svelte')).toContain(
      "from '@lostgradient/button/components/button/button.svelte'",
    );
    expect(read(root, 'components/card/src/components/card/card-mocks.test.ts')).toBe(
      [
        "const buttonModule = await import('@lostgradient/button/components/button/index.ts');",
        "const { focus } = await import('@lostgradient/foundation/utilities/focus.ts');",
        "const { default: Card } = await import('./card.svelte');",
        "mock.module('@lostgradient/button/components/button/index.ts', () => buttonModule);",
        "mock.module('@lostgradient/foundation/utilities/focus.ts', () => ({ focus }));",
        "mock.module('./card.svelte', () => ({ default: Card }));",
        '',
      ].join('\n'),
    );
    expect(read(root, 'components/button/src/components/button/button.test.ts')).toContain(
      "'../../../../core/src/styles/components.css'",
    );
    expect(read(root, 'components/button/src/components/button/button.test.ts')).toContain(
      "join(packageRoot, '..', 'core', 'src', 'styles', 'components.css')",
    );
    expect(read(root, `${CORE}/src/exports/extra.ts`)).toContain(
      "from '@lostgradient/card/_internal/card-context.ts'",
    );
    expect(manifest(root, 'card').exports['./_internal/card-context.ts']).toBe(
      './src/_internal/card-context.ts',
    );
    expect(manifest(root, 'button').dependencies).toEqual({
      '@floating-ui/dom': 'catalog:',
      '@lostgradient/foundation': 'workspace:*',
      svelte: 'catalog:',
    });
    expect(manifest(root, 'button').devDependencies['@testing-library/svelte']).toBe('catalog:');
    expect(read(root, `${CORE}/src/styles/components.css`)).toBe(
      [
        '/* The component stylesheets. */',
        "@import '@lostgradient/foundation/components/_partial.css';",
        "@import '@lostgradient/card/components/card/card-surface.css';",
        "@import '@lostgradient/button/button.css';",
        '',
        '/* Card sits after button. */',
        "@import '@lostgradient/card/card.css';",
        '',
      ].join('\n'),
    );
    // A family whose lines sit apart is imported line by line; its stylesheet keeps their order.
    expect(read(root, 'components/card/src/styles/index.css')).toContain(
      "@import '../components/card/card-surface.css';\n@import '../components/card/card.css';",
    );
    expect(read(root, 'components/button/src/styles/index.css')).toContain(
      "@import '../components/button/button.css';",
    );
    expect(read(root, 'components/button/src/index.ts')).toContain(
      "export type { ButtonProps } from './components/button/index.ts';",
    );
    expect(read(root, `${CORE}/src/index.ts`)).toContain(
      "export { resolveTokens } from '@lostgradient/tokens';\nexport type { TokenSet } from '@lostgradient/tokens';",
    );
    // Core re-exports a family's component from the component's module, clause unchanged, so
    // importing core evaluates the stylesheets in the order it always did.
    expect(read(root, `${CORE}/src/index.ts`)).toContain(
      "export { default as Button } from '@lostgradient/button/components/button/index.ts';\nexport type { ButtonProps } from '@lostgradient/button/components/button/index.ts';",
    );
    expect(read(root, 'scripts/check.ts')).toContain(
      "'components/button/src/components/button/button.css'",
    );
    expect(read(root, 'scripts/check.ts')).toContain("'components/core/src/components'");
    // A file no package holds follows what it names into the package that holds it now.
    expect(read(root, 'components/chat/README.md')).toBe(
      'See [`Button`](../button/src/components/button/README.md#usage).\n',
    );
    expect(read(root, 'components/chat/src/focus.test.ts')).toContain(
      "new URL('../../button/src/components/button/button.css', import.meta.url)",
    );
    // A README's link to a component another package holds reaches it there, fragment kept.
    expect(read(root, 'components/card/src/components/card/README.md')).toContain(
      '[`Button`](../../../../button/src/components/button/README.md#usage) and [notes](./notes.md)',
    );

    // Core exports the same names, and the split tree derives the same map.
    expect(exportNames(join(root, CORE, 'src/index.ts'))).toEqual(namesBefore);
    expect(deriveFromRepository(RULES, root)).toEqual(ORIGINAL);
    expect(readPackageTree(join(root, CORE)).has('src/components/button/index.ts')).toBe(false);
  });

  test('a newer map moves a test an earlier run placed back to core', async () => {
    const root = repository();
    await extract(root, { kind: 'all' });
    const file = 'src/components/button/button.test.ts';
    const newer: DerivedFamilies = {
      ...ORIGINAL,
      testMoves: [...ORIGINAL.testMoves, { file, from: 'button', to: 'core', because: 'test' }],
    };
    const result = await extractFamilies({
      root,
      core: CORE,
      families: newer,
      rules: RULES,
      selection: { kind: 'all' },
    });
    // Every family has left, so core keeps it in its tests directory, not its components path.
    const moved = `${CORE}/src/component-tests/button/button.test.ts`;
    expect(result.moves).toEqual([{ from: `components/button/${file}`, to: moved }]);
    expect(existsSync(join(root, 'components/button', file))).toBe(false);
    // Its paths into core still reach core from there: a sibling path names core by directory.
    expect(read(root, moved)).toContain(
      "join(packageRoot, '..', 'core', 'src', 'styles', 'components.css')",
    );
  });

  test('names a path no rewrite follows that still reaches where a moved file was', async () => {
    const root = repository();
    // Core's own JSON names a token module by a relative path, which no rewrite reads.
    writeFileSync(
      join(root, CORE, 'scripts/paths.json'),
      '{ "runtime": "../src/tokens/runtime/index.ts", "kept": "../src/index.ts" }\n',
    );
    const result = await extract(root, { kind: 'packages', names: ['tokens'] });
    expect(result.dead).toEqual([
      `${CORE}/scripts/paths.json: ../src/tokens/runtime/index.ts reaches ${CORE}/src/tokens/runtime/index.ts, now components/tokens/src/tokens/runtime/index.ts.`,
    ]);
  });

  test('a second run changes nothing', async () => {
    const root = repository();
    await extract(root, { kind: 'packages', names: ['tokens', 'foundation'] });
    await extract(root, { kind: 'all' });
    const before = snapshot(root);
    const again = await extract(root, { kind: 'all' });
    expect(again.moves).toEqual([]);
    expect(again.written).toEqual([]);
    expect(snapshot(root)).toEqual(before);
  });
});

describe('formatting a rewritten file', () => {
  // Sorts import lines the way organize-imports would, unless the file opts out.
  const sortImports = async (_path: string, text: string) => {
    if (text.includes('// organize-imports-ignore')) return text;
    const lines = text.split('\n');
    // Package imports first, then relative ones, each group alphabetical.
    const rank = (line: string) => `${/['"]\./.test(line) ? 1 : 0}${line}`;
    const imports = lines
      .filter((line) => line.startsWith('import '))
      .toSorted((a, b) => rank(a).localeCompare(rank(b)));
    return [...imports, ...lines.filter((line) => !line.startsWith('import '))].join('\n');
  };

  test('keeps the order of stylesheet imports a sort would change', async () => {
    const text = "import '../button/button.css';\nimport '@lostgradient/input/input.css';\n";
    const formatted = await formatKeepingImportOrder('index.ts', text, sortImports);
    expect(formatted.startsWith('// organize-imports-ignore\n')).toBe(true);
    expect(sideEffectImports(formatted)).toEqual([
      '../button/button.css',
      '@lostgradient/input/input.css',
    ]);
  });

  test('formats a file whose stylesheet order a sort leaves alone', async () => {
    const text = "import { b } from './b.ts';\nimport { a } from './a.ts';\nimport './x.css';\n";
    expect(await formatKeepingImportOrder('index.ts', text, sortImports)).toBe(
      "import './x.css';\nimport { a } from './a.ts';\nimport { b } from './b.ts';\n",
    );
  });
});

describe('check-foundation-imports', () => {
  test('fails on a foundation import of a family and passes on one of tokens', () => {
    const files = new Map([
      ['src/utilities/bad.ts', "import Button from '@lostgradient/button';\n"],
      ['src/utilities/relative.ts', "import Card from '../components/card/card.svelte';\n"],
      [
        'src/utilities/good.ts',
        "import { resolveTokens } from '@lostgradient/tokens/tokens/runtime/index.ts';\n",
      ],
    ]);
    expect(foundationImportViolations(files, ORIGINAL)).toEqual([
      'src/utilities/bad.ts imports @lostgradient/button, which is the family "button".',
      'src/utilities/relative.ts imports ../components/card/card.svelte, which is the family "card".',
    ]);
  });
});

describe('the repository', () => {
  test('the foundation workspace, once extracted, imports no family', () => {
    const families = JSON.parse(
      readFileSync(join(import.meta.dir, '../families.json'), 'utf8'),
    ) as DerivedFamilies;
    const foundation = join(import.meta.dir, '../../../components/foundation');
    if (!existsSync(foundation)) return;
    expect(foundationImportViolations(readPackageTree(foundation), families)).toEqual([]);
  });
});
