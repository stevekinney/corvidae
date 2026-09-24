import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

// Imported from this directory's own `index.ts` (the `./review-editor` subpath
// `package-surface.json` publishes), not from `@lostgradient/editor` (the package root).
// Corvidae's own dev-time manifest resolves the package root to `src/index.ts`, whose barrel
// happens to re-export these — so a self-import from the bare specifier passes inside corvidae
// but fails once the mirror composes the *published* manifest, whose root `bun`/`browser`/`svelte`
// conditions resolve to `src/lib/index.ts` instead (`package-surface.json`'s `sourceRoot` for this
// workspace). That file's own doc comment says it deliberately mirrors upstream's narrower barrel
// and is "the public API for every source consumer" — a documented surface decision, not a bug —
// so `ReviewEditor`, `createReviewEditorState` and `buildFormDataFromValues` are real, published,
// but only under `./review-editor`, never at the root. Importing from the sibling `index.ts`
// directly resolves the same file either way and is what this suite is actually testing.
import {
  buildFormDataFromValues,
  createReviewEditorState,
  ReviewEditor as ExportedReviewEditor,
  toPersistedThreads,
  toRuntimeThreads,
} from './index.ts';
import ReviewEditor from './review-editor.svelte';

const implementationSource = await Bun.file(
  new URL('./review-editor-impl.svelte', import.meta.url).pathname,
).text();

const wrapperSource = await Bun.file(
  new URL('./review-editor.svelte', import.meta.url).pathname,
).text();

describe('review-editor original bindable regression', () => {
  /**
   * The bug: `original` was a plain prop (`original = ''`), not $bindable.
   * setState() assigned `original = state.original` locally, but the write
   * never propagated to the parent — when the parent re-rendered it reverted
   * the baseline, silently breaking diffStats/hasContentChanges/exportUnifiedDiff.
   *
   * Fix: `original = $bindable('')` in review-editor-impl.svelte (matching
   * value and threads), and `bind:original` forwarded in review-editor.svelte.
   */
  test('review-editor-impl.svelte declares original as $bindable so setState writes propagate to the parent', () => {
    // Must match: original = $bindable('') in the $props() destructure.
    // A plain `original = ''` would fail this assertion.
    expect(implementationSource).toMatch(/original\s*=\s*\$bindable\s*\(\s*['"]{2}\s*\)/);
  });

  test('review-editor.svelte destructures original as $bindable to support two-way binding from callers', () => {
    // The outer wrapper must also declare the prop as $bindable so callers
    // using bind:original on the public ReviewEditor component work correctly.
    expect(wrapperSource).toMatch(/original\s*=\s*\$bindable\s*\(\s*['"]{2}\s*\)/);
  });

  test('review-editor.svelte forwards bind:original to the implementation component', () => {
    // Without bind:original on the inner ReviewEditorImplementation, setState
    // writes to original in the impl never reach the outer wrapper's binding.
    expect(wrapperSource).toMatch(/bind:original/);
  });
});

describe('review-editor public entrypoint', () => {
  test('exports review APIs from this workspace’s own source entry', async () => {
    const packageJson = await Bun.file(`${import.meta.dir}/../../../../package.json`).json();
    // Corvidae's own dev-time convention (`scripts/workspace-contract.test.ts` pins it for every
    // workspace): `exports['.']` always points at `src/index.ts` here, in this checkout. That is
    // not the same claim as "the published package's root re-exports review-editor" — see the
    // import comment above — so this assertion is about corvidae's manifest, not about npm's.
    expect(packageJson.exports).toEqual({ '.': './src/index.ts' });
    expect(ReviewEditor).toBeDefined();
    expect(ExportedReviewEditor).toBeDefined();
    expect(createReviewEditorState).toBeTypeOf('function');
    expect(buildFormDataFromValues).toBeTypeOf('function');
    // Both directions of the persistence round trip must reach the root a
    // consumer restoring a saved ReviewState actually imports from.
    expect(toPersistedThreads).toBeTypeOf('function');
    expect(toRuntimeThreads).toBeTypeOf('function');
  });

  /**
   * Locks in the surface split the import comment above documents, so a future edit that moves
   * these exports (in either direction) fails here instead of silently reintroducing the self-import
   * defect. `src/lib/index.ts` is the file `package-surface.json`'s `exports['.']` `bun`/`browser`/
   * `svelte` conditions actually resolve to once the mirror composes the published manifest — see
   * that file's own doc comment, which calls itself "the published root entry point."
   */
  test('the published package root does not carry these APIs; only the review-editor subpath does', async () => {
    const publishedRoot = await Bun.file(
      new URL('../../index.ts', import.meta.url).pathname,
    ).text();
    for (const name of [
      'ReviewEditor',
      'createReviewEditorState',
      'buildFormDataFromValues',
      'toPersistedThreads',
      'toRuntimeThreads',
    ]) {
      expect(publishedRoot).not.toContain(name);
    }
  });

  /**
   * The actual failure this suite's self-import used to cause, reproduced directly: a package
   * whose `exports['.']` root resolves the way the mirror's *published* manifest resolves
   * `@lostgradient/editor` (root → `src/lib/index.ts`, per `package-surface.json`'s `sourceRoot`),
   * imported from a copy of this file's old import block. Bun's ESM loader refuses a named import
   * an ES module does not actually export — verified empirically (`SyntaxError: Export named 'x'
   * not found in module '...'`, Bun 1.4.2) — which is exactly what made `typecheck-published` (and
   * a real `bun run` of the emitted test) fail in the cinder target before this file's import was
   * changed to `./index.ts`. The target module here is a stub, not a copy of the real
   * `src/lib/index.ts`: the point is the *shape* of the failure (root export condition resolves to
   * a module without these names), not that file's exact content, which the test above already
   * pins against the real file.
   */
  test('reproduction: the old self-import fails against a stub matching the published root’s real shape', async () => {
    const scratch = await mkdtemp(`${tmpdir()}/editor-surface-repro-`);
    try {
      const packageDirectory = `${scratch}/node_modules/@fixture/editor-root-stub`;
      await Bun.write(
        `${packageDirectory}/package.json`,
        JSON.stringify({
          name: '@fixture/editor-root-stub',
          exports: { '.': { bun: './src/lib/index.ts', default: './src/lib/index.ts' } },
        }),
      );
      // The shape that matters: a root that exports *something*, but none of review-editor's APIs
      // — matching `src/lib/index.ts`'s real, narrower barrel without needing its transitive
      // imports to resolve too.
      await Bun.write(`${packageDirectory}/src/lib/index.ts`, 'export const anchoring = true;\n');
      await Bun.write(
        `${scratch}/old-self-import.ts`,
        "import { buildFormDataFromValues, createReviewEditorState, ReviewEditor, toPersistedThreads, toRuntimeThreads } from '@fixture/editor-root-stub';\n" +
          'console.log(buildFormDataFromValues, createReviewEditorState, ReviewEditor, toPersistedThreads, toRuntimeThreads);\n',
      );
      const result = Bun.spawnSync(['bun', 'run', 'old-self-import.ts'], { cwd: scratch });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr.toString()).toContain('not found in module');
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
});
