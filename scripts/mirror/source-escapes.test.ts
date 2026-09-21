import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { committedPlans } from './committed-plans.ts';
import type { MirrorTarget } from './manifests.ts';
import {
  assertNoSourceEscapes,
  findSourceEscapes,
  internalScope,
  moduleSpecifiers,
  SourceEscapeError,
} from './source-escapes.ts';
import { planSource } from './source.ts';

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

/**
 * The names `package-map.json` assigns the workspaces these fixtures use.
 *
 * Written out rather than loaded so a fixture's expected output is readable beside its input; the
 * real map is what `committed-plans.ts` exercises, over the real tree.
 */
const publicNames: ReadonlyMap<string, string> = new Map([
  [`${internalScope}/armorer`, '@lostgradient/armorer'],
  [`${internalScope}/editor`, '@lostgradient/editor'],
  [`${internalScope}/testing`, '@lostgradient/testing'],
  [`${internalScope}/weft`, '@lostgradient/weft'],
]);

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
    expect(moduleSpecifiers(source, 'packages/editor/src/index.ts')).toEqual([
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
    expect(moduleSpecifiers(component, 'packages/chat/src/lib/widget.svelte').toSorted()).toEqual([
      '../registry.ts',
      './child.svelte',
      './lazy.ts',
      './reexported.ts',
    ]);
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
        kind: 'unemitted-path',
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
        kind: 'unemitted-path',
        resolved: 'packages/chat/fixtures/rows.ts',
      },
      {
        file: 'packages/chat/src/lib/widget.svelte',
        specifier: '../../tests/harness.ts',
        kind: 'unemitted-path',
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
        kind: 'unemitted-path',
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

describe('an internal name in emitted source', () => {
  test('every specifier form is caught, and a string that only looks like one is not', () => {
    const files = {
      'packages/weft/src/index.ts': [
        `import { a } from '${internalScope}/weft';`,
        `import type { B } from '${internalScope}/weft';`,
        `export * from '${internalScope}/armorer';`,
        `const c = await import('${internalScope}/markdown');`,
        `const d = import.meta.resolve('${internalScope}/weft');`,
        `declare module '${internalScope}/weft' { interface Registry { a: 1 } }`,
        `import { e } from '${internalScope}/weft/client';`,
        `const key = Symbol.for('${internalScope}/operative/backend-descriptors');`,
        "import { z } from 'zod';",
      ].join('\n'),
    };
    expect(findSourceEscapes(files).map((escape) => `${escape.kind} ${escape.specifier}`)).toEqual([
      `internal-name ${internalScope}/armorer`,
      `internal-name ${internalScope}/markdown`,
      `internal-name ${internalScope}/weft`,
      `internal-name ${internalScope}/weft`,
      `internal-name ${internalScope}/weft`,
      `internal-name ${internalScope}/weft`,
      `internal-name ${internalScope}/weft/client`,
    ]);
  });

  test('a Svelte component is read the same way', () => {
    expect(
      findSourceEscapes({
        'packages/chat/src/widget.svelte': [
          '<script lang="ts">',
          `  import { render } from '${internalScope}/markdown';`,
          '</script>',
          '<span>{render}</span>',
        ].join('\n'),
      }),
    ).toEqual([
      {
        file: 'packages/chat/src/widget.svelte',
        specifier: `${internalScope}/markdown`,
        kind: 'internal-name',
      },
    ]);
  });

  test('a type-position `import()` in a Svelte script is caught, not only a plain import', () => {
    expect(
      findSourceEscapes({
        'packages/editor/src/editor.svelte': [
          '<script lang="ts">',
          `  type Utilities = Pick<typeof import('${internalScope}/markdown'), 'normalize'>;`,
          '  let utilities: Utilities | undefined;',
          '</script>',
          '<span>{utilities}</span>',
        ].join('\n'),
      }),
    ).toEqual([
      {
        file: 'packages/editor/src/editor.svelte',
        specifier: `${internalScope}/markdown`,
        kind: 'internal-name',
      },
    ]);
  });

  test('a third-party bare specifier is still not an escape', () => {
    expect(
      findSourceEscapes({
        'packages/weft/src/index.ts': [
          "import { join } from 'node:path';",
          "import { z } from 'zod';",
          "import { render } from '@lostgradient/markdown';",
        ].join('\n'),
      }),
    ).toEqual([]);
  });

  test('the message names every offender and says where the rewrite lives', () => {
    const files = {
      'packages/weft/src/index.ts': `import { a } from '${internalScope}/weft';\n`,
      'packages/weft/src/other.ts': "export * from '../outside.ts';\n",
    };
    try {
      assertNoSourceEscapes(files);
      throw new Error('expected the gate to refuse this plan');
    } catch (error) {
      expect(error).toBeInstanceOf(SourceEscapeError);
      const message = (error as Error).message;
      expect(message).toContain(`packages/weft/src/index.ts: ${internalScope}/weft`);
      expect(message).toContain('packages/weft/src/other.ts: ../outside.ts');
      expect(message).toContain('internal-names.ts');
      expect(message).toContain('additionalSourceRoots');
    }
  });
});

describe('an internal name in an emitted TypeScript configuration', () => {
  test('`extends` is read, which a `.json` file was never scanned for before', () => {
    expect(
      findSourceEscapes({
        'packages/weft/src/cli/__fixtures__/typecheck/tsconfig.json': `{\n  // a tsconfig is JSON with comments\n  "extends": "${internalScope}/typescript/library.json"\n}\n`,
      }),
    ).toEqual([
      {
        file: 'packages/weft/src/cli/__fixtures__/typecheck/tsconfig.json',
        specifier: `${internalScope}/typescript/library.json`,
        kind: 'internal-name',
      },
    ]);
  });

  test('`compilerOptions.paths` keys are read, for a configuration with no `extends` at all', () => {
    expect(
      findSourceEscapes({
        'packages/weft/src/client/__fixtures__/registry/tsconfig.json': JSON.stringify({
          compilerOptions: {
            paths: { [`${internalScope}/weft`]: ['../../../index.ts'], './local': ['./local.ts'] },
          },
        }),
      }).map((escape) => escape.specifier),
    ).toEqual([`${internalScope}/weft`]);
  });

  test('every entry of an `extends` array is read', () => {
    expect(
      findSourceEscapes({
        'packages/weft/tsconfig.json': JSON.stringify({
          extends: [`${internalScope}/typescript/library.json`, './.svelte-kit/tsconfig.json'],
        }),
        'packages/weft/.svelte-kit/tsconfig.json': '{}',
      }).map((escape) => escape.specifier),
    ).toEqual([`${internalScope}/typescript/library.json`]);
  });

  test('a configuration the transform has already rewritten is clean', () => {
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
  const armorer = {
    workspace: 'armorer',
    corvidaeDirectory: 'packages/armorer',
    targetDirectory: 'packages/armorer',
  } as const;

  /**
   * `@lostgradient/armorer` declares exactly one path — `test/helpers/async-assertions.ts` — so it is
   * the smallest workspace in the table that proves the mechanism end to end.
   */
  test('satisfies the gate, because the declared file is emitted beside the source', async () => {
    await withTree(
      {
        'packages/armorer/src/compose.test.ts':
          "import { settles } from '../test/helpers/async-assertions';\nexport const used = settles;\n",
        'packages/armorer/test/helpers/async-assertions.ts': 'export const settles = true;\n',
      },
      async (root) => {
        const plan = await planSource(root, [armorer], publicNames);
        expect(Object.keys(plan.files).toSorted()).toEqual([
          'packages/armorer/src/compose.test.ts',
          'packages/armorer/test/helpers/async-assertions.ts',
        ]);
        expect(findSourceEscapes(plan.files)).toEqual([]);
        // Declaration is emission, not deletion authority: the prune scope is still `src/` alone,
        // so nothing under the target's own `test/` can be removed by a sync.
        expect(plan.ownedPrefixes).toEqual(['packages/armorer/src']);
      },
    );
  });

  test('is not a bypass: the declared file’s own imports are checked the same way', async () => {
    await withTree(
      {
        'packages/armorer/src/compose.test.ts':
          "import { settles } from '../test/helpers/async-assertions';\nexport const used = settles;\n",
        'packages/armorer/test/helpers/async-assertions.ts':
          "export { settles } from '../../vendor/assertions.ts';\n",
        'packages/armorer/vendor/assertions.ts': 'export const settles = true;\n',
      },
      async (root) => {
        const plan = await planSource(root, [armorer], publicNames);
        expect(findSourceEscapes(plan.files)).toEqual([
          {
            file: 'packages/armorer/test/helpers/async-assertions.ts',
            specifier: '../../vendor/assertions.ts',
            kind: 'unemitted-path',
            resolved: 'packages/armorer/vendor/assertions.ts',
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
      },
      async (root) => {
        const plan = await planSource(
          root,
          [
            {
              workspace: '@lostgradient/editor',
              corvidaeDirectory: 'components/editor',
              targetDirectory: 'packages/editor',
            },
          ],
          publicNames,
        );
        expect(findSourceEscapes(plan.files)).toEqual([
          {
            file: 'packages/editor/src/compose.test.ts',
            specifier: '../test/helpers/async-assertions.ts',
            kind: 'unemitted-path',
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
