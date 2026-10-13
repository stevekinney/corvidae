import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

import { committedPlans, corvidaeRoot } from './committed-plans.ts';
import { layoutFor } from './layout-map.ts';
import { assertNothingDeferred, discoverWorkspaces } from './manifests.ts';
import { loadPackageMap } from './package-map.ts';
import { checkPublishedImportGraph, loadPackageSurface } from './package-surface.ts';
import { isFirstPublish } from './registry-baseline.ts';
import { nonSourceNames, nonSourcePrefixes } from './source.ts';
import {
  assertPublishable,
  isExpectedPackRewrite,
  privateBuildDependencies,
  SurfaceError,
  unresolvedFindings,
  unresolvedSubpaths,
  type SurfacePlan,
} from './surface.ts';

import { mirrorTargets, targetFor, type MirrorTarget } from './target-definitions.ts';
import { assertWritablePaths, loadTargetOwnedPolicy } from './target-owned.ts';
import { configurationFiles, vendoredDirectory } from './typescript-configuration.ts';

test('private build dependencies include development edges only to other private builders', () => {
  const manifest = {
    dependencies: { '@lostgradient/memory': 'workspace:*' },
    devDependencies: {
      '@lostgradient/skills': 'workspace:*',
      '@lostgradient/typescript': 'workspace:*',
    },
    peerDependencies: { '@lostgradient/bureau': 'workspace:*' },
  };
  expect(
    privateBuildDependencies(manifest, new Set(['@lostgradient/memory', '@lostgradient/skills'])),
  ).toEqual(['@lostgradient/memory', '@lostgradient/skills']);
});

/**
 * The acceptance gates, run against the committed tree rather than a fixture, because what they
 * assert is a property of the real workspaces. Nothing here reaches the network: surface parity
 * reads the committed registry baseline, and `refresh-registry-baseline.ts --verify` is the
 * separate, explicit command that checks the baseline itself against npm.
 *
 * Both plans come from `committed-plans.ts`, built once for the process when that module loads
 * and shared with `target-resolvability.test.ts` and `source.test.ts`. A test body that built one
 * would be several seconds of planning measured against bun's per-test timeout, which is a
 * failure about the machine rather than about the tree.
 */

/**
 * One plan entry as text. Plan contents are bytes or text since the transform started emitting
 * source, and every file these tests read is a manifest or a tsconfig, which is always text.
 */
function planText(plan: SurfacePlan, path: string): string {
  const contents = plan.files[path];
  if (contents === undefined) return '{}';
  return typeof contents === 'string' ? contents : new TextDecoder().decode(contents);
}

/**
 * Exports targets that name source this checkout does not have. Every one is a published subpath
 * whose file the consolidation into corvidae dropped, relocated or renamed, and each needs a
 * restore-or-accept ruling before a sync can run. The list is pinned rather than tolerated: a new
 * orphan fails this test, and so does resolving one without deleting its line.
 *
 * COR-1189's walk found twenty-one, two of them `bin` targets rather than subpaths — a published
 * binary is a path into the same build output and breaks the same way, so it is walked alongside
 * the exports map. Nineteen were restored: each now has a source file at the path the emitted
 * manifest names, re-exporting whatever corvidae renamed or relocated the implementation to. The
 * two below are the accepted narrowings, and they are the only entries left.
 */
const unresolvedByTarget: Record<MirrorTarget, readonly string[]> = {
  weft: [],
  // COR-1287: the agent-bureau target's ten packages each resolve every subpath their emitted
  // manifest names, so it joins weft with nothing accepted.
  'agent-bureau': [],
  // COR-1196: the two promoted components' deprecated shims were once accepted here as
  // unresolved, which left the cinder plan unpublishable: stageSurface's assertPublishable refused
  // it outright. Published cinder 0.26.2 exports both `./experimental/*` subpaths, so dropping them
  // would break consumers; the shims now live in corvidae and the target joins the others.
  cinder: [],
};

describe('published dependency edges', () => {
  /**
   * COR-1289: `dependsOn` is what orders verification, and it is only allowed to name published
   * packages of the same target. Asserted over the committed tree rather than a fixture because
   * the narrowing it pins is about real membership: `planManifests` records every surviving
   * `workspace:*` edge, including edges to private workspaces, and a private workspace is never
   * built into a `dist/` for anything to wait on. Also asserted against `intraTargetEdges`, so
   * `dependsOn` cannot acquire an edge the manifest half never recorded.
   */
  for (const target of mirrorTargets) {
    test(`${target}: dependsOn names only published packages the transform recorded an edge to`, () => {
      const { plan } = committedPlans[target];
      const publishedNames = new Set(plan.published.map((entry) => entry.publicName));
      for (const entry of plan.published) {
        const recorded = new Set(plan.intraTargetEdges.get(entry.workspace) ?? []);
        expect([
          entry.publicName,
          entry.dependsOn.filter((name) => !publishedNames.has(name)),
        ]).toEqual([entry.publicName, []]);
        expect([entry.publicName, entry.dependsOn.filter((name) => !recorded.has(name))]).toEqual([
          entry.publicName,
          [],
        ]);
      }
    });
  }

  /**
   * The defect's own shape, on the tree that has it: `chat` depends on two packages that both come
   * after it in discovery order. Asserting the edges rather than the resulting step order keeps
   * this test about what `planSurface` produces; `verify-steps.test.ts` owns the ordering itself.
   */
  test('cinder’s chat records its edges to cinder and markdown', () => {
    const { plan } = committedPlans.cinder;
    const chat = plan.published.find((entry) => entry.publicName === '@lostgradient/chat');
    expect(chat?.dependsOn).toContain('@lostgradient/cinder');
    expect(chat?.dependsOn).toContain('@lostgradient/markdown');
  });
});

function textOf(content: string | Uint8Array | undefined): string {
  if (content === undefined) throw new Error('expected the plan to emit this file');
  return typeof content === 'string' ? content : new TextDecoder().decode(content);
}

describe('the token runtime subpath (COR-491)', () => {
  const { plan } = committedPlans.cinder;
  const cinder = plan.published.find((entry) => entry.publicName === '@lostgradient/cinder')!;
  const packageRoot = join(corvidaeRoot, 'components', 'cinder');
  const manifest = JSON.parse(plan.files['packages/components/package.json'] as string) as {
    version: string;
    dependencies: Record<string, string>;
  };
  const dependencies = new Set(Object.keys(manifest.dependencies));

  test('is exported with source for the browser and import conditions', () => {
    expect(cinder.exports['./tokens/runtime']).toMatchObject({
      browser: './src/tokens/runtime/index.ts',
      import: './src/tokens/runtime/index.ts',
      svelte: './src/tokens/runtime/index.ts',
    });
  });

  test('every file its source import graph reaches is published, and every package it imports is declared', () => {
    expect(
      checkPublishedImportGraph({
        publicName: cinder.publicName,
        exports: cinder.exports,
        files: cinder.files,
        packageRoot,
        dependencies,
        subpaths: ['./tokens/runtime'],
      }),
    ).toEqual([]);
    expect(dependencies.has('postcss-value-parser')).toBe(true);
  });

  test('reaches the generated validators, base digest, catalogue and bundled token sources', () => {
    const shipped = (path: string) =>
      cinder.files.length > 0 && Bun.file(join(packageRoot, path)).size > 0;
    for (const path of [
      'src/tokens/runtime/format-validator.generated.js',
      'src/tokens/runtime/resolver-validator.generated.js',
      'src/tokens/runtime/base-corpus.generated.ts',
      'src/tokens/runtime/authoring-catalogue.generated.ts',
      'src/tokens/runtime/package-version.generated.ts',
      'src/tokens/sets/foundation.tokens.json',
      'src/tokens/cinder.resolver.json',
    ]) {
      expect(shipped(path), path).toBe(true);
    }
    expect(cinder.files).toContain('src/tokens/runtime/**/*.js');
  });

  test('the gate fails when a reached file is not published or a package is undeclared (control)', () => {
    const options = {
      publicName: cinder.publicName,
      exports: cinder.exports,
      packageRoot,
      subpaths: ['./tokens/runtime'],
    };
    const withoutValidators = checkPublishedImportGraph({
      ...options,
      files: cinder.files.filter((pattern) => pattern !== 'src/tokens/runtime/**/*.js'),
      dependencies,
    });
    expect(withoutValidators.map((finding) => finding.reached)).toEqual(
      expect.arrayContaining([
        'src/tokens/runtime/format-validator.generated.js',
        'src/tokens/runtime/resolver-validator.generated.js',
      ]),
    );
    expect(withoutValidators.every((finding) => finding.problem === 'not-shipped')).toBe(true);
    const withoutParser = checkPublishedImportGraph({
      ...options,
      files: cinder.files,
      dependencies: new Set([...dependencies].filter((name) => name !== 'postcss-value-parser')),
    });
    expect(withoutParser.length).toBeGreaterThan(0);
    expect(
      withoutParser.every(
        (finding) =>
          finding.reached === 'postcss-value-parser' && finding.problem === 'undeclared-dependency',
      ),
    ).toBe(true);
  });

  test('the mirrored package carries the composed manifest version, not the workspace sentinel', async () => {
    const mirrored = textOf(
      plan.files['packages/components/src/tokens/runtime/package-version.generated.ts'],
    );
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(mirrored).toContain(`export const VERSION = '${manifest.version}';`);
    expect(mirrored).not.toContain("'workspace'");
    const source = await Bun.file(
      join(packageRoot, 'src/tokens/runtime/package-version.generated.ts'),
    ).text();
    expect(source).toContain("export const VERSION = 'workspace';");
  });

  test('the substitution cannot change the base source digest', async () => {
    const digestFile = 'src/tokens/runtime/base-corpus.generated.ts';
    expect(textOf(plan.files[`packages/components/${digestFile}`])).toBe(
      await Bun.file(join(packageRoot, digestFile)).text(),
    );
  });
});

describe('surface parity', () => {
  for (const target of mirrorTargets) {
    test(`${target}: no published subpath disappears`, () => {
      const { plan } = committedPlans[target];
      const narrowed = plan.parity.filter((result) => result.missing.length > 0);
      expect(
        narrowed.map((result) => `${result.publicName}: ${result.missing.join(', ')}`),
      ).toEqual([]);
    });
  }

  test('checks every published package across the two targets exactly once', async () => {
    const surface = await loadPackageSurface();
    const checked: string[] = [];
    for (const target of mirrorTargets) {
      const { plan } = committedPlans[target];
      checked.push(...plan.parity.map((result) => result.publicName));
    }
    expect(checked.toSorted()).toEqual(
      Object.values(surface.packages)
        .map((entry) => entry.publicName)
        .toSorted(),
    );
  });

  test('cinder is regenerated to the full published surface, not a subset', () => {
    const { plan } = committedPlans.cinder;
    const result = plan.parity.find((entry) => entry.publicName === '@lostgradient/cinder');
    expect(result?.baselineVersion).toBe('0.27.0');
    expect(result?.missing).toEqual([]);
    // `./tokens/runtime` (COR-491) is the first subpath the registry baseline has not seen; it
    // joins the baseline when that version is published and the baseline is refreshed.
    expect(result?.added).toEqual(['./tokens/runtime']);
  });

  /**
   * COR-1287 split the `runtime-closure-forced` packages that had never published across two
   * targets, all four landing in agent-bureau with the rest of that repository's source.
   * `@lostgradient/weft-ui` used to be cinder's one first-publish member; COR-1196 moved it to
   * `private-workspace`, which never reaches `plan.parity` at all (only a `publish-as` workspace
   * does), so cinder now has none. Asserted per target rather than merged back into one list,
   * because a package appearing under the wrong target here is precisely the routing mistake the
   * member map exists to prevent, and a merged list would hide it.
   *
   * The expected set is derived from the committed `package-map.json` rather than written as a
   * literal: COR-1198 published all four of agent-bureau's `runtime-closure-forced` packages
   * (`@lostgradient/cryptography`, `@lostgradient/embeddings`, `@lostgradient/lifecycle`,
   * `@lostgradient/tool-protocol`), so a literal list turned every one of those publishes into a
   * test edit here — the same trap `weftRecordedVersion` in manifests.test.ts avoids for the same
   * reason. `targetFor` is the hand-authored routing table (`membersOf`), independent of
   * `isFirstPublish`/parity, so comparing its per-target grouping against what `committedPlans`
   * actually produced still catches a workspace routed to, or emitted from, the wrong target.
   */
  test('a package with no published predecessor is a first publish, not a failure', async () => {
    const map = await loadPackageMap();
    const expectedFirstPublishNames = (target: MirrorTarget): string[] =>
      Object.entries(map.workspaces)
        .filter(
          ([workspace, entry]) =>
            entry.disposition === 'publish-as' &&
            entry.lastPublishedVersion === null &&
            targetFor(workspace) === target,
        )
        .map(([, entry]) => (entry.disposition === 'publish-as' ? entry.name : ''))
        .toSorted();
    const firstPublishNames = (target: MirrorTarget): string[] =>
      committedPlans[target].plan.parity
        .filter(isFirstPublish)
        .map((result) => result.publicName)
        .toSorted();
    for (const target of mirrorTargets) {
      expect(firstPublishNames(target)).toEqual(expectedFirstPublishNames(target));
    }

    for (const target of mirrorTargets) {
      for (const result of committedPlans[target].plan.parity.filter(isFirstPublish)) {
        expect(
          result.missing,
          `${result.publicName} cannot narrow what was never published`,
        ).toEqual([]);
        expect(result.added.length, `${result.publicName} proposes no subpaths`).toBeGreaterThan(0);
      }
    }
  });
});

describe('target coverage', () => {
  for (const target of mirrorTargets) {
    test(`${target}: the only unpublished targets are the ones the pack script rewrites`, async () => {
      const { plan } = committedPlans[target];
      const surface = await loadPackageSurface();
      const byPublicName = new Map(
        Object.values(surface.packages).map((entry) => [entry.publicName, entry] as const),
      );
      const unexplained = plan.coverage.filter((finding) => {
        if (finding.problem !== 'not-shipped') return false;
        const entry = byPublicName.get(finding.publicName);
        return entry === undefined || !isExpectedPackRewrite(finding, entry);
      });
      expect(describeUnexpected(unexplained)).toEqual([]);
    });

    test(`${target}: exports targets with no source are exactly the known blockers`, async () => {
      const { plan } = committedPlans[target];
      const surface = await loadPackageSurface();
      expect(unresolvedSubpaths(unresolvedFindings(plan, surface.packages))).toEqual(
        [...unresolvedByTarget[target]].toSorted(),
      );
    });

    test(`${target}: the gate refuses to publish exactly while a blocker stands`, async () => {
      const { plan } = committedPlans[target];
      const surface = await loadPackageSurface();
      const blockers = unresolvedByTarget[target];
      let thrown: unknown;
      try {
        assertPublishable(plan, surface.packages);
      } catch (error) {
        thrown = error;
      }
      if (blockers.length === 0) {
        // Every restore landed, so nothing in this target is unresolved and the gate has no
        // account to refuse on. A parity narrowing would still throw, which is the point of
        // asserting the absence rather than skipping the target.
        expect(thrown).toBeUndefined();
        return;
      }
      expect(thrown).toBeInstanceOf(SurfaceError);
      for (const blocker of blockers) {
        expect((thrown as SurfaceError).message).toContain(blocker);
      }
    });
  }

  test('a plan with nothing unresolved is publishable', () => {
    const { plan } = committedPlans.weft;
    expect(() => assertPublishable({ ...plan, coverage: [], parity: [] }, {})).not.toThrow();
  });
});

/**
 * COR-1274: the subpaths whose `types` condition is authored separately from a runtime module,
 * per target. Pinned rather than counted so an entry that starts or stops qualifying is a visible
 * change: weft's SQLite subpath is the one that shipped unimportable, and cinder's six are
 * stylesheet stubs whose `export {}` declares nothing a `.css` file could fail to provide.
 */
const declarationSubpathsByTarget: Readonly<Record<MirrorTarget, readonly string[]>> = {
  weft: ['@lostgradient/weft ./storage/sqlite'],
  cinder: [
    '@lostgradient/cinder ./styles',
    '@lostgradient/cinder ./styles/all',
    '@lostgradient/cinder ./styles/foundation',
    '@lostgradient/cinder ./styles/json-highlight',
    '@lostgradient/cinder ./styles/tokens',
    '@lostgradient/cinder ./styles/utilities',
  ],
  'agent-bureau': [],
};

describe('declaration agreement', () => {
  for (const target of mirrorTargets) {
    test(`${target}: every separately authored declaration is delivered by its runtime modules`, () => {
      const { plan } = committedPlans[target];
      const examined = plan.declarations.flatMap((result) =>
        result.examined.map((subpath) => `${result.publicName} ${subpath}`),
      );
      expect(examined.toSorted()).toEqual([...declarationSubpathsByTarget[target]].toSorted());
      expect(plan.declarations.flatMap((result) => result.findings)).toEqual([]);
      // One result per published package, so a package the check skipped would show up here.
      expect(plan.declarations.map((result) => result.publicName)).toEqual(
        plan.published.map((entry) => entry.publicName),
      );
    });
  }

  test('a declared value its runtime module lacks refuses the plan', () => {
    const { plan } = committedPlans.weft;
    const finding = {
      publicName: '@lostgradient/weft',
      subpath: './storage/sqlite',
      declaration: 'src/storage/sqlite.ts',
      runtime: 'src/storage/bun-sql.ts',
      missing: ['SQLiteStorage'],
    };
    const refused = {
      ...plan,
      coverage: [],
      parity: [],
      declarations: [
        { publicName: finding.publicName, examined: [finding.subpath], findings: [finding] },
      ],
    };
    expect(() => assertPublishable(refused, {})).toThrow(SurfaceError);
    expect(() => assertPublishable(refused, {})).toThrow(
      '@lostgradient/weft ./storage/sqlite: src/storage/sqlite.ts declares SQLiteStorage, which src/storage/bun-sql.ts does not export',
    );
  });
});

function describeUnexpected(
  findings: readonly { publicName: string; subpath: string }[],
): string[] {
  return findings.map((finding) => `${finding.publicName} ${finding.subpath}`);
}

describe('emitted manifests', () => {
  test('every published package receives an exports map, a files allowlist and a build', async () => {
    const surface = await loadPackageSurface();
    const workspaces = await discoverWorkspaces(corvidaeRoot);
    // The target's directory for each workspace, not corvidae's: `components/chat` is emitted as
    // `packages/chat`, so looking the manifest up by corvidae's path would find nothing and the
    // `checked` count below would be the assertion that noticed.
    const directories = new Map(
      await Promise.all(
        workspaces.map(async ({ name }) => {
          const layout = await layoutFor(name);
          return [
            name,
            layout.disposition === 'emit' ? layout.targetDirectory : undefined,
          ] as const;
        }),
      ),
    );
    let checked = 0;
    for (const target of mirrorTargets) {
      const { plan } = committedPlans[target];
      for (const [workspace, entry] of Object.entries(surface.packages)) {
        const path = `${directories.get(workspace)}/package.json`;
        if (plan.files[path] === undefined) continue;
        checked += 1;
        const manifest = JSON.parse(planText(plan, path)) as Record<string, unknown>;
        expect(
          Object.keys(manifest['exports'] ?? {}).length,
          `${workspace} exports`,
        ).toBeGreaterThan(0);
        expect(manifest['files'], `${workspace} files`).toBeArray();
        expect(
          (manifest['scripts'] as Record<string, string> | undefined)?.['build'],
          `${workspace} build script`,
        ).toBe(entry.build.scripts['build'] ?? '');
      }
    }
    expect(checked, 'no published manifest was inspected').toBe(
      Object.keys(surface.packages).length,
    );
  });

  test('the build toolchain is inlined where the target has no catalog to hold it', () => {
    const { plan } = committedPlans.weft;
    const manifest = JSON.parse(planText(plan, 'packages/weft/package.json')) as {
      devDependencies?: Record<string, string>;
    };
    expect(manifest.devDependencies?.['chalk']).toMatch(/^\^/);
    expect(manifest.devDependencies?.['chalk']).not.toBe('catalog:');
  });

  test('the build toolchain stays a catalog reference where the target has a catalog', () => {
    const { plan } = committedPlans.cinder;
    const manifest = JSON.parse(planText(plan, 'packages/chat/package.json')) as {
      devDependencies?: Record<string, string>;
    };
    expect(manifest.devDependencies?.['svelte']).toBe('catalog:');
    expect(manifest.devDependencies?.['@lostgradient/bun-plugin-svelte']).toBeString();
  });

  test('a private workspace keeps its source exports and never gains a files allowlist', () => {
    const { plan } = committedPlans.cinder;
    const manifest = JSON.parse(planText(plan, 'packages/testing/package.json')) as {
      exports?: unknown;
      files?: unknown;
      private?: boolean;
    };
    expect(manifest.private).toBe(true);
    expect(manifest.files).toBeUndefined();
  });
});

describe('TypeScript configuration', () => {
  test('the weft target vendors the configuration and extends it by relative path', () => {
    const { plan } = committedPlans.weft;
    expect(plan.typescript.vendoredInto).toEqual(['packages/weft']);
    for (const file of configurationFiles) {
      expect(plan.files[`packages/weft/${vendoredDirectory}/${file}`]).toBeString();
    }
    const emitted = JSON.parse(planText(plan, 'packages/weft/tsconfig.json')) as {
      extends?: string;
    };
    expect(emitted.extends).toBe(`./${vendoredDirectory}/library.json`);
  });

  test('the cinder target keeps the configuration as a workspace package', () => {
    const { plan } = committedPlans.cinder;
    expect(plan.typescript.vendoredInto).toEqual([]);
    expect(plan.files['internal/typescript/library.json']).toBeString();
    const emitted = JSON.parse(planText(plan, 'packages/components/tsconfig.json')) as {
      extends?: string;
    };
    expect(emitted.extends).toBe('@lostgradient/typescript/browser.json');
  });

  test('COR-1188’s dropped configuration edge is the only one, and vendoring closes it', () => {
    const weft = committedPlans.weft.plan;
    expect(weft.droppedEdges).toEqual(['@lostgradient/weft -> @lostgradient/typescript']);
    // `planSurface` runs `assertTypeScriptEdgeClosed`, so reaching here is the closure.
    expect(weft.typescript.vendoredInto).toContain('packages/weft');
    const cinder = committedPlans.cinder.plan;
    expect(cinder.droppedEdges).toEqual([]);
  });
});

describe('emitted source', () => {
  test('every workspace the target receives brings its source, at the remapped path', async () => {
    const { plan } = committedPlans.cinder;
    for (const workspace of plan.emitted) {
      const emitted = Object.keys(plan.files).filter((path) =>
        path.startsWith(`${workspace.targetDirectory}/src/`),
      );
      // `@lostgradient/typescript` is three JSON files and no source tree, which is why this asks for
      // a source tree only where corvidae has one.
      const carries = await Bun.file(
        join(corvidaeRoot, workspace.corvidaeDirectory, 'src', 'index.ts'),
      ).exists();
      expect(emitted.length > 0, `${workspace.workspace} source`).toBe(carries);
    }
    // The remap is what these paths are: corvidae keeps all four under `components/`.
    for (const path of [
      'packages/components/src/index.ts',
      'packages/chat/src/lib/index.ts',
      'packages/editor/src/lib/index.ts',
      'packages/weft-ui/src/index.ts',
    ]) {
      expect(plan.files[path], path).toBeDefined();
    }
    expect(
      Object.keys(plan.files).filter((path) => path.startsWith('components/')),
      'corvidae’s own directory is never a target path',
    ).toEqual([]);
  });

  test('the target’s binaries keep the executable bit their source carries', () => {
    const { plan } = committedPlans.weft;
    expect(plan.source.executable).toEqual([
      'packages/weft/src/cli-main.ts',
      'packages/weft/src/cli-mcp.ts',
    ]);
  });

  test('the excluded desktop application is emitted nowhere and holds nothing up', () => {
    // `@lostgradient/desktop` is excluded from the mirror by owner ruling (2026-09-21), decided in
    // `package-map.json` before the layout is consulted, so the committed cinder plan carries no
    // deferred workspace and nothing lands under the target's application or lab directories.
    const { plan } = committedPlans.cinder;
    expect(plan.deferred).toEqual([]);
    expect(
      Object.keys(plan.files).filter(
        (path) => path.startsWith('applications/') || path.startsWith('labs/'),
      ),
    ).toEqual([]);
    expect(() => assertNothingDeferred(plan)).not.toThrow();
  });

  test('every emitted private workspace is checked by something', () => {
    const { plan } = committedPlans.cinder;
    for (const entry of plan.privateWorkspaces) {
      // `verifyTarget` runs `typecheck` for each of these, and throws for one that emits
      // TypeScript without declaring the script. Nothing here may be in that state.
      expect([entry.publicName, entry.emitsTypeScript && !entry.typechecks]).toEqual([
        entry.publicName,
        false,
      ]);
    }
    // The two development-only workspaces, plus `@lostgradient/weft-ui` since COR-1196 ruled it
    // held back for API design rather than published. bureau, memory and skills were excluded
    // from the mirror entirely by the repository owner once it was clear that `private-workspace`
    // still ships source to the *public* mirror repository, which would have made three
    // never-published packages public for the first time.
    expect(plan.privateWorkspaces.map((entry) => entry.publicName).toSorted()).toEqual([
      '@lostgradient/testing',
      '@lostgradient/typescript',
      '@lostgradient/weft-ui',
    ]);
  });

  /**
   * COR-1196: the ruling itself, pinned directly rather than left to be inferred from the private
   * workspace count above. `package-map.json` is what a sync reads to decide this, but the plan is
   * what a downstream consumer (`verify-steps.ts`, the mirror-verify workflow) actually sees, so
   * this asserts the ruling took effect there too.
   */
  test('weft-ui ships as unpublished source, not a published package', () => {
    const { plan } = committedPlans.cinder;
    expect(plan.published.map((entry) => entry.publicName)).not.toContain('@lostgradient/weft-ui');
    expect(plan.privateWorkspaces.map((entry) => entry.publicName)).toContain(
      '@lostgradient/weft-ui',
    );
  });
});

describe('the plan and the guard on the committed tree', () => {
  test('nothing the transform would write is a path the target owns', async () => {
    // The real tree is what makes this worth asserting: corvidae carries three
    // `coverage-ratchet.json` files, an `AGENTS.md` in every workspace, a `.gitignore` and
    // `CHANGELOG`-shaped files, all of which match a target-owned glob. The source filter is what
    // keeps them out of the plan and the guard is what would refuse them if it ever stopped
    // doing so; this is the two mechanisms agreeing on the committed tree rather than a fixture.
    const policy = await loadTargetOwnedPolicy();
    for (const target of mirrorTargets) {
      const { plan } = committedPlans[target];
      expect(() =>
        assertWritablePaths({ policy, target, paths: Object.keys(plan.files) }),
      ).not.toThrow();
    }
  });

  test('the non-source filter covers exactly the target-owned globs that reach inside a tree', async () => {
    const policy = await loadTargetOwnedPolicy();
    // A `**/`-rooted glob is the only kind that can match a path inside a workspace's `src/`;
    // every other entry is anchored at the repository or a package root, where no source lives.
    const reaching = policy.paths
      .filter((entry) => entry.glob.startsWith('**/'))
      .map((entry) => entry.glob.slice('**/'.length))
      .toSorted();
    const filtered = [
      ...nonSourceNames,
      ...nonSourcePrefixes.map((prefix) => `${prefix}*`),
    ].toSorted();
    expect(filtered).toEqual(reaching);
  });
});

/**
 * COR-1192. The first tagged release failed at `bun run prepack` on the real target: the sync
 * had put `prepack: bun run scripts/run-gates.ts prepack` back onto a manifest the cleanup pull
 * request had trimmed, because `package-surface.json` recorded that script and
 * `applySurfaceToManifest` writes the recorded scripts over the target's block. What the surface
 * records is therefore a ruling about the published package, and it must never name a file the
 * same policy retires.
 */
describe('emitted scripts and retired files', () => {
  test('no script the surface records for a published package names a path its target retires', async () => {
    // The surface's `build.scripts` are written over the target's block on every sync, so they are
    // the ruling about the published package's scripts. (A committed plan with no target clone
    // also carries corvidae's own `lint`/`test` scripts, which name corvidae's gates; a real sync
    // keeps the target's block for those, so they are not what this test judges.)
    const policy = await loadTargetOwnedPolicy();
    const surface = await loadPackageSurface();
    for (const [workspace, entry] of Object.entries(surface.packages)) {
      const target = targetFor(workspace);
      const retiredNames = policy.retired.entries
        .filter((retired) => retired.target === target)
        .map((retired) => retired.directory.split('/').at(-1) ?? '');
      for (const [name, command] of Object.entries(entry.build.scripts)) {
        for (const retired of retiredNames) {
          expect(command, `${target} ${workspace} ${name}`).not.toContain(retired);
        }
      }
    }
  });

  test('weft’s prepack is the trimmed release gate and prepublishOnly is gone', () => {
    const { plan } = committedPlans.weft;
    const manifest = JSON.parse(String(plan.files['packages/weft/package.json']));
    expect(manifest.scripts.prepack).toBe(
      'bun run build && bun run verify:exports && bun run verify:portability && bun run validate:package-consumers',
    );
    expect(manifest.scripts.prepublishOnly).toBeUndefined();
  });
});
