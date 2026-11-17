import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { LINUX_BASELINE_DIRECTORY } from './baseline-provenance.ts';
import {
  checkRunHead,
  describePlan,
  mapActual,
  planBaselineCopies,
  writeBaselineCopies,
} from './baselines-from-run.ts';

function put(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

function fixture() {
  const repository = mkdtempSync(join(tmpdir(), 'baselines-from-run-repository-'));
  const download = mkdtempSync(join(tmpdir(), 'baselines-from-run-download-'));
  put(repository, `${LINUX_BASELINE_DIRECTORY}/button/light-desktop-default.png`, 'old');
  // Shard artifacts nest the results under the artifact name and a test directory.
  put(
    download,
    'playwright-fixtures-1/components/cinder/browser/test-results/case-a/button/light-desktop-default-actual.png',
    'changed',
  );
  put(
    download,
    'playwright-fixtures-2/components/cinder/browser/test-results/case-b/button/dark-mobile-loading-actual.png',
    'brand new',
  );
  put(download, 'playwright-fixtures-2/playwright-output/stray-actual.png', 'stray');
  put(download, 'playwright-fixtures-2/playwright-output/results.json', '{}');
  return { repository, download };
}

describe('baselines from a run', () => {
  it('maps a changed, a new and an unmatched actual', async () => {
    const { repository, download } = fixture();
    const plan = await planBaselineCopies(download, repository);
    const button = `${LINUX_BASELINE_DIRECTORY}/button`;
    expect(
      plan.map((entry) => `${entry.kind} ${'baseline' in entry ? entry.baseline : ''}`).toSorted(),
    ).toEqual([
      `changed ${button}/light-desktop-default.png`,
      `new ${button}/dark-mobile-loading.png`,
      'unmatched ',
    ]);
    expect(describePlan(plan, false)).toContain('1 changed, 1 new, 1 unmatched.');
    expect(describePlan(plan, false)).toContain('Dry run');
  });

  // COR-2080: a package suite's actual goes back to that package's own baselines.
  it("maps a package browser suite's actual to the package's baselines", () => {
    const plan = mapActual(
      'playwright-packages/terminal/browser/test-results/case/terminal/light-mobile-lab-actual.png',
      () => true,
    );
    expect(plan).toEqual({
      kind: 'changed',
      actual:
        'playwright-packages/terminal/browser/test-results/case/terminal/light-mobile-lab-actual.png',
      baseline:
        'components/terminal/browser/snapshots/chromium/linux/terminal/light-mobile-lab.png',
    });
  });

  it('does not guess a baseline for a name outside the screenshot pattern', () => {
    const none = () => false;
    expect(mapActual('a/button/weird-actual.png', none).kind).toBe('unmatched');
    expect(mapActual('a/Button Name/light-desktop-x-actual.png', none).kind).toBe('unmatched');
    expect(mapActual('light-desktop-x-actual.png', none).kind).toBe('unmatched');
    expect(mapActual('a/button/light-desktop-x.png', none).kind).toBe('unmatched');
  });

  it('copies changed and new actuals, and never an unmatched one', async () => {
    const { repository, download } = fixture();
    const plan = await planBaselineCopies(download, repository);
    expect(await writeBaselineCopies(plan, download, repository)).toBe(2);
    const button = join(repository, LINUX_BASELINE_DIRECTORY, 'button');
    expect(readFileSync(join(button, 'light-desktop-default.png'), 'utf8')).toBe('changed');
    expect(readFileSync(join(button, 'dark-mobile-loading.png'), 'utf8')).toBe('brand new');
  });

  it('plans without writing', async () => {
    const { repository, download } = fixture();
    await planBaselineCopies(download, repository);
    expect(
      readFileSync(
        join(repository, LINUX_BASELINE_DIRECTORY, 'button/light-desktop-default.png'),
        'utf8',
      ),
    ).toBe('old');
  });

  it('refuses a run whose head is not HEAD', () => {
    expect(checkRunHead('abc123\n', 'abc123')).toEqual({ ok: true });
    const result = checkRunHead('abc123', 'def456');
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain('Nothing was copied');
  });
});
