import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyPreservedFields,
  discoverWorkspaces,
  ManifestTransformError,
  planManifests,
  publicNameFor,
  readPointer,
  stageTarget,
  targetFor,
  writePointer,
  type ManifestPlan,
  type MirrorTarget,
} from './manifests.ts';
import { PackageMapError } from './package-map.ts';
import { assertWritablePaths, loadTargetOwnedPolicy } from './target-owned.ts';

const licence = 'MIT License\n\nCopyright (c) 2026 Steve Kinney\n';

/**
 * A throwaway corvidae tree. Workspace names are real ones so `dispositionFor` resolves against
 * the committed map — the map is the input under test, not something to restate in a fixture —
 * while the dependency edges are pared down to the ones each assertion needs.
 */
const workspaces: Record<string, Record<string, unknown>> = {
  'applications/chat-room': {
    name: '@corvidae/chat-room',
    private: true,
    dependencies: {
      '@corvidae/cinder': 'workspace:*',
      '@corvidae/weft': 'workspace:*',
      svelte: 'catalog:',
    },
    devDependencies: { '@corvidae/typescript': 'workspace:*' },
  },
  'components/cinder': {
    name: '@corvidae/cinder',
    private: true,
    exports: { '.': './src/index.ts' },
    dependencies: { '@corvidae/markdown': 'workspace:*', svelte: 'catalog:' },
    devDependencies: { '@corvidae/typescript': 'workspace:*' },
  },
  'components/weft-ui': {
    name: '@corvidae/weft-ui',
    private: true,
    dependencies: { '@corvidae/cinder': 'workspace:*', '@corvidae/weft': 'workspace:*' },
  },
  'internal/typescript': { name: '@corvidae/typescript', private: true },
  'packages/markdown': {
    name: '@corvidae/markdown',
    private: true,
    dependencies: { zod: 'catalog:' },
  },
  'packages/operative': {
    name: '@corvidae/operative',
    private: true,
    dependencies: { '@corvidae/weft': 'workspace:*', zod: 'catalog:' },
  },
  'packages/weft': {
    name: '@corvidae/weft',
    private: true,
    exports: { '.': './src/index.ts' },
    dependencies: { zod: 'catalog:' },
    devDependencies: { '@corvidae/typescript': 'workspace:*', turbo: 'catalog:' },
  },
};

const catalog = { svelte: '^5.56.7', turbo: '^2.10.13', zod: '^4.6.5' };

const corvidaeRoot = {
  name: 'corvidae',
  private: true,
  type: 'module',
  license: 'MIT',
  author: 'Steve Kinney <hello@stevekinney.net>',
  workspaces: ['applications/*', 'components/*', 'packages/*', 'internal/*'],
  catalog,
  scripts: { validate: 'bun run lint && bun run typecheck' },
  devDependencies: { '@corvidae/cinder': 'workspace:*', zod: 'catalog:' },
  packageManager: 'bun@1.4.2',
  engines: { bun: '>=1.4.2' },
};

async function writeTree(root: string, files: Record<string, unknown>): Promise<void> {
  for (const [path, contents] of Object.entries(files)) {
    await Bun.write(
      join(root, path),
      typeof contents === 'string' ? contents : `${JSON.stringify(contents, undefined, 2)}\n`,
    );
  }
}

/** Stand up a fixture tree, hand it to the body, and remove it however the body ends. */
async function withTree(
  files: Record<string, unknown>,
  body: (root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'corvidae-manifests-'));
  try {
    await writeTree(root, files);
    await body(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function corvidaeFixture(extra: Record<string, unknown> = {}): Record<string, unknown> {
  const files: Record<string, unknown> = { 'package.json': corvidaeRoot, LICENSE: licence };
  for (const [directory, manifest] of Object.entries(workspaces)) {
    files[`${directory}/package.json`] = manifest;
  }
  return { ...files, ...extra };
}

function parse(plan: ManifestPlan, path: string): Record<string, unknown> {
  const contents = plan.files[path];
  if (contents === undefined) throw new Error(`${path} is not in the ${plan.target} plan`);
  return JSON.parse(contents) as Record<string, unknown>;
}

async function planFor(
  target: MirrorTarget,
  options: { targetDirectory?: string; extra?: Record<string, unknown> } = {},
): Promise<ManifestPlan> {
  let plan: ManifestPlan | undefined;
  await withTree(corvidaeFixture(options.extra), async (root) => {
    plan = await planManifests({
      corvidaeRoot: root,
      target,
      targetDirectory: options.targetDirectory,
    });
  });
  if (!plan) throw new Error('plan was not produced');
  return plan;
}

describe('workspace discovery and target membership', () => {
  test('workspaces are read from their manifests across all four directories', async () => {
    await withTree(corvidaeFixture(), async (root) => {
      const discovered = await discoverWorkspaces(root);
      expect(discovered.map((workspace) => workspace.name).toSorted()).toEqual(
        Object.values(workspaces)
          .map((manifest) => manifest['name'] as string)
          .toSorted(),
      );
    });
  });

  test('only weft ships from the weft target', () => {
    expect(targetFor('@corvidae/weft')).toBe('weft');
    for (const manifest of Object.values(workspaces)) {
      const name = manifest['name'] as string;
      if (name === '@corvidae/weft') continue;
      expect(targetFor(name)).toBe('cinder');
    }
  });

  test('a private workspace gets a derived name rather than a published one', async () => {
    expect(
      publicNameFor('@corvidae/typescript', {
        disposition: 'private-workspace',
        basis: 'development-only',
        reason: 'fixture',
      }),
    ).toBe('@lostgradient/typescript');
  });
});

describe('name mapping', () => {
  test('no emitted manifest carries a @corvidae/ specifier, for either target', async () => {
    for (const target of ['weft', 'cinder'] as const) {
      const plan = await planFor(target);
      for (const [path, contents] of Object.entries(plan.files)) {
        if (!path.endsWith('package.json')) continue;
        expect([path, contents.includes('@corvidae/')]).toEqual([path, false]);
      }
    }
  });

  test('a workspace absent from package-map.json fails, naming the workspace', async () => {
    const plan = planFor('cinder', {
      extra: { 'packages/phantom/package.json': { name: '@corvidae/phantom', private: true } },
    });
    await expect(plan).rejects.toThrow(PackageMapError);
    await expect(plan).rejects.toThrow(/@corvidae\/phantom/);
  });

  test('the command line transform exits non-zero on an unmapped workspace', async () => {
    await withTree(
      corvidaeFixture({
        'packages/phantom/package.json': { name: '@corvidae/phantom', private: true },
      }),
      async (root) => {
        const directory = await mkdtemp(join(tmpdir(), 'corvidae-unmapped-'));
        try {
          const transform = Bun.spawn(
            [
              'bun',
              new URL('./manifests.ts', import.meta.url).pathname,
              '--corvidae-root',
              root,
              '--target',
              'cinder',
              '--directory',
              directory,
            ],
            { stdout: 'pipe', stderr: 'pipe' },
          );
          const [stderr, exitCode] = await Promise.all([
            new Response(transform.stderr).text(),
            transform.exited,
          ]);
          expect(exitCode).not.toBe(0);
          expect(stderr).toContain('@corvidae/phantom');
          expect(await Bun.file(join(directory, 'package.json')).exists()).toBe(false);
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      },
    );
  });

  test('a runtime edge to a private workspace is refused rather than dropped', async () => {
    await withTree(
      corvidaeFixture({
        'packages/weft/package.json': {
          name: '@corvidae/weft',
          private: true,
          dependencies: { '@corvidae/typescript': 'workspace:*' },
        },
      }),
      async (root) => {
        await expect(planManifests({ corvidaeRoot: root, target: 'weft' })).rejects.toThrow(
          /lists @corvidae\/typescript under dependencies/,
        );
      },
    );
  });

  test('publish-as drops `private` while a private workspace keeps it', async () => {
    const plan = await planFor('cinder');
    const cinder = parse(plan, 'components/cinder/package.json');
    expect(cinder['name']).toBe('@lostgradient/cinder');
    expect('private' in cinder).toBe(false);

    const typescript = parse(plan, 'internal/typescript/package.json');
    expect(typescript['name']).toBe('@lostgradient/typescript');
    expect(typescript['private']).toBe(true);
  });

  test('exports are carried through untouched, because COR-1189 owns regenerating them', async () => {
    const plan = await planFor('cinder');
    expect(parse(plan, 'components/cinder/package.json')['exports']).toEqual({
      '.': './src/index.ts',
    });
    expect('files' in parse(plan, 'components/cinder/package.json')).toBe(false);
  });
});

describe('workspace and catalog resolution', () => {
  test('the weft target inlines every catalog specifier and holds no catalog', async () => {
    const plan = await planFor('weft');
    expect(Object.keys(plan.files).toSorted()).toEqual([
      'package.json',
      'packages/weft/LICENSE',
      'packages/weft/package.json',
    ]);
    for (const contents of Object.values(plan.files)) {
      expect(contents.includes('catalog:')).toBe(false);
    }
    const weft = parse(plan, 'packages/weft/package.json');
    expect(weft['dependencies']).toEqual({ zod: '^4.6.5' });
    expect(weft['devDependencies']).toEqual({ turbo: '^2.10.13' });
    expect('catalog' in parse(plan, 'package.json')).toBe(false);
  });

  test('the weft target drops its development-only edge and reports it', async () => {
    const plan = await planFor('weft');
    expect(plan.droppedEdges).toEqual(['@corvidae/weft -> @corvidae/typescript']);
  });

  test('the monorepo target keeps its catalog and its internal workspace edges', async () => {
    const plan = await planFor('cinder');
    const root = parse(plan, 'package.json');
    expect(root['catalog']).toEqual({ ...catalog, '@lostgradient/weft': '^0.25.0' });
    expect(parse(plan, 'components/cinder/package.json')['dependencies']).toEqual({
      '@lostgradient/markdown': 'workspace:*',
      svelte: 'catalog:',
    });
  });

  test('every edge into weft routes through the one root catalog entry', async () => {
    const plan = await planFor('cinder');
    const consumers = [
      'applications/chat-room/package.json',
      'components/weft-ui/package.json',
      'packages/operative/package.json',
    ];
    for (const consumer of consumers) {
      const dependencies = parse(plan, consumer)['dependencies'] as Record<string, string>;
      expect([consumer, dependencies['@lostgradient/weft']]).toEqual([consumer, 'catalog:']);
    }
    expect(
      (parse(plan, 'package.json')['catalog'] as Record<string, string>)['@lostgradient/weft'],
    ).toBe('^0.25.0');
  });

  test('a cross-target edge inlines the published range where no catalog can hold it', async () => {
    await withTree(
      corvidaeFixture({
        'packages/weft/package.json': {
          name: '@corvidae/weft',
          private: true,
          dependencies: { '@corvidae/cinder': 'workspace:*' },
        },
      }),
      async (root) => {
        const plan = await planManifests({ corvidaeRoot: root, target: 'weft' });
        expect(parse(plan, 'packages/weft/package.json')['dependencies']).toEqual({
          '@lostgradient/cinder': '^0.26.2',
        });
      },
    );
  });

  test('a cross-target edge to a never-published package is refused rather than guessed', async () => {
    await withTree(
      corvidaeFixture({
        'packages/weft/package.json': {
          name: '@corvidae/weft',
          private: true,
          dependencies: { '@corvidae/weft-ui': 'workspace:*' },
        },
      }),
      async (root) => {
        const plan = planManifests({ corvidaeRoot: root, target: 'weft' });
        await expect(plan).rejects.toThrow(ManifestTransformError);
        await expect(plan).rejects.toThrow(/never been published/);
      },
    );
  });

  test('a catalog specifier with no catalog entry is refused', async () => {
    await withTree(
      corvidaeFixture({
        'packages/weft/package.json': {
          name: '@corvidae/weft',
          private: true,
          dependencies: { 'not-in-catalog': 'catalog:' },
        },
      }),
      async (root) => {
        await expect(planManifests({ corvidaeRoot: root, target: 'weft' })).rejects.toThrow(
          /root catalog does not declare it/,
        );
      },
    );
  });
});

describe('per-package LICENSE fan-out', () => {
  test('every emitted package directory gets one and the root never does', async () => {
    for (const target of ['weft', 'cinder'] as const) {
      const plan = await planFor(target);
      const directories = Object.keys(plan.files)
        .filter((path) => path.endsWith('/package.json'))
        .map((path) => path.slice(0, -'/package.json'.length));
      expect(directories.length).toBeGreaterThan(0);
      for (const directory of directories) {
        expect([directory, plan.files[`${directory}/LICENSE`]]).toEqual([directory, licence]);
      }
      expect('LICENSE' in plan.files).toBe(false);
    }
  });
});

describe('target-owned fields', () => {
  test('JSON Pointers read, write and delete', () => {
    const document: Record<string, unknown> = { scripts: { prepare: 'husky' } };
    expect(readPointer(document, '/scripts/prepare')).toBe('husky');
    expect(readPointer(document, '/scripts/missing')).toBeUndefined();
    writePointer(document, '/devDependencies/husky', '^9.1.7');
    expect(document['devDependencies']).toEqual({ husky: '^9.1.7' });
    writePointer(document, '/scripts/prepare', undefined);
    expect(document['scripts']).toEqual({});
  });

  test('every enumerated pointer is carried out of the target manifest', async () => {
    const policy = await loadTargetOwnedPolicy();
    const emitted: Record<string, unknown> = { name: 'weft-monorepo', version: '0.0.0' };
    applyPreservedFields(policy, 'weft', 'package.json', emitted, {
      version: '9.9.9',
      scripts: { prepare: 'husky && bun packages/weft/scripts/husky/verify-hooks-installed.ts' },
      devDependencies: { husky: '^9.1.7' },
    });
    expect(emitted['version']).toBe('9.9.9');
    expect(emitted['scripts']).toEqual({
      prepare: 'husky && bun packages/weft/scripts/husky/verify-hooks-installed.ts',
    });
    expect(emitted['devDependencies']).toEqual({ husky: '^9.1.7' });
  });

  test('a target-scoped pointer does not bind the other target', async () => {
    const policy = await loadTargetOwnedPolicy();
    const emitted: Record<string, unknown> = { 'lint-staged': { '*.ts': ['prettier --write'] } };
    applyPreservedFields(policy, 'weft', 'package.json', emitted, { name: 'weft-monorepo' });
    expect(emitted['lint-staged']).toEqual({ '*.ts': ['prettier --write'] });
    applyPreservedFields(policy, 'cinder', 'package.json', emitted, { name: 'cinder-workspace' });
    expect('lint-staged' in emitted).toBe(false);
  });

  test("an existing target version is carried through, not overwritten with corvidae's", async () => {
    await withTree(
      { 'packages/weft/package.json': { name: '@lostgradient/weft', version: '0.25.0' } },
      async (targetDirectory) => {
        const plan = await planFor('weft', { targetDirectory });
        expect(parse(plan, 'packages/weft/package.json')['version']).toBe('0.25.0');
        expect(plan.firstPublish).toEqual([]);
      },
    );
  });

  test('a package the target has never carried is seeded at 0.0.0 and reported', async () => {
    const plan = await planFor('weft');
    expect(parse(plan, 'packages/weft/package.json')['version']).toBe('0.0.0');
    expect(plan.firstPublish).toEqual(['@lostgradient/weft']);
  });

  test('a published package missing from the target clone is refused, not rewound', async () => {
    await withTree({ 'package.json': { name: 'weft-monorepo' } }, async (targetDirectory) => {
      await expect(planFor('weft', { targetDirectory })).rejects.toThrow(
        /published at 0\.25\.0 but the target has no packages\/weft\/package\.json/,
      );
    });
  });

  test('only the package the target has never carried counts as a first publish', async () => {
    const versioned: Record<string, unknown> = {};
    for (const [directory, manifest] of Object.entries(workspaces)) {
      if (manifest['name'] === '@corvidae/weft') continue;
      // `@corvidae/weft-ui` is the fixture's stand-in for the four the map records as never
      // published, so it is the one workspace the target clone deliberately does not carry.
      if (manifest['name'] === '@corvidae/weft-ui') continue;
      versioned[`${directory}/package.json`] = { name: manifest['name'], version: '1.2.3' };
    }
    await withTree(versioned, async (targetDirectory) => {
      const plan = await planFor('cinder', { targetDirectory });
      expect(plan.firstPublish).toEqual(['@lostgradient/weft-ui']);
      expect(parse(plan, 'components/cinder/package.json')['version']).toBe('1.2.3');
    });
  });
});

describe('the plan never touches a target-owned path', () => {
  test('both targets clear the guard', async () => {
    const policy = await loadTargetOwnedPolicy();
    for (const target of ['weft', 'cinder'] as const) {
      const plan = await planFor(target);
      expect(() =>
        assertWritablePaths({ policy, target, paths: Object.keys(plan.files) }),
      ).not.toThrow();
      expect(Object.keys(plan.files).some((path) => path.startsWith('.changeset/'))).toBe(false);
    }
  });
});

describe('lockfile generation', () => {
  /**
   * Deliberately free of external dependencies so the staging install resolves entirely from the
   * staged tree: the test proves the transform produces an installable graph without reaching a
   * registry, which also keeps it hermetic.
   */
  const offline: Record<string, unknown> = {
    'package.json': { ...corvidaeRoot, catalog: {}, devDependencies: {} },
    LICENSE: licence,
    'packages/markdown/package.json': { name: '@corvidae/markdown', private: true },
    'components/cinder/package.json': {
      name: '@corvidae/cinder',
      private: true,
      dependencies: { '@corvidae/markdown': 'workspace:*' },
    },
  };

  test('a staged tree installs and its lockfile is frozen-install clean', async () => {
    await withTree(offline, async (root) => {
      const directory = await mkdtemp(join(tmpdir(), 'corvidae-staged-'));
      try {
        const staged = await stageTarget({ corvidaeRoot: root, target: 'cinder', directory });
        expect(staged.written).toContain('components/cinder/package.json');
        expect(await Bun.file(join(directory, 'bun.lock')).exists()).toBe(true);

        const frozen = Bun.spawn(['bun', 'install', '--frozen-lockfile', '--ignore-scripts'], {
          cwd: directory,
          stdout: 'pipe',
          stderr: 'pipe',
        });
        expect(await frozen.exited).toBe(0);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
  }, 60_000);
});
