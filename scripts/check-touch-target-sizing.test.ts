import { describe, expect, test } from 'bun:test';
import {
  ALLOWED_DECLARATIONS,
  compareWithAllowance,
  findTouchTargetSizing,
  scanTouchTargetSizing,
} from './check-touch-target-sizing';

describe('touch-target sizing', () => {
  test.each([
    ['a minimum block size', '  min-block-size: var(--cinder-touch-target-min);'],
    ['a width', '  width: var(--cinder-touch-target-min);'],
    ['a height with a fallback', '  height: var(--cinder-touch-target-min, 2.75rem);'],
    ['a calculation', '  min-inline-size: calc(var(--cinder-touch-target-min) + 4px);'],
    ['a button height token', '  height: var(--cinder-button-height-sm);'],
    ['a maximum', '  max-height: var(--cinder-button-height-md);'],
  ])('reports %s', (_name, declaration) => {
    const source = `.control {\n${declaration}\n}`;
    expect(findTouchTargetSizing(source).map((found) => found.line)).toEqual([2]);
  });

  test.each([
    [
      'a hit area positioned with inset',
      '  inset: calc((1.5rem - var(--cinder-touch-target-min)) / 2);',
    ],
    ['a size from another token', '  min-block-size: var(--cinder-space-8);'],
    ['a gap', '  gap: var(--cinder-touch-target-min);'],
    ['a custom property that holds the token', '  --row-size: var(--cinder-touch-target-min);'],
    ['a comment that names the token', '  /* reaches --cinder-touch-target-min by its hit area */'],
  ])('passes %s', (_name, declaration) => {
    expect(findTouchTargetSizing(`.control {\n${declaration}\n}`)).toEqual([]);
  });

  test('a file over its allowance fails, and so does one under it', () => {
    const declaration = { line: 1, text: 'height: var(--cinder-touch-target-min);' };
    expect(compareWithAllowance({ 'a.css': [declaration] }, {})).toEqual([
      'a.css: 1 sizing declarations (lines 1), 0 allowed',
    ]);
    expect(compareWithAllowance({ 'a.css': [declaration] }, { 'a.css': 1 })).toEqual([]);
    expect(compareWithAllowance({}, { 'a.css': 1 })).toEqual([
      'a.css: 0 sizing declarations, 1 allowed; lower its count in ALLOWED_DECLARATIONS',
    ]);
    // An inherited key is not an allowance.
    expect(compareWithAllowance({ constructor: [declaration] }, {})).toHaveLength(1);
  });

  test('the repository holds exactly the allowed declarations', async () => {
    expect(compareWithAllowance(await scanTouchTargetSizing(), ALLOWED_DECLARATIONS)).toEqual([]);
  });
});
