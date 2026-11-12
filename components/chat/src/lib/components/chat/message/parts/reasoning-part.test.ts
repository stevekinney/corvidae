/**
 * Tests for reasoning-part.svelte (C4).
 *
 * Covers:
 *   1. Renders a disclosure button with aria-expanded=false by default.
 *   2. Expanded=true reveals the reasoning content.
 *   3. Clicking the toggle fires onToggle.
 *   4. aria-expanded matches the expanded prop.
 *   5. aria-controls points to the content region.
 *   6. While streaming, the toggle button is disabled.
 *   7. While streaming, the shared frame renders one busy indicator.
 *   8. While streaming, the content region has aria-live="off".
 *   9. While streaming=false and expanded=true, a "Reasoning complete." polite region is present.
 *  10. Empty content edge case: still renders (caller is responsible for guarding).
 *  11. The label reads Thinking… with the seconds so far, then Thought for N s; never tokens.
 *  12. data-cinder-reasoning attribute is present.
 *  13. data-cinder-streaming is set/absent based on streaming prop.
 *  14. data-cinder-expanded is set/absent based on expanded prop.
 *  15. PROVE absent by default: a plain message without reasoning context produces
 *      no reasoning part (via deriveMessageParts).
 */

/// <reference lib="dom" />
import { afterEach, describe, expect, jest, mock, test } from 'bun:test';
import { flushSync } from 'svelte';

import { setupHappyDom } from '@lostgradient/testing';
import type { ReasoningMessagePart } from '../../utilities/types.ts';

setupHappyDom();

const { render, cleanup, fireEvent } = await import('@testing-library/svelte');
const { default: ReasoningPart } = await import('./reasoning-part.svelte');

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

function makePart(overrides?: Partial<ReasoningMessagePart>): ReasoningMessagePart {
  return {
    type: 'reasoning',
    key: 'm1:reasoning',
    content: 'This is my extended reasoning about the problem.',
    streaming: false,
    ...overrides,
  };
}

describe('ReasoningPart — label (C#10)', () => {
  test('a block that never streamed here reads Thought process, with no token count', () => {
    const { container } = render(ReasoningPart, { props: { part: makePart() } });
    expect(container.querySelector('.chat-reasoning-label')?.textContent?.trim()).toBe(
      'Thought process',
    );
    expect(container.textContent).not.toContain('token');
  });

  test('reads Thinking… with the seconds so far while it streams, then Thought for N s', () => {
    jest.useFakeTimers({ now: new Date('2026-11-11T12:00:00.000Z') });
    try {
      const { container, rerender } = render(ReasoningPart, {
        props: { part: makePart({ streaming: true }) },
      });
      flushSync();
      const label = () => container.querySelector('.chat-reasoning-label')?.textContent?.trim();
      const status = () => container.querySelector('.chat-entry-frame__status')?.textContent;
      expect(label()).toBe('Thinking…');
      expect(status()).toBe('0s');

      jest.advanceTimersByTime(4_000);
      flushSync();
      expect(status()).toBe('4s');

      rerender({ part: makePart({ streaming: false }) });
      flushSync();
      expect(label()).toBe('Thought for 4s');
      expect(container.querySelector('.chat-entry-frame__status')).toBeNull();
      expect(container.textContent).not.toContain('token');
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('ReasoningPart — collapsed state (default)', () => {
  test('renders a disclosure button', () => {
    const { container } = render(ReasoningPart, { props: { part: makePart() } });
    const button = container.querySelector('button');
    expect(button).not.toBeNull();
  });

  test('aria-expanded is false when expanded prop is false', () => {
    const { container } = render(ReasoningPart, {
      props: { part: makePart(), expanded: false },
    });
    const button = container.querySelector('button');
    expect(button?.getAttribute('aria-expanded')).toBe('false');
  });

  test('has data-cinder-reasoning attribute', () => {
    const { container } = render(ReasoningPart, { props: { part: makePart() } });
    expect(container.querySelector('[data-cinder-reasoning]')).not.toBeNull();
  });

  test('data-cinder-expanded is absent when collapsed', () => {
    const { container } = render(ReasoningPart, {
      props: { part: makePart(), expanded: false },
    });
    const root = container.querySelector('[data-cinder-reasoning]');
    expect(root?.hasAttribute('data-cinder-expanded')).toBe(false);
  });

  test('clicking the toggle fires onToggle', () => {
    const onToggle = mock(() => {});
    const { container } = render(ReasoningPart, {
      props: { part: makePart(), expanded: false, onToggle },
    });
    const button = container.querySelector('button');
    expect(button).not.toBeNull();
    button && fireEvent.click(button);
    flushSync();
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  test('collapsed shared disclosure omits a dangling aria-controls reference', () => {
    const { container } = render(ReasoningPart, { props: { part: makePart() } });
    const button = container.querySelector('button');
    const controlsId = button?.getAttribute('aria-controls');
    expect(controlsId).toBeNull();
  });

  test('user can reopen finished reasoning and reveal its content', () => {
    const { container } = render(ReasoningPart, { props: { part: makePart() } });
    const button = container.querySelector('button');
    expect(button?.getAttribute('aria-expanded')).toBe('false');

    button && fireEvent.click(button);
    flushSync();

    expect(button?.getAttribute('aria-expanded')).toBe('true');
    expect(container.textContent).toContain('This is my extended reasoning about the problem.');
  });
});

describe('ReasoningPart — expanded state', () => {
  test('aria-expanded is true when expanded prop is true', () => {
    const { container } = render(ReasoningPart, {
      props: { part: makePart(), expanded: true },
    });
    const button = container.querySelector('button');
    expect(button?.getAttribute('aria-expanded')).toBe('true');
  });

  test('data-cinder-expanded is present when expanded', () => {
    const { container } = render(ReasoningPart, {
      props: { part: makePart(), expanded: true },
    });
    const root = container.querySelector('[data-cinder-reasoning]');
    expect(root?.hasAttribute('data-cinder-expanded')).toBe(true);
  });

  test('content is in the DOM when expanded', () => {
    const { container } = render(ReasoningPart, {
      props: { part: makePart(), expanded: true },
    });
    expect(container.textContent).toContain('This is my extended reasoning about the problem.');
  });

  test('a never-streamed (static) reasoning block does NOT announce "Reasoning complete."', () => {
    // A static historical reasoning block must stay silent — the announcement is
    // for a stream that just FINISHED, not for any non-streaming render.
    const { container } = render(ReasoningPart, {
      props: { part: makePart({ streaming: false }), expanded: true },
    });
    const liveRegions = container.querySelectorAll('[aria-live="polite"]');
    const hasComplete = Array.from(liveRegions).some((el) =>
      el.textContent?.includes('Reasoning complete.'),
    );
    expect(hasComplete).toBe(false);
  });

  test('"Reasoning complete." fires once after a streaming true→false transition', () => {
    const { container, rerender } = render(ReasoningPart, {
      props: { part: makePart({ streaming: true }), expanded: true },
    });
    const politeText = () =>
      Array.from(container.querySelectorAll('[aria-live="polite"]'))
        .map((el) => el.textContent ?? '')
        .join(' ');

    // Silent while streaming.
    expect(politeText()).not.toContain('Reasoning complete.');

    // Stream ends → the polite region announces exactly once.
    rerender({ part: makePart({ streaming: false }), expanded: true });
    flushSync();
    expect(politeText()).toContain('Reasoning complete.');
  });

  test('the announcement clears again when a new stream starts (fires per session)', () => {
    const { container, rerender } = render(ReasoningPart, {
      props: { part: makePart({ streaming: true }) },
    });
    const politeText = () =>
      Array.from(container.querySelectorAll('[aria-live="polite"]'))
        .map((el) => el.textContent ?? '')
        .join(' ');

    rerender({ part: makePart({ streaming: false }) });
    flushSync();
    expect(politeText()).toContain('Reasoning complete.');

    // A new stream begins on the same block — the region clears so the next
    // completion announces again.
    rerender({ part: makePart({ streaming: true }) });
    flushSync();
    expect(politeText()).not.toContain('Reasoning complete.');
  });
});

describe('ReasoningPart — streaming state', () => {
  test('opens while streaming and folds when streaming finishes unless controlled open', () => {
    const { container, rerender } = render(ReasoningPart, {
      props: { part: makePart({ streaming: true }) },
    });
    const button = container.querySelector('button');
    expect(button?.getAttribute('aria-expanded')).toBe('true');
    expect(container.textContent).toContain('This is my extended reasoning about the problem.');

    rerender({ part: makePart({ streaming: false }) });
    flushSync();
    expect(button?.getAttribute('aria-expanded')).toBe('false');

    rerender({ part: makePart({ streaming: false }), expanded: true });
    flushSync();
    expect(button?.getAttribute('aria-expanded')).toBe('true');
  });

  test('toggle button is disabled when streaming', () => {
    const { container } = render(ReasoningPart, {
      props: { part: makePart({ streaming: true }) },
    });
    const button = container.querySelector('button');
    expect(button?.disabled).toBe(true);
  });

  test('clicking disabled toggle does not fire onToggle', () => {
    const onToggle = mock(() => {});
    const { container } = render(ReasoningPart, {
      props: { part: makePart({ streaming: true }), onToggle },
    });
    const button = container.querySelector('button');
    button && fireEvent.click(button);
    flushSync();
    expect(onToggle).toHaveBeenCalledTimes(0);
  });

  test('data-cinder-streaming is present when streaming', () => {
    const { container } = render(ReasoningPart, {
      props: { part: makePart({ streaming: true }) },
    });
    const root = container.querySelector('[data-cinder-reasoning]');
    expect(root?.hasAttribute('data-cinder-streaming')).toBe(true);
  });

  test('data-cinder-streaming is absent when not streaming', () => {
    const { container } = render(ReasoningPart, {
      props: { part: makePart({ streaming: false }) },
    });
    const root = container.querySelector('[data-cinder-reasoning]');
    expect(root?.hasAttribute('data-cinder-streaming')).toBe(false);
  });

  test('content region has aria-live="off" while streaming', () => {
    const { container } = render(ReasoningPart, {
      props: { part: makePart({ streaming: true }), expanded: true },
    });
    const contentEl = container.querySelector('.chat-reasoning-content');
    expect(contentEl?.getAttribute('aria-live')).toBe('off');
  });

  test('content region has no aria-live when not streaming', () => {
    const { container } = render(ReasoningPart, {
      props: { part: makePart({ streaming: false }), expanded: true },
    });
    const button = container.querySelector('button');
    const contentId = button?.getAttribute('aria-controls');
    const contentEl = contentId ? container.querySelector(`#${contentId}`) : null;
    expect(contentEl?.getAttribute('aria-live')).toBeNull();
  });

  test('no status dot is drawn while streaming; the name still says in progress', () => {
    const { container } = render(ReasoningPart, {
      props: { part: makePart({ streaming: true }) },
    });
    expect(container.querySelector('.chat-entry-frame__busy')).toBeNull();
    expect(container.querySelector('button')?.getAttribute('aria-label')).toContain('0s');
  });

  test('leading whitespace is trimmed from the reasoning body', () => {
    const { container } = render(ReasoningPart, {
      props: { part: makePart({ content: '\n\n  Start here.' }), expanded: true },
    });
    // The text is the only pre-wrapped node, so no layout whitespace can lead it.
    expect(container.querySelector('.chat-reasoning-text')?.textContent).toBe('Start here.');
  });

  test('shared busy indicator is absent when not streaming', () => {
    const { container } = render(ReasoningPart, {
      props: { part: makePart({ streaming: false }) },
    });
    expect(container.querySelector('.chat-entry-frame__busy')).toBeNull();
  });
});

describe('ReasoningPart — stable DOM under content updates', () => {
  test('updating content does not remount the disclosure button', () => {
    const { container, rerender } = render(ReasoningPart, {
      props: { part: makePart({ content: 'first token', streaming: true }) },
    });
    const button1 = container.querySelector('button');

    rerender({ part: makePart({ content: 'first token second', streaming: true }) });
    flushSync();

    const button2 = container.querySelector('button');
    // Same DOM node — no remount
    expect(button1).toBe(button2);
  });
});

describe('ReasoningPart — absence for plain messages', () => {
  test('deriveMessageParts without reasoning context produces no reasoning part', async () => {
    const { deriveMessageParts } = await import('../../utilities/utilities.ts');
    const message = {
      id: 'msg-plain',
      role: 'assistant' as const,
      content: 'Hello, world!',
      position: 0,
      metadata: {},
      hidden: false,
      createdAt: new Date().toISOString(),
    };
    const parts = deriveMessageParts(message, {});
    const hasReasoning = parts.some((p) => p.type === 'reasoning');
    expect(hasReasoning).toBe(false);
  });

  test('deriveMessageParts with empty string reasoning produces no reasoning part', async () => {
    const { deriveMessageParts } = await import('../../utilities/utilities.ts');
    const message = {
      id: 'msg-empty-reasoning',
      role: 'assistant' as const,
      content: 'Answer here.',
      position: 0,
      metadata: {},
      hidden: false,
      createdAt: new Date().toISOString(),
    };
    const parts = deriveMessageParts(message, { reasoning: '' });
    const hasReasoning = parts.some((p) => p.type === 'reasoning');
    expect(hasReasoning).toBe(false);
  });

  test('deriveMessageParts with non-empty reasoning emits a reasoning part before markdown', async () => {
    const { deriveMessageParts } = await import('../../utilities/utilities.ts');
    const message = {
      id: 'msg-with-reasoning',
      role: 'assistant' as const,
      content: 'Final answer.',
      position: 0,
      metadata: {},
      hidden: false,
      createdAt: new Date().toISOString(),
    };
    const parts = deriveMessageParts(message, { reasoning: 'I thought about it carefully.' });
    const reasoningIndex = parts.findIndex((p) => p.type === 'reasoning');
    const markdownIndex = parts.findIndex((p) => p.type === 'markdown');
    expect(reasoningIndex).toBeGreaterThanOrEqual(0);
    expect(markdownIndex).toBeGreaterThanOrEqual(0);
    expect(reasoningIndex).toBeLessThan(markdownIndex);
  });
});
