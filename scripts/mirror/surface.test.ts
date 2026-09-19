import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

import { discoverWorkspaces, mirrorTargets, type MirrorTarget } from './manifests.ts';
import { loadPackageSurface } from './package-surface.ts';
import { isFirstPublish } from './registry-baseline.ts';
import {
  assertPublishable,
  isExpectedPackRewrite,
  planSurface,
  SurfaceError,
  unresolvedFindings,
  unresolvedSubpaths,
  type SurfacePlan,
} from './surface.ts';
import { configurationFiles, vendoredDirectory } from './typescript-configuration.ts';

const corvidaeRoot = join(import.meta.dir, '..', '..');

/**
 * The acceptance gates, run against the committed tree rather than a fixture, because what they
 * assert is a property of the real workspaces. Nothing here reaches the network: surface parity
 * reads the committed registry baseline, and `refresh-registry-baseline.ts --verify` is the
 * separate, explicit command that checks the baseline itself against npm.
 */

const plans = new Map<MirrorTarget, SurfacePlan>();

async function planFor(target: MirrorTarget): Promise<SurfacePlan> {
  const existing = plans.get(target);
  if (existing) return existing;
  const plan = await planSurface({ corvidaeRoot, target });
  plans.set(target, plan);
  return plan;
}

/**
 * Exports targets that name source this checkout does not have. Every one is a published subpath
 * whose file the consolidation into corvidae dropped, relocated or renamed, and each needs a
 * restore-or-accept ruling before a sync can run. The list is pinned rather than tolerated: a new
 * orphan fails this test, and so does resolving one without deleting its line.
 *
 * COR-1186 predicted the ten cinder exports entries. The other eleven are new, and two of them
 * are `bin` targets rather than subpaths: a published binary is a path into the same build output
 * and breaks the same way, so it is walked alongside the exports map.
 */
const unresolvedByTarget: Record<MirrorTarget, readonly string[]> = {
  weft: [
    // upstream `src/storage/sqlite.ts`; corvidae keeps only `sqlite-key-value-queries.ts`
    '@lostgradient/weft ./storage/sqlite',
    // upstream `src/mcp/cli.ts`; corvidae renamed it `src/cli-mcp.ts`, so the binary has no source
    '@lostgradient/weft bin:weft-mcp',
  ],
  cinder: [
    // the two promoted components' shims: `src/components/experimental/` is absent here
    '@lostgradient/cinder ./experimental/json-viewer',
    '@lostgradient/cinder ./experimental/message',
    // `src/cli/` relocated to `components/cinder/scripts/knowledge/`, outside the published surface
    '@lostgradient/cinder ./knowledge',
    // six `src/styles/*.css.d.ts` declaration companions; the CSS itself resolves
    '@lostgradient/cinder ./styles',
    '@lostgradient/cinder ./styles/all',
    '@lostgradient/cinder ./styles/foundation',
    '@lostgradient/cinder ./styles/json-highlight',
    '@lostgradient/cinder ./styles/tokens',
    '@lostgradient/cinder ./styles/utilities',
    // `src/styles/base-guard.ts` is absent here
    '@lostgradient/cinder ./styles/guard',
    // the published `cinder` binary, built from the same relocated `src/cli/`
    '@lostgradient/cinder bin:cinder',
    // corvidae moved the barrel to `src/index.ts`; the published tree builds from `src/lib/index.ts`
    '@lostgradient/editor .',
    // upstream `component-runtime.ts`; corvidae renamed it `milkdown-plugin-runtime.ts`
    '@lostgradient/editor ./editor/component-runtime',
    // upstream `src/rendering/async.ts`; corvidae renamed it `render-async.ts`
    '@lostgradient/markdown ./rendering/async',
    // upstream `src/{anthropic,openai,gemini}.ts`; corvidae moved them under `src/providers/`
    '@lostgradient/operative ./anthropic',
    '@lostgradient/operative ./gemini',
    '@lostgradient/operative ./openai',
    // never published, so no parity risk, but `src/mount.ts` is absent here
    '@lostgradient/weft-ui .',
    // upstream `src/sort/`; absent here
    'conversationalist ./sort',
  ],
};

describe('surface parity', () => {
  for (const target of mirrorTargets) {
    test(`${target}: no published subpath disappears`, async () => {
      const plan = await planFor(target);
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
      const plan = await planFor(target);
      checked.push(...plan.parity.map((result) => result.publicName));
    }
    expect(checked.toSorted()).toEqual(
      Object.values(surface.packages)
        .map((entry) => entry.publicName)
        .toSorted(),
    );
  });

  test('cinder is regenerated to the full published surface, not a subset', async () => {
    const plan = await planFor('cinder');
    const result = plan.parity.find((entry) => entry.publicName === '@lostgradient/cinder');
    expect(result?.baselineVersion).toBe('0.26.2');
    expect(result?.missing).toEqual([]);
    expect(result?.added).toEqual([]);
  });

  test('a package with no published predecessor is a first publish, not a failure', async () => {
    const plan = await planFor('cinder');
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
      const plan = await planFor(target);
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
      const plan = await planFor(target);
      const surface = await loadPackageSurface();
      expect(unresolvedSubpaths(unresolvedFindings(plan, surface.packages))).toEqual(
        [...unresolvedByTarget[target]].toSorted(),
      );
    });

    test(`${target}: the gate refuses to publish while those blockers stand`, async () => {
      const plan = await planFor(target);
      const surface = await loadPackageSurface();
      expect(() => assertPublishable(plan, surface.packages)).toThrow(SurfaceError);
    });
  }

  test('a plan with nothing unresolved is publishable', async () => {
    const plan = await planFor('weft');
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
    const directories = new Map(
      workspaces.map(({ name, directory }) => [name, directory] as const),
    );
    let checked = 0;
    for (const target of mirrorTargets) {
      const plan = await planFor(target);
      for (const [workspace, entry] of Object.entries(surface.packages)) {
        const path = `${directories.get(workspace)}/package.json`;
        if (plan.files[path] === undefined) continue;
        checked += 1;
        const manifest = JSON.parse(plan.files[path] ?? '{}') as Record<string, unknown>;
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

  test('the build toolchain is inlined where the target has no catalog to hold it', async () => {
    const plan = await planFor('weft');
    const manifest = JSON.parse(plan.files['packages/weft/package.json'] ?? '{}') as {
      devDependencies?: Record<string, string>;
    };
    expect(manifest.devDependencies?.['chalk']).toMatch(/^\^/);
    expect(manifest.devDependencies?.['chalk']).not.toBe('catalog:');
  });

  test('the build toolchain stays a catalog reference where the target has a catalog', async () => {
    const plan = await planFor('cinder');
    const manifest = JSON.parse(plan.files['components/chat/package.json'] ?? '{}') as {
      devDependencies?: Record<string, string>;
    };
    expect(manifest.devDependencies?.['svelte']).toBe('catalog:');
    expect(manifest.devDependencies?.['@lostgradient/bun-plugin-svelte']).toBeString();
  });

  test('a private workspace keeps its source exports and never gains a files allowlist', async () => {
    const plan = await planFor('cinder');
    const manifest = JSON.parse(plan.files['packages/testing/package.json'] ?? '{}') as {
      exports?: unknown;
      files?: unknown;
      private?: boolean;
    };
    expect(manifest.private).toBe(true);
    expect(manifest.files).toBeUndefined();
  });
});

describe('TypeScript configuration', () => {
  test('the weft target vendors the configuration and extends it by relative path', async () => {
    const plan = await planFor('weft');
    expect(plan.typescript.vendoredInto).toEqual(['packages/weft']);
    for (const file of configurationFiles) {
      expect(plan.files[`packages/weft/${vendoredDirectory}/${file}`]).toBeString();
    }
    const emitted = JSON.parse(plan.files['packages/weft/tsconfig.json'] ?? '{}') as {
      extends?: string;
    };
    expect(emitted.extends).toBe(`./${vendoredDirectory}/library.json`);
  });

  test('the cinder target keeps the configuration as a workspace package', async () => {
    const plan = await planFor('cinder');
    expect(plan.typescript.vendoredInto).toEqual([]);
    expect(plan.files['internal/typescript/library.json']).toBeString();
    const emitted = JSON.parse(plan.files['components/cinder/tsconfig.json'] ?? '{}') as {
      extends?: string;
    };
    expect(emitted.extends).toBe('@lostgradient/typescript/browser.json');
  });

  test('COR-1188’s dropped configuration edge is the only one, and vendoring closes it', async () => {
    const weft = await planFor('weft');
    expect(weft.droppedEdges).toEqual(['@corvidae/weft -> @corvidae/typescript']);
    // `planSurface` runs `assertTypeScriptEdgeClosed`, so reaching here is the closure.
    expect(weft.typescript.vendoredInto).toContain('packages/weft');
    const cinder = await planFor('cinder');
    expect(cinder.droppedEdges).toEqual([]);
  });
});
