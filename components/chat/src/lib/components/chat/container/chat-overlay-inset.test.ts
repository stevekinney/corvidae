/**
 * A host can lay a header over the top of the transcript, on a translucent ground, so the
 * transcript scrolls under it. It names the header's height in `--cinder-chat-overlay-inset-start`
 * and the transcript starts its first row, and rests a row it scrolls to, clear of it, at the wide
 * padding and at the narrow one. With nothing laid over the inset is 0 and nothing moves.
 */
import { describe, expect, test } from 'bun:test';

const source = await Bun.file(new URL('./chat.svelte', import.meta.url)).text();

describe('the transcript under an overlaid header', () => {
  test('reads the host inset, defaulting to none', () => {
    expect(source).toContain(
      '--_cinder-chat-overlay-inset-start: var(--cinder-chat-overlay-inset-start, 0px);',
    );
  });

  test('starts its first row below the inset at the wide padding and at the narrow one', () => {
    expect(source).toMatch(
      /padding-block-start: calc\(\s*var\(--cinder-chat-timeline-padding\) \+ var\(--_cinder-chat-overlay-inset-start\)\s*\);/,
    );
    expect(source).toMatch(
      /padding-block-start: calc\(\s*var\(--cinder-chat-narrow-padding\) \+ var\(--_cinder-chat-overlay-inset-start\)\s*\);/,
    );
  });

  test('rests a row it scrolls to below the inset', () => {
    expect(source).toMatch(
      /scroll-padding-block-start: calc\(\s*var\(--cinder-space-2\) \+ var\(--_cinder-chat-overlay-inset-start\)\s*\);/,
    );
  });
});
