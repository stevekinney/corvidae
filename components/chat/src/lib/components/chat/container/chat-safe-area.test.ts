/**
 * The composer's area keeps clear of a phone's home indicator: its bottom padding grows by the
 * safe-area inset, which is 0 wherever the page has none.
 */
import { describe, expect, test } from 'bun:test';

describe('Chat composer area', () => {
  test('adds the bottom safe-area inset to the area padding', async () => {
    const source = await Bun.file(new URL('./chat.svelte', import.meta.url)).text();

    expect(source).toMatch(
      /\.chat-input-area \{[^}]*padding: var\(--cinder-chat-timeline-padding\) var\(--cinder-chat-reading-inline-padding\);[^}]*padding-block-end: calc\(\s*var\(--cinder-chat-timeline-padding\) \+ env\(safe-area-inset-bottom, 0px\)\s*\);/,
    );
  });
});
