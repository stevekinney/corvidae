import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

/**
 * A list whose rows carry a figure in `trailing` (a cost, a count) sizes the trailing track once, for
 * the list, so the time before it ends at one edge in every row (COR-2525). The stylesheet reads the
 * width and the alignment from custom properties a list sets; with none set a row sizes the track by
 * its own content and centers the region on both lines, as it always did.
 */
const stylesheet = readFileSync(new URL('./stacked-list-item.css', import.meta.url), 'utf8');

describe('StackedListItem trailing track (COR-2525)', () => {
  test('the two-line status-first and status-line-two layouts size the trailing track from the list, auto by default', () => {
    const templates = stylesheet.match(
      /\[trailing\] var\(--cinder-stacked-list-item-trailing-track, auto\);/g,
    );
    expect(templates?.length).toBe(2);
  });

  test('no two-line desktop layout keeps a bare auto trailing track a list could not size', () => {
    // The layouts left to their content: the phone's time track and the chat list's pane.
    const bare = stylesheet.split('\n').filter((line) => /\[trailing\] auto;/.test(line));
    expect(bare.length).toBe(2);
  });

  test('the trailing region centers on both lines unless a list asks for the first line’s baseline', () => {
    expect(stylesheet).toMatch(
      /\.cinder-stacked-list-item--lines \.cinder-stacked-list-item__trailing \{[^}]*align-self: var\(--cinder-stacked-list-item-trailing-align, center\);/,
    );
  });

  test('the properties are consumed with a fallback only, so a row that sets none changes nothing and no manifest lists them', () => {
    const declared = stylesheet.match(/--cinder-stacked-list-item-trailing-(?:track|align)\s*:/g);
    expect(declared).toBeNull();
  });
});
