/**
 * The board renderer's decisions that need no browser (`scripts/design-review-render-boards.ts`): the
 * size a board asks for, when a board is sliced and how, and the command line.
 */
import { describe, expect, test } from 'bun:test';

import {
  parseArguments,
  previewSize,
  SLICE_HEIGHT,
  SLICE_THRESHOLD,
  sliceOffsets,
} from './design-review-render-boards.ts';

describe('previewSize', () => {
  test('reads the board’s $preview size, and falls back to 1440 by 1000', () => {
    expect(previewSize('{"$preview":{"width":390,"height":844},"x":1}')).toEqual({
      width: 390,
      height: 844,
    });
    expect(previewSize('<html>no preview</html>')).toEqual({ width: 1440, height: 1000 });
  });
});

describe('sliceOffsets', () => {
  test('leaves a board that fits whole, and slices a tall one to its last pixel', () => {
    expect(sliceOffsets(SLICE_THRESHOLD)).toEqual([]);
    expect(sliceOffsets(3000)).toEqual([
      { top: 0, height: SLICE_HEIGHT },
      { top: 1200, height: SLICE_HEIGHT },
      { top: 2400, height: 600 },
    ]);
  });
});

describe('parseArguments', () => {
  test('writes beside the boards by default and keeps named boards', () => {
    const options = parseArguments(['--boards', 'boards', 'ChatPage.dc.html']);
    if (typeof options === 'string') throw new Error(options);
    expect(options.out).toBe(options.boards);
    expect(options.boards).toEndWith('/boards');
    expect(options.names).toEqual(['ChatPage.dc.html']);
  });

  test('refuses a missing directory, an unknown flag and a file that is not a board', () => {
    expect(parseArguments([])).toBe('--boards is required');
    expect(parseArguments(['--boards', 'b', '--size', '2'])).toBe('unknown flag --size');
    expect(parseArguments(['--boards', 'b', 'notes.md'])).toBe('notes.md is not a .dc.html board');
    expect(parseArguments(['--boards'])).toBe('--boards needs a value');
  });
});
