import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const stylesheet = readFileSync(new URL('./autocomplete.css', import.meta.url), 'utf8');
const sharedRows = readFileSync(
  new URL('../../styles/components/_row-item.css', import.meta.url),
  'utf8',
);

describe('Autocomplete suggestion rows', () => {
  test('the active row is a fill with no ring, so it is not a box inside the floating surface', () => {
    const rule =
      /\.cinder-autocomplete__option\.cinder-_option-row\[data-cinder-active\]\s*\{([^}]*)\}/.exec(
        stylesheet,
      );
    expect(rule).not.toBeNull();
    expect(rule?.[1]).toMatch(/box-shadow:\s*none/);
  });

  test('the shared row keeps its fill and its ring for every other list, and its forced-colours cursor', () => {
    expect(sharedRows).toMatch(
      /\.cinder-_option-row\[data-cinder-active\]\s*\{\s*box-shadow:\s*inset 0 0 0 1px var\(--cinder-ring-color\)/,
    );
    expect(sharedRows).toMatch(/outline:\s*1px solid Highlight/);
  });

  test('the popover keeps its own edge, which this stylesheet does not heavy up', () => {
    expect(stylesheet).not.toMatch(/__panel[^{]*\{[^}]*border/);
  });
});
