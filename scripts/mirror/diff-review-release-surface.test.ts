import { describe, expect, test } from 'bun:test';

import { committedPlans } from './committed-plans.ts';

/**
 * COR-510 (DR-9, local release readiness): the diff-review public surface must survive a sync
 * unaltered. `surface.test.ts` and `target-resolvability.test.ts` already prove, generically, that
 * every declared export target has real source and is covered by a package's `files` allowlist —
 * that generic proof is why `bun run test:self` already passed before this file existed. What it
 * does not do is name the specific DR-9 paths, so a future edit that silently dropped one of them
 * (a rename, a pruned subpath) would still pass every existing test. This file is that regression
 * test: it reads the same committed, locally-computed plan (`committed-plans.ts`, no network) and
 * asserts each path by name, in both the editor's and cinder's emitted manifests.
 *
 * `@lostgradient/editor`'s `peerDependencies.@lostgradient/cinder` range is asserted the same way:
 * `package-surface.json`'s `peerDependencies` is only ever a *default* — `surface.ts`'s
 * `applySurfaceToManifest` supplies it exclusively when the target's own manifest does not already
 * carry the key, per `target-owned.json`'s ruling that a peer range is target-owned packaging
 * policy. The downstream `packages/editor/package.json` already has this key, so bumping it here
 * documents the required floor and supplies it for a fresh target, but does not by itself change
 * what a real publish emits — that edit belongs to whoever cuts the release in the mirror target,
 * as recorded in `components/editor/documentation/diff-review-contract.md`.
 */

const editorManifestPath = 'packages/editor/package.json';
const cinderManifestPath = 'packages/components/package.json';

function readManifest(path: string): Record<string, unknown> {
  const raw = committedPlans.cinder.plan.files[path];
  if (raw === undefined) throw new Error(`${path} was not emitted by the committed cinder plan`);
  const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
  return JSON.parse(text) as Record<string, unknown>;
}

describe('DR-9 diff-review release surface', () => {
  test('the editor manifest exports every new and existing diff-review public path', () => {
    const manifest = readManifest(editorManifestPath);
    const exports = manifest['exports'] as Record<string, unknown>;
    const required = [
      './diff-review',
      './diff-review/styles',
      './diff-review-comments',
      './diff-review-comments/styles',
      './diff-review-state',
      './export',
      './diff-viewer',
      './review-editor',
    ];
    for (const subpath of required) {
      expect(Object.hasOwn(exports, subpath), subpath).toBe(true);
    }
  });

  test('the cinder manifest exports source-diff-viewer and its styles', () => {
    const manifest = readManifest(cinderManifestPath);
    const exports = manifest['exports'] as Record<string, unknown>;
    expect(Object.hasOwn(exports, './source-diff-viewer')).toBe(true);
    expect(Object.hasOwn(exports, './source-diff-viewer/styles')).toBe(true);
  });

  test("the editor's Cinder peer range excludes versions that predate the annotation hooks", () => {
    const manifest = readManifest(editorManifestPath);
    const peerDependencies = manifest['peerDependencies'] as Record<string, string>;
    const range = peerDependencies['@lostgradient/cinder'];
    expect(range).toBeString();
    if (range === undefined) return;
    // 0.26.2 is the last version vendored into package-surface.json before DR-3 (COR-515) added
    // SourceDiffViewer's activeFileOccurrence/onfileschange/focusFile/focusAnchor annotation hooks;
    // 0.27.0 is the minimum version DR-9 records as carrying them, pending the real publish-time
    // version assignment documented in the decision record.
    expect(Bun.semver.satisfies('0.26.2', range)).toBe(false);
    expect(Bun.semver.satisfies('0.27.0', range)).toBe(true);
  });
});
