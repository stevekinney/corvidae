import { describe, expect, it } from 'bun:test';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BUILD_PIPELINE_MODULE_NAMES,
  PROCESS_OWNING_MODULE_NAMES,
  createTestProcessPlan,
  discoverTestFiles,
  requiresFreshProcess,
  type PlaygroundTestFile,
} from './run-tests.ts';

function testFile(path: string, source = ''): PlaygroundTestFile {
  return { path, source };
}

describe('playground test process isolation', () => {
  it.each([
    ['src/component-page.test.ts', ''],
    ['src/playground-server.test.ts', "import { handleRequest } from './playground-server.ts';"],
    ['scripts/static-export.test.ts', "import { runStaticExport } from './static-export.ts';"],
    [
      'src/featured-example-server-renderer.test.ts',
      "import { renderFeaturedExample } from './featured-example-server-renderer.ts';",
    ],
    ['src/page-bundle.test.ts', "import { compilePageBundleArtifacts } from './page-bundle.ts';"],
    [
      'src/documentation-styles.test.ts',
      "import { buildDocumentationStylesheet } from './documentation-styles.ts';",
    ],
    ['src/direct-build.test.ts', 'await Bun.build(options);'],
    ['scripts/spawns.test.ts', "const child = Bun.spawn(['true']);"],
    ['scripts/spawns-sync.test.ts', "Bun.spawnSync(['git', 'status']);"],
    [
      'scripts/gate-lifecycle.test.ts',
      "import { ProcessOwner } from './static-playground-processes.ts';",
    ],
    [
      'scripts/gate.test.ts',
      "import { runStaticPlaygroundGate } from './check-static-playground.ts';",
    ],
    ['src/dynamic-server.test.ts', "const server = await import('./playground-server.ts');"],
    ['src/side-effect-server.test.ts', "import './playground-server.ts';"],
  ])('isolates %s in a fresh process', (path, source) => {
    expect(requiresFreshProcess(testFile(path, source))).toBeTrue();
  });

  it('keeps tests without mounts or builds in the shared process', () => {
    expect(requiresFreshProcess(testFile('src/analyze.test.ts'))).toBeFalse();
  });

  it('ignores build syntax inside strings and comments', () => {
    expect(
      requiresFreshProcess(
        testFile(
          'src/classifier.test.ts',
          `
            const importFixture = "import './playground-server.ts'";
            const buildFixture = 'await Bun.build(options)';
            // import './static-export.ts';
          `,
        ),
      ),
    ).toBeFalse();
  });

  it('places every state-sensitive test in its own process', () => {
    expect(
      createTestProcessPlan([
        testFile(
          'src/playground-server.test.ts',
          "import { handleRequest } from './playground-server.ts';",
        ),
        testFile('src/analyze.test.ts'),
        testFile(
          'scripts/static-export.test.ts',
          "import { runStaticExport } from './static-export.ts';",
        ),
        testFile('src/discover.test.ts'),
      ]),
    ).toEqual([
      ['src/analyze.test.ts', 'src/discover.test.ts'],
      ['scripts/static-export.test.ts'],
      ['src/playground-server.test.ts'],
    ]);
  });

  it('lists every playground module that calls Bun.build, so a test importing one is isolated', async () => {
    // `fileURLToPath`, not `new URL(...).pathname`, which is a broken `/C:/...` on Windows.
    const playgroundRoot = fileURLToPath(new URL('..', import.meta.url));
    const callers: string[] = [];
    for (const directory of ['scripts', 'src']) {
      const glob = new Bun.Glob('**/*.ts');
      for await (const relativePath of glob.scan({ cwd: join(playgroundRoot, directory) })) {
        if (relativePath.endsWith('.test.ts') || relativePath === 'run-tests.ts') continue;
        const source = await Bun.file(join(playgroundRoot, directory, relativePath)).text();
        if (/\bBun\.build\(/.test(source)) callers.push(basename(relativePath));
      }
    }

    expect(callers.length).toBeGreaterThan(0);
    const listed: readonly string[] = BUILD_PIPELINE_MODULE_NAMES;
    expect(callers.filter((moduleName) => !listed.includes(moduleName)).toSorted()).toEqual([]);
  });

  it('runs the stand-in lifecycle cases by default but never the real-Chromium check', async () => {
    const testFiles = await discoverTestFiles();
    const paths = testFiles.map((testFile) => testFile.path);

    expect(paths).toContain('scripts/static-playground-lifecycle.test.ts');
    expect(paths).toContain('scripts/check-static-playground.test.ts');
    expect(
      await Bun.file(
        join(import.meta.dirname, 'static-playground-browser-lifecycle.check.ts'),
      ).exists(),
    ).toBe(true);
    expect(paths.filter((path) => !path.endsWith('.test.ts'))).toEqual([]);
    expect(paths.filter((path) => path.includes('browser-lifecycle'))).toEqual([]);
  });

  it('isolates every test that spawns processes or imports a process-owning module', async () => {
    const testFiles = await discoverTestFiles();
    // This file names those calls and modules only inside string fixtures, which the AST
    // classifier correctly ignores; the text match here would not.
    const spawning = testFiles.filter(
      (testFile) =>
        testFile.path !== 'scripts/run-tests.test.ts' &&
        (/\bBun\.spawn(?:Sync)?\(/.test(testFile.source) ||
          PROCESS_OWNING_MODULE_NAMES.some((moduleName) => testFile.source.includes(moduleName))),
    );

    expect(spawning.map((testFile) => testFile.path)).toContain(
      'scripts/static-playground-lifecycle.test.ts',
    );
    expect(
      spawning.filter((testFile) => !requiresFreshProcess(testFile)).map((t) => t.path),
    ).toEqual([]);
  });
});
