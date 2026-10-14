import { describe, expect, it } from 'bun:test';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BUILD_PIPELINE_MODULE_NAMES,
  createTestProcessPlan,
  requiresFreshProcess,
  selectLaneFiles,
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
});

describe('playground test lanes', () => {
  const files = [
    testFile('src/analyze.test.ts'),
    testFile('src/analyze.slow.test.ts'),
    testFile('scripts/run-tests.test.ts'),
  ];

  it('keeps slow files out of the fast lane', () => {
    expect(selectLaneFiles(files, 'fast').map(({ path }) => path)).toEqual([
      'src/analyze.test.ts',
      'scripts/run-tests.test.ts',
    ]);
  });

  it('runs only slow files in the slow lane', () => {
    expect(selectLaneFiles(files, 'slow').map(({ path }) => path)).toEqual([
      'src/analyze.slow.test.ts',
    ]);
  });
});
