import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { committedPlans } from './committed-plans.ts';
import { planSource } from './source.ts';
import type { MirrorTarget } from './target-definitions.ts';
import {
  assertNoSourceEscapes,
  findSourceEscapes,
  isScannable,
  SourceEscapeError,
  specifiersCarriedBy,
} from './target-resolvability.ts';

/** Stand up a throwaway tree, hand it to the body, and remove it however the body ends. */
async function withTree(
  files: Record<string, string>,
  body: (root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'corvidae-escapes-'));
  try {
    for (const [path, contents] of Object.entries(files))
      await Bun.write(join(root, path), contents);
    await body(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('reading a file’s module edges', () => {
  test('every form that creates one, and nothing that only looks like one', () => {
    const source = `
      import { a } from './a.ts';
      import type { B } from './b.ts';
      export * from './c.ts';
      export { d } from './d.ts';
      const e = await import('./e.ts');
      const f = require('./f.ts');
      type G = import('./g.ts').G;
      const h = import.meta.resolve('./h.ts');
      const notAnEdge = "import { i } from './i.ts';";
      // import { j } from './j.ts';
    `;
    expect(specifiersCarriedBy(source, 'packages/editor/src/index.ts')).toEqual([
      './a.ts',
      './b.ts',
      './c.ts',
      './d.ts',
      './e.ts',
      './f.ts',
      './g.ts',
      './h.ts',
    ]);
  });

  test('a Svelte component’s edges come from its script blocks and its markup', () => {
    const component = [
      '<script module lang="ts">',
      "  import { registry } from '../registry.ts';",
      '</script>',
      '<script lang="ts">',
      "  import Child from './child.svelte';",
      "  export * from './reexported.ts';",
      '</script>',
      "{#await import('./lazy.ts') then lazy}{lazy.value}{/await}",
      '<Child {registry} />',
    ].join('\n');
    expect(
      specifiersCarriedBy(component, 'packages/chat/src/lib/widget.svelte').toSorted(),
    ).toEqual(['../registry.ts', './child.svelte', './lazy.ts', './reexported.ts']);
  });
});

describe('the gate over one plan', () => {
  test('an emitted file importing a sibling outside the emitted set fails, naming both', () => {
    const files = {
      'packages/components/src/cli/index.ts': "export * from '../../scripts/knowledge/index.ts';\n",
      'packages/components/src/index.ts': "export * from './cli/index.ts';\n",
    };
    expect(findSourceEscapes(files)).toEqual([
      {
        file: 'packages/components/src/cli/index.ts',
        specifier: '../../scripts/knowledge/index.ts',
        resolved: 'packages/components/scripts/knowledge/index.ts',
      },
    ]);
    expect(() => assertNoSourceEscapes(files)).toThrow(SourceEscapeError);
    try {
      assertNoSourceEscapes(files);
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain('packages/components/src/cli/index.ts');
      expect(message).toContain('../../scripts/knowledge/index.ts');
      expect(message).toContain('packages/components/scripts/knowledge/index.ts');
    }
  });

  test('`export * from` escapes exactly as `import` does, and a `.svelte` file escapes too', () => {
    const files = {
      'packages/chat/src/lib/widget.svelte': [
        '<script lang="ts">',
        "  import { helper } from '../../tests/harness.ts';",
        '</script>',
        '<span>{helper}</span>',
      ].join('\n'),
      'packages/chat/src/lib/reexport.ts': "export * from '../../fixtures/rows.ts';\n",
    };
    expect(findSourceEscapes(files)).toEqual([
      {
        file: 'packages/chat/src/lib/reexport.ts',
        specifier: '../../fixtures/rows.ts',
        resolved: 'packages/chat/fixtures/rows.ts',
      },
      {
        file: 'packages/chat/src/lib/widget.svelte',
        specifier: '../../tests/harness.ts',
        resolved: 'packages/chat/tests/harness.ts',
      },
    ]);
  });

  test('a specifier climbing above the target root is an escape like any other', () => {
    expect(
      findSourceEscapes({ 'packages/weft/src/index.ts': "import '../../../../outside.ts';\n" }),
    ).toEqual([
      {
        file: 'packages/weft/src/index.ts',
        specifier: '../../../../outside.ts',
        resolved: '../outside.ts',
      },
    ]);
  });

  test('a specifier the plan does emit is satisfied, however it is written', () => {
    // Extensionless, `.js`-for-`.ts`, a directory index, a query suffix and a non-relative
    // specifier: five ways a real import is written that the gate must not report.
    expect(
      findSourceEscapes({
        'packages/armorer/src/compose.test.ts': [
          "import { settles } from './helpers/async-assertions';",
          "import { tool } from './tool.js';",
          "import { registry } from './registry';",
          "import styles from './theme.css?raw';",
          "import { join } from 'node:path';",
        ].join('\n'),
        'packages/armorer/src/helpers/async-assertions.ts': 'export const settles = true;\n',
        'packages/armorer/src/tool.ts': 'export const tool = true;\n',
        'packages/armorer/src/registry/index.ts': 'export const registry = true;\n',
        'packages/armorer/src/theme.css': '.theme {}\n',
      }),
    ).toEqual([]);
  });

  test('a manifest the other half of the transform emits satisfies a specifier into it', () => {
    expect(
      findSourceEscapes({
        'packages/weft/src/version.ts':
          "import manifest from '../package.json' with { type: 'json' };\nexport const version = manifest.version;\n",
        'packages/weft/package.json': '{"name":"@lostgradient/weft","version":"0.25.0"}\n',
      }),
    ).toEqual([]);
  });

  test('an emitted file that is not code is a valid target and never a source of edges', () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(
      findSourceEscapes({
        'packages/testing/src/__fixtures__/baseline.png': bytes,
        'packages/testing/src/compare.ts': "import baseline from './__fixtures__/baseline.png';\n",
      }),
    ).toEqual([]);
  });
});

describe('a tsconfig’s `extends`', () => {
  test('is read, which a `.json` file was never scanned for before', () => {
    expect(
      findSourceEscapes({
        'packages/weft/src/cli/__fixtures__/typecheck/tsconfig.json':
          '{\n  // a tsconfig is JSON with comments\n  "extends": "../../../missing/tsconfig.json"\n}\n',
      }),
    ).toEqual([
      {
        file: 'packages/weft/src/cli/__fixtures__/typecheck/tsconfig.json',
        specifier: '../../../missing/tsconfig.json',
        resolved: 'packages/weft/src/missing/tsconfig.json',
      },
    ]);
  });

  test('every entry of an `extends` array is read', () => {
    expect(
      findSourceEscapes({
        'packages/weft/tsconfig.json': JSON.stringify({
          extends: ['./missing/tsconfig.json', './.svelte-kit/tsconfig.json'],
        }),
        'packages/weft/.svelte-kit/tsconfig.json': '{}',
      }).map((escape) => escape.specifier),
    ).toEqual(['./missing/tsconfig.json']);
  });

  test('`compilerOptions.paths` keys are not read: a pattern is matched against an import, never resolved', () => {
    expect(
      findSourceEscapes({
        'packages/weft/src/client/__fixtures__/registry/tsconfig.json': JSON.stringify({
          compilerOptions: {
            paths: {
              './nothing/emits/this': ['./nothing.ts'],
              '@lostgradient/weft': ['../../../index.ts'],
            },
          },
        }),
      }),
    ).toEqual([]);
  });

  test('a configuration whose `extends` resolves is clean', () => {
    expect(
      findSourceEscapes({
        'packages/weft/src/cli/__fixtures__/typecheck/tsconfig.json': JSON.stringify({
          extends: '../../../../typescript/library.json',
          compilerOptions: { paths: { '@lostgradient/weft': ['../../../index.ts'] } },
        }),
        'packages/weft/typescript/library.json': '{}',
      }),
    ).toEqual([]);
  });
});

describe('a declared additional source root', () => {
  const weftUi = {
    workspace: '@lostgradient/weft-ui',
    corvidaeDirectory: 'components/weft-ui',
    targetDirectory: 'packages/weft-ui',
  } as const;

  /**
   * `@lostgradient/weft-ui` declares a DOM harness its route suites import from outside `src/`,
   * plus twelve workflow fixtures. A declared file corvidae does not carry is a refusal, so every
   * fixture carries all thirteen; only the harness carries a real edge.
   */
  const declaredFixtures = Object.fromEntries(
    [
      'async-activity',
      'children',
      'coordination',
      'failures',
      'finalizer',
      'history',
      'restart-lineage',
      'reviews',
      'saga',
      'schedules',
      'tagged',
      'workflows',
    ].map((name) => [`components/weft-ui/fixtures/${name}.ts`, 'export {};\n']),
  );

  test('satisfies the gate, because the declared file is emitted beside the source', async () => {
    await withTree(
      {
        'components/weft-ui/src/routes/runs.test.ts':
          "import { dom } from '../../tests/dom-test-support';\nexport const used = dom;\n",
        'components/weft-ui/tests/dom-test-support.ts': 'export const dom = true;\n',
        'components/weft-ui/tests/setup.ts': 'export {};\n',
        ...declaredFixtures,
      },
      async (root) => {
        const plan = await planSource(root, [weftUi]);
        expect(Object.keys(plan.files)).toContain('packages/weft-ui/tests/dom-test-support.ts');
        expect(findSourceEscapes(plan.files)).toEqual([]);
        // Declaration is emission, not deletion authority: the prune scope is still `src/` alone,
        // so nothing else under the target's own `tests/` can be removed by a sync.
        expect(plan.ownedPrefixes).toEqual(['packages/weft-ui/src']);
      },
    );
  });

  test('is not a bypass: the declared file’s own imports are checked the same way', async () => {
    await withTree(
      {
        'components/weft-ui/src/routes/runs.test.ts':
          "import { dom } from '../../tests/dom-test-support';\nexport const used = dom;\n",
        'components/weft-ui/tests/dom-test-support.ts': "export { dom } from '../vendor/dom.ts';\n",
        'components/weft-ui/vendor/dom.ts': 'export const dom = true;\n',
        'components/weft-ui/tests/setup.ts': 'export {};\n',
        ...declaredFixtures,
      },
      async (root) => {
        const plan = await planSource(root, [weftUi]);
        expect(findSourceEscapes(plan.files)).toEqual([
          {
            file: 'packages/weft-ui/tests/dom-test-support.ts',
            specifier: '../vendor/dom.ts',
            resolved: 'packages/weft-ui/vendor/dom.ts',
          },
        ]);
      },
    );
  });

  test('the same escape in a workspace that declares nothing is reported', async () => {
    await withTree(
      {
        'components/editor/src/compose.test.ts':
          "import { settles } from '../test/helpers/async-assertions.ts';\nexport const used = settles;\n",
        'components/editor/test/helpers/async-assertions.ts': 'export const settles = true;\n',
        // `validationInputs['@lostgradient/editor']` declares `scripts/preload.ts` (COR-1196), so
        // `planSource` requires it wherever this workspace name is planned, even in a fixture
        // that is otherwise about an unrelated escape.
        'components/editor/scripts/preload.ts': 'export {};\n',
      },
      async (root) => {
        const plan = await planSource(root, [
          {
            workspace: '@lostgradient/editor',
            corvidaeDirectory: 'components/editor',
            targetDirectory: 'packages/editor',
          },
        ]);
        expect(findSourceEscapes(plan.files)).toEqual([
          {
            file: 'packages/editor/src/compose.test.ts',
            specifier: '../test/helpers/async-assertions.ts',
            resolved: 'packages/editor/test/helpers/async-assertions.ts',
          },
        ]);
      },
    );
  });
});

describe('the committed workspaces', () => {
  /**
   * The gate against the real tree rather than a fixture, for both targets, because what it
   * asserts is a property of the real workspaces. `planSurface` already refuses a plan with an
   * escape; this states the same result as a finding so a failure reads as the list of escapes
   * rather than as an unrelated test blowing up.
   *
   * The plan and its scan are both `committed-plans.ts`'s, built once for the process when this
   * file loads. Neither belongs on a test's clock: the cinder plan is seconds of work and so is
   * rescanning its five and a half thousand emitted files.
   */
  test.each<MirrorTarget>(['cinder', 'weft'])(
    'the %s plan emits nothing that escapes',
    (target) => {
      expect(committedPlans[target].escapes).toEqual([]);
    },
  );

  test('the cinder binary and the published knowledge subpath resolve in the target', () => {
    const { plan } = committedPlans.cinder;
    // COR-1189 restored these two shims and COR-1221's emission rule left what they re-export
    // behind. Both now land, which is what makes `dist/cli/index.js` buildable and
    // `@lostgradient/cinder/knowledge` resolvable for `@lostgradient/cinder-mcp`.
    for (const path of [
      'packages/components/src/cli/index.ts',
      'packages/components/src/cli/knowledge.ts',
      'packages/components/scripts/knowledge/index.ts',
      'packages/components/scripts/knowledge/knowledge.ts',
      'packages/components/components.json',
    ]) {
      expect(plan.files[path], `${path} is not emitted`).toBeDefined();
    }
  });
});

describe('isScannable', () => {
  test('a scannable extension is read for its module specifiers, anything else is a valid target only', () => {
    expect(isScannable('packages/weft/src/index.ts')).toBe(true);
    expect(isScannable('packages/weft/src/widget.svelte')).toBe(true);
    expect(isScannable('packages/weft/package.json')).toBe(false);
    expect(isScannable('packages/weft/src/__fixtures__/baseline.png')).toBe(false);
  });
});
