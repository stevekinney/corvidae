/// <reference lib="dom" />

/**
 * Markdown SSR-safety contract.
 *
 * The Markdown component renders its content through `markdown.svelte`,
 * which is where `@lostgradient/markdown`'s rendering pipeline (shiki/rehype/katex)
 * enters the component tree. That pipeline is SSR-safe at module-evaluation
 * time (see `packages/markdown/src/ssr-import.integration.test.ts`), so the only remaining
 * SSR concern is that the *runtime* render — which calls
 * `renderMarkdownWithMath` and touches the DOM via `{@html}` — must not run on
 * the server.
 *
 * markdown.svelte satisfies this by:
 *   - requesting the cached rendering-pipeline import inside a `$effect`, never
 *     at module evaluation — `$effect` bodies never run during SSR, so the import
 *     is never evaluated on the server, and the heavy rendering graph stays out
 *     of the SSR path; and
 *   - rendering a raw-text fallback (`<p>{content}</p>`) in the `{:else}`
 *     branch, so the server emits the message text without throwing and the
 *     client swaps in formatted HTML after hydration.
 *
 * Unlike `@lostgradient/editor`'s `markdown-editor.svelte` — whose live-editor
 * branch pulls in ProseMirror runtime and so cannot be exercised by
 * `renderThenHydrate` (the recompiled SSR module resolves that import
 * against a missing "node"-conditional dist, producing `effect_orphan`) —
 * markdown.svelte has no static markdown/editor import.
 * Its only heavy dependency is reached through the cached loader inside an
 * `$effect`, which never runs during SSR. We therefore verify the SSR contract by
 * actually rendering on the server via `renderThenHydrate` and asserting on the
 * produced markup, the same pattern `portal.integration.test.ts` uses for its SSR-omission
 * contract.
 */

import { describe, expect, test } from 'bun:test';

import {
  hydrateServerHtml,
  prepareSvelteServerSource,
  renderSvelteOnServer,
} from '@lostgradient/testing';
import { tick } from 'svelte';

const markdownModule = await import('./markdown.svelte');
const { default: Markdown, segmentRenderedMarkdown } = markdownModule;

const sourcePath = new URL('./markdown.svelte', import.meta.url).pathname;

await prepareSvelteServerSource(sourcePath);

// Server rendering is a real DOM-free process, so each distinct message renders once here at module
// scope, off the per-test clock; the tests hydrate the recorded HTML and assert.
const contents = ['hello world', '**bold**', '<img src=x onError=alert(1)>'] as const;
const serverHtml = new Map(
  await Promise.all(
    contents.map(
      async (content) => [content, await renderSvelteOnServer(sourcePath, { content })] as const,
    ),
  ),
);

async function hydrateMessage(content: (typeof contents)[number]) {
  const result = hydrateServerHtml(Markdown, serverHtml.get(content) ?? '', { content });
  await tick();
  return result;
}

describe('Markdown SSR contract', () => {
  test('preserves ancestors while extracting nested override placeholders', () => {
    const segments = segmentRenderedMarkdown(
      '<blockquote><p>Before</p><cinder-markdown-node data-cinder-markdown-kind="table" data-cinder-markdown-index="4"><table><tbody><tr><td>Cell</td></tr></tbody></table></cinder-markdown-node></blockquote>',
      document,
    );

    expect(segments).toHaveLength(1);
    expect(segments[0]?.kind).toBe('element');
    if (segments[0]?.kind !== 'element') throw new Error('Expected a preserved blockquote');
    expect(segments[0].tag).toBe('blockquote');
    expect(segments[0].children.some((child) => child.kind === 'node')).toBe(true);
    expect(JSON.stringify(segments)).not.toContain('<cinder-markdown-node');
  });

  test('drops images, keeping their alt text, when images are off', () => {
    const html =
      '<p>Before <img src="https://tracker.test/pixel" alt="pixel"> after</p><picture><source srcset="https://tracker.test/a"></picture>';
    const kept = segmentRenderedMarkdown(html, document);
    const dropped = segmentRenderedMarkdown(html, document, { images: false });

    expect(JSON.stringify(kept)).toContain('tracker.test');
    expect(JSON.stringify(dropped)).not.toContain('tracker.test');
    expect(JSON.stringify(dropped)).toContain('pixel');
  });

  test('keeps a link’s text but not the link when links are off', () => {
    const html = '<p>See <a href="https://example.test/">the docs</a>.</p>';
    const dropped = segmentRenderedMarkdown(html, document, { links: false });

    expect(JSON.stringify(dropped)).not.toContain('href');
    expect(JSON.stringify(dropped)).toContain('the docs');
  });

  test('server-renders the raw-text fallback for the message content', async () => {
    // The `$effect` that populates `renderedHtml` never runs on the server, so
    // `renderedHtml` stays '' and the `{:else}` branch emits the raw content as
    // a paragraph — without throwing and without importing the rendering graph.
    const result = await hydrateMessage('hello world');

    try {
      expect(result.ssrHtml).toContain(
        '<div class="cinder-markdown-content" data-state="pending">',
      );
      expect(result.ssrHtml).toContain('<p class="cinder-markdown-pending">hello world</p>');
    } finally {
      await result.cleanup();
    }
  });

  test('does not emit rendered {@html} markdown output on the server', async () => {
    // `**bold**` would become `<strong>bold</strong>` once the client pipeline
    // runs. On the server the `{#if renderedHtml}` branch is never taken, so the
    // markdown source is emitted verbatim inside the `<p>` fallback and the
    // rendered `<strong>` markup is absent.
    const result = await hydrateMessage('**bold**');

    try {
      expect(result.ssrHtml).toContain('<p class="cinder-markdown-pending">**bold**</p>');
      expect(result.ssrHtml).not.toContain('<strong>');
    } finally {
      await result.cleanup();
    }
  });

  test('escapes HTML-special characters in the server-rendered fallback', async () => {
    // The fallback is a plain `{content}` text interpolation, so Svelte escapes
    // the opening `<` to `&lt;`. This proves the server path emits *text*,
    // never an unescaped `{@html}` injection of the raw message body — the
    // `<img>` tag is neutralized and cannot execute its `onError` handler.
    const result = await hydrateMessage('<img src=x onError=alert(1)>');

    try {
      expect(result.ssrHtml).toContain('&lt;img src=x onError=alert(1)>');
      expect(result.ssrHtml).not.toContain('<img src=x onError=alert(1)>');
    } finally {
      await result.cleanup();
    }
  });

  test('hydrates the server markup without warnings, then shows the formatted result', async () => {
    // Without `math` the client renders synchronously, so its first render is the formatted
    // result while the server emitted the raw-text fallback. Svelte repairs the differing branch
    // without a mismatch warning, and the formatted markup replaces the server's paragraph.
    const result = await hydrateMessage('**bold**');

    try {
      expect(result.warnings).toEqual([]);
      expect(result.container.querySelector('strong')?.textContent).toBe('bold');
      expect(result.container.querySelector('.cinder-markdown-pending')).toBeNull();
    } finally {
      await result.cleanup();
    }
  });
});
