/**
 * The engine and the UI share a package, not a runtime or an import graph.
 *
 * - The engine invocation of `test` runs under `bunfig.toml`, whose preload installs no DOM; the
 *   UI's happy-dom globals come only from `bunfig.ui.toml`'s preload. If the engine invocation ever
 *   loaded the UI's preload, `document` would be defined here.
 * - Nothing under `src/` outside `src/ui` imports from `src/ui`, by a relative path or through the
 *   package's own `./ui` export, so the root entry stays free of the UI for Node, serverless, and
 *   extension consumers.
 * - Nothing under `packages/weft` imports `@lostgradient/testing`. The mirror drops that private
 *   development dependency for the weft target, so it would not resolve in the Weft repository; the
 *   UI uses Weft's own test support and the Svelte plugin copied into `scripts/lib/`.
 *
 * Specifiers are read with TypeScript's `preProcessFile`, which reports static imports, `import
 * type`, re-exports, `import()` and `require()` — not text that merely mentions a package — and
 * from the `<script>` blocks of Svelte components.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';

import packageJson from '../package.json' with { type: 'json' };

const packageRoot = join(import.meta.dir, '..');
const sourceRoot = join(packageRoot, 'src');
const uiRoot = join(sourceRoot, 'ui');

const CODE_FILE = /\.(?:[cm]?[jt]sx?|svelte)$/;
const SKIPPED_DIRECTORIES = new Set([
  'node_modules',
  'coverage',
  'test-output',
  'build',
  'dist',
  '.turbo',
]);

/** Every module specifier a code file names, from a Svelte component's script blocks if it is one. */
function moduleSpecifiers(path: string, text: string): string[] {
  const code = path.endsWith('.svelte')
    ? [...text.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)]
        .map((match) => match[1] ?? '')
        .join('\n')
    : text;
  return ts.preProcessFile(code, true, true).importedFiles.map((imported) => imported.fileName);
}

function codeFilesUnder(directory: string, found: string[] = []): string[] {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) codeFilesUnder(join(directory, entry.name), found);
    } else if (CODE_FILE.test(entry.name)) {
      found.push(join(directory, entry.name));
    }
  }
  return found;
}

function isTestingPackage(specifier: string): boolean {
  return specifier === '@lostgradient/testing' || specifier.startsWith('@lostgradient/testing/');
}

/** Whether `specifier`, written in `importer`, reaches the UI. */
function reachesUi(importer: string, specifier: string): boolean {
  if (specifier === '@lostgradient/weft/ui' || specifier.startsWith('@lostgradient/weft/ui/')) {
    return true;
  }
  if (!specifier.startsWith('.')) return false;
  const target = resolve(dirname(importer), specifier);
  return target === uiRoot || target.startsWith(`${uiRoot}${sep}`);
}

/** `file: specifier` for every specifier in `files` that `offends` flags. */
function offences(
  files: readonly { path: string; text: string }[],
  offends: (importer: string, specifier: string) => boolean,
): string[] {
  return files.flatMap(({ path, text }) =>
    moduleSpecifiers(path, text)
      .filter((specifier) => offends(path, specifier))
      .map((specifier) => `${relative(packageRoot, path)}: ${specifier}`),
  );
}

function read(paths: readonly string[]): { path: string; text: string }[] {
  return paths.map((path) => ({ path, text: readFileSync(path, 'utf8') }));
}

// Reading and parsing every code file in the package is seconds of work on a loaded host, so it
// runs at module scope, off the per-test clock.
const packageFiles = read(codeFilesUnder(packageRoot));
const engineFiles = packageFiles.filter(
  ({ path }) => path.startsWith(`${sourceRoot}${sep}`) && !path.startsWith(`${uiRoot}${sep}`),
);

describe('the engine and the UI', () => {
  test('the engine invocation loads no UI preload, so no DOM is installed', () => {
    expect(Reflect.get(globalThis, 'document')).toBeUndefined();
  });

  test('no engine source imports from src/ui', () => {
    expect(engineFiles.length).toBeGreaterThan(100);
    expect(packageFiles.some(({ path }) => path.startsWith(`${uiRoot}${sep}`))).toBe(true);
    expect(offences(engineFiles, reachesUi)).toEqual([]);
  });

  test('the src/ui check catches relative, self-referencing, dynamic, and type-only imports', () => {
    const importer = join(sourceRoot, 'server', 'example.ts');
    const fixture = [
      "import { router } from '../ui/lib/router.svelte.ts';",
      "export { WeftConsole } from '../ui/index.ts';",
      "import type { RouteState } from '@lostgradient/weft/ui';",
      "const ui = await import('../ui');",
      "// import { nothing } from '../ui/lib/client.ts';",
      "import { serve } from './index.ts';",
      "import { Engine } from '@lostgradient/weft';",
    ].join('\n');
    expect(offences([{ path: importer, text: fixture }], reachesUi)).toEqual([
      'src/server/example.ts: ../ui/lib/router.svelte.ts',
      'src/server/example.ts: ../ui/index.ts',
      'src/server/example.ts: @lostgradient/weft/ui',
      'src/server/example.ts: ../ui',
    ]);
  });

  test('nothing under packages/weft declares or imports @lostgradient/testing', () => {
    for (const field of [
      'dependencies',
      'devDependencies',
      'peerDependencies',
      'optionalDependencies',
    ]) {
      expect(Object.keys(Reflect.get(packageJson, field) ?? {})).not.toContain(
        '@lostgradient/testing',
      );
    }
    expect(packageFiles.length).toBeGreaterThan(engineFiles.length);
    expect(offences(packageFiles, (_importer, specifier) => isTestingPackage(specifier))).toEqual(
      [],
    );
  });

  test('the @lostgradient/testing check catches static, dynamic, required, and Svelte imports', () => {
    const fixtures = [
      {
        path: join(uiRoot, 'example.test.ts'),
        text: [
          "import { rejectionOf } from '@lostgradient/testing';",
          "import type { Helper } from '@lostgradient/testing/helpers';",
          "const { buildBrowser } = await import('@lostgradient/testing');",
          "const plugin = require('@lostgradient/testing');",
          "const text = 'from @lostgradient/testing';",
        ].join('\n'),
      },
      {
        path: join(uiRoot, 'example.svelte'),
        text: '<script lang="ts">\n  import { requiredValue } from \'@lostgradient/testing\';\n</script>\n<p>@lostgradient/testing</p>\n',
      },
    ];
    expect(offences(fixtures, (_importer, specifier) => isTestingPackage(specifier))).toEqual([
      'src/ui/example.test.ts: @lostgradient/testing',
      'src/ui/example.test.ts: @lostgradient/testing/helpers',
      'src/ui/example.test.ts: @lostgradient/testing',
      'src/ui/example.test.ts: @lostgradient/testing',
      'src/ui/example.svelte: @lostgradient/testing',
    ]);
  });
});
