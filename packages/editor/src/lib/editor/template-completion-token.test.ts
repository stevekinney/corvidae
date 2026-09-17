import { describe, expect, it } from 'bun:test';
import { findTokenEnd } from './template-completion-acceptance.js';
import { createStateWithText } from './template-completion-test-utilities.js';

// ---------------------------------------------------------------------------
// findTokenEnd
// ---------------------------------------------------------------------------

describe('findTokenEnd', () => {
  it('finds the end of a complete token when cursor is at the start', () => {
    // Text: "{{input.name}}", tokenFrom = 1 (position of `{{`)
    const state = createStateWithText('{{input.name}}', 0);
    // tokenFrom is doc position 1 (1 = doc open + 0 for paragraph content start)
    const result = findTokenEnd(state, 1);

    // Should point past the closing `}}`
    // `{{input.name}}` has length 14, so end = 1 + 14 = 15
    expect(result).toBe(15);
  });

  it('finds the end of a complete token when cursor is in the middle', () => {
    // Text: "{{input.name}}", tokenFrom = 1
    // Simulates cursor mid-token (e.g., between `input.n` and `ame}}`).
    const state = createStateWithText('{{input.name}}', 8);
    const result = findTokenEnd(state, 1);

    expect(result).toBe(15); // position after the final `}}`
  });

  it('returns null when there is no closing `}}`', () => {
    // Text: "{{input.na" — no closing braces
    const state = createStateWithText('{{input.na', 10);
    const result = findTokenEnd(state, 1);

    expect(result).toBeNull();
  });

  it('finds the first `}}` when multiple tokens exist in the block', () => {
    // Text: "{{input.name}} and {{output.result}}"
    // First token: positions 1..15 (`{{input.name}}`)
    const state = createStateWithText('{{input.name}} and {{output.result}}', 0);
    const result = findTokenEnd(state, 1);

    // First `}}` is at offset 12 within the content after `{{` (offset 2),
    // so result = 1 + 2 + 12 + 2 = 17... let's count:
    // `{{input.name}}` = positions 1..14 in content, so doc pos 1+14=15.
    expect(result).toBe(15);
  });

  it('finds the end of the second token in a block', () => {
    // Text: "{{input.name}} and {{output.result}}"
    // Second token `{{` is at text offset 19, doc position 1 + 19 = 20.
    const state = createStateWithText('{{input.name}} and {{output.result}}', 0);
    const result = findTokenEnd(state, 20);

    // contentStart = 22, `output.result}}` has `}}` at index 13,
    // so return = 22 + 13 + 2 = 37.
    expect(result).toBe(37);
  });
});
