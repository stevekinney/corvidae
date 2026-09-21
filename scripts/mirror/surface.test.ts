import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

import { committedPlans, corvidaeRoot } from './committed-plans.ts';
import { layoutFor } from './layout-map.ts';
import {
  assertNothingDeferred,
  discoverWorkspaces,
  mirrorTargets,
  type MirrorTarget,
} from './manifests.ts';
import { loadPackageSurface } from './package-surface.ts';
import { isFirstPublish } from './registry-baseline.ts';
import { nonSourceNames, nonSourcePrefixes } from './source.ts';
import {
  assertPublishable,
  isExpectedPackRewrite,
  SurfaceError,
  unresolvedFindings,
  unresolvedSubpaths,
  type SurfacePlan,
} from './surface.ts';
import { assertWritablePaths, loadTargetOwnedPolicy } from './target-owned.ts';
import { configurationFiles, vendoredDirectory } from './typescript-configuration.ts';

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
  cinder: [
    // The two promoted components' deprecated shims: `src/components/experimental/` is absent
    // here, and only the bare component entry narrows — each one's `/schema`, `/variables` and
    // `/styles` facets resolve against the promoted component. Accepted rather than restored.
    '@lostgradient/cinder ./experimental/json-viewer',
    '@lostgradient/cinder ./experimental/message',
  ],
};

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
    expect(result?.baselineVersion).toBe('0.26.2');
    expect(result?.missing).toEqual([]);
    expect(result?.added).toEqual([]);
  });

  test('a package with no published predecessor is a first publish, not a failure', () => {
    const { plan } = committedPlans.cinder;
    const results = plan.parity.filter(isFirstPublish);
    expect(results.map((result) => result.publicName).toSorted()).toEqual([
      '@lostgradient/cryptography',
      '@lostgradient/embeddings',
      '@lostgradient/lifecycle',
      '@lostgradient/tool-protocol',
      '@lostgradient/weft-ui',
    ]);
    for (const result of results) {
      expect(result.missing, `${result.publicName} cannot narrow what was never published`).toEqual(
        [],
      );
      expect(result.added.length, `${result.publicName} proposes no subpaths`).toBeGreaterThan(0);
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

  test('the excluded chat-room application is emitted nowhere and holds nothing up', () => {
    // `@lostgradient/chat-room` is excluded from the mirror by owner ruling (2026-09-21), decided in
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
    // Only the two development-only workspaces. bureau, memory and skills were excluded from
    // the mirror entirely by the repository owner once it was clear that `private-workspace`
    // still ships source to the *public* mirror repository, which would have made three
    // never-published packages public for the first time.
    expect(plan.privateWorkspaces.map((entry) => entry.publicName).toSorted()).toEqual([
      '@lostgradient/testing',
      '@lostgradient/typescript',
    ]);
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
