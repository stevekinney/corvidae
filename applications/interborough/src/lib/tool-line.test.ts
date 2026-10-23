import { describe, expect, test } from 'bun:test';

import { TOOL_LINE_LIMIT, toolLine } from './tool-line.ts';

const LONG_PROMPT =
  'Create a workflow: a JSON file of a trigger and steps that Bureau runs. `name` is what the workflow is called, and its identifier is derived from it (lowercase, with runs of other characters turned into one hyphen) unless you give `id`. A taken identifier is a conflict. The workflow is yours to change and starts working as soon as the call returns.';

describe('toolLine', () => {
  test('shows the line a tool declares, and offers the description it replaces', () => {
    const result = toolLine({
      description: LONG_PROMPT,
      shortDescription: 'Create a workflow Bureau runs on a schedule or a signal.',
    });
    expect(result).toEqual({
      line: 'Create a workflow Bureau runs on a schedule or a signal.',
      expandable: true,
    });
  });

  test('shows a short description whole, with nothing to expand', () => {
    expect(
      toolLine({
        description: 'Look up an order by its identifier.',
        shortDescription: null,
      }),
    ).toEqual({ line: 'Look up an order by its identifier.', expandable: false });
  });

  test('cuts a long description to the limit, ends it with an ellipsis, and offers the rest', () => {
    const result = toolLine({ description: LONG_PROMPT, shortDescription: null });
    // A space left at the cut is dropped before the ellipsis, so the line may be a character short.
    expect(Array.from(result.line).length).toBeLessThanOrEqual(TOOL_LINE_LIMIT);
    expect(Array.from(result.line).length).toBeGreaterThanOrEqual(TOOL_LINE_LIMIT - 1);
    expect(result.line.endsWith('…')).toBe(true);
    expect(LONG_PROMPT.startsWith(result.line.slice(0, -1))).toBe(true);
    expect(result.expandable).toBe(true);
  });

  test('keeps a description of exactly the limit whole', () => {
    const exact = 'a'.repeat(TOOL_LINE_LIMIT);
    expect(toolLine({ description: exact, shortDescription: null })).toEqual({
      line: exact,
      expandable: false,
    });
    const over = toolLine({ description: `${exact}b`, shortDescription: null });
    expect(Array.from(over.line)).toHaveLength(TOOL_LINE_LIMIT);
    expect(over.expandable).toBe(true);
  });

  test('cuts a declared line that is itself too long, so no row passes the limit', () => {
    const result = toolLine({ description: 'x', shortDescription: 'word '.repeat(60) });
    expect(Array.from(result.line).length).toBeLessThanOrEqual(TOOL_LINE_LIMIT);
    expect(result.line.endsWith('…')).toBe(true);
  });

  test('puts a multi-line description on one line, and offers the original layout', () => {
    const result = toolLine({
      description: 'First line.\n\nSecond paragraph.',
      shortDescription: null,
    });
    expect(result.line).toBe('First line. Second paragraph.');
    expect(result.expandable).toBe(true);
  });

  test('treats a blank declared line as none', () => {
    expect(toolLine({ description: 'Refund an order.', shortDescription: '   ' })).toEqual({
      line: 'Refund an order.',
      expandable: false,
    });
  });

  test('counts characters, not UTF-16 units, so an emoji is not split', () => {
    const emoji = '😀'.repeat(TOOL_LINE_LIMIT + 5);
    const result = toolLine({ description: emoji, shortDescription: null });
    expect(Array.from(result.line)).toHaveLength(TOOL_LINE_LIMIT);
    expect(result.line).not.toContain('\ud83d…');
  });
});
