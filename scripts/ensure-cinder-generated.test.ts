import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  CINDER_GENERATED_OUTPUTS,
  cinderGeneratedStaleness,
  ensureCinderGenerated,
} from './ensure-cinder-generated.ts';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

/** A repository root holding a Cinder package with every output, newer than its one input. */
function fixture(): { root: string; cinder: string } {
  const root = mkdtempSync(join(tmpdir(), 'corvidae-ensure-cinder-'));
  directories.push(root);
  const cinder = join(root, 'components/cinder');
  const touch = (path: string, seconds: number) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '');
    utimesSync(path, seconds, seconds);
  };
  touch(join(cinder, 'src/tokens/sets/colors.tokens.json'), 1_000);
  mkdirSync(join(cinder, 'scripts'), { recursive: true });
  for (const output of CINDER_GENERATED_OUTPUTS) touch(join(cinder, output), 2_000);
  return { root, cinder };
}

test('fresh generated files are left alone: the generator is not run', () => {
  const { root } = fixture();
  let runs = 0;
  expect(ensureCinderGenerated({ root, generate: () => ((runs += 1), 0) })).toBe(false);
  expect(runs).toBe(0);
});

test('a missing output runs the generator once, and a failing generator is an error', () => {
  const { root, cinder } = fixture();
  rmSync(join(cinder, 'src/tokens/resolved/dark.json'));
  expect(cinderGeneratedStaleness(cinder)).toContain('resolved/dark.json is missing');
  let runs = 0;
  expect(
    ensureCinderGenerated({
      root,
      generate: () => {
        runs += 1;
        writeFileSync(join(cinder, 'src/tokens/resolved/dark.json'), '');
        return 0;
      },
    }),
  ).toBe(true);
  expect(runs).toBe(1);
  expect(ensureCinderGenerated({ root, generate: () => 1 })).toBe(false);
  rmSync(join(cinder, 'src/styles/tokens-base.css'));
  expect(() => ensureCinderGenerated({ root, generate: () => 1 })).toThrow('metadata task failed');
});

test('an input newer than the oldest output is stale, and a test file is not an input', () => {
  const { cinder } = fixture();
  const input = join(cinder, 'src/tokens/sets/colors.tokens.json');
  utimesSync(input, 3_000, 3_000);
  expect(cinderGeneratedStaleness(cinder)).toBe('an input is newer than the oldest output');
  const test = join(cinder, 'src/tokens/sets/colors.test.ts');
  writeFileSync(test, '');
  utimesSync(input, 1_000, 1_000);
  utimesSync(test, 3_000, 3_000);
  expect(cinderGeneratedStaleness(cinder)).toBeUndefined();
});
