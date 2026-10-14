/// <reference lib="dom" />
/**
 * Server render and hydration of the public Terminal component.
 *
 * The server render runs in a separate process with no DOM and the server Svelte runtime, so it
 * proves the component renders without touching the document. The hydration uses the real client
 * runtime over that markup.
 */
import {
  prepareSvelteServerSource,
  renderSvelteOnServer,
  renderThenHydrate,
} from '@lostgradient/testing';
import { describe, expect, test } from 'bun:test';

import { waitFor } from './terminal-test-support.ts';
import Terminal from './terminal.svelte';
import { TERMINAL_STATE_MESSAGE } from './terminal.types.ts';

const sourcePath = new URL('./terminal.svelte', import.meta.url).pathname;

// Compile the server graph before the timed assertions: the first compile of Cinder's graph is
// slow, and the tests below should measure render and hydrate, not the compiler.
await prepareSvelteServerSource(sourcePath);

const props = { title: 'Build shell', state: 'writable' } as const;

describe('server render', () => {
  test('emits the labelled region, title, status, and an inert viewport with the loading message', async () => {
    const html = await renderSvelteOnServer(sourcePath, props);
    expect(html).toContain('role="region"');
    expect(html).toContain('aria-labelledby=');
    expect(html).toContain('Build shell');
    expect(html).toContain('data-cinder-status="connected"');
    expect(html).toContain(TERMINAL_STATE_MESSAGE.loading);
    expect(html).toMatch(/<div[^>]*class="cinder-terminal__viewport"[^>]*inert/);
  });

  test('emits no engine DOM, editable element, autofocus, or script', async () => {
    const html = await renderSvelteOnServer(sourcePath, props);
    expect(html).not.toContain('xterm');
    expect(html).not.toContain('<textarea');
    expect(html).not.toContain('<input');
    expect(html).not.toContain('contenteditable');
    expect(html).not.toContain('autofocus');
    expect(html).not.toContain('<script');
  });

  test('says what an error is on the server rather than "loading"', async () => {
    const html = await renderSvelteOnServer(sourcePath, { title: 'Shell', state: 'denied' });
    expect(html).toContain(TERMINAL_STATE_MESSAGE.denied);
    expect(html).not.toContain(TERMINAL_STATE_MESSAGE.loading);
  });

  test('renders the empty state with no viewport at all', async () => {
    const html = await renderSvelteOnServer(sourcePath, { title: 'Shell' });
    expect(html).toContain(TERMINAL_STATE_MESSAGE.empty);
    expect(html).not.toContain('cinder-terminal__viewport');
  });
});

describe('hydration', () => {
  test('hydrates without a mismatch and mounts exactly one engine', async () => {
    const result = await renderThenHydrate(Terminal, sourcePath, { ...props });
    try {
      expect(result.ssrHtml).not.toContain('xterm');
      expect(result.container.querySelectorAll('.xterm')).toHaveLength(0);
      await waitFor(() => result.container.querySelector('.xterm') !== null, 'the engine to mount');
      await waitFor(
        () => !result.container.querySelector('.cinder-terminal__viewport')!.hasAttribute('inert'),
        'the viewport to become interactive',
      );
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(result.container.querySelectorAll('.xterm')).toHaveLength(1);
      expect(result.container.querySelectorAll('textarea')).toHaveLength(1);
      expect(result.warnings.filter((warning) => warning.toLowerCase().includes('hydrat'))).toEqual(
        [],
      );
    } finally {
      await result.cleanup();
    }
  });

  test('preserves the server structure until the engine attaches', async () => {
    const result = await renderThenHydrate(Terminal, sourcePath, { ...props });
    try {
      const region = result.container.querySelector('[role="region"]');
      expect(region?.getAttribute('data-cinder-status')).toBe('connected');
      expect(result.container.querySelector('h2')?.textContent).toBe('Build shell');
    } finally {
      await result.cleanup();
    }
  });
});
