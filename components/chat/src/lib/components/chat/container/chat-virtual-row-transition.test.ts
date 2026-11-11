/**
 * The virtualized transcript writes each row's offset and the spacer's size inline. Under reduced
 * motion Cinder's `foundation.css` gives every element a 0.01ms transition on `all`, so a row whose
 * offset changed reported its old position until the next frame, and the scroll anchoring that runs
 * after a source list opens above the viewport read no drift (COR-2259). The rows and the spacer
 * name no transition property, so nothing they draw animates.
 */
import { describe, expect, test } from 'bun:test';

describe('Chat virtualized rows', () => {
  test('the spacer and the rows never transition their geometry', async () => {
    const source = await Bun.file(new URL('./chat.svelte', import.meta.url)).text();

    expect(source).toMatch(
      /\.chat-virtual-spacer,\s*\.chat-virtual-row \{\s*transition-property: none;\s*\}/,
    );
  });
});
