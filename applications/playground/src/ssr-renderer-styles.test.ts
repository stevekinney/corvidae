import { describe, expect, it } from 'bun:test';

import { loadShellServerRenderer, resetShellRendererWarmupState } from './ssr-renderer.ts';

describe('the shell server renderer', () => {
  // The landing page ships no shell JavaScript until a reader interacts, so the styles
  // of the shell's own components have to arrive in the server-rendered head. This
  // builds the real renderer from the package roots, so it carries the cost of a cold
  // server build and an explicit budget for it.
  it('puts the shell components styles in the server-rendered head', async () => {
    resetShellRendererWarmupState();
    try {
      const { renderer, usedFallback } = await loadShellServerRenderer();
      expect(usedFallback).toBe(false);

      const rendered = renderer({ components: ['button'], readmeHtml: '<p>Landing</p>' });

      expect(rendered.head).toMatch(/<style id="svelte-[a-z0-9]+">/);
      expect(rendered.body).toContain('Landing');
    } finally {
      resetShellRendererWarmupState();
    }
  });
});
