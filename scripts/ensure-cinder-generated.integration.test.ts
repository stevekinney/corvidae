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
  touch(join(root, 'internal/component-tooling/scripts/generate.ts'), 1_000);
  touch(join(root, 'internal/component-tooling/src/schema.ts'), 1_000);
  touch(join(root, 'package.json'), 1_000);
  touch(join(root, 'bun.lock'), 1_000);
  touch(join(root, 'internal/component-tooling/package.json'), 1_000);
  touch(join(cinder, 'package.json'), 1_000);
  for (const output of CINDER_GENERATED_OUTPUTS) touch(join(cinder, output), 2_000);
  return { root, cinder };
}

const freshScenario = await (async () => {
  const { root } = fixture();
  let runs = 0;
  const generated = await ensureCinderGenerated({ root, generate: () => ((runs += 1), 0) });
  return { generated, runs };
})();

const generationScenario = await (async () => {
  const { root, cinder } = fixture();
  rmSync(join(cinder, 'src/tokens/resolved/dark.json'));
  const reason = cinderGeneratedStaleness(cinder);
  let runs = 0;
  const generated = await ensureCinderGenerated({
    root,
    generate: () => {
      runs += 1;
      writeFileSync(join(cinder, 'src/tokens/resolved/dark.json'), '');
      return 0;
    },
  });
  const second = await ensureCinderGenerated({ root, generate: () => 1 });
  rmSync(join(cinder, 'src/styles/tokens-base.css'));
  const failure = await ensureCinderGenerated({ root, generate: () => 1 }).then(
    () => undefined,
    (error: unknown) => error,
  );
  return { reason, runs, generated, second, failure };
})();

test('fresh generated files are left alone: the generator is not run', () => {
  expect(freshScenario).toEqual({ generated: false, runs: 0 });
});

test('a missing output runs the generator once, and a failing generator is an error', () => {
  expect(generationScenario.reason).toContain('resolved/dark.json is missing');
  expect(generationScenario.generated).toBe(true);
  expect(generationScenario.runs).toBe(1);
  expect(generationScenario.second).toBe(false);
  expect(generationScenario.failure).toBeInstanceOf(Error);
  expect((generationScenario.failure as Error).message).toContain('metadata task failed');
});
