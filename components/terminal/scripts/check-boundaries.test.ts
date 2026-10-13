import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  checkBoundaries,
  findImportViolations,
  findLockfileViolations,
  findManifestViolations,
  forbiddenImportReason,
  formatViolations,
  importProbeViolations,
  importReferences,
  runImportProbe,
} from './check-boundaries.ts';

const realPackageRoot = join(import.meta.dir, '..');
const scratchDirectories: string[] = [];

afterEach(() => {
  for (const directory of scratchDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function write(root: string, files: Record<string, string>): void {
  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), contents);
  }
}

const terminalManifest = JSON.stringify({
  name: '@lostgradient/terminal',
  dependencies: { '@xterm/xterm': 'catalog:' },
});
const rootManifest = JSON.stringify({ name: 'corvidae', catalog: { '@xterm/xterm': '6.0.0' } });
/** bun.lock is JSONC: trailing commas are part of the format. */
const cleanLockfile = `{
  "lockfileVersion": 1,
  "workspaces": {
    "": { "name": "corvidae" },
    "components/terminal": {
      "name": "@lostgradient/terminal",
      "dependencies": { "@xterm/xterm": "catalog:", },
    },
  },
  "packages": {
    "@xterm/xterm": ["@xterm/xterm@6.0.0", "", {}, "sha512-fixture"],
    "ghostty-web-docs": ["ghostty-web-docs@1.0.0", "", {}, "sha512-fixture"],
  },
}
`;

/** A lockfile whose `packages` and `workspaces` sections are the given entries. */
function lockfile(
  packages: Record<string, string>,
  workspaces: Record<string, object> = { '': { name: 'corvidae' } },
): string {
  return JSON.stringify({
    lockfileVersion: 1,
    workspaces,
    packages: Object.fromEntries(
      Object.entries(packages).map(([key, resolved]) => [key, [resolved, '', {}, 'sha512-x']]),
    ),
  });
}

/** A scratch workspace shaped like this repository, returning its `components/terminal` root. */
function workspaceFixture(files: Record<string, string> = {}): {
  workspaceRoot: string;
  packageRoot: string;
} {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'terminal-boundaries-'));
  scratchDirectories.push(workspaceRoot);
  const packageRoot = join(workspaceRoot, 'components/terminal');
  write(workspaceRoot, {
    'package.json': rootManifest,
    'bun.lock': cleanLockfile,
    'components/terminal/package.json': terminalManifest,
    'components/terminal/src/index.ts': 'export {};\n',
    ...Object.fromEntries(
      Object.entries(files).map(([path, contents]) => [
        path.startsWith('/') ? path.slice(1) : `components/terminal/${path}`,
        contents,
      ]),
    ),
  });
  return { workspaceRoot, packageRoot };
}

describe('forbiddenImportReason', () => {
  test.each([
    '@lostgradient/ventriloquist',
    '@lostgradient/cinder',
    '@xterm/xterm',
    'svelte',
    './local.ts',
    '../up.ts',
  ])('allows %s', (specifier) => {
    expect(forbiddenImportReason(specifier)).toBeUndefined();
  });

  test.each([
    ['@lostgradient/ventriloquist/bun', 'Bun host entry'],
    ['@lostgradient/ventriloquist/websocket', 'Bun host entry'],
    ['@lostgradient/ventriloquist/anything-else', 'Bun host entry'],
    ['bun', 'Bun module'],
    ['bun:test', 'Bun module'],
    ['bun:sqlite', 'Bun module'],
    ['node:fs', 'Node module'],
    ['node:path', 'Node module'],
    ['ghostty-web', 'comparison engine'],
    ['@wterm/dom/styles', 'comparison engine'],
    ['fs', 'Node module'],
    ['path', 'Node module'],
  ])('rejects %s', (specifier, reason) => {
    expect(forbiddenImportReason(specifier)).toContain(reason);
  });
});

describe('importReferences', () => {
  test('finds static, re-exported, dynamic, and required specifiers with their lines', () => {
    const source = [
      "import { a } from './a.ts';",
      "export { b } from './b.ts';",
      "export * from './c.ts';",
      "const d = await import('./d.ts');",
      "const e = require('./e.ts');",
    ].join('\n');
    expect(importReferences(source, 'module.ts')).toEqual([
      { specifier: './a.ts', line: 1 },
      { specifier: './b.ts', line: 2 },
      { specifier: './c.ts', line: 3 },
      { specifier: './d.ts', line: 4 },
      { specifier: './e.ts', line: 5 },
    ]);
  });

  test('reads every script block of a Svelte file, numbered against the whole file', () => {
    const source = [
      '<script lang="ts" module>',
      "  import { a } from './a.ts';",
      '</script>',
      '<script lang="ts">',
      "  import { b } from 'node:fs';",
      '</script>',
      '<p>{b}</p>',
    ].join('\n');
    expect(importReferences(source, 'component.svelte')).toEqual([
      { specifier: './a.ts', line: 2 },
      { specifier: 'node:fs', line: 5 },
    ]);
  });

  test('skips type-only imports and exports, which erase before runtime', () => {
    const source = [
      "import type { A } from 'node:fs';",
      "export type { B } from 'node:path';",
      "import type C = require('node:os');",
      "type D = import('node:url').URL;",
      "import { type E } from 'node:crypto';",
      "import F = require('node:zlib');",
      'export const dynamicName = await import(`./${name}.ts`);',
      'const g = await import(`node:http`);',
    ].join('\n');
    expect(importReferences(source, 'module.ts')).toEqual([
      { specifier: 'node:crypto', line: 5 },
      { specifier: 'node:zlib', line: 6 },
      { specifier: 'node:http', line: 8 },
    ]);
  });

  test('parses each extension with its own script kind, so JSX does not hide an import', () => {
    const source = [
      'export const Lazy = () => (',
      "  <Suspense>{import('node:fs').then((fs) => <p>{String(fs)}</p>)}</Suspense>",
      ');',
    ].join('\n');
    expect(importReferences(source, 'component.tsx')).toEqual([{ specifier: 'node:fs', line: 2 }]);
    expect(importReferences(source, 'component.jsx')).toEqual([{ specifier: 'node:fs', line: 2 }]);
    expect(importReferences("module.exports = require('node:fs');", 'index.cjs')).toEqual([
      { specifier: 'node:fs', line: 1 },
    ]);
  });

  test('finds dynamic imports and requires in Svelte markup, outside any script block', () => {
    const source = [
      '<script lang="ts">',
      '  let ready = true;',
      '</script>',
      "{#await import('node:fs') then fs}{fs}{/await}",
      '<p>{require("node:path")}</p>',
    ].join('\n');
    expect(importReferences(source, 'component.svelte')).toEqual([
      { specifier: 'node:fs', line: 4 },
      { specifier: 'node:path', line: 5 },
    ]);
  });

  test('ignores a Svelte file with no script', () => {
    expect(importReferences('<p>hello</p>', 'component.svelte')).toEqual([]);
  });
});

describe('findImportViolations', () => {
  test('reports every forbidden import in browser source, file and line included', () => {
    const { packageRoot } = workspaceFixture({
      'src/lib/forbidden.ts': [
        "import { server } from '@lostgradient/ventriloquist/websocket';",
        "import { pty } from '@lostgradient/ventriloquist/bun';",
        "import { test } from 'bun:test';",
        "import { readFile } from 'node:fs';",
        "const lazy = () => import('node:path');",
      ].join('\n'),
      'src/lib/component.svelte': '<script lang="ts">\n  import { join } from "path";\n</script>\n',
    });
    expect(findImportViolations(packageRoot).map(({ file, line }) => `${file}:${line}`)).toEqual([
      'src/lib/component.svelte:2',
      'src/lib/forbidden.ts:1',
      'src/lib/forbidden.ts:2',
      'src/lib/forbidden.ts:3',
      'src/lib/forbidden.ts:4',
      'src/lib/forbidden.ts:5',
    ]);
  });

  test.each(['tsx', 'mts', 'cts', 'jsx', 'js', 'mjs', 'cjs', 'svelte.ts', 'svelte.js'])(
    'scans .%s browser source',
    (extension) => {
      const { packageRoot } = workspaceFixture({
        [`src/lib/forbidden.${extension}`]: "import { readFile } from 'node:fs';\n",
      });
      expect(findImportViolations(packageRoot).map(({ file, line }) => `${file}:${line}`)).toEqual([
        `src/lib/forbidden.${extension}:1`,
      ]);
    },
  );

  test('allows type-only imports of server entries, which erase before runtime', () => {
    const { packageRoot } = workspaceFixture({
      'src/lib/types.ts': [
        "import type { Pty } from '@lostgradient/ventriloquist/bun';",
        "export type { Socket } from '@lostgradient/ventriloquist/websocket';",
      ].join('\n'),
    });
    expect(findImportViolations(packageRoot)).toEqual([]);
  });

  test('rejects a rejected comparison engine imported from source', () => {
    const { packageRoot } = workspaceFixture({
      'src/lib/engine.ts': "import { init } from 'ghostty-web';\n",
    });
    expect(formatViolations(findImportViolations(packageRoot))).toContain(
      'src/lib/engine.ts:1: ghostty-web is a comparison engine',
    );
  });

  test('rejects a relative import that leaves the package, even into a server entry', () => {
    const { packageRoot } = workspaceFixture({
      'src/lib/reach.ts': [
        "import { pty } from '../../../ventriloquist/src/bun/index.ts';",
        "import { local } from './local.ts';",
        "import { absolute } from '/etc/anywhere.ts';",
      ].join('\n'),
    });
    expect(formatViolations(findImportViolations(packageRoot)).split('\n')).toEqual([
      'src/lib/reach.ts:1: ../../../ventriloquist/src/bun/index.ts leaves the package; import it through its package name',
      'src/lib/reach.ts:3: /etc/anywhere.ts leaves the package; import it through its package name',
    ]);
  });

  test('allows the neutral ventriloquist export and the declared dependencies', () => {
    const { packageRoot } = workspaceFixture({
      'src/lib/allowed.ts': [
        "import { PROTOCOL_VERSION } from '@lostgradient/ventriloquist';",
        "import { Terminal } from '@xterm/xterm';",
        "import { mount } from 'svelte';",
      ].join('\n'),
    });
    expect(findImportViolations(packageRoot)).toEqual([]);
  });

  test('skips test scaffolding, which legitimately imports Bun and Node modules', () => {
    const forbidden = "import { test } from 'bun:test';\nimport { join } from 'node:path';\n";
    const { packageRoot } = workspaceFixture({
      'src/lib/thing.test.ts': forbidden,
      'src/lib/thing.spec.ts': forbidden,
      'src/lib/thing.test-support.ts': forbidden,
      'src/lib/thing-test-helpers.ts': forbidden,
      'src/test/harness.ts': forbidden,
      'src/lib/tests/harness.ts': forbidden,
      'src/lib/__fixtures__/harness.ts': forbidden,
      'src/lib/notes.md': forbidden,
    });
    expect(findImportViolations(packageRoot)).toEqual([]);
  });
});

describe('findManifestViolations', () => {
  test('accepts the selected engine through the root catalog', () => {
    const { packageRoot, workspaceRoot } = workspaceFixture();
    expect(findManifestViolations(packageRoot, workspaceRoot)).toEqual([]);
  });

  test('requires the exact catalog pin', () => {
    const { packageRoot, workspaceRoot } = workspaceFixture({
      '/package.json': JSON.stringify({ catalog: { '@xterm/xterm': '^6.0.0' } }),
    });
    expect(formatViolations(findManifestViolations(packageRoot, workspaceRoot))).toContain(
      'root catalog must pin @xterm/xterm to 6.0.0, found ^6.0.0',
    );
  });

  test('requires the terminal to take the engine from the catalog', () => {
    const { packageRoot, workspaceRoot } = workspaceFixture({
      'package.json': JSON.stringify({ dependencies: { '@xterm/xterm': '6.0.0' } }),
    });
    expect(formatViolations(findManifestViolations(packageRoot, workspaceRoot))).toContain(
      '@xterm/xterm must be a dependency through the root catalog, found 6.0.0',
    );
  });

  test('requires the engine to be declared at all', () => {
    const { packageRoot, workspaceRoot } = workspaceFixture({
      'package.json': JSON.stringify({ name: '@lostgradient/terminal' }),
      '/package.json': JSON.stringify({ catalog: {} }),
    });
    const text = formatViolations(findManifestViolations(packageRoot, workspaceRoot));
    expect(text).toContain('found nothing');
    expect(text.split('\n')).toHaveLength(2);
  });

  test('accepts the clean lockfile', () => {
    const { packageRoot, workspaceRoot } = workspaceFixture();
    expect(findLockfileViolations(packageRoot, workspaceRoot)).toEqual([]);
  });
});

describe('findLockfileViolations', () => {
  function lockViolations(lock: string): string {
    const { packageRoot, workspaceRoot } = workspaceFixture({ '/bun.lock': lock });
    return formatViolations(findLockfileViolations(packageRoot, workspaceRoot));
  }
  const xterm = { '@xterm/xterm': '@xterm/xterm@6.0.0' };

  test.each([
    ['an engine under its own name', { 'ghostty-web': 'ghostty-web@0.4.0' }],
    ['an aliased engine', { 'terminal-engine': 'ghostty-web@0.4.0' }],
    ['an aliased scoped engine', { renderer: '@wterm/dom@1.2.3' }],
    ['a git engine', { 'ghostty-web': 'ghostty-web@github:ghostty-org/ghostty-web#v0.4.0' }],
    ['a git URL engine', { engine: '@wterm/core@git+https://example.invalid/wterm.git#abc123' }],
    ['a nested engine', { 'parent/ghostty-web': 'ghostty-web@0.4.0' }],
  ])('rejects %s resolved in the lockfile', (_name, packages) => {
    expect(lockViolations(lockfile({ ...xterm, ...packages }))).toMatch(
      /bun\.lock:1: \S+ resolves to (?:ghostty-web|@wterm\/\w+), a comparison engine/,
    );
  });

  test.each([
    ['an overridden version', '@xterm/xterm@5.5.0', '5.5.0'],
    ['a git source', '@xterm/xterm@github:xtermjs/xterm.js#abc', 'github:xtermjs/xterm.js#abc'],
  ])('rejects the engine resolving to %s', (_name, resolved, shown) => {
    expect(lockViolations(lockfile({ '@xterm/xterm': resolved }))).toContain(
      `bun.lock:1: @xterm/xterm resolves to ${shown}, but the contract pins 6.0.0`,
    );
  });

  test('rejects a second, nested copy of the engine at another version', () => {
    expect(
      lockViolations(lockfile({ ...xterm, 'other/@xterm/xterm': '@xterm/xterm@5.5.0' })),
    ).toContain('@xterm/xterm resolves to 5.5.0');
  });

  test('requires the engine to resolve at all', () => {
    expect(lockViolations(lockfile({ left: 'left@1.0.0' }))).toContain(
      'bun.lock:1: @xterm/xterm does not resolve in the lockfile',
    );
  });

  test('does not mistake a similarly named package for a comparison engine', () => {
    expect(
      lockViolations(lockfile({ ...xterm, 'ghostty-web-docs': 'ghostty-web-docs@1.0.0' })),
    ).toBe('');
  });

  test('reads workspaces from the lockfile, including ones a glob would not describe', () => {
    const text = lockViolations(
      lockfile(xterm, {
        '': { name: 'corvidae' },
        'scripts/browser-fixtures': { dependencies: { 'ghostty-web': '1.0.0' } },
        'packages/other': { optionalDependencies: { '@wterm/dom': '1.0.0' } },
        'packages/peer': { peerDependencies: { 'ghostty-web': '1' }, devDependencies: { ok: '1' } },
      }),
    );
    expect(text).toContain(
      'bun.lock:1: scripts/browser-fixtures declares ghostty-web, a comparison engine',
    );
    expect(text).toContain('packages/other declares @wterm/dom');
    expect(text).toContain('packages/peer declares ghostty-web');
    expect(text.split('\n')).toHaveLength(3);
  });

  test('names the root workspace when the root declares an engine', () => {
    expect(
      lockViolations(lockfile(xterm, { '': { devDependencies: { 'ghostty-web': '1' } } })),
    ).toContain('the root workspace declares ghostty-web');
  });
});

describe('import probe', () => {
  function probe(entrySource: string, extraFiles: Record<string, string> = {}) {
    const { packageRoot } = workspaceFixture({ 'src/index.ts': entrySource, ...extraFiles });
    return runImportProbe(packageRoot, join(packageRoot, 'src/index.ts'));
  }

  test('reports nothing for a module that only defines exports', () => {
    expect(probe('export const value = 1;\n')).toEqual({
      forbiddenModules: [],
      trappedCalls: [],
      domGlobals: [],
      addedGlobals: [],
    });
  });

  test.each([
    ['fetch', "await fetch('https://example.invalid/');", ['fetch']],
    [
      'WebAssembly compilation',
      'await WebAssembly.compile(new Uint8Array());',
      ['WebAssembly.compile'],
    ],
    [
      'WebAssembly module construction',
      'new WebAssembly.Module(new Uint8Array());',
      ['new WebAssembly.Module'],
    ],
    [
      'WebAssembly instance construction',
      'new WebAssembly.Instance({});',
      ['new WebAssembly.Instance'],
    ],
    ['a timeout', 'setTimeout(() => {}, 60_000);', ['setTimeout']],
    ['an interval', 'setInterval(() => {}, 60_000);', ['setInterval']],
    ['an immediate', 'setImmediate(() => {});', ['setImmediate']],
    ['a worker', "new Worker('worker.js');", ['new Worker']],
    ['a socket', "new WebSocket('ws://example.invalid/');", ['new WebSocket']],
  ])('traps %s made while importing', (_name, statement, calls) => {
    const report = probe(`try { ${statement} } catch {}\nexport {};\n`);
    expect(report.trappedCalls).toEqual(calls);
  });

  test('reports a read of a DOM global, even behind a typeof guard', () => {
    expect(probe("export const live = typeof document !== 'undefined';\n").domGlobals).toEqual([
      'document',
    ]);
  });

  test('reports a read of a DOM-like global Bun already defines', () => {
    const report = probe('export const agent = navigator.userAgent;\n');
    expect(report.domGlobals).toEqual(['navigator']);
    expect(report.error).toBeUndefined();
  });

  test('reports a global the import defines', () => {
    expect(
      probe('Object.assign(globalThis, { leakedByImport: 1 });\nexport {};\n').addedGlobals,
    ).toEqual(['leakedByImport']);
  });

  const installedPackages = {
    'node_modules/@xterm/xterm/package.json': '{"name":"@xterm/xterm","main":"lib/xterm.js"}',
    'node_modules/@xterm/xterm/lib/xterm.js': 'globalThis.engineLoaded = true;\n',
    'node_modules/@lostgradient/ventriloquist/package.json': JSON.stringify({
      name: '@lostgradient/ventriloquist',
      exports: {
        '.': './src/index.ts',
        './bun': './src/bun/index.ts',
        './websocket': './src/websocket/index.ts',
      },
    }),
    'node_modules/@lostgradient/ventriloquist/src/index.ts': 'export const neutral = 1;\n',
    'node_modules/@lostgradient/ventriloquist/src/bun/index.ts': 'export const bun = 1;\n',
    'node_modules/@lostgradient/ventriloquist/src/websocket/index.ts': 'export const socket = 1;\n',
  };

  test.each([
    ['the engine', "import '@xterm/xterm';", '/node_modules/@xterm/xterm/lib/xterm.js'],
    [
      'the Bun pipe and PTY entry',
      "import '@lostgradient/ventriloquist/bun';",
      '/ventriloquist/src/bun/index.ts',
    ],
    [
      'the WebSocket server entry',
      "import '@lostgradient/ventriloquist/websocket';",
      '/ventriloquist/src/websocket/index.ts',
    ],
  ])('reports %s when the import graph loads it', (_name, statement, suffix) => {
    const report = probe(`import './lib/reaches.ts';\nexport {};\n`, {
      ...installedPackages,
      'src/lib/reaches.ts': `${statement}\n`,
    });
    expect(report.forbiddenModules).toHaveLength(1);
    expect(report.forbiddenModules[0]).toEndWith(suffix);
    // The probe replaces a forbidden module with an empty one, so the engine never runs.
    expect(report.addedGlobals).toEqual([]);
  });

  test('allows the neutral ventriloquist entry', () => {
    const report = probe("import '@lostgradient/ventriloquist';\nexport {};\n", installedPackages);
    expect(report.forbiddenModules).toEqual([]);
    expect(report.error).toBeUndefined();
  });

  test('reports an import that throws', () => {
    expect(probe("throw new Error('boom');\n").error).toBe('boom');
  });

  test('turns each finding into a violation against the entry', () => {
    const { packageRoot } = workspaceFixture();
    const entry = join(packageRoot, 'src/index.ts');
    expect(
      importProbeViolations(
        {
          forbiddenModules: ['/node_modules/@xterm/xterm/lib/xterm.js'],
          trappedCalls: ['fetch'],
          domGlobals: ['window'],
          addedGlobals: ['leak'],
          error: 'boom',
        },
        packageRoot,
        entry,
      ).map(({ file, message }) => `${file}: ${message}`),
    ).toEqual([
      'src/index.ts: importing the package loaded /node_modules/@xterm/xterm/lib/xterm.js',
      'src/index.ts: importing the package called fetch',
      'src/index.ts: importing the package read the DOM global window',
      'src/index.ts: importing the package added the global leak',
      'src/index.ts: importing the package failed: boom',
    ]);
  });
});

describe('checkBoundaries', () => {
  test('holds for this package', () => {
    expect(formatViolations(checkBoundaries(realPackageRoot))).toBe('');
  });

  test('fails the command line, naming the file and line, when browser source imports a Bun entry', () => {
    const { packageRoot } = workspaceFixture({
      'src/lib/forbidden.ts':
        "import { spawn } from '@lostgradient/ventriloquist/bun';\nexport { spawn };\n",
    });
    const result = Bun.spawnSync(
      [
        process.execPath,
        join(import.meta.dir, 'check-boundaries.ts'),
        '--package-root',
        packageRoot,
      ],
      { cwd: realPackageRoot },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain('src/lib/forbidden.ts:1');
    expect(result.stderr.toString()).toContain(
      '@lostgradient/ventriloquist/bun is a Bun host entry',
    );
  });

  test('passes the command line for a clean package', () => {
    const { packageRoot } = workspaceFixture();
    const result = Bun.spawnSync(
      [
        process.execPath,
        join(import.meta.dir, 'check-boundaries.ts'),
        '--package-root',
        packageRoot,
      ],
      { cwd: realPackageRoot },
    );
    expect(result.stderr.toString()).toBe('');
    expect(result.exitCode).toBe(0);
  });

  test('requires a path after --package-root', () => {
    const result = Bun.spawnSync(
      [process.execPath, join(import.meta.dir, 'check-boundaries.ts'), '--package-root'],
      { cwd: realPackageRoot },
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain('--package-root requires a path argument');
  });
});
