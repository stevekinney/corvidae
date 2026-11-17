import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

const readOutcome = await outcomeOf(async () => {
  const directory = mkdtempSync(join(tmpdir(), 'outcome-accounting-read-'));
  const record = join(directory, 'missing.json');
  try {
    const result = await runWithHangGuard([
      'bun',
      '--no-install',
      'scripts/chef/outcome-accounting.ts',
      'read',
      record,
      'outcome',
    ]);
    expect(result.exitCode).toBe(1);
    expect(existsSync(record)).toBe(false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

const unknownOutcome = await outcomeOf(async () => {
  const directory = mkdtempSync(join(tmpdir(), 'outcome-accounting-unknown-'));
  const record = join(directory, 'record.json');
  try {
    const initialize = await runWithHangGuard([
      'bun',
      '--no-install',
      'scripts/chef/outcome-accounting.ts',
      'initialize',
      record,
      'outcome',
    ]);
    if (initialize.exitCode !== 0) throw new Error(initialize.stderr.toString());
    const reserved = await runWithHangGuard([
      'bun',
      '--no-install',
      'scripts/chef/outcome-accounting.ts',
      'reserve',
      record,
      'outcome',
      'dispatch',
      'unknown',
    ]);
    if (reserved.exitCode !== 0) throw new Error(reserved.stderr.toString());
    const payload = JSON.parse(reserved.stdout.toString());
    expect(payload.admission).toBe('admitted');
    expect(payload.record.operations.dispatch.amount).toBe('unknown');
    const settled = await runWithHangGuard([
      'bun',
      '--no-install',
      'scripts/chef/outcome-accounting.ts',
      'settle',
      record,
      'outcome',
      'dispatch',
      'unknown',
    ]);
    expect(settled.exitCode).toBe(0);
    expect(JSON.parse(settled.stdout.toString()).spentTokens).toBe('unknown');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
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

test('read never initializes a missing accounting record', () => {
  rethrow(readOutcome);
});

test('literal unknown survives reserve and settlement', () => {
  rethrow(unknownOutcome);
});

test('verify-task-bank enforces the frozen policy snapshot provenance', () => {
  rethrow(provenanceOutcome);
});
