import { describe, expect, test } from 'bun:test';
import { join, resolve } from 'node:path';
import { format, resolveConfig } from 'prettier';

import {
  declarationsSource,
  rewriteBarrelImports,
  rewriteLocationPaths,
  rewriteRelativeImports,
  stylesheetImports,
  stylesheetOrderModule,
} from './move-browser-specs.ts';
import type { ExportSource } from './place-browser-specs.ts';

describe('rewriteRelativeImports', () => {
  const moves = new Map([
    [
      'scripts/browser-fixtures/tests/a.playwright.ts',
      'components/button/browser/tests/a.playwright.ts',
    ],
    [
      'scripts/browser-fixtures/src/fixtures/panel.svelte',
      'components/button/browser/fixtures/panel.svelte',
    ],
  ]);

  test('re-points a moved file to its neighbours from its new place', () => {
    const source = [
      "import { environmentConfiguration } from '../environment-configuration.ts';",
      "import Panel from '../src/fixtures/panel.svelte';",
      "import { tokens } from '../../../components/tokens/src/index.ts';",
    ].join('\n');
    expect(
      rewriteRelativeImports(
        source,
        'scripts/browser-fixtures/tests/a.playwright.ts',
        'components/button/browser/tests/a.playwright.ts',
        moves,
      ),
    ).toBe(
      [
        "import { environmentConfiguration } from '@lostgradient/testing/environment-configuration';",
        "import Panel from '../fixtures/panel.svelte';",
        "import { tokens } from '../../../tokens/src/index.ts';",
      ].join('\n'),
    );
  });

  test('leaves an unmoved file whose imports moved nothing alone', () => {
    const source = "import { a } from './a.ts';\n";
    expect(rewriteRelativeImports(source, 'scripts/x.ts', 'scripts/x.ts', moves)).toBe(source);
  });
});

describe('rewriteLocationPaths', () => {
  const before = 'scripts/browser-fixtures/tests/a.playwright.ts';
  const after = 'components/core/browser/tests/a.playwright.ts';
  const moves = new Map([[before, after]]);

  test("re-points a path built from the file's location, to a file outside the suite", () => {
    expect(
      rewriteLocationPaths(
        "join(import.meta.dirname, '..', '..', '..', 'components', 'tokens', 'registry.json')",
        before,
        after,
        moves,
      ),
    ).toBe("join(import.meta.dirname, '..', '..', '..', 'tokens', 'registry.json')");
    expect(
      rewriteLocationPaths(
        "new URL('../../../components/table/table.css', import.meta.url)",
        before,
        after,
        moves,
      ),
    ).toBe("new URL('../../../table/table.css', import.meta.url)");
  });

  test("keeps a path into the suite's own directories pointing at the new suite's", () => {
    expect(
      rewriteLocationPaths(
        "resolve(import.meta.dirname, '..', 'snapshots', name)",
        before,
        after,
        moves,
      ),
    ).toBe("resolve(import.meta.dirname, '..', 'snapshots', name)");
  });
});

describe('rewriteBarrelImports', () => {
  const sources = new Map<string, ExportSource>([
    [
      'Button',
      {
        package: '@lostgradient/button',
        specifier: '@lostgradient/button/components/button/index.ts',
        imported: 'default',
        type: false,
      },
    ],
    [
      'ButtonProps',
      {
        package: '@lostgradient/button',
        specifier: '@lostgradient/button/components/button/index.ts',
        imported: 'ButtonProps',
        type: true,
      },
    ],
    [
      'useToast',
      {
        package: '@lostgradient/foundation',
        specifier: '@lostgradient/foundation/utilities/use-toast.ts',
        imported: 'useToast',
        type: false,
      },
    ],
  ]);

  test("takes each of core's barrel names from the module core takes it from", () => {
    const source =
      "import { Button, type ButtonProps, useToast as toast } from '@lostgradient/cinder';";
    expect(rewriteBarrelImports(source, sources)).toBe(
      [
        "import Button from '@lostgradient/button/components/button/index.ts';",
        "  import { type ButtonProps } from '@lostgradient/button/components/button/index.ts';",
        "  import { useToast as toast } from '@lostgradient/foundation/utilities/use-toast.ts';",
      ].join('\n'),
    );
  });

  test('refuses a name core does not take from a package', () => {
    expect(() =>
      rewriteBarrelImports("import { Unknown } from '@lostgradient/cinder';", sources),
    ).toThrow('does not take');
  });
});

describe('declarationsSource', () => {
  test('writes a new declarations module, and adds to an existing one before its end', () => {
    const created = declarationsSource(undefined, { panel: ['assertion'] });
    expect(created).toContain(
      'export const appFixtureDeclarations = {\n  "panel": ["assertion"],\n}',
    );
    const merged = declarationsSource(
      "export const chatAppFixtureDeclarations = {\n  chat: ['assertion'],\n} as const satisfies Record<string, readonly string[]>;\n",
      { 'chat-stress': ['assertion'] },
    );
    expect(merged).toBe(
      'export const chatAppFixtureDeclarations = {\n  chat: [\'assertion\'],\n  "chat-stress": ["assertion"],\n} as const satisfies Record<string, readonly string[]>;\n',
    );
  });
});

describe('stylesheetImports', () => {
  const files: Record<string, string> = {
    '/r/components/core/src/styles/index.css':
      "@import '@lostgradient/tokens/tokens.css' layer(tokens);\n@import '../../../foundation/src/f.css';\n",
    '/r/components/foundation/src/f.css': 'body {}',
    '/r/components/tokens/src/styles/tokens.css': "@import './tokens-base.css';\n:root {}",
    '/r/components/tokens/src/styles/tokens-base.css': ':root { --a: 1; }',
    '/r/components/button/src/button.css': "@import url('./partial.css');\n.cinder-button {}",
    '/r/components/button/src/partial.css': '.cinder-button {}',
    '/r/node_modules/.bun/@x+y@1.0.0/node_modules/@x/y/css/y.css': '.y {}',
  };
  const read = (path: string) => files[path];
  const resolveImport = (specifier: string, directory: string) =>
    specifier.startsWith('.')
      ? resolve(directory, specifier)
      : specifier.replace('@lostgradient/tokens/', '/r/components/tokens/src/styles/');

  test('names each stylesheet once, in order, leaving out what a conditional @import reaches', () => {
    expect(
      stylesheetImports(
        [
          '/r/components/tokens/src/styles/tokens-base.css',
          '/r/components/tokens/src/styles/tokens.css',
          '/r/components/foundation/src/f.css',
          '/r/components/core/src/styles/index.css',
          '/r/components/button/src/partial.css',
          '/r/node_modules/.bun/@x+y@1.0.0/node_modules/@x/y/css/y.css',
          '/r/components/button/src/button.css',
          '/r/components/core/src/styles/index.css',
        ],
        '/r/components/core/browser',
        read,
        resolveImport,
      ),
    ).toEqual([
      "import '../../foundation/src/f.css';",
      "import '../src/styles/index.css';",
      "import '../../button/src/partial.css';",
      "import '@x/y/css/y.css';",
      "import '../../button/src/button.css';",
    ]);
  });

  test('refuses a stylesheet that is not on disk', () => {
    expect(() =>
      stylesheetImports(
        ['/r/components/gone.css'],
        '/r/components/core/browser',
        read,
        resolveImport,
      ),
    ).toThrow('/r/components/gone.css');
  });
});

describe('stylesheetOrderModule', () => {
  test('keeps its imports in the recorded order through the formatter', async () => {
    const imports = [
      "import '../../tokens/src/styles/tokens.css';",
      "import '../../alert/src/alert.css';",
    ];
    const path = join(
      import.meta.dirname,
      '..',
      '..',
      '..',
      'components',
      'core',
      'browser',
      'stylesheet-order.ts',
    );
    const source = stylesheetOrderModule(imports);
    const formatted = await format(source, { ...(await resolveConfig(path)), filepath: path });
    expect(formatted.split('\n').filter((line) => line.startsWith('import'))).toEqual(imports);
  });
});
