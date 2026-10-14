import { outcomeOf, rethrow, SCENARIO_HANG_GUARD_MILLISECONDS } from '@lostgradient/testing';
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const packageRoot = join(import.meta.dir, '..');
const typescriptCompiler = Bun.resolveSync('typescript/bin/tsc', packageRoot);

/**
 * Type-check one extra source file under the neutral program's compiler options. The scratch
 * configuration extends `tsconfig.neutral.json` but replaces its file list, so the fixture is the
 * only input and nothing in the real source tree is touched. The scratch directory is removed
 * before this returns.
 */
function checkNeutral(source: string): { exitCode: number; output: string } {
  const directory = mkdtempSync(join(tmpdir(), 'ventriloquist-neutral-'));
  try {
    mkdirSync(join(directory, 'src/protocol'), { recursive: true });
    writeFileSync(join(directory, 'src/protocol/fixture.ts'), source);
    writeFileSync(
      join(directory, 'tsconfig.json'),
      JSON.stringify({
        extends: join(packageRoot, 'tsconfig.neutral.json'),
        include: [join(directory, 'src/**/*.ts')],
        exclude: [],
      }),
    );
    const result = Bun.spawnSync(
      [process.execPath, typescriptCompiler, '--noEmit', '--pretty', 'false', '-p', directory],
      { cwd: packageRoot, timeout: SCENARIO_HANG_GUARD_MILLISECONDS },
    );
    return {
      exitCode: result.exitCode,
      output: result.stdout.toString() + result.stderr.toString(),
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

// Each type-check starts a real `tsc` process, so it runs once at module scope, off Bun's
// five-second per-test clock; its test rethrows whatever the scenario threw.
const acceptsEcmaScriptOnly = await outcomeOf(() => {
  const { exitCode, output } = checkNeutral('export const doubled = [1, 2].map((n) => n * 2);\n');
  expect(output).toBe('');
  expect(exitCode).toBe(0);
});

const rejectedReferences: [string, string, string][] = [
  ['Bun', 'export const version: string = Bun.version;\n', "Cannot find name 'Bun'"],
  ['process', 'export const platform: string = process.platform;\n', "Cannot find name 'process'"],
  [
    'a DOM global',
    'export const href: string = document.location.href;\n',
    "Cannot find name 'document'",
  ],
  [
    'a Bun module',
    "import { file } from 'bun';\nexport const reader = file;\n",
    "Cannot find module 'bun'",
  ],
  [
    'a Node module',
    "import { join } from 'node:path';\nexport const joiner = join;\n",
    "Cannot find name 'node:path'",
  ],
];

const rejectedOutcomes: [string, unknown][] = [];
for (const [name, source, message] of rejectedReferences) {
  rejectedOutcomes.push([
    name,
    await outcomeOf(() => {
      const { exitCode, output } = checkNeutral(source);
      expect(exitCode).not.toBe(0);
      expect(output).toContain(message);
    }),
  ]);
}

describe('platform-neutral TypeScript program', () => {
  test('accepts source that uses only the ECMAScript library', () =>
    rethrow(acceptsEcmaScriptOnly));

  test.each(rejectedOutcomes)('rejects a reference to %s', (_name, outcome) => rethrow(outcome));
});
