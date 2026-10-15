import { describe, expect, it } from 'bun:test';

import {
  extractPorcelainPath,
  hasMeaningfulSnapshotChanges,
  isMeaningfulSnapshotPath,
} from './snapshot-change-detection.ts';

const LINUX = 'scripts/browser-fixtures/snapshots/chromium/linux';

describe('snapshot change detection', () => {
  it('detects first-time untracked PNG baselines', () => {
    expect(hasMeaningfulSnapshotChanges(`?? ${LINUX}/button/light-desktop-default.png\n`)).toBe(
      true,
    );
  });

  it('detects provenance-only changes', () => {
    expect(hasMeaningfulSnapshotChanges(` M ${LINUX}/provenance.json\n`)).toBe(true);
  });

  it('detects modified nested PNG baselines', () => {
    expect(hasMeaningfulSnapshotChanges(` M ${LINUX}/button/dark-mobile-default.png\n`)).toBe(true);
  });

  it('detects renamed PNG baselines when either path is under snapshots', () => {
    expect(
      hasMeaningfulSnapshotChanges(`R  ${LINUX}/button/old.png -> ${LINUX}/button/new.png\n`),
    ).toBe(true);
  });

  it('ignores non-PNG files under the snapshot directory and PNGs elsewhere', () => {
    expect(isMeaningfulSnapshotPath(`${LINUX}/button/readme.txt`)).toBe(false);
    expect(isMeaningfulSnapshotPath('scripts/browser-fixtures/fixtures/image.png')).toBe(false);
    expect(hasMeaningfulSnapshotChanges('')).toBe(false);
  });

  it('extracts both sides of git rename porcelain output', () => {
    expect(extractPorcelainPath(`R  ${LINUX}/button/old.png -> ${LINUX}/button/new.png`)).toEqual([
      `${LINUX}/button/old.png`,
      `${LINUX}/button/new.png`,
    ]);
  });
});
