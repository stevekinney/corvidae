import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  analyzeSource,
  resolveSpecifier,
  type WorkspaceDescription,
} from './affected-tests-graph.ts';
import {
  buildManifest,
  manifestDirectory,
  narrowBunTestArguments,
  readManifest,
  rootAdmits,
  selectedFilesFor,
  SELECTION_VARIABLE,
  splitBunTestArguments,
  writeManifest,
} from './affected-tests-manifest.ts';
import { selectTests, type Selection } from './affected-tests-selection.ts';
import { discoverWorkspaces, explain, planInvocations } from './affected-tests.ts';

const root = join(import.meta.dir, '..');

function workspace(
  name: string,
  directory: string,
  overrides: Partial<WorkspaceDescription> = {},
): WorkspaceDescription {
  return {
    name,
    directory,
    dependencies: [],
    exports: directory === '' ? null : { '.': './src/index.ts' },
    preloads: [],
    testScripts: directory === '' ? [] : ['bun ../../scripts/bun-test-junit.ts'],
    ...overrides,
  };
}

const rootWorkspace = workspace('corvidae', '');
const alpha = workspace('@scope/alpha', 'packages/alpha', {
  exports: { '.': './src/index.ts', './extra': './src/extra.ts' },
});
const beta = workspace('@scope/beta', 'packages/beta', { dependencies: ['@scope/alpha'] });
const gamma = workspace('@scope/gamma', 'packages/gamma');
const everyWorkspace = [rootWorkspace, alpha, beta, gamma];

function select(files: Record<string, string>, changed: string[], workspaces = everyWorkspace) {
  const selection = selectTests({
    changed,
    tree: { paths: new Set(Object.keys(files)), read: (path) => files[path] },
    workspaces,
  });
  return {
    selection,
    selected(name: string): string[] {
      const entry = selection.workspaces.find((candidate) => candidate.name === name);
      return [...(entry?.tests.keys() ?? [])].toSorted();
    },
    mode(name: string) {
      return selection.workspaces.find((candidate) => candidate.name === name)?.mode;
    },
  };
}

/** A small repository: Beta's test reaches Alpha's `deep.ts` through Alpha's barrel. */
const baseFiles: Record<string, string> = {
  'package.json': '{}',
  'packages/alpha/package.json': '{}',
  'packages/alpha/src/index.ts': "export * from './deep.ts';\nexport * from './other.ts';\n",
  'packages/alpha/src/deep.ts': 'export const deep = 1;\n',
  'packages/alpha/src/other.ts': 'export const other = 1;\n',
  'packages/alpha/src/extra.ts': 'export const extra = 1;\n',
  'packages/alpha/src/deep.test.ts': "import { deep } from './deep.ts';\nvoid deep;\n",
  'packages/alpha/src/other.test.ts': "import { other } from './other.ts';\nvoid other;\n",
  'packages/beta/package.json': '{}',
  'packages/beta/src/index.ts': 'export const beta = 1;\n',
  'packages/beta/src/uses-alpha.test.ts': "import { deep } from '@scope/alpha';\nvoid deep;\n",
  'packages/beta/src/uses-extra.test.ts':
    "import { extra } from '@scope/alpha/extra';\nvoid extra;\n",
  'packages/beta/src/alone.test.ts': "import { beta } from './index.ts';\nvoid beta;\n",
  'packages/gamma/package.json': '{}',
  'packages/gamma/src/index.ts': 'export const gamma = 1;\n',
  'packages/gamma/src/gamma.test.ts': "import { gamma } from './index.ts';\nvoid gamma;\n",
};

describe('import graph selection', () => {
  test('selects a changed test file and nothing else in its workspace', () => {
    const { selected, mode } = select(baseFiles, ['packages/gamma/src/gamma.test.ts']);
    expect(selected('@scope/gamma')).toEqual(['packages/gamma/src/gamma.test.ts']);
    expect(mode('@scope/gamma')).toBe('full');
    expect(selected('@scope/alpha')).toEqual([]);
  });

  test('selects a test that imports the changed file, directly or through a barrel', () => {
    const { selected } = select(baseFiles, ['packages/alpha/src/deep.ts']);
    expect(selected('@scope/alpha')).toEqual(['packages/alpha/src/deep.test.ts']);
  });

  test('selects a test in another workspace that reaches the changed file through a workspace specifier', () => {
    // The red case: Beta never names `deep.ts`. Its test imports `@scope/alpha`, whose exports map
    // points at `src/index.ts`, which re-exports `deep.ts`.
    const { selected, selection } = select(baseFiles, ['packages/alpha/src/deep.ts']);
    expect(selected('@scope/beta')).toContain('packages/beta/src/uses-alpha.test.ts');
    const beta = selection.workspaces.find((entry) => entry.name === '@scope/beta');
    const reason = beta?.tests.get('packages/beta/src/uses-alpha.test.ts');
    expect(reason).toEqual({
      kind: 'imports',
      chain: [
        'packages/beta/src/uses-alpha.test.ts',
        'packages/alpha/src/index.ts',
        'packages/alpha/src/deep.ts',
      ],
    });
  });

  test('leaves unrelated tests out', () => {
    const { selected, mode } = select(baseFiles, ['packages/alpha/src/deep.ts']);
    expect(selected('@scope/beta')).not.toContain('packages/beta/src/alone.test.ts');
    expect(selected('@scope/gamma')).toEqual([]);
    expect(mode('@scope/gamma')).toBe('none');
  });

  test('resolves a subpath export to the one file it names', () => {
    const { selected } = select(baseFiles, ['packages/alpha/src/extra.ts']);
    expect(selected('@scope/beta')).toEqual(['packages/beta/src/uses-extra.test.ts']);
    expect(selected('@scope/alpha')).toEqual([]);
  });

  test('does not follow a type-only import, which leaves no runtime edge', () => {
    const files = {
      ...baseFiles,
      'packages/gamma/src/types.ts': 'export type Shape = { a: number };\n',
      'packages/gamma/src/typed.test.ts':
        "import type { Shape } from './types.ts';\nvoid (0 as unknown as Shape);\n",
    };
    expect(select(files, ['packages/gamma/src/types.ts']).selected('@scope/gamma')).toEqual([]);
  });

  test('keeps a side-effect import and a value import even when unused', () => {
    const files = {
      ...baseFiles,
      'packages/gamma/src/setup.ts': 'globalThis.ready = true;\n',
      'packages/gamma/src/side-effect.test.ts': "import './setup.ts';\n",
    };
    expect(select(files, ['packages/gamma/src/setup.ts']).selected('@scope/gamma')).toEqual([
      'packages/gamma/src/side-effect.test.ts',
    ]);
  });

  test('resolves `.js` specifiers to TypeScript sources and directories to their index', () => {
    const files = {
      ...baseFiles,
      'packages/gamma/src/lib/index.ts': 'export const lib = 1;\n',
      'packages/gamma/src/lib-user.test.ts': "import { lib } from './lib';\nvoid lib;\n",
      'packages/gamma/src/js-user.test.ts': "import { gamma } from './index.js';\nvoid gamma;\n",
    };
    expect(select(files, ['packages/gamma/src/lib/index.ts']).selected('@scope/gamma')).toEqual([
      'packages/gamma/src/lib-user.test.ts',
    ]);
    expect(select(files, ['packages/gamma/src/index.ts']).selected('@scope/gamma')).toContain(
      'packages/gamma/src/js-user.test.ts',
    );
  });

  test('a deleted file reaches the tests whose importers still name it', () => {
    const files = { ...baseFiles };
    delete files['packages/alpha/src/deep.ts'];
    const { selected } = select(files, ['packages/alpha/src/deep.ts']);
    expect(selected('@scope/alpha').length).toBeGreaterThan(0);
  });

  test('analysis reads exports-from and dynamic literal imports, and skips comments', () => {
    const analysis = analyzeSource(
      'a.ts',
      "export { x } from './x.ts';\nconst y = await import('./y.ts');\n// import('./z.ts')\n",
    );
    expect(analysis.specifiers).toEqual(['./x.ts', './y.ts']);
    expect(analysis.importsDynamically).toBe(false);
  });

  test('resolves a workspace specifier its exports map does not name to the manifest', () => {
    const paths = new Set(['packages/alpha/package.json', 'packages/alpha/src/index.ts']);
    expect(resolveSpecifier('x.ts', '@scope/alpha/missing', paths, everyWorkspace)).toBe(
      'packages/alpha/package.json',
    );
    expect(resolveSpecifier('x.ts', 'react', paths, everyWorkspace)).toBeNull();
  });
});

describe('Svelte sources', () => {
  const files: Record<string, string> = {
    ...baseFiles,
    'packages/gamma/src/helper.ts': 'export const helper = 1;\n',
    'packages/gamma/src/module-helper.ts': 'export const moduleHelper = 1;\n',
    'packages/gamma/src/styles.css': '.a { color: red; }\n',
    'packages/gamma/src/Widget.svelte': [
      '<script module lang="ts">',
      "  import { moduleHelper } from './module-helper.ts';",
      '  export { moduleHelper };',
      '</script>',
      '<script lang="ts">',
      "  import { helper } from './helper.ts';",
      "  import './styles.css';",
      '  const value: number = helper;',
      '</script>',
      '<p>{value}</p>',
    ].join('\n'),
    'packages/gamma/src/widget.test.ts': "import Widget from './Widget.svelte';\nvoid Widget;\n",
    'packages/gamma/src/plain.test.ts': 'void 0;\n',
  };

  test('selects a test importing a component whose script imports the changed file', () => {
    expect(select(files, ['packages/gamma/src/helper.ts']).selected('@scope/gamma')).toEqual([
      'packages/gamma/src/widget.test.ts',
    ]);
  });

  test('reads the module script block too', () => {
    expect(select(files, ['packages/gamma/src/module-helper.ts']).selected('@scope/gamma')).toEqual(
      ['packages/gamma/src/widget.test.ts'],
    );
  });

  test('selects a test through a stylesheet the component imports', () => {
    expect(select(files, ['packages/gamma/src/styles.css']).selected('@scope/gamma')).toEqual([
      'packages/gamma/src/widget.test.ts',
    ]);
  });

  test('selects a test when the component itself changed', () => {
    expect(select(files, ['packages/gamma/src/Widget.svelte']).selected('@scope/gamma')).toEqual([
      'packages/gamma/src/widget.test.ts',
    ]);
  });
});

describe('fallbacks that widen the selection', () => {
  test('a workspace package.json selects its workspace and its dependents that import it', () => {
    const { selected, mode, selection } = select(baseFiles, ['packages/alpha/package.json']);
    expect(mode('@scope/alpha')).toBe('full');
    expect(selected('@scope/beta')).toContain('packages/beta/src/uses-alpha.test.ts');
    expect(selected('@scope/beta')).not.toContain('packages/beta/src/alone.test.ts');
    expect(selection.repositoryRule).toBeNull();
  });

  test.each(['packages/alpha/bunfig.toml', 'packages/alpha/tsconfig.json'])(
    '%s selects the whole workspace and no other',
    (path) => {
      const { mode } = select({ ...baseFiles, [path]: '' }, [path]);
      expect(mode('@scope/alpha')).toBe('full');
      expect(mode('@scope/beta')).toBe('none');
    },
  );

  test.each(['package.json', 'bun.lock', 'bunfig.toml', 'turbo.json', 'tsconfig.json'])(
    'root %s selects the whole repository',
    (path) => {
      const { selection, mode } = select({ ...baseFiles, [path]: '' }, [path]);
      expect(selection.repositoryRule).toContain(path);
      expect(mode('@scope/gamma')).toBe('full');
    },
  );

  test('a preload file, and what it imports, select the whole workspace that preloads it', () => {
    const files = {
      ...baseFiles,
      'packages/gamma/tests/setup.ts': "import './register.ts';\n",
      'packages/gamma/tests/register.ts': 'globalThis.registered = true;\n',
    };
    const withPreload = [
      rootWorkspace,
      alpha,
      beta,
      workspace('@scope/gamma', 'packages/gamma', { preloads: ['packages/gamma/tests/setup.ts'] }),
    ];
    for (const changed of ['packages/gamma/tests/setup.ts', 'packages/gamma/tests/register.ts']) {
      const result = select(files, [changed], withPreload);
      expect(result.mode('@scope/gamma')).toBe('full');
      expect(result.mode('@scope/alpha')).toBe('none');
    }
  });

  test('data no importer or reference names selects its whole workspace', () => {
    const files = { ...baseFiles, 'packages/gamma/fixtures/case.json': '{}' };
    const { mode } = select(files, ['packages/gamma/fixtures/case.json']);
    expect(mode('@scope/gamma')).toBe('full');
    expect(mode('@scope/alpha')).toBe('none');
  });

  test('data a test imports or names by literal path reaches that test and no more', () => {
    const files = {
      ...baseFiles,
      'packages/gamma/fixtures/imported.json': '{}',
      'packages/gamma/fixtures/read.json': '{}',
      'packages/gamma/src/imports-data.test.ts':
        "import data from '../fixtures/imported.json' with { type: 'json' };\nvoid data;\n",
      'packages/gamma/src/reads-data.test.ts':
        "const text = await Bun.file(`${import.meta.dir}/../fixtures/read.json`).text();\nvoid text;\nconst name = '../fixtures/read.json';\nvoid name;\n",
    };
    expect(
      select(files, ['packages/gamma/fixtures/imported.json']).selected('@scope/gamma'),
    ).toEqual(['packages/gamma/src/imports-data.test.ts']);
    expect(select(files, ['packages/gamma/fixtures/read.json']).selected('@scope/gamma')).toEqual([
      'packages/gamma/src/reads-data.test.ts',
    ]);
  });

  test('a file a test names by a bare or partial path reaches that test, not the workspace', () => {
    const files = {
      ...baseFiles,
      'documentation/contracts.md': '# Contracts\n',
      'packages/gamma/src/contract.test.ts':
        "import { join } from 'node:path';\nconst file = join(import.meta.dir, '..', '..', '..', 'documentation', 'contracts.md');\nvoid file;\n",
    };
    const { selected, mode, selection } = select(files, ['documentation/contracts.md']);
    expect(selected('@scope/gamma')).toEqual(['packages/gamma/src/contract.test.ts']);
    expect(mode('@scope/alpha')).toBe('none');
    expect(selection.repositoryRule).toBeNull();
  });

  describe('files a test reads through a path anchored to its own location', () => {
    // The chat.css case: a stylesheet a component imports, and a test that also reads it as text.
    const reading: Record<string, string> = {
      ...baseFiles,
      'packages/gamma/src/chat.css': '.a { color: red; }\n',
      'packages/gamma/src/Chat.svelte':
        '<script lang="ts">\n  import \'./chat.css\';\n</script>\n<p>chat</p>\n',
      'packages/gamma/src/chat.test.ts': "import Chat from './Chat.svelte';\nvoid Chat;\n",
    };
    const readers: Record<string, string> = {
      'template-dir.test.ts': 'await Bun.file(`${import.meta.dir}/chat.css`).text();\n',
      'template-dirname.test.ts': 'await Bun.file(`${import.meta.dirname}/chat.css`).text();\n',
      'url.test.ts': "await Bun.file(new URL('./chat.css', import.meta.url)).text();\n",
      'join.test.ts':
        "import { join } from 'node:path';\nawait Bun.file(join(import.meta.dir, 'chat.css')).text();\n",
    };

    for (const [name, source] of Object.entries(readers)) {
      test(`${name} is selected when the stylesheet it reads changes, though a component imports it`, () => {
        const files = { ...reading, [`packages/gamma/src/${name}`]: source };
        const { selected } = select(files, ['packages/gamma/src/chat.css']);
        expect(selected('@scope/gamma')).toContain(`packages/gamma/src/${name}`);
        expect(selected('@scope/gamma')).toContain('packages/gamma/src/chat.test.ts');
      });
    }

    test('a path built from a run-time value falls back to the readers of that kind of file in the workspace', () => {
      const files = {
        ...reading,
        'packages/gamma/src/other.css': '.b {}\n',
        'packages/gamma/src/computed.test.ts':
          'const name = process.env.STYLE ?? "";\nawait Bun.file(`${import.meta.dir}/${name}.css`).text();\n',
        'packages/alpha/src/computed.test.ts':
          'const name = process.env.STYLE ?? "";\nawait Bun.file(`${import.meta.dir}/${name}.css`).text();\n',
      };
      const { selected } = select(files, ['packages/gamma/src/other.css']);
      expect(selected('@scope/gamma')).toContain('packages/gamma/src/computed.test.ts');
      expect(selected('@scope/alpha')).not.toContain('packages/alpha/src/computed.test.ts');
    });
  });

  test('a workspace with no code, such as the shared TypeScript bases, selects the repository', () => {
    const configuration = workspace('@scope/typescript', 'internal/typescript', {
      exports: { './base.json': './base.json' },
      testScripts: [],
    });
    const files = { ...baseFiles, 'internal/typescript/base.json': '{}' };
    const { selection, mode } = select(
      files,
      ['internal/typescript/base.json'],
      [...everyWorkspace, configuration],
    );
    expect(selection.repositoryRule).toContain('internal/typescript/base.json');
    expect(mode('@scope/gamma')).toBe('full');
  });

  test('a snapshot selects the test it belongs to', () => {
    const files = {
      ...baseFiles,
      'packages/gamma/src/__snapshots__/gamma.test.ts.snap': 'exports[`a`] = 1;\n',
    };
    const { selected, mode } = select(files, [
      'packages/gamma/src/__snapshots__/gamma.test.ts.snap',
    ]);
    expect(selected('@scope/gamma')).toEqual(['packages/gamma/src/gamma.test.ts']);
    expect(mode('@scope/gamma')).toBe('full');
  });

  test('a code file nothing imports selects its workspace', () => {
    const files = { ...baseFiles, 'packages/gamma/scripts/orphan.ts': 'console.log(1);\n' };
    expect(select(files, ['packages/gamma/scripts/orphan.ts']).mode('@scope/gamma')).toBe('full');
  });

  test('an unattributed file outside every workspace selects the repository', () => {
    const files = { ...baseFiles, '.github/something.yml': 'a: 1\n' };
    const { selection } = select(files, ['.github/something.yml']);
    expect(selection.repositoryRule).toContain('.github/something.yml');
  });

  test('unattributed documentation reaches tests that scan the tree, not every test', () => {
    const files = {
      ...baseFiles,
      'documentation/guide.md': '# Guide\n',
      'packages/gamma/src/scanner.test.ts':
        "import { readdirSync } from 'node:fs';\nvoid readdirSync(import.meta.dir);\n",
    };
    const { selected, mode, selection } = select(files, ['documentation/guide.md']);
    expect(selection.repositoryRule).toBeNull();
    expect(selected('@scope/gamma')).toEqual(['packages/gamma/src/scanner.test.ts']);
    expect(mode('@scope/alpha')).toBe('none');
  });

  test('a test that reads the file system is selected by any change in its workspace', () => {
    const files = {
      ...baseFiles,
      'packages/gamma/src/scanner.test.ts':
        "import { Glob } from 'bun';\nvoid new Glob('**/*.ts');\n",
    };
    expect(select(files, ['packages/gamma/src/index.ts']).selected('@scope/gamma')).toContain(
      'packages/gamma/src/scanner.test.ts',
    );
    expect(select(files, ['packages/alpha/src/other.ts']).selected('@scope/gamma')).toEqual([]);
  });

  test('a test that imports a module by a run-time specifier depends on its workspace and dependencies', () => {
    const files = {
      ...baseFiles,
      'packages/beta/src/dynamic.test.ts':
        "const name = process.env.MODULE ?? '';\nawait import(name);\n",
    };
    expect(select(files, ['packages/alpha/src/other.ts']).selected('@scope/beta')).toContain(
      'packages/beta/src/dynamic.test.ts',
    );
    expect(select(files, ['packages/gamma/src/index.ts']).selected('@scope/beta')).not.toContain(
      'packages/beta/src/dynamic.test.ts',
    );
  });

  test('library source that imports by a run-time specifier does not select every importer', () => {
    // Library code loads modules on its callers' behalf, and the tests that call it name them.
    const files = {
      ...baseFiles,
      'packages/gamma/src/loader.ts': 'export const load = (name: string) => import(name);\n',
      'packages/gamma/src/uses-loader.test.ts': "import { load } from './loader.ts';\nvoid load;\n",
    };
    expect(select(files, ['packages/gamma/src/index.ts']).selected('@scope/gamma')).toEqual([
      'packages/gamma/src/gamma.test.ts',
    ]);
  });

  test('code that runs Bun.build depends on its workspace and dependencies', () => {
    const files = {
      ...baseFiles,
      'packages/beta/src/bundle.ts':
        'export const bundle = () => Bun.build({ entrypoints: [] });\n',
      'packages/beta/src/bundle.test.ts': "import { bundle } from './bundle.ts';\nvoid bundle;\n",
    };
    expect(select(files, ['packages/alpha/src/other.ts']).selected('@scope/beta')).toContain(
      'packages/beta/src/bundle.test.ts',
    );
  });

  test('a test that scans the workspaces is selected by any change', () => {
    const files = {
      ...baseFiles,
      'scripts/workspace-directories.ts': 'export const workspaceParentDirectories = [];\n',
      'scripts/contract.test.ts':
        "import { workspaceParentDirectories } from './workspace-directories.ts';\nvoid [workspaceParentDirectories, import.meta.dir];\n",
      'scripts/parameterized.test.ts':
        "import { workspaceParentDirectories } from './workspace-directories.ts';\nvoid workspaceParentDirectories;\n",
    };
    expect(select(files, ['packages/gamma/src/index.ts']).selected('corvidae')).toEqual([
      'scripts/contract.test.ts',
    ]);
  });

  test('a lane entrypoint selects its workspace, and a shared runner selects the repository', () => {
    const files = {
      ...baseFiles,
      'scripts/bun-test-junit.ts': 'export {};\n',
      'packages/gamma/scripts/check-coverage.ts': "import '../src/index.ts';\n",
    };
    const lanes = [
      rootWorkspace,
      alpha,
      beta,
      workspace('@scope/gamma', 'packages/gamma', {
        testScripts: ['bun ../../scripts/bun-test-junit.ts', 'bun scripts/check-coverage.ts'],
      }),
    ];
    const coverage = select(files, ['packages/gamma/scripts/check-coverage.ts'], lanes);
    expect(coverage.mode('@scope/gamma')).toBe('full');
    expect(coverage.mode('@scope/alpha')).toBe('none');

    const runner = select(
      files,
      ['scripts/bun-test-junit.ts'],
      [...lanes.slice(0, 3), lanes[3] as WorkspaceDescription],
    );
    expect(runner.selection.repositoryRule).toContain('scripts/bun-test-junit.ts');
    expect(runner.mode('@scope/alpha')).toBe('full');
  });

  test('library source a lane entrypoint imports does not turn the entrypoint into a fallback', () => {
    const files = {
      ...baseFiles,
      'packages/gamma/scripts/check-coverage.ts': "import '../src/index.ts';\n",
    };
    const lanes = [
      rootWorkspace,
      alpha,
      beta,
      workspace('@scope/gamma', 'packages/gamma', {
        testScripts: ['bun scripts/check-coverage.ts'],
      }),
    ];
    const result = select(files, ['packages/gamma/src/index.ts'], lanes);
    expect(result.selected('@scope/gamma')).toEqual(['packages/gamma/src/gamma.test.ts']);
  });
});

describe('selection modes and reporting', () => {
  test('a workspace whose every test file is reached is selected whole', () => {
    expect(select(baseFiles, ['packages/gamma/src/index.ts']).mode('@scope/gamma')).toBe('full');
  });

  test('a workspace with some tests reached is partial and with none is none', () => {
    const result = select(baseFiles, ['packages/alpha/src/extra.ts']);
    expect(result.mode('@scope/beta')).toBe('partial');
    expect(result.mode('@scope/alpha')).toBe('none');
  });

  test('explain says why each file was selected', () => {
    const { selection } = select(baseFiles, ['packages/alpha/src/deep.ts']);
    const text = explain(selection, ['packages/alpha/src/deep.ts']);
    expect(text).toContain(
      'packages/beta/src/uses-alpha.test.ts  [imports packages/alpha/src/index.ts <- packages/alpha/src/deep.ts]',
    );
    expect(text).toContain('package-level --affected would run');
  });

  test('the affected set is the changed workspaces and their dependents', () => {
    expect(select(baseFiles, ['packages/alpha/src/deep.ts']).selection.affectedWorkspaces).toEqual([
      '@scope/alpha',
      '@scope/beta',
    ]);
  });
});

describe('invocation plan and manifest', () => {
  function plan(files: Record<string, string>, changed: string[]) {
    return planInvocations(select(files, changed).selection);
  }

  test('a whole workspace runs test:gate, which keeps its coverage floor', () => {
    const steps = plan(baseFiles, ['packages/gamma/src/index.ts']);
    expect(steps[0]).toMatchObject({
      tasks: ['test:gate'],
      filters: ['--filter=@scope/gamma'],
      narrowed: false,
    });
  });

  test('a partial workspace runs the narrowed test lane, never the coverage lane', () => {
    const steps = plan(baseFiles, ['packages/alpha/src/extra.ts']);
    expect(steps[0]).toMatchObject({
      tasks: ['test'],
      filters: ['--filter=@scope/beta'],
      narrowed: true,
    });
    expect(steps.flatMap((step) => step.tasks)).not.toContain('test:gate');
    expect(steps.flatMap((step) => step.tasks)).not.toContain('test:coverage');
  });

  test('the slow lanes follow the fast lanes, serially', () => {
    const steps = plan(baseFiles, ['packages/alpha/src/extra.ts']);
    const slow = steps.filter((step) => step.tasks.includes('test:slow'));
    expect(slow.length).toBeGreaterThan(0);
    for (const step of slow) expect(step.extra).toEqual(['--concurrency=1']);
    expect(steps.indexOf(slow[0] as (typeof steps)[number])).toBeGreaterThan(0);
  });

  test('nothing reachable means nothing to run', () => {
    expect(plan(baseFiles, ['README.md'])).toEqual([]);
  });

  test('the root lanes run through the root filter and always narrowed', () => {
    const files = {
      ...baseFiles,
      'scripts/tool.ts': 'export const tool = 1;\n',
      'scripts/tool.test.ts': "import { tool } from './tool.ts';\nvoid tool;\n",
    };
    const steps = plan(files, ['scripts/tool.ts']);
    expect(steps).toContainEqual({
      tasks: ['test:self'],
      filters: ['--filter=//'],
      narrowed: true,
      extra: [],
    });
    expect(steps.some((step) => step.tasks.includes('test:self:slow'))).toBe(true);
  });

  test('the manifest lists each non-empty workspace relative to where its lane runs', () => {
    const { selection } = select(baseFiles, ['packages/alpha/src/deep.ts']);
    const manifest = buildManifest(selection);
    expect(manifest.workspaces['packages/alpha']).toEqual({
      mode: 'partial',
      files: ['src/deep.test.ts'],
    });
    expect(manifest.workspaces['packages/gamma']).toBeUndefined();
  });

  test('workspaces that run from the root share the root entry, relative to the root', () => {
    const browserFixtures = workspace('@scope/fixtures', 'scripts/fixtures', { testScripts: [] });
    const files = {
      ...baseFiles,
      'scripts/tool.ts': 'export const tool = 1;\n',
      'scripts/tool.test.ts': "import { tool } from './tool.ts';\nvoid tool;\n",
      'scripts/fixtures/package.json': '{}',
      'scripts/fixtures/scripts/a.test.ts': 'void 0;\n',
      'scripts/fixtures/scripts/b.test.ts': 'void 0;\n',
    };
    const { selection } = select(
      files,
      ['scripts/tool.ts', 'scripts/fixtures/scripts/a.test.ts'],
      [...everyWorkspace, browserFixtures],
    );
    expect(buildManifest(selection).workspaces['.']).toEqual({
      mode: 'partial',
      files: ['scripts/fixtures/scripts/a.test.ts', 'scripts/tool.test.ts'],
    });
  });
});

describe('narrowing `bun test` arguments', () => {
  const lane = [
    '--conditions',
    'browser',
    '--parallel=4',
    '--path-ignore-patterns=**/*.slow.test.ts',
    'src',
    'scripts',
  ];

  test('separates flags, their values, and the positional roots', () => {
    expect(splitBunTestArguments(lane)).toEqual({
      flags: [
        '--conditions',
        'browser',
        '--parallel=4',
        '--path-ignore-patterns=**/*.slow.test.ts',
      ],
      roots: ['src', 'scripts'],
      ignorePatterns: ['**/*.slow.test.ts'],
      configuration: null,
    });
  });

  test('keeps every flag and replaces the roots with the selected files they admit', () => {
    const narrowed = narrowBunTestArguments(
      lane,
      ['src/a.test.ts', 'scripts/b.test.ts', 'tests/c.test.ts', 'src/slow.slow.test.ts'],
      root,
    );
    expect(narrowed).toEqual([
      '--conditions',
      'browser',
      '--parallel=4',
      '--path-ignore-patterns=**/*.slow.test.ts',
      './src/a.test.ts',
      './scripts/b.test.ts',
    ]);
  });

  test('never widens: files outside the lane roots are dropped, and none left means nothing to run', () => {
    expect(narrowBunTestArguments(['src/host'], ['src/ui/a.test.ts'], root)).toBeNull();
    expect(narrowBunTestArguments(['src'], [], root)).toBeNull();
  });

  test('a lane with no roots admits every selected file', () => {
    expect(narrowBunTestArguments(['--parallel=4'], ['a.test.ts'], root)).toEqual([
      '--parallel=4',
      './a.test.ts',
    ]);
  });

  test('the slow lane filter admits only slow files', () => {
    expect(
      narrowBunTestArguments(['.slow.test.ts'], ['a.test.ts', 'b.slow.test.ts'], root),
    ).toEqual(['./b.slow.test.ts']);
  });

  test('a whole-workspace selection leaves the arguments as they are', () => {
    expect(narrowBunTestArguments(['src'], 'all', root)).toEqual(['src']);
  });

  test('./ roots match by path prefix and bare roots by substring', () => {
    expect(rootAdmits('./src/host', 'src/host/a.test.ts')).toBe(true);
    expect(rootAdmits('./src/host', 'src/hosts/a.test.ts')).toBe(false);
    expect(rootAdmits('src', 'nested/src/a.test.ts')).toBe(true);
  });
});

describe('the repository itself', () => {
  const workspaces = discoverWorkspaces(root);

  test('discovers the root and every workspace with the lane scripts that pick test files', () => {
    expect(workspaces.find((entry) => entry.directory === '')).toBeDefined();
    const weft = workspaces.find((entry) => entry.name === '@lostgradient/weft');
    expect(weft?.directory).toBe('packages/weft');
    expect(weft?.exports?.['.']).toBe('./src/index.ts');
    expect(weft?.preloads).toContain('packages/weft/tests/test-preload.ts');
    expect(weft?.testScripts.some((script) => script.includes('bun-test-junit.ts'))).toBe(true);
  });

  test('every lane script splits into roots that exist, so narrowing keeps each lane in scope', () => {
    for (const entry of workspaces) {
      for (const script of entry.testScripts) {
        for (const command of script.split('&&')) {
          if (!/bun-test-(?:junit|selected)\.ts/.test(command)) continue;
          const tokens = command
            .trim()
            .split(/\s+/)
            .filter((token) => !token.includes('*') && !token.includes('='));
          const wrapperIndex = tokens.findIndex((token) =>
            /bun-test-(?:junit|selected)\.ts$/.test(token),
          );
          const { roots } = splitBunTestArguments(tokens.slice(wrapperIndex + 1));
          for (const lane of roots) {
            if (lane.startsWith('--') || lane === '.slow.test.ts') continue;
            expect(existsSync(join(root, entry.directory, lane)), `${entry.name}: ${lane}`).toBe(
              true,
            );
          }
        }
      }
    }
  });
});

test('a selection with a repository rule runs every workspace whole', () => {
  const files = { ...baseFiles, 'turbo.json': '{}' };
  const { selection } = select(files, ['turbo.json']);
  const typed: Selection = selection;
  expect(
    typed.workspaces.filter((entry) => entry.total > 0).every((entry) => entry.mode === 'full'),
  ).toBe(true);
});

describe('the manifest hand-off', () => {
  function withTemporaryRoot(body: (directory: string) => void) {
    const directory = mkdtempSync(join(tmpdir(), 'affected-tests-manifest-'));
    try {
      body(directory);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }

  test('no variable means no selection is in force', () => {
    expect(selectedFilesFor({}, 'packages/alpha')).toBeNull();
    expect(selectedFilesFor({ [SELECTION_VARIABLE]: '' }, 'packages/alpha')).toBeNull();
  });

  test('a runner reads its own workspace from the manifest the digest names', () => {
    withTemporaryRoot((directory) => {
      const { selection } = select(baseFiles, ['packages/alpha/src/extra.ts']);
      const digest = writeManifest(buildManifest(selection), directory);
      const environment = { [SELECTION_VARIABLE]: digest };
      expect(selectedFilesFor(environment, 'packages/beta', directory)).toEqual([
        'src/uses-extra.test.ts',
      ]);
      // A workspace the manifest omits has nothing selected, never everything.
      expect(selectedFilesFor(environment, 'packages/gamma', directory)).toEqual([]);
    });
  });

  test('a workspace selected whole reads as all', () => {
    withTemporaryRoot((directory) => {
      const { selection } = select(baseFiles, ['packages/gamma/src/index.ts']);
      const digest = writeManifest(buildManifest(selection), directory);
      expect(selectedFilesFor({ [SELECTION_VARIABLE]: digest }, 'packages/gamma', directory)).toBe(
        'all',
      );
    });
  });

  test('a digest with no manifest, or a manifest changed after it was written, fails loudly', () => {
    withTemporaryRoot((directory) => {
      expect(() => readManifest('0123456789abcdef', directory)).toThrow('names no manifest');
      const digest = writeManifest({ version: 1, workspaces: {} }, directory);
      writeFileSync(
        join(manifestDirectory(directory), `${digest}.json`),
        '{"version":1,"workspaces":{"x":{"mode":"full","files":[]}}}\n',
      );
      expect(() => readManifest(digest, directory)).toThrow('does not match its digest');
    });
  });

  test('different selections have different digests, so cache keys differ', () => {
    withTemporaryRoot((directory) => {
      const first = select(baseFiles, ['packages/alpha/src/extra.ts']).selection;
      const second = select(baseFiles, ['packages/alpha/src/deep.ts']).selection;
      expect(writeManifest(buildManifest(first), directory)).not.toBe(
        writeManifest(buildManifest(second), directory),
      );
      expect(writeManifest(buildManifest(first), directory)).toBe(
        writeManifest(buildManifest(first), directory),
      );
    });
  });
});
