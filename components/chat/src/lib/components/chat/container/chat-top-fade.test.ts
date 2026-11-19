/**
 * The transcript's top edge fades under the translucent chat header, at the header's bottom edge,
 * so a scrolled message no longer meets the header in a flat line. The fade is the transcript's
 * existing mask fade (the end edge's pattern) with its start moved to the header's bottom edge
 * (`--cinder-chat-overlay-inset-start`). These pin the rule; the captures show the result.
 */
import { describe, expect, test } from 'bun:test';

const text = await Bun.file(new URL('./chat.svelte', import.meta.url)).text();
const source = text.replace(/\s+/g, ' ');

describe('the transcript top fade under the header', () => {
  test('starts at the header’s bottom edge, using the overlay inset the host publishes', () => {
    expect(source).toContain(
      '--_chat-timeline-fade-top: var(--_cinder-chat-overlay-inset-start, 0px);',
    );
    expect(source).toContain(
      'black var(--_chat-timeline-fade-top), transparent var(--_chat-timeline-fade-top), black calc(var(--_chat-timeline-fade-top) + var(--_chat-timeline-fade-start)),',
    );
  });

  test('is as long as the timeline’s top padding, so the row at rest under the header is never dimmed', () => {
    expect(source).toContain(
      '--_chat-timeline-fade-start-size: var(--cinder-chat-timeline-padding);',
    );
    expect(source).toMatch(
      /\.chat-timeline-mask-fade \{ --_chat-timeline-fade-start-size: var\(--cinder-chat-narrow-padding\); \}/,
    );
  });

  test('is one pattern with the end edge: one mask, both themes read the same rule and no colour', () => {
    const masks = source.match(/[^{}]*\{[^{}]*mask-image[^{}]*\}/g) ?? [];
    // The mask paints no colour of its own, so light and dark share it; the only mask is the
    // transparent surface's, and its other edge keeps the full size.
    expect(masks.some((rule) => rule.includes('.chat-timeline-mask-fade'))).toBe(true);
    expect(source).toContain('--_chat-timeline-fade-size: var(--cinder-space-6);');
    expect(source).toContain('black calc(100% - var(--_chat-timeline-fade-end)),');
  });

  test('is off under reduced transparency, where the header is solid and has a real edge', () => {
    expect(source).toMatch(
      /@media \(prefers-reduced-transparency: reduce\), \(forced-colors: active\) \{ \.chat-timeline-mask-fade \{ mask-image: none; \} \}/,
    );
  });

  test('takes no pointer events: it is a mask on the scroller, not an element laid over it', () => {
    const rule = source.match(/\.chat-timeline-mask-fade \{[^}]*\}/)?.[0] ?? '';
    expect(rule).toContain('mask-image:');
    expect(rule).not.toContain('::before');
    expect(rule).not.toContain('pointer-events');
  });
});
