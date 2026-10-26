/**
 * The `data-state` hook on the markdown preview: `pending` while the raw-text fallback shows,
 * `rendered` once the pipeline has swapped its HTML in. The swap replaces the DOM nodes and so
 * collapses a selection made in the fallback; callers that select text wait for `rendered`.
 */
import { afterEach, describe, expect, test } from 'bun:test';

import { setupHappyDom } from '@lostgradient/testing';

// setupHappyDom() MUST run before any `@testing-library/svelte` import.
setupHappyDom();
const { render, cleanup, waitFor } = await import('@testing-library/svelte');
const { default: MarkdownPreview } = await import('./markdown-preview.svelte');
const { preloadMarkdownPipeline } = await import('./markdown-pipeline.ts');

const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');

afterEach(() => {
  cleanup();
  if (originalWindowDescriptor) {
    Object.defineProperty(globalThis, 'window', originalWindowDescriptor);
  }
});

describe('markdown preview data-state', () => {
  test('is pending on the raw text, then rendered once the pipeline swaps in its HTML', async () => {
    // The preloader only loads in a real browser realm, so present this one as such.
    Object.defineProperty(globalThis, 'window', { configurable: true, value: globalThis });
    await preloadMarkdownPipeline(async () => ({
      renderMarkdownWithMath: async (content: string) => ({
        html: `<p><strong>${content}</strong></p>`,
      }),
    }));

    const { container } = render(MarkdownPreview, { props: { content: 'hello' } });
    const preview = container.querySelector('.message-content-preview');
    expect(preview?.getAttribute('data-state')).toBe('pending');
    // Bun runs every file in one process, and the preloader caches its first pipeline, so the
    // renderer in use may belong to another file. The state, not its HTML, is what is asserted.
    await waitFor(() => expect(preview?.getAttribute('data-state')).toBe('rendered'));
  });
});
