import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { throwingRejectionOf } from '../promise-outcome.test-support.ts';
import { DeferredWorkspaceError, layoutFor } from './layout-map.ts';
import {
  assertNothingDeferred,
  composeManifest,
  discoverWorkspaces,
  ManifestTransformError,
  planManifests,
  publicNameFor,
  stageTarget,
  type ManifestPlan,
} from './manifests.ts';
import { loadPackageMap, PackageMapError, type PackageMap } from './package-map.ts';
import {
  collectDigestedFiles,
  hashDigestedFiles,
  publicationInputContract,
} from './source-digest.ts';
import {
  membersOf,
  MirrorTargetError,
  mirrorTargets,
  targetFor,
  type MirrorTarget,
} from './target-definitions.ts';
import { assertWritablePaths, loadTargetOwnedPolicy } from './target-owned.ts';

const licence = 'MIT License\n\nCopyright (c) 2026 Steve Kinney\n';

/**
 * Weft's recorded release and the range an edge into it renders as. Read from the real map rather
 * than written as a literal: these tests assert the rule that a cross-target edge follows
 * `lastPublishedVersion`, and a literal turned every weft release into six test edits.
 */
const realPackageMap = await loadPackageMap();
const weftDisposition = realPackageMap.workspaces['@lostgradient/weft'];
if (weftDisposition?.disposition !== 'publish-as' || !weftDisposition.lastPublishedVersion) {
  throw new Error('package-map.json must record @lostgradient/weft as published');
}
const weftRecordedVersion = weftDisposition.lastPublishedVersion;
const weftRange = `^${weftRecordedVersion}`;

/**
 * A `publish-as` workspace's recorded `lastPublishedVersion`, read from the real map rather than
 * written as a literal — the same reasoning as `weftRecordedVersion` above, for
 * COR-1229's seeding tests against operative, armorer, and conversationalist.
 */
function recordedVersion(workspace: string): string {
  const disposition = realPackageMap.workspaces[workspace];
  if (disposition?.disposition !== 'publish-as' || !disposition.lastPublishedVersion) {
    throw new Error(`package-map.json must record ${workspace} as published`);
  }
  return disposition.lastPublishedVersion;
}

const operativeRecordedVersion = recordedVersion('@lostgradient/operative');
const armorerRecordedVersion = recordedVersion('armorer');
const conversationalistRecordedVersion = recordedVersion('conversationalist');

/**
 * A throwaway corvidae tree. Workspace names are real ones so `dispositionFor` resolves against
 * the committed map — the map is the input under test, not something to restate in a fixture —
 * while the dependency edges are pared down to the ones each assertion needs.
 */
const workspaces: Record<string, Record<string, unknown>> = {
  'applications/playground': {
    name: '@lostgradient/playground',
    private: true,
    dependencies: {
      '@lostgradient/cinder': 'workspace:*',
      '@lostgradient/weft': 'workspace:*',
      svelte: 'catalog:',
    },
    devDependencies: { '@lostgradient/typescript': 'workspace:*' },
  },
  'components/cinder': {
    name: '@lostgradient/cinder',
    private: true,
    exports: { '.': './src/index.ts' },
    dependencies: { '@lostgradient/markdown': 'workspace:*', svelte: 'catalog:' },
    devDependencies: { '@lostgradient/typescript': 'workspace:*' },
  },
  'components/weft-ui': {
    name: '@lostgradient/weft-ui',
    private: true,
    dependencies: { '@lostgradient/cinder': 'workspace:*', '@lostgradient/weft': 'workspace:*' },
  },
  'internal/typescript': { name: '@lostgradient/typescript', private: true },
  'packages/markdown': {
    name: '@lostgradient/markdown',
    private: true,
    dependencies: { zod: 'catalog:' },
  },
  'packages/operative': {
    name: '@lostgradient/operative',
    private: true,
    dependencies: { '@lostgradient/weft': 'workspace:*', zod: 'catalog:' },
  },
  'packages/weft': {
    name: '@lostgradient/weft',
    private: true,
    exports: { '.': './src/index.ts' },
    dependencies: { zod: 'catalog:' },
    devDependencies: { '@lostgradient/typescript': 'workspace:*', turbo: 'catalog:' },
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
  devDependencies: { '@lostgradient/cinder': 'workspace:*', zod: 'catalog:' },
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
    const surface = await Bun.file(new URL('./package-surface.json', import.meta.url)).json();
    // These tests exercise manifest composition, so their fixture owns a literal, minimal surface.
    surface.packages['@lostgradient/cinder'].exports = { '.': './dist/index.js' };
    surface.packages['@lostgradient/cinder'].files = ['dist'];
    for (const entry of Object.values(surface.packages) as {
      build: { toolchain: Record<string, string> };
    }[])
      entry.build.toolchain = {};
    await writeTree(root, {
      'internal/typescript/base.json': { compilerOptions: { strict: true } },
      'internal/typescript/library.json': { extends: './base.json' },
      'internal/typescript/browser.json': {
        extends: './base.json',
        compilerOptions: { lib: ['DOM'] },
      },
      'scripts/mirror/package-map.json': realPackageMap,
      'scripts/mirror/package-surface.json': surface,
      'scripts/mirror/target-definitions.ts': await Bun.file(
        new URL('./target-definitions.ts', import.meta.url),
      ).text(),
      'scripts/mirror/layout-map.json': await Bun.file(
        new URL('./layout-map.json', import.meta.url),
      ).text(),
    });
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

/**
 * `package-map.json`, with every `publish-as` entry's `sourceDigest` overlaid to its digest as
 * `root` (a fixture tree, not real corvidae) currently stands.
 *
 * Every test here plans a synthetic tree against the *real* map — `dispositionFor` resolving
 * against the committed map is deliberate, per this file's own fixture comment above — so a fixture
 * consuming `@lostgradient/weft` cross-target hits `assertEdgeNotStale` unless something records a
 * digest that matches. Overlaying the fixture's own current digest is that something: this file's
 * tests are about manifest composition and rewriting, not about the digest guard, which has its
 * own tests in `source-digest.test.ts` against the real map.
 */
async function packageMapWithCurrentDigests(root: string): Promise<PackageMap> {
  const map = await loadPackageMap();
  const workspaces = await discoverWorkspaces(root);
  const overlaid: PackageMap['workspaces'] = {};
  for (const [name, entry] of Object.entries(map.workspaces)) {
    if (entry.disposition !== 'publish-as') {
      overlaid[name] = entry;
      continue;
    }
    const workspace = workspaces.find((candidate) => candidate.name === name);
    if (workspace === undefined) {
      overlaid[name] = entry;
      continue;
    }
    const sourceFiles = await collectDigestedFiles({
      corvidaeRoot: root,
      corvidaeDirectory: workspace.directory,
      workspace: workspace.name,
    });
    const input = await publicationInputContract({
      corvidaeRoot: root,
      corvidaeDirectory: workspace.directory,
      workspace: workspace.name,
    });
    overlaid[name] = {
      ...entry,
      publishedSnapshot: {
        schemaVersion: 1,
        version: entry.lastPublishedVersion ?? '0.0.0',
        gitHead: '0'.repeat(40),
        corvidaeCommit: '0'.repeat(40),
        source: {
          algorithm: 'sha256-files-v1',
          paths: sourceFiles.map((file) => file.path),
          digest: hashDigestedFiles(sourceFiles),
        },
        publicationInputContract: input,
        registryManifestContract: input,
        registryPayloadContract: {
          algorithm: 'sha256-package-payload-v1',
          files: [],
          digest: '0'.repeat(64),
        },
      },
    };
  }
  return { ...map, workspaces: overlaid };
}

/**
 * `packageMapWithCurrentDigests`, with `workspace`'s `lastPublishedVersion` forced back to `null`
 * — the shape `package-map.json` carried for every agent-bureau package before COR-1198 recorded
 * their first publish. Every `publish-as` entry in the committed map now records a real version,
 * so the "never published" branches this exercises need a fixture map rather than the live one;
 * forcing a real, still-`publish-as` workspace's version to `null` on an overridden map tests the
 * same code path without pinning the assertion to whichever real workspace happens to be
 * unpublished on a given day.
 */
async function packageMapWithNeverPublished(root: string, workspace: string): Promise<PackageMap> {
  const map = await packageMapWithCurrentDigests(root);
  const entry = map.workspaces[workspace];
  if (entry?.disposition !== 'publish-as') {
    throw new Error(`${workspace} must be publish-as in the real map`);
  }
  return {
    ...map,
    workspaces: { ...map.workspaces, [workspace]: { ...entry, lastPublishedVersion: null } },
  };
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
      packageMap: await packageMapWithCurrentDigests(root),
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

  test('each target claims exactly the workspaces its repository ships', () => {
    expect(targetFor('@lostgradient/weft')).toBe('weft');
    expect(targetFor('@lostgradient/cinder')).toBe('cinder');
    expect(targetFor('armorer')).toBe('agent-bureau');
    expect(targetFor('@lostgradient/operative')).toBe('agent-bureau');
  });

  /**
   * The routing gate. Until COR-1287 `targetFor` defaulted every unlisted workspace to cinder, so
   * a workspace nobody routed still got a target — the wrong one, silently, with no failure
   * anywhere downstream because every consumer only ever asks which target a workspace belongs to
   * and believes the answer. With three targets the default is gone and the membership lists have
   * to be exhaustive instead, which is a property of `package-map.json` rather than of this file:
   * a workspace added to the map with any disposition but `exclude` is a workspace that must
   * appear in exactly one list. Asserted in both directions, because a member list naming a
   * workspace the map excludes or no longer carries is the same defect pointing the other way.
   */
  test('every non-excluded workspace in package-map.json has exactly one target', async () => {
    const map = await loadPackageMap();
    const routed = Object.entries(map.workspaces).filter(
      ([, entry]) => entry.disposition !== 'exclude',
    );
    expect(routed.length).toBeGreaterThan(0);

    const claims = new Map<string, MirrorTarget[]>();
    for (const target of mirrorTargets) {
      for (const member of membersOf(target)) {
        claims.set(member, [...(claims.get(member) ?? []), target]);
      }
    }

    const unrouted = routed.map(([name]) => name).filter((name) => !claims.has(name));
    expect(unrouted).toEqual([]);

    const multiplyClaimed = [...claims]
      .filter(([, targets]) => targets.length > 1)
      .map(([name, targets]) => `${name} -> ${targets.join(', ')}`);
    expect(multiplyClaimed).toEqual([]);

    const routedNames = new Set(routed.map(([name]) => name));
    const claimedButNotRouted = [...claims.keys()]
      .filter((name) => !routedNames.has(name))
      .toSorted();
    expect(claimedButNotRouted).toEqual([]);
  });

  test('a workspace no target claims is refused rather than defaulted', () => {
    expect(() => targetFor('@lostgradient/not-a-workspace')).toThrow(MirrorTargetError);
  });

  test('a private workspace gets a derived name rather than a published one', async () => {
    expect(
      publicNameFor('@lostgradient/typescript', {
        disposition: 'private-workspace',
        basis: 'development-only',
        reason: 'fixture',
      }),
    ).toBe('@lostgradient/typescript');
  });
});

describe('name mapping', () => {
  /**
   * COR-1285 deleted the source-side rewrite layer, which existed to translate a corvidae-only
   * name into the one `package-map.json` publishes it under. This is the fact that made that
   * deletable, stated on the manifest half rather than the source half: since COR-1284 renamed
   * every workspace to the name it already publishes under, nothing here has ever needed
   * translating either — each emitted manifest's `name` carries the same workspace name corvidae
   * itself declares, unchanged.
   */
  test('every emitted manifest’s name is the workspace’s own name, carried unchanged', async () => {
    for (const target of ['weft', 'cinder'] as const) {
      const plan = await planFor(target);
      for (const workspace of plan.emitted) {
        const path = `${workspace.targetDirectory}/package.json`;
        const manifest = parse(plan, path);
        expect([path, manifest['name']]).toEqual([path, workspace.workspace]);
      }
    }
  });

  test('a workspace absent from package-map.json fails, naming the workspace', async () => {
    const plan = planFor('cinder', {
      extra: { 'packages/phantom/package.json': { name: '@lostgradient/phantom', private: true } },
    });
    expect(await throwingRejectionOf(plan)).toThrow(PackageMapError);
    expect(await throwingRejectionOf(plan)).toThrow(/@lostgradient\/phantom/);
  });

  test('the command line transform exits non-zero on an unmapped workspace', async () => {
    await withTree(
      corvidaeFixture({
        'packages/phantom/package.json': { name: '@lostgradient/phantom', private: true },
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
          expect(stderr).toContain('@lostgradient/phantom');
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
          name: '@lostgradient/weft',
          private: true,
          dependencies: { '@lostgradient/typescript': 'workspace:*' },
        },
      }),
      async (root) => {
        expect(
          await throwingRejectionOf(planManifests({ corvidaeRoot: root, target: 'weft' })),
        ).toThrow(/lists @lostgradient\/typescript under dependencies/);
      },
    );
  });

  test('publish-as drops `private` while a private workspace keeps it', async () => {
    const plan = await planFor('cinder');
    const cinder = parse(plan, 'packages/components/package.json');
    expect(cinder['name']).toBe('@lostgradient/cinder');
    expect('private' in cinder).toBe(false);

    const typescript = parse(plan, 'internal/typescript/package.json');
    expect(typescript['name']).toBe('@lostgradient/typescript');
    expect(typescript['private']).toBe(true);
  });

  test('exports are carried through untouched, because COR-1189 owns regenerating them', async () => {
    const plan = await planFor('cinder');
    expect(parse(plan, 'packages/components/package.json')['exports']).toEqual({
      '.': './src/index.ts',
    });
    expect('files' in parse(plan, 'packages/components/package.json')).toBe(false);
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
    expect(plan.droppedEdges).toEqual(['@lostgradient/weft -> @lostgradient/typescript']);
  });

  /**
   * COR-1289: the two rulings behind `publishedEdgeFields`, pinned so that widening it later fails
   * here rather than silently changing a verification order. The fixture is the shape the exclusion
   * exists for — `markdown` declares a development-only edge back to `cinder`, which already
   * depends on `markdown` — and counting it would make an ordinary arrangement an unorderable
   * cycle. The edge itself is untouched: only the ordering record leaves it out.
   */
  test('a dependencies edge orders the target; a devDependencies back-edge does not', async () => {
    const plan = await planFor('cinder', {
      extra: {
        'packages/markdown/package.json': {
          name: '@lostgradient/markdown',
          private: true,
          dependencies: { zod: 'catalog:' },
          devDependencies: { '@lostgradient/cinder': 'workspace:*' },
        },
      },
    });
    expect(plan.intraTargetEdges.get('@lostgradient/cinder')).toEqual(['@lostgradient/markdown']);
    expect(plan.intraTargetEdges.get('@lostgradient/markdown')).toBeUndefined();
    expect(parse(plan, 'packages/markdown/package.json')['devDependencies']).toEqual({
      '@lostgradient/cinder': 'workspace:*',
    });
  });

  test('the monorepo target keeps its catalog and its internal workspace edges', async () => {
    const plan = await planFor('cinder');
    const root = parse(plan, 'package.json');
    expect(root['catalog']).toEqual({ ...catalog, '@lostgradient/weft': weftRange });
    expect(parse(plan, 'packages/components/package.json')['dependencies']).toEqual({
      '@lostgradient/markdown': 'workspace:*',
      svelte: 'catalog:',
    });
  });

  test('every edge into weft routes through the one root catalog entry', async () => {
    const plan = await planFor('cinder');
    // `applications/playground` is absent deliberately: `package-map.json` excludes it, so nothing
    // is emitted for it at all. The test below is what holds that. `packages/operative` is absent
    // for a different reason as of COR-1287 — it ships from the agent-bureau target now, and the
    // test below covers the same edge there, where no catalog exists to route it through.
    const dependencies = parse(plan, 'packages/weft-ui/package.json')['dependencies'] as Record<
      string,
      string
    >;
    expect(dependencies['@lostgradient/weft']).toBe('catalog:');
    expect(
      (parse(plan, 'package.json')['catalog'] as Record<string, string>)['@lostgradient/weft'],
    ).toBe(weftRange);
  });

  test('the agent-bureau target inlines its edge into weft, having no catalog to hold it', async () => {
    const plan = await planFor('agent-bureau');
    expect(parse(plan, 'packages/operative/package.json')['dependencies']).toEqual({
      '@lostgradient/weft': weftRange,
      zod: '^4.6.5',
    });
    expect(parse(plan, 'package.json')['catalog']).toBeUndefined();
  });

  test('a cross-target edge inlines the published range where no catalog can hold it', async () => {
    await withTree(
      corvidaeFixture({
        'packages/weft/package.json': {
          name: '@lostgradient/weft',
          private: true,
          dependencies: { '@lostgradient/cinder': 'workspace:*' },
        },
      }),
      async (root) => {
        const plan = await planManifests({
          corvidaeRoot: root,
          target: 'weft',
          packageMap: await packageMapWithCurrentDigests(root),
        });
        expect(parse(plan, 'packages/weft/package.json')['dependencies']).toEqual({
          '@lostgradient/cinder': '^0.27.0',
        });
      },
    );
  });

  test('a cross-target edge to a never-published package is refused rather than guessed', async () => {
    await withTree(
      corvidaeFixture({
        'packages/weft/package.json': {
          name: '@lostgradient/weft',
          private: true,
          // Every `publish-as` entry in the real map now records a `lastPublishedVersion`
          // (COR-1198), so `packageMapWithNeverPublished` forces cryptography's back to `null` on
          // an overridden map rather than this fixture needing a real workspace that has genuinely
          // never published. `@lostgradient/weft-ui` used to be this fixture's example of the same
          // fact; COR-1196 moved it to `private-workspace`, which refuses a cross-target edge for a
          // different reason (see the next test), so this one still needs a `publish-as` package.
          dependencies: { '@lostgradient/cryptography': 'workspace:*' },
        },
        'packages/cryptography/package.json': {
          name: '@lostgradient/cryptography',
          private: true,
        },
      }),
      async (root) => {
        const plan = planManifests({
          corvidaeRoot: root,
          target: 'weft',
          packageMap: await packageMapWithNeverPublished(root, '@lostgradient/cryptography'),
        });
        expect(await throwingRejectionOf(plan)).toThrow(ManifestTransformError);
        expect(await throwingRejectionOf(plan)).toThrow(/never been published/);
      },
    );
  });

  test('a cross-target edge to a private workspace outside development-only tooling is refused', async () => {
    // COR-1196: `@lostgradient/weft-ui` is `private-workspace` with basis `held-for-api-design`
    // in the real map, not `development-only`, so an edge to it cannot be silently dropped the
    // way `@lostgradient/typescript`'s devDependencies edge can (see "the weft target drops its
    // development-only edge" above). Nothing in the real tree declares this edge — this pins the
    // refusal the code path takes if one ever did, which was previously untested.
    await withTree(
      corvidaeFixture({
        'packages/weft/package.json': {
          name: '@lostgradient/weft',
          private: true,
          dependencies: { '@lostgradient/weft-ui': 'workspace:*' },
        },
      }),
      async (root) => {
        const plan = planManifests({ corvidaeRoot: root, target: 'weft' });
        expect(await throwingRejectionOf(plan)).toThrow(ManifestTransformError);
        expect(await throwingRejectionOf(plan)).toThrow(
          /only a devDependencies edge to development-only tooling can be dropped/,
        );
      },
    );
  });

  test('a catalog specifier with no catalog entry is refused', async () => {
    await withTree(
      corvidaeFixture({
        'packages/weft/package.json': {
          name: '@lostgradient/weft',
          private: true,
          dependencies: { 'not-in-catalog': 'catalog:' },
        },
      }),
      async (root) => {
        expect(
          await throwingRejectionOf(planManifests({ corvidaeRoot: root, target: 'weft' })),
        ).toThrow(/root catalog does not declare it/);
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

describe('composition against a manifest the target already carries', () => {
  /**
   * COR-1223's four defects, each one a key the old rule emitted from corvidae over an answer the
   * target already had. They are asserted through `composeManifest` directly rather than through a
   * plan, because the unit is the rule: a plan would prove the rule fires for weft's manifest and
   * say nothing about whether the rule itself is right.
   */
  const target = {
    name: '@lostgradient/weft',
    version: '0.25.0',
    description: 'Durable workflows',
    license: 'MIT',
    repository: { type: 'git', url: 'git+https://github.com/stevekinney/weft.git' },
    'lint-staged': { '*.ts': ['prettier --write'] },
    scripts: {
      'test:coverage': 'bun run scripts/check-coverage.ts',
      'verify:documentation': 'bun run scripts/verify-documentation.ts',
      prepare: 'husky',
    },
    dependencies: { '@msgpack/msgpack': '^3.1.3', zod: '^4.3.6' },
    devDependencies: {
      husky: '^9.1.7',
      oxlint: '^1.79.0',
      'oxlint-tsgolint': '^7.0.2001',
      valibot: '^1.4.0',
    },
    optionalDependencies: { 'better-sqlite3': '^12.8.0' },
    peerDependencies: { 'better-sqlite3': '^12.8.0' },
    peerDependenciesMeta: { 'better-sqlite3': { optional: true } },
    engines: { bun: '>=1.3.13' },
  };

  /** Corvidae's manifest for the same workspace, as `rewriteWorkspaceManifest` leaves it. */
  const corvidae = {
    name: '@lostgradient/weft',
    version: '0.0.0',
    scripts: { test: "bun test --path-ignore-patterns='scripts/benchmarks/**'" },
    dependencies: {
      '@msgpack/msgpack': '^3.1.3',
      'better-sqlite3': '^12.8.0',
      valibot: '^1.4.0',
      zod: '^4.6.5',
      'newly-imported': '^1.0.0',
    },
    devDependencies: { oxlint: '^1.83.0' },
    engines: { bun: '>=1.4.2' },
  };

  async function compose(): Promise<ReturnType<typeof composeManifest>> {
    return composeManifest({
      policy: await loadTargetOwnedPolicy(),
      target: 'weft',
      emitted: structuredClone(corvidae),
      existing: structuredClone(target),
      mirrorPackages: new Set(['@lostgradient/weft']),
    });
  }

  test('a target-owned script survives, and corvidae’s never replaces the block', async () => {
    const { manifest } = await compose();
    expect(manifest['scripts']).toEqual(target.scripts);
  });

  test('a target-owned devDependency survives even though corvidae has no such edge', async () => {
    const { manifest } = await compose();
    const devDependencies = manifest['devDependencies'] as Record<string, string>;
    // `oxlint --type-aware` shells out to this one; without it every lint job fails outright.
    expect(devDependencies['oxlint-tsgolint']).toBe('^7.0.2001');
    expect(devDependencies['husky']).toBe('^9.1.7');
    // A devDependency both carry keeps the target's pin, because the target's scripts run it.
    expect(devDependencies['oxlint']).toBe('^1.79.0');
  });

  test('the target’s classification of a third-party dependency survives', async () => {
    const { manifest } = await compose();
    // Corvidae lists both as plain runtime dependencies because every internal edge is one.
    // The target's packaging says otherwise, and the target is the repository that publishes.
    expect(manifest['optionalDependencies']).toEqual({ 'better-sqlite3': '^12.8.0' });
    expect(manifest['devDependencies']).toHaveProperty('valibot', '^1.4.0');
    expect(manifest['dependencies']).not.toHaveProperty('better-sqlite3');
    expect(manifest['dependencies']).not.toHaveProperty('valibot');
    // Range follows the block it is kept in, so a sync never retunes a pin the target chose.
    expect(manifest['dependencies']).toHaveProperty('zod', '^4.3.6');
  });

  test('every piece of package metadata survives', async () => {
    const { manifest } = await compose();
    for (const key of ['description', 'license', 'repository', 'lint-staged'] as const) {
      expect([key, manifest[key]]).toEqual([key, target[key]]);
    }
    expect(manifest['peerDependencies']).toEqual(target.peerDependencies);
    expect(manifest['peerDependenciesMeta']).toEqual(target.peerDependenciesMeta);
    expect(manifest['engines']).toEqual(target.engines);
  });

  test('a dependency the target declares nowhere is added, in corvidae’s block, and reported', async () => {
    const { manifest, added } = await compose();
    expect(manifest['dependencies']).toHaveProperty('newly-imported', '^1.0.0');
    expect(added).toEqual(['newly-imported (dependencies)']);
  });

  test('a manifest the target does not carry is emitted whole, since nothing can be preserved', async () => {
    const { manifest, added } = composeManifest({
      policy: await loadTargetOwnedPolicy(),
      target: 'weft',
      emitted: structuredClone(corvidae),
      existing: undefined,
      mirrorPackages: new Set(),
    });
    expect(manifest).toEqual(corvidae);
    expect(added).toEqual([]);
  });

  test('an existing target root keeps neither its own workspaces nor its own catalog', async () => {
    // Both are computed rather than copied. The catalog the transform emits is corvidae's plus
    // one entry per cross-target edge the plan resolved, and every emitted package manifest
    // referencing one says `catalog:` — so a root that kept the target's would name a catalog
    // entry nothing declares, and the staged install would fail to resolve it. The weft target
    // cannot show this (it holds no catalog and its globs already match), which is exactly why
    // it is asserted here rather than left to the dry run.
    const versioned: Record<string, unknown> = {
      'package.json': {
        name: 'cinder-workspace',
        private: true,
        workspaces: ['packages/*'],
        catalog: { svelte: '^5.0.0' },
      },
    };
    for (const manifest of Object.values(workspaces)) {
      const layout = await layoutFor(String(manifest['name']));
      if (layout.disposition !== 'emit') continue;
      versioned[`${layout.targetDirectory}/package.json`] = {
        name: manifest['name'],
        version: '1.2.3',
      };
    }
    await withTree(versioned, async (targetDirectory) => {
      const plan = await planFor('cinder', { targetDirectory });
      const root = parse(plan, 'package.json');
      expect(root['workspaces']).toEqual([
        'applications/*',
        'components/*',
        'packages/*',
        'internal/*',
      ]);
      const emittedCatalog = root['catalog'] as Record<string, string>;
      expect(emittedCatalog['@lostgradient/weft']).toBe(weftRange);
      expect(emittedCatalog['svelte']).toBe(catalog.svelte);
    });
  });

  test('a stale edge to a package this mirror ships is replaced, not kept alongside', async () => {
    const { manifest } = composeManifest({
      policy: await loadTargetOwnedPolicy(),
      target: 'cinder',
      emitted: {
        name: '@lostgradient/cinder',
        dependencies: { '@lostgradient/markdown': '^2.0.0' },
      },
      existing: {
        name: '@lostgradient/cinder',
        dependencies: { '@lostgradient/markdown': '^1.0.0', '@lostgradient/retired': '^1.0.0' },
      },
      mirrorPackages: new Set(['@lostgradient/markdown', '@lostgradient/retired']),
    });
    expect(manifest['dependencies']).toEqual({ '@lostgradient/markdown': '^2.0.0' });
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

  test('a never-published workspace with no target clone is seeded at 0.0.0 and reported', async () => {
    // Every `publish-as` entry in the real map now records a `lastPublishedVersion` (COR-1198), so
    // `packageMapWithNeverPublished` forces cryptography's back to `null` on an overridden map to
    // exercise the pre-COR-1229 fallback. `@lostgradient/weft-ui` used to be this test's example of
    // a `publish-as` package with no seed; COR-1196 moved it to `private-workspace`, which has no
    // `lastPublishedVersion` to be null in the first place, so it no longer demonstrates this
    // mechanism.
    await withTree(
      corvidaeFixture({
        'packages/cryptography/package.json': { name: '@lostgradient/cryptography', private: true },
      }),
      async (root) => {
        const plan = await planManifests({
          corvidaeRoot: root,
          target: 'agent-bureau',
          packageMap: await packageMapWithNeverPublished(root, '@lostgradient/cryptography'),
        });
        expect(parse(plan, 'packages/cryptography/package.json')['version']).toBe('0.0.0');
        expect(plan.firstPublish).toContain('@lostgradient/cryptography');
        expect(plan.seededFromPackageMap).not.toContain('@lostgradient/cryptography');
      },
    );
  });

  test(
    'COR-1229: a published package missing from the target clone is seeded at ' +
      'lastPublishedVersion, not refused',
    async () => {
      await withTree({ 'package.json': { name: 'weft-monorepo' } }, async (targetDirectory) => {
        const plan = await planFor('weft', { targetDirectory });
        expect(parse(plan, 'packages/weft/package.json')['version']).toBe(weftRecordedVersion);
        expect(plan.seededFromPackageMap).toEqual(['@lostgradient/weft']);
        expect(plan.firstPublish).toEqual([]);
      });
    },
  );

  test('COR-1229: no target clone at all seeds the same way as an incomplete one', async () => {
    const plan = await planFor('weft');
    expect(parse(plan, 'packages/weft/package.json')['version']).toBe(weftRecordedVersion);
    expect(plan.seededFromPackageMap).toEqual(['@lostgradient/weft']);
    expect(plan.firstPublish).toEqual([]);
  });

  test('only the package the target has never carried counts as a first publish', async () => {
    const versioned: Record<string, unknown> = {};
    for (const manifest of Object.values(workspaces)) {
      if (manifest['name'] === '@lostgradient/weft') continue;
      // `@lostgradient/weft-ui` is `private-workspace` in the real map (COR-1196) with no
      // `lastPublishedVersion` to seed from, so it is the one workspace the target clone
      // deliberately does not carry — the property this test pins (only the truly-missing one
      // counts as a first publish) holds regardless of a workspace's publish disposition.
      if (manifest['name'] === '@lostgradient/weft-ui') continue;
      const layout = await layoutFor(String(manifest['name']));
      // The clone is the target's tree, so its manifests sit at the target's own paths.
      if (layout.disposition !== 'emit') continue;
      versioned[`${layout.targetDirectory}/package.json`] = {
        name: manifest['name'],
        version: '1.2.3',
        // Cinder's husky hook lives in this manifest rather than only at the root, and
        // `target-owned.json` enumerates it by the target's path. The entry could never match
        // while `@lostgradient/cinder` was emitted at corvidae's `components/cinder`; seeded here so
        // the remap and the enumeration are checked together.
        ...(manifest['name'] === '@lostgradient/cinder'
          ? { scripts: { prepare: 'cd ../.. && husky' } }
          : {}),
      };
    }
    await withTree(versioned, async (targetDirectory) => {
      const plan = await planFor('cinder', { targetDirectory });
      expect(plan.firstPublish).toEqual(['@lostgradient/weft-ui']);
      const cinder = parse(plan, 'packages/components/package.json');
      expect(cinder['version']).toBe('1.2.3');
      expect((cinder['scripts'] as Record<string, string>)['prepare']).toBe('cd ../.. && husky');
    });
  });

  test(
    'COR-1196: an existing manifest missing a version is seeded like a new one, ' +
      'not left without one',
    async () => {
      const versioned: Record<string, unknown> = {};
      for (const manifest of Object.values(workspaces)) {
        if (manifest['name'] === '@lostgradient/weft') continue;
        if (manifest['name'] === '@lostgradient/weft-ui') continue;
        const layout = await layoutFor(String(manifest['name']));
        if (layout.disposition !== 'emit') continue;
        versioned[`${layout.targetDirectory}/package.json`] = {
          name: manifest['name'],
          version: '1.2.3',
        };
      }
      // `@lostgradient/testing` is COR-1196's real example: a private workspace the target
      // already has a manifest for — named `@cinder/testing`, the real target's own spelling —
      // but whose manifest has never carried a `version` key at all.
      versioned['packages/testing/package.json'] = { name: '@cinder/testing', private: true };
      await withTree(versioned, async (targetDirectory) => {
        const plan = await planFor('cinder', {
          targetDirectory,
          extra: {
            'packages/testing/package.json': {
              name: '@lostgradient/testing',
              private: true,
              dependencies: { svelte: 'catalog:' },
            },
          },
        });
        const testing = parse(plan, 'packages/testing/package.json');
        expect(testing['version']).toBe('0.0.0');
        // Not a first publish and not seeded from the package map: the target already has *a*
        // manifest for this workspace, just not a versioned one — a third case neither list
        // describes.
        expect(plan.firstPublish).not.toContain('@lostgradient/testing');
        expect(plan.seededFromPackageMap).not.toContain('@lostgradient/testing');
        const cinder = parse(plan, 'packages/components/package.json');
        expect(cinder['version']).toBe('1.2.3');
      });
    },
  );
});

/**
 * COR-1287, found by staging against the real stevekinney/agent-bureau rather than by reading the
 * code: that target names corvidae's `@lostgradient/lifecycle` simply `lifecycle`, and six of its
 * packages depend on it under that name. Rule (1) in `target-owned.json` matched only the public
 * name, so rule (2) kept the target's entry as an ordinary third-party edge and the composed
 * manifest declared the same workspace twice. `bun install` refused the staged tree outright —
 * `Workspace dependency "lifecycle" not found` — which is the good outcome; the bad one is a
 * target that installs and resolves two copies.
 */
describe("COR-1287: the target's own name for a mirror workspace is an alias, not a third party", () => {
  /** An agent-bureau clone that names lifecycle the way the real one does, with a consumer. */
  function cloneNamingLifecycleUnscoped(): Record<string, unknown> {
    return {
      'package.json': { name: 'agent-bureau', private: true, workspaces: ['packages/*'] },
      'packages/lifecycle/package.json': { name: 'lifecycle', private: true, version: '0.0.1' },
      'packages/operative/package.json': {
        name: '@lostgradient/operative',
        version: '0.12.0',
        dependencies: { lifecycle: 'workspace:*', zod: '^4.0.0' },
      },
    };
  }

  test('the stale unscoped edge is replaced, not kept alongside the scoped one', async () => {
    await withTree(cloneNamingLifecycleUnscoped(), async (targetDirectory) => {
      const plan = await planFor('agent-bureau', {
        targetDirectory,
        extra: {
          'packages/lifecycle/package.json': { name: '@lostgradient/lifecycle', private: true },
          'packages/operative/package.json': {
            name: '@lostgradient/operative',
            private: true,
            dependencies: { '@lostgradient/lifecycle': 'workspace:*', zod: 'catalog:' },
          },
        },
      });
      const dependencies = parse(plan, 'packages/operative/package.json')['dependencies'] as Record<
        string,
        string
      >;
      expect(dependencies['@lostgradient/lifecycle']).toBe('workspace:*');
      expect(dependencies).not.toHaveProperty('lifecycle');
      // The target's own name for the workspace is replaced in the manifest it names, too.
      expect(parse(plan, 'packages/lifecycle/package.json')['name']).toBe(
        '@lostgradient/lifecycle',
      );
    });
  });

  test("a target name that is another workspace's public name is a collision, not an alias", async () => {
    await withTree(
      {
        'package.json': { name: 'agent-bureau', private: true, workspaces: ['packages/*'] },
        // The target calls its `packages/lifecycle` by armorer's published name. Dropping that
        // edge as an alias would silently remove a real dependency on armorer.
        'packages/lifecycle/package.json': { name: 'armorer', private: true, version: '0.0.1' },
      },
      async (targetDirectory) => {
        expect(
          await throwingRejectionOf(
            planFor('agent-bureau', {
              targetDirectory,
              extra: {
                'packages/lifecycle/package.json': {
                  name: '@lostgradient/lifecycle',
                  private: true,
                },
                'packages/armorer/package.json': { name: 'armorer', private: true },
              },
            }),
          ),
        ).toThrow(/which is armorer's public name/);
      },
    );
  });
});

describe('COR-1229: seeding a released package the target clone does not yet carry', () => {
  /**
   * An agent-bureau clone carrying none of the three directories this decision is about.
   *
   * COR-1287 moved all three workspaces to the agent-bureau target, so this fixture moved with
   * them. It is deliberately *not* the real stevekinney/agent-bureau layout, which does carry all
   * three: the mechanism under test is what happens when the target has no manifest to read a
   * version off, and a clone that already has one exercises the other branch.
   */
  function agentBureauCloneMissingThree(): Record<string, unknown> {
    const files: Record<string, unknown> = {
      'package.json': { name: 'agent-bureau', private: true, workspaces: ['packages/*'] },
    };
    for (const name of ['bureau', 'lifecycle', 'memory', 'skills']) {
      files[`packages/${name}/package.json`] = { name, private: true, version: '9.9.9' };
    }
    return files;
  }

  test('operative, armorer, and conversationalist are each seeded at their lastPublishedVersion', async () => {
    await withTree(agentBureauCloneMissingThree(), async (targetDirectory) => {
      const plan = await planFor('agent-bureau', {
        targetDirectory,
        extra: {
          'packages/armorer/package.json': { name: 'armorer', private: true },
          'packages/conversationalist/package.json': {
            name: 'conversationalist',
            private: true,
          },
          'packages/lifecycle/package.json': { name: '@lostgradient/lifecycle', private: true },
        },
      });
      expect(parse(plan, 'packages/operative/package.json')['version']).toBe(
        operativeRecordedVersion,
      );
      expect(parse(plan, 'packages/armorer/package.json')['version']).toBe(armorerRecordedVersion);
      expect(parse(plan, 'packages/conversationalist/package.json')['version']).toBe(
        conversationalistRecordedVersion,
      );
      expect(plan.seededFromPackageMap.toSorted()).toEqual(
        ['@lostgradient/operative', 'armorer', 'conversationalist'].toSorted(),
      );
      // Lifecycle's target manifest already exists, so it is carried through at the target's own
      // `9.9.9` rather than seeded or reported as a first publish — true regardless of whatever
      // `package-map.json` records for its own `lastPublishedVersion`, since an existing target
      // manifest short-circuits both branches before either is ever consulted.
      expect(plan.seededFromPackageMap).not.toContain('@lostgradient/lifecycle');
      expect(plan.firstPublish).not.toContain('@lostgradient/lifecycle');
      expect(parse(plan, 'packages/lifecycle/package.json')['version']).toBe('9.9.9');
    });
  });
});

/**
 * `@lostgradient/playground` is excluded from the mirror outright. Exclusion is decided in
 * `package-map.json` before the layout is ever consulted, so the plan carries no deferred entry
 * and the cinder sync does not refuse on its account — while the layout entry keeps its
 * `deferred` disposition, so lifting the exclusion would bring the refusal back until the
 * placement is actually ruled on.
 */
describe('the excluded playground application', () => {
  test('is emitted nowhere and does not hold the cinder sync', async () => {
    const plan = await planFor('cinder');
    expect(plan.deferred).toEqual([]);
    expect(
      Object.keys(plan.files).filter((path) => path.startsWith('applications/')),
      'nothing is emitted for an excluded workspace',
    ).toEqual([]);
    expect(() => assertNothingDeferred(plan)).not.toThrow();
    const layout = await layoutFor('@lostgradient/playground');
    expect(layout.disposition).toBe('deferred');
  });

  test('a deferred workspace that is not excluded still refuses the sync by name', async () => {
    const layout = await layoutFor('@lostgradient/playground');
    if (layout.disposition !== 'deferred') throw new Error('the fixture entry must stay deferred');
    const plan = { deferred: [{ workspace: '@lostgradient/playground', layout }] };
    expect(() => assertNothingDeferred(plan)).toThrow(DeferredWorkspaceError);
    try {
      assertNothingDeferred(plan);
    } catch (error) {
      expect((error as Error).message).toContain('@lostgradient/playground');
      expect((error as Error).message).toContain('applications/playground');
      expect((error as Error).message).toContain('COR-1201');
    }
  });

  test('leaves every other member of its target emitted', async () => {
    const plan = await planFor('cinder');
    // `packages/operative` left this list in COR-1287, not because anything excluded it but
    // because it ships from the agent-bureau target now; the assertion below is the same one for
    // its new home.
    expect(plan.emitted.map((entry) => entry.targetDirectory).toSorted()).toEqual([
      'internal/typescript',
      'packages/components',
      'packages/markdown',
      'packages/weft-ui',
    ]);
    const agentBureau = await planFor('agent-bureau');
    expect(agentBureau.emitted.map((entry) => entry.targetDirectory).toSorted()).toEqual([
      'packages/operative',
    ]);
  });
});

describe('the plan never touches a target-owned path', () => {
  test('every target clears the guard', async () => {
    const policy = await loadTargetOwnedPolicy();
    for (const target of mirrorTargets) {
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
    'packages/markdown/package.json': { name: '@lostgradient/markdown', private: true },
    'components/cinder/package.json': {
      name: '@lostgradient/cinder',
      private: true,
      dependencies: { '@lostgradient/markdown': 'workspace:*' },
    },
  };

  test('a staged tree installs and its lockfile is frozen-install clean', async () => {
    await withTree(offline, async (root) => {
      const directory = await mkdtemp(join(tmpdir(), 'corvidae-staged-'));
      try {
        const staged = await stageTarget({ corvidaeRoot: root, target: 'cinder', directory });
        expect(staged.written).toContain('packages/components/package.json');
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

test('plans publication inputs only for dependencies that cross into the selected target', async () => {
  await withTree(
    corvidaeFixture({
      'components/cinder/package.json': {
        ...workspaces['components/cinder'],
        dependencies: { unrelated: 'catalog:' },
      },
    }),
    async (root) => {
      const plan = await planManifests({
        corvidaeRoot: root,
        target: 'weft',
        packageMap: realPackageMap,
      });
      expect(parse(plan, 'packages/weft/package.json')['name']).toBe('@lostgradient/weft');
    },
  );
});
