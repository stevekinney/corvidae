import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  assertTypeScriptEdgeClosed,
  configurationFiles,
  configurationWorkspace,
  discoverConfigurations,
  planTypeScriptConfiguration,
  rewriteExtends,
  TypeScriptConfigurationError,
  vendoredDirectory,
  vendorsConfiguration,
  type TypeScriptPlan,
} from './typescript-configuration.ts';

const corvidaeRoot = join(import.meta.dir, '..', '..');

/**
 * The names `package-map.json` assigns the workspaces these fixtures use, which is what a nested
 * configuration's `compilerOptions.paths` keys are rewritten to.
 */
const publicNames: ReadonlyMap<string, string> = new Map([
  ['@corvidae/cinder', '@lostgradient/cinder'],
  ['@corvidae/weft', '@lostgradient/weft'],
]);

/** A throwaway corvidae tree carrying only `internal/typescript` and the workspaces under test. */
async function withTree(
  files: Record<string, string>,
  body: (root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'mirror-tsconfig-'));
  try {
    for (const file of configurationFiles) {
      await Bun.write(join(root, 'internal', 'typescript', file), `{ "marker": "${file}" }\n`);
    }
    for (const [path, contents] of Object.entries(files)) {
      await Bun.write(join(root, path), contents);
    }
    await body(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('vendorsConfiguration', () => {
  test('vendors for the single-package target and keeps the package for the workspace one', () => {
    expect(vendorsConfiguration('weft')).toBe(true);
    expect(vendorsConfiguration('cinder')).toBe(false);
  });
});

describe('rewriteExtends', () => {
  test('rescopes the specifier when the target keeps the package', () => {
    expect(
      rewriteExtends(`${configurationWorkspace}/library.json`, '@lostgradient/typescript', false),
    ).toBe('@lostgradient/typescript/library.json');
  });

  test('points at the vendored copy when the target cannot hold the package', () => {
    expect(
      rewriteExtends(`${configurationWorkspace}/browser.json`, '@lostgradient/typescript', true),
    ).toBe(`./${vendoredDirectory}/browser.json`);
  });

  test('leaves an unrelated specifier alone', () => {
    expect(rewriteExtends('./.svelte-kit/tsconfig.json', '@lostgradient/typescript', true)).toBe(
      './.svelte-kit/tsconfig.json',
    );
  });

  test('refuses a bare package specifier when vendoring, which names no file', () => {
    expect(() => rewriteExtends(configurationWorkspace, '@lostgradient/typescript', true)).toThrow(
      TypeScriptConfigurationError,
    );
  });
});

describe('discoverConfigurations', () => {
  test('finds every tsconfig variant in a workspace, sorted', async () => {
    await withTree(
      {
        'packages/example/tsconfig.json': '{}\n',
        'packages/example/tsconfig.check.json': '{}\n',
        'packages/example/package.json': '{}\n',
      },
      async (root) => {
        expect(await discoverConfigurations(join(root, 'packages/example'))).toEqual([
          'tsconfig.check.json',
          'tsconfig.json',
        ]);
      },
    );
  });

  test('finds the ones nested inside `src/`, which the fixture configurations live in', async () => {
    await withTree(
      {
        'packages/example/tsconfig.json': '{}\n',
        'packages/example/src/cli/__fixtures__/typecheck/tsconfig.json': '{}\n',
        'packages/example/src/client/__fixtures__/registry/tsconfig.json': '{}\n',
        'packages/example/src/index.ts': 'export const a = 1;\n',
      },
      async (root) => {
        expect(await discoverConfigurations(join(root, 'packages/example'))).toEqual([
          'src/cli/__fixtures__/typecheck/tsconfig.json',
          'src/client/__fixtures__/registry/tsconfig.json',
          'tsconfig.json',
        ]);
      },
    );
  });

  test('stops at the source tree: a configuration elsewhere in the workspace is not emitted', async () => {
    // `examples/` and `test/` are not source, so nothing under them ships. A configuration found
    // there would be emitted into a directory whose siblings are absent.
    await withTree(
      {
        'packages/example/tsconfig.json': '{}\n',
        'packages/example/examples/demo/tsconfig.json': '{}\n',
        'packages/example/test/tsconfig.json': '{}\n',
      },
      async (root) => {
        expect(await discoverConfigurations(join(root, 'packages/example'))).toEqual([
          'tsconfig.json',
        ]);
      },
    );
  });
});

describe('a configuration nested inside the source tree', () => {
  test('its extends resolves to the vendored copy from its own depth', async () => {
    await withTree(
      {
        'packages/weft/tsconfig.json': JSON.stringify({
          extends: `${configurationWorkspace}/library.json`,
        }),
        'packages/weft/src/cli/__fixtures__/typecheck/tsconfig.json': JSON.stringify({
          extends: `${configurationWorkspace}/library.json`,
          include: ['consumer.ts'],
        }),
      },
      async (root) => {
        const plan = await planTypeScriptConfiguration({
          corvidaeRoot: root,
          target: 'weft',
          workspaces: [{ corvidaeDirectory: 'packages/weft', targetDirectory: 'packages/weft' }],
          publicNames,
        });
        const nested = JSON.parse(
          plan.files['packages/weft/src/cli/__fixtures__/typecheck/tsconfig.json'] ?? '{}',
        ) as { extends?: string; include?: string[] };
        // Four directories below the package root, so four `../` to reach the vendored copy.
        expect(nested.extends).toBe(`../../../../${vendoredDirectory}/library.json`);
        // Its `include` names sibling fixture files this transform emits, so it is corvidae's.
        expect(nested.include).toEqual(['consumer.ts']);
      },
    );
  });

  test('its `compilerOptions.paths` keys are renamed and its values left alone', async () => {
    await withTree(
      {
        'packages/weft/tsconfig.json': JSON.stringify({
          extends: `${configurationWorkspace}/library.json`,
        }),
        'packages/weft/src/client/__fixtures__/registry/tsconfig.json': JSON.stringify({
          compilerOptions: {
            strict: true,
            paths: {
              '@corvidae/weft': ['../../../index.ts'],
              '@corvidae/weft/client': ['../../../client/index.ts'],
            },
          },
          include: ['consumer.ts'],
        }),
      },
      async (root) => {
        const plan = await planTypeScriptConfiguration({
          corvidaeRoot: root,
          target: 'weft',
          workspaces: [{ corvidaeDirectory: 'packages/weft', targetDirectory: 'packages/weft' }],
          publicNames,
        });
        const nested = JSON.parse(
          plan.files['packages/weft/src/client/__fixtures__/registry/tsconfig.json'] ?? '{}',
        ) as { compilerOptions?: { strict?: boolean; paths?: Record<string, string[]> } };
        expect(nested.compilerOptions?.paths).toEqual({
          '@lostgradient/weft': ['../../../index.ts'],
          '@lostgradient/weft/client': ['../../../client/index.ts'],
        });
        expect(nested.compilerOptions?.strict).toBe(true);
      },
    );
  });

  test('keeps its own include even where the target carries a copy without one', async () => {
    await withTree(
      {
        'packages/weft/tsconfig.json': JSON.stringify({
          extends: `${configurationWorkspace}/library.json`,
          include: ['src'],
        }),
        'packages/weft/src/cli/__fixtures__/typecheck/tsconfig.json': JSON.stringify({
          extends: `${configurationWorkspace}/library.json`,
          include: ['consumer.ts', 'weft.generated.d.ts'],
        }),
      },
      async (root) => {
        const clone = await mkdtemp(join(tmpdir(), 'mirror-tsconfig-nested-'));
        try {
          await Bun.write(
            join(clone, 'packages/weft/tsconfig.json'),
            JSON.stringify({ include: ['src', 'scripts/build.ts'] }),
          );
          await Bun.write(
            join(clone, 'packages/weft/src/cli/__fixtures__/typecheck/tsconfig.json'),
            JSON.stringify({ extends: './elsewhere.json' }),
          );
          const plan = await planTypeScriptConfiguration({
            corvidaeRoot: root,
            target: 'weft',
            workspaces: [{ corvidaeDirectory: 'packages/weft', targetDirectory: 'packages/weft' }],
            publicNames,
            targetDirectory: clone,
          });
          const root_ = JSON.parse(plan.files['packages/weft/tsconfig.json'] ?? '{}') as {
            include?: string[];
          };
          const nested = JSON.parse(
            plan.files['packages/weft/src/cli/__fixtures__/typecheck/tsconfig.json'] ?? '{}',
          ) as { include?: string[] };
          // The repository's own `include` wins at the workspace root and nowhere else: the target
          // has no `include` on the nested one, and taking that answer would empty a fixture's
          // compilation.
          expect(root_.include).toEqual(['src', 'scripts/build.ts']);
          expect(nested.include).toEqual(['consumer.ts', 'weft.generated.d.ts']);
        } finally {
          await rm(clone, { recursive: true, force: true });
        }
      },
    );
  });
});

describe('planTypeScriptConfiguration', () => {
  test('vendors the configuration into the weft target and rewrites extends to it', async () => {
    await withTree(
      {
        'packages/weft/tsconfig.json': JSON.stringify({
          extends: `${configurationWorkspace}/library.json`,
          include: ['src'],
        }),
      },
      async (root) => {
        const plan = await planTypeScriptConfiguration({
          corvidaeRoot: root,
          target: 'weft',
          workspaces: [{ corvidaeDirectory: 'packages/weft', targetDirectory: 'packages/weft' }],
          publicNames,
        });
        expect(plan.vendoredInto).toEqual(['packages/weft']);
        for (const file of configurationFiles) {
          expect(plan.files[`packages/weft/${vendoredDirectory}/${file}`]).toContain(file);
        }
        const emitted = JSON.parse(plan.files['packages/weft/tsconfig.json'] ?? '{}') as {
          extends?: string;
        };
        expect(emitted.extends).toBe(`./${vendoredDirectory}/library.json`);
        expect(plan.files['internal/typescript/base.json']).toBeUndefined();
      },
    );
  });

  test('the target’s own include and exclude survive, while extends stays the transform’s', async () => {
    await withTree(
      {
        'packages/weft/tsconfig.json': JSON.stringify({
          extends: `${configurationWorkspace}/library.json`,
          include: ['src', 'tests', 'scripts', 'examples'],
          exclude: ['node_modules', '**/*.test-d.ts'],
        }),
      },
      async (root) => {
        // The target checks `src` plus five named scripts, and deliberately never checks its
        // `examples/`: they import the package by its public name, which resolves through
        // `exports` to a `dist/` that does not exist when `typecheck` runs. Emitting corvidae's
        // widened `include` over that is what produced TS2307 across every example file.
        const include = ['src', 'scripts/build.ts'];
        const clone = await mkdtemp(join(tmpdir(), 'mirror-tsconfig-target-'));
        try {
          await Bun.write(
            join(clone, 'packages/weft/tsconfig.json'),
            JSON.stringify({ compilerOptions: { strict: true }, include }),
          );
          const plan = await planTypeScriptConfiguration({
            corvidaeRoot: root,
            target: 'weft',
            workspaces: [{ corvidaeDirectory: 'packages/weft', targetDirectory: 'packages/weft' }],
            publicNames,
            targetDirectory: clone,
          });
          const emitted = JSON.parse(plan.files['packages/weft/tsconfig.json'] ?? '{}') as {
            extends?: string;
            include?: string[];
            exclude?: string[];
          };
          expect(emitted.include).toEqual(include);
          // The target carries no `exclude`, and "the target owns this key" and "the target chose
          // not to set it" are the same statement, so corvidae's is dropped rather than kept.
          expect('exclude' in emitted).toBe(false);
          expect(emitted.extends).toBe(`./${vendoredDirectory}/library.json`);
        } finally {
          await rm(clone, { recursive: true, force: true });
        }
      },
    );
  });

  test('a target with no configuration at that path gets corvidae’s whole', async () => {
    await withTree(
      {
        'packages/weft/tsconfig.json': JSON.stringify({
          extends: `${configurationWorkspace}/library.json`,
          include: ['src', 'tests'],
        }),
      },
      async (root) => {
        const clone = await mkdtemp(join(tmpdir(), 'mirror-tsconfig-fresh-'));
        try {
          const plan = await planTypeScriptConfiguration({
            corvidaeRoot: root,
            target: 'weft',
            workspaces: [{ corvidaeDirectory: 'packages/weft', targetDirectory: 'packages/weft' }],
            publicNames,
            targetDirectory: clone,
          });
          const emitted = JSON.parse(plan.files['packages/weft/tsconfig.json'] ?? '{}') as {
            include?: string[];
          };
          expect(emitted.include).toEqual(['src', 'tests']);
        } finally {
          await rm(clone, { recursive: true, force: true });
        }
      },
    );
  });

  test('keeps the configuration a workspace in the cinder target', async () => {
    await withTree(
      {
        'components/cinder/tsconfig.json': JSON.stringify({
          extends: `${configurationWorkspace}/browser.json`,
        }),
      },
      async (root) => {
        const plan = await planTypeScriptConfiguration({
          corvidaeRoot: root,
          target: 'cinder',
          workspaces: [
            { corvidaeDirectory: 'components/cinder', targetDirectory: 'packages/components' },
          ],
          publicNames,
        });
        expect(plan.vendoredInto).toEqual([]);
        const emitted = JSON.parse(plan.files['packages/components/tsconfig.json'] ?? '{}') as {
          extends?: string;
        };
        expect(emitted.extends).toBe('@lostgradient/typescript/browser.json');
        expect(plan.files['internal/typescript/browser.json']).toBeDefined();
      },
    );
  });

  test('rewrites every entry of an extends array', async () => {
    await withTree(
      {
        'applications/chat-room/tsconfig.json': JSON.stringify({
          extends: [`${configurationWorkspace}/library.json`, './.svelte-kit/tsconfig.json'],
        }),
      },
      async (root) => {
        const plan = await planTypeScriptConfiguration({
          corvidaeRoot: root,
          target: 'cinder',
          workspaces: [
            { corvidaeDirectory: 'applications/chat-room', targetDirectory: 'labs/chat-room' },
          ],
          publicNames,
        });
        const emitted = JSON.parse(plan.files['labs/chat-room/tsconfig.json'] ?? '{}') as {
          extends?: string[];
        };
        expect(emitted.extends).toEqual([
          '@lostgradient/typescript/library.json',
          './.svelte-kit/tsconfig.json',
        ]);
      },
    );
  });

  test('rewrites the real weft workspace, whose policy the target must not lose', async () => {
    const plan = await planTypeScriptConfiguration({
      corvidaeRoot,
      target: 'weft',
      workspaces: [{ corvidaeDirectory: 'packages/weft', targetDirectory: 'packages/weft' }],
      publicNames,
    });
    const emitted = JSON.parse(plan.files['packages/weft/tsconfig.json'] ?? '{}') as {
      extends?: string;
    };
    expect(emitted.extends).toBe(`./${vendoredDirectory}/library.json`);
    const base = JSON.parse(plan.files[`packages/weft/${vendoredDirectory}/base.json`] ?? '{}') as {
      compilerOptions?: Record<string, unknown>;
    };
    // The setting the issue names as the reason weft's source differs from upstream's.
    expect(base.compilerOptions?.['exactOptionalPropertyTypes']).toBe(true);
  });
});

describe('assertTypeScriptEdgeClosed', () => {
  const vendoredPlan: TypeScriptPlan = {
    files: { [`packages/weft/${vendoredDirectory}/base.json`]: '{}' },
    vendoredInto: ['packages/weft'],
  };

  test('accepts a configuration edge replaced by a vendored copy', () => {
    expect(() =>
      assertTypeScriptEdgeClosed([`@corvidae/weft -> ${configurationWorkspace}`], vendoredPlan),
    ).not.toThrow();
  });

  test('refuses a configuration edge with nothing vendored in its place', () => {
    expect(() =>
      assertTypeScriptEdgeClosed([`@corvidae/weft -> ${configurationWorkspace}`], {
        files: {},
        vendoredInto: [],
      }),
    ).toThrow(TypeScriptConfigurationError);
  });

  test('refuses any other dropped edge, which nothing here replaces', () => {
    expect(() =>
      assertTypeScriptEdgeClosed(['@corvidae/weft -> @corvidae/testing'], vendoredPlan),
    ).toThrow(/nothing replaces/);
  });
});
