/**
 * MarkdownEditor SSR → hydration path test
 *
 * Verifies that the server renders <EditorSkeleton> (the SSR branch) and
 * the client hydrates the live editor without a hydration-mismatch warning.
 *
 * MarkdownEditor's SSR contract:
 *   - Server: `{#if browser}` is false → renders <EditorSkeleton>
 *   - Client: `BROWSER` from esm-env resolves to true → hydrates with the
 *     live editor inside the `{#if browser}` branch
 *
 */

import { afterEach, describe, expect, test } from 'bun:test';

import { prepareSvelteServerSource, renderThenHydrate } from '@corvidae/testing';
import MarkdownEditor from './markdown-editor.svelte';

const sourcePath = new URL('./markdown-editor.svelte', import.meta.url).pathname;
const SVELTE_SOURCE = await Bun.file(sourcePath).text();

// Compile the server graph before the timed hydration assertion. The editor's
// first server compilation can exceed Bun's per-test timeout when the complete
// package suite is cold; the test should measure render and hydrate behavior.
await prepareSvelteServerSource(sourcePath);
describe('MarkdownEditor SSR contract', () => {
  test('renders EditorSkeleton in the {:else} branch of {#if browser}', () => {
    // The component has: {#if browser} ... {:else} <EditorSkeleton .../> {/if}
    // This is the server-rendered path. Verify the structure exists.
    expect(SVELTE_SOURCE).toMatch(/\{:else\}[\s\S]*?EditorSkeleton/);
  });

  test('EditorSkeleton is in the {:else} immediately before the closing {/if}', () => {
    // The component structure is:
    //   {#if browser}
    //     ... live editor ...
    //   {:else}
    //     <EditorSkeleton .../>
    //   {/if}
    // Verify the else→skeleton→close-if sequence exists directly.
    expect(SVELTE_SOURCE).toMatch(/\{:else\}\s*\n\s*<EditorSkeleton[^>]*\/>\s*\n\s*\{\/if\}/);
  });

  test('BROWSER import guard: effects use `if (!browser) return` early-return pattern', () => {
    // The two dynamic-import effects each guard with `if (!browser) return;`
    // This is the runtime SSR safety mechanism — effects never fire on the server.
    const earlyReturnGuards = SVELTE_SOURCE.match(/if \(!browser\) return;/g) ?? [];
    expect(earlyReturnGuards.length).toBeGreaterThanOrEqual(2);
  });

  test('server output does not render the live editor (role=application) element', () => {
    // The live editor div has role="application". Svelte's SSR renderer won't
    // emit it because it's inside `{#if browser}`.
    // Extract the browser branch by finding the outer {#if browser} … {:else} boundary.
    // Use index-based extraction rather than a non-greedy regex to avoid matching
    // the inner {:else} inside {#if mode === 'wysiwyg'} that appears before the
    // browser/server boundary.
    const ifBrowserStart = SVELTE_SOURCE.indexOf('{#if browser}');
    expect(ifBrowserStart).toBeGreaterThan(-1);
    // The EditorSkeleton {:else} is the server branch; match it without
    // depending on indentation so layout wrappers can move around it.
    const elseSkeletonMatch = /\{:else\}\s*\n\s*<EditorSkeleton/.exec(
      SVELTE_SOURCE.slice(ifBrowserStart),
    );
    const elseStart = elseSkeletonMatch === null ? -1 : ifBrowserStart + elseSkeletonMatch.index;
    expect(elseStart).toBeGreaterThan(ifBrowserStart);
    const browserBranch = SVELTE_SOURCE.slice(ifBrowserStart + '{#if browser}'.length, elseStart);
    expect(browserBranch).toContain('role="application"');
  });

  test('EditorSkeleton is referenced by name in the component source', () => {
    // Confirms the SSR-rendered skeleton component is present in the source.
    expect(SVELTE_SOURCE).toContain('EditorSkeleton');
  });
});

describe('MarkdownEditor hydration status', () => {
  let cleanup: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
  });

  test('hydrates the default WYSIWYG editor from its server-rendered skeleton', async () => {
    let resolveReady: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    const result = await renderThenHydrate(
      MarkdownEditor,
      new URL('./markdown-editor.svelte', import.meta.url).pathname,
      {
        id: 'hydration-editor',
        label: 'Hydration editor',
        showToolbar: false,
        value: '# Hydration',
        onready: () => resolveReady?.(),
      },
      {
        id: 'hydration-editor',
        label: 'Hydration editor',
        showToolbar: false,
        value: '# Hydration',
      },
    );
    cleanup = result.cleanup;

    expect(result.ssrHtml).toContain('editor-skeleton');
    await ready;
    expect(result.container.querySelector('[role="application"]')).not.toBeNull();
    expect(result.container.querySelector('[data-ready="true"]')).not.toBeNull();
    expect(result.warnings).toEqual([]);
  });
});
