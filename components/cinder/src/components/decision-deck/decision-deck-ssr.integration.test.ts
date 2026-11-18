/// <reference lib="dom" />
/**
 * Hydration contract for DecisionDeck (COR-2441, from COR-2362): the server-rendered markup is a
 * complete deck, and hydrating it on the client keeps that markup, raises no hydration warning,
 * and leaves a deck that still decides.
 */
import { describe, expect, test } from 'bun:test';
import { tick } from 'svelte';

import {
  hydrateServerHtml,
  prepareSvelteServerSource,
  renderSvelteOnServer,
  requiredInstance,
  setupHappyDom,
} from '@lostgradient/testing';

setupHappyDom();

const { default: DecisionDeck } = await import('./decision-deck.svelte');
const sourcePath = new URL('./decision-deck.svelte', import.meta.url).pathname;
await prepareSvelteServerSource(sourcePath);

const props = {
  label: 'Review queue',
  items: [
    { id: 'receipts', title: 'Archive receipts', description: 'Move mail to Receipts.' },
    { id: 'digest', title: 'Label the weekly digest', eyebrow: 'News Weekly' },
    { id: 'invoices', title: 'Star invoices' },
  ],
};

// Server rendering spawns a Bun process, so it runs once at module scope, off bun's per-test clock.
const serverHtml = await renderSvelteOnServer(sourcePath, props);

describe('DecisionDeck server rendering and hydration', () => {
  test('the server markup holds the progress, the three cards, the actions and the hint', () => {
    expect(serverHtml).toContain('cinder-decision-deck__progress-text');
    expect(serverHtml).toContain('1 of 3');
    expect(serverHtml.match(/data-cinder-decision-card/g)?.length).toBe(3);
    expect(serverHtml).toContain('data-decision-action="accept"');
    expect(serverHtml).toContain('data-decision-action="reject"');
    expect(serverHtml).toContain('data-decision-action="later"');
    expect(serverHtml).toContain('Press the right arrow key to accept');
    // No decision has been made, so no exit copy and no Undo bar are drawn.
    expect(serverHtml).not.toContain('data-cinder-decision-exit');
    expect(serverHtml).not.toContain('data-decision-action="undo"');
  });

  test('hydrates without warnings and keeps the server markup', async () => {
    const result = hydrateServerHtml(DecisionDeck, serverHtml, props);
    await tick();

    try {
      const hydrationWarnings = result.warnings.filter((warning) =>
        warning.toLowerCase().includes('hydration'),
      );
      expect(hydrationWarnings).toEqual([]);
      expect(result.container.querySelectorAll('[data-cinder-decision-card]')).toHaveLength(3);
      expect(
        result.container.querySelector('[data-cinder-decision-card][data-depth="0"]')?.textContent,
      ).toContain('Archive receipts');
    } finally {
      await result.cleanup();
    }
  });

  test('a hydrated deck decides: the accept button moves to the next card and offers Undo', async () => {
    const result = hydrateServerHtml(DecisionDeck, serverHtml, props);
    await tick();

    try {
      const accept = requiredInstance(
        result.container.querySelector('[data-decision-action="accept"]'),
        HTMLElement,
      );
      accept.click();
      await tick();

      expect(
        result.container.querySelector('[data-cinder-decision-card][data-depth="0"]')?.textContent,
      ).toContain('Label the weekly digest');
      expect(
        result.container.querySelector('.cinder-decision-deck__progress-text')?.textContent,
      ).toBe('2 of 3');
      expect(result.container.querySelector('[data-decision-action="undo"]')).not.toBeNull();
    } finally {
      await result.cleanup();
    }
  });
});
