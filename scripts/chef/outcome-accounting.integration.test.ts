import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runWithHangGuard } from '../../testing/testing/src/hang-guard.ts';
import { outcomeOf, rethrow } from '../module-scope-scenario.test-support.ts';
import { materializeTask, verifyTaskBank, type TaskBank } from './outcome-accounting.ts';

test('rejects a bank whose repaired control changes an oracle', async () => {
  const bank = JSON.parse(
    await Bun.file('scripts/chef/fixtures/sdlc-task-bank.json').text(),
  ) as TaskBank;
  const invalid = structuredClone(bank);
  invalid.tasks[0]!.permittedPaths.push('oracle.ts');
  invalid.tasks[0]!.repairedFiles['oracle.ts'] = 'process.exit(0);';
  expect(verifyTaskBank(invalid)).toContain('local-01 permits its oracle: oracle.ts.');
  expect(() => materializeTask(invalid.tasks[0]!, process.cwd(), 'repaired')).toThrow(
    'local-01 permits its oracle: oracle.ts.',
  );
});

const provenanceOutcome = await outcomeOf(async () => {
  mkdirSync(join(process.cwd(), 'tmp/chef'), { recursive: true });
  const directory = mkdtempSync(join(process.cwd(), 'tmp/chef/outcome-accounting-provenance-'));
  const manifest = join(directory, 'task-bank.json');
  const bank = JSON.parse(
    readFileSync('scripts/chef/fixtures/sdlc-task-bank.json', 'utf8'),
  ) as TaskBank;
  const verify = async (candidate: TaskBank, expectedExitCode: number) => {
    writeFileSync(manifest, JSON.stringify(candidate));
    const result = await runWithHangGuard([
      'bun',
      '--no-install',
      'scripts/chef/outcome-accounting.ts',
      'verify-task-bank',
      manifest,
    ]);
    expect(result.exitCode).toBe(expectedExitCode);
    return result;
  };
  try {
    await verify(bank, 0);
    const wrongDigest = structuredClone(bank);
    wrongDigest.policySnapshot =
      'scripts/chef/fixtures/sdlc-policy-baseline.json@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    await verify(wrongDigest, 1);
    const traversal = structuredClone(bank);
    traversal.policySnapshot = `../${bank.policySnapshot}`;
    await verify(traversal, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('verify-task-bank enforces the frozen policy snapshot provenance', () => {
  rethrow(provenanceOutcome);
});
