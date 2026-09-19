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
          workspaceDirectories: ['packages/weft'],
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
          workspaceDirectories: ['components/cinder'],
        });
        expect(plan.vendoredInto).toEqual([]);
        const emitted = JSON.parse(plan.files['components/cinder/tsconfig.json'] ?? '{}') as {
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
          workspaceDirectories: ['applications/chat-room'],
        });
        const emitted = JSON.parse(plan.files['applications/chat-room/tsconfig.json'] ?? '{}') as {
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
      workspaceDirectories: ['packages/weft'],
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
