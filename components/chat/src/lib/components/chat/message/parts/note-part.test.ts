/**
 * Tests for note-part.svelte: the lines a run leaves under a message (memory written, a wakeup,
 * a child run, why the run stopped).
 */

/// <reference lib="dom" />
import { afterEach, describe, expect, test } from 'bun:test';

import { setupHappyDom } from '@lostgradient/testing';
import type { NoteMessagePart } from '../../utilities/types.ts';

setupHappyDom();

const { render, cleanup } = await import('@testing-library/svelte');
const { default: NotePart } = await import('./note-part.svelte');
const { default: ChatMessagePartsRenderer } = await import('../chat-message-parts-renderer.svelte');

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

function show(part: NoteMessagePart): HTMLElement {
  const { container } = render(NotePart, { props: { note: part } });
  return container;
}

describe('NotePart', () => {
  test('a memory record reads Remembered with its collection and class, and links when it can', () => {
    const container = show({
      type: 'note',
      key: 'm:note:memory:r1',
      kind: 'memory',
      id: 'memory:r1',
      recordId: 'r1',
      collection: 'preferences',
      memoryClass: 'episodic',
      href: '/agents/helper/memories',
    });
    expect(container.textContent).toContain('Remembered');
    expect(container.textContent).toContain('preferences · episodic');
    const link = container.querySelector('a[data-chat-note-link]');
    expect(link?.getAttribute('href')).toBe('/agents/helper/memories');
  });

  test('a link that leaves the application is not rendered', () => {
    for (const href of ['https://example.com/x', '//example.com/x', 'javascript:alert(1)']) {
      const container = show({
        type: 'note',
        key: `m:note:${href}`,
        kind: 'memory',
        id: 'memory:r1',
        recordId: 'r1',
        collection: 'c',
        memoryClass: 'semantic',
        href,
      });
      expect(container.querySelector('a')).toBeNull();
      cleanup();
    }
  });

  test('a wakeup reads Will continue at with a machine-readable time and its note', () => {
    const wakeAt = Date.UTC(2031, 0, 2, 15, 40);
    const container = show({
      type: 'note',
      key: 'm:note:wakeup:r:1',
      kind: 'wakeup',
      id: 'wakeup:r:1',
      wakeAt,
      note: 'check the deploy',
    });
    expect(container.textContent).toContain('Will continue at');
    expect(container.querySelector('time')?.getAttribute('datetime')).toBe(
      new Date(wakeAt).toISOString(),
    );
    expect(container.textContent).toContain('check the deploy');
  });

  test('a child run is a card with its agent, its status and a link to the run', () => {
    const container = show({
      type: 'note',
      key: 'm:note:child:c1',
      kind: 'child-run',
      id: 'child:c1',
      childRunId: 'c1',
      agentName: 'researcher',
      status: 'failed',
      href: '/runs/c1',
    });
    const card = container.querySelector('[data-kind="child-run"]');
    expect(card?.getAttribute('data-status')).toBe('failed');
    expect(card?.textContent).toContain('researcher');
    expect(card?.textContent).toContain('Failed');
    expect(card?.querySelector('a')?.getAttribute('href')).toBe('/runs/c1');
  });

  test('a stop reads Stopped with the reason', () => {
    const container = show({
      type: 'note',
      key: 'm:note:stopped',
      kind: 'stopped',
      id: 'stopped',
      reason: 'Budget exceeded: max calls 1',
    });
    expect(container.textContent).toContain('Stopped');
    expect(container.textContent).toContain('Budget exceeded: max calls 1');
  });
});

describe('NotePart through the parts renderer', () => {
  test('is rendered by the default renderer, after the body that precedes it', () => {
    const { container } = render(ChatMessagePartsRenderer, {
      props: {
        parts: [
          { type: 'markdown', key: 'm:body', content: 'Noted.', streaming: false, expanded: true },
          {
            type: 'note',
            key: 'm:note:memory:r1',
            kind: 'memory',
            id: 'memory:r1',
            recordId: 'r1',
            collection: 'preferences',
            memoryClass: 'episodic',
          },
        ],
      },
    });
    expect(container.querySelector('[data-cinder-unhandled-part]')).toBeNull();
    expect(container.querySelector('[data-kind="memory"]')?.textContent).toContain('Remembered');
  });
});
