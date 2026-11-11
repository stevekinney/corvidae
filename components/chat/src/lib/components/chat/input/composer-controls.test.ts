import { describe, expect, test } from 'bun:test';
import { COMPOSER_FOLD_WIDTH, composerControlsFold } from './composer-controls.ts';

const REM = 16;
const WIDE = 60 * REM;

describe('composerControlsFold', () => {
  test('draws the full row when the composer has no layout to measure', () => {
    expect(
      composerControlsFold({
        composerWidth: 0,
        remInPixels: REM,
        availableWidth: 0,
        neededWidth: 900,
      }),
    ).toBe(false);
  });

  test('folds below the fold width whatever the controls need', () => {
    expect(
      composerControlsFold({
        composerWidth: COMPOSER_FOLD_WIDTH * REM - 1,
        remInPixels: REM,
        availableWidth: 400,
        neededWidth: 100,
      }),
    ).toBe(true);
  });

  test('keeps the row at desktop width while every value fits in full', () => {
    expect(
      composerControlsFold({
        composerWidth: WIDE,
        remInPixels: REM,
        availableWidth: 600,
        neededWidth: 560,
      }),
    ).toBe(false);
  });

  // The 1280 chat: Model, Effort and Permissions were cut to "claude-s…", "M.." and "On ch…" in a
  // 45rem composer, because only the composer's own width decided the fold.
  test('folds at desktop width when the values in full do not fit beside the meter and Send', () => {
    expect(
      composerControlsFold({
        composerWidth: 45.5 * REM,
        remInPixels: REM,
        availableWidth: 470,
        neededWidth: 610,
      }),
    ).toBe(true);
  });

  test('ignores half a pixel of rounding', () => {
    expect(
      composerControlsFold({
        composerWidth: WIDE,
        remInPixels: REM,
        availableWidth: 500,
        neededWidth: 500.4,
      }),
    ).toBe(false);
  });

  test('draws the full row above the fold width until the controls have been measured', () => {
    expect(
      composerControlsFold({
        composerWidth: WIDE,
        remInPixels: REM,
        availableWidth: 300,
        neededWidth: undefined,
      }),
    ).toBe(false);
  });
});
