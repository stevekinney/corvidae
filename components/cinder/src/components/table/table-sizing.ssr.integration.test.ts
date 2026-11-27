/**
 * COR-2769: the server's HTML already carries each cell's column sizing, so the first paint is the
 * sized layout, not the equal columns a script would correct after hydration.
 */
import { renderSvelteOnServer } from '@lostgradient/testing';
import { describe, expect, test } from 'bun:test';

const fixturePath = new URL('./table-sizing.fixture.svelte', import.meta.url).pathname;
// Server rendering spawns a Bun process, so it runs once at module scope, off bun's per-test clock.
const html = await renderSvelteOnServer(fixturePath, {});

describe('Table column sizing in server HTML', () => {
  test('every header and body cell carries its column sizing', () => {
    const sizings = Array.from(html.matchAll(/data-cinder-sizing="(\w+)"/g), (match) => match[1]);
    // Three header cells, then two body rows of three cells each.
    expect(sizings).toEqual([
      'content',
      'content',
      'fill',
      'content',
      'content',
      'fill',
      'content',
      'content',
      'fill',
    ]);
  });
});
