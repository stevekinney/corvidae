import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runWithHangGuard } from '../../testing/testing/src/hang-guard.ts';
import { materializeTask, verifyTaskBank, type TaskBank } from './outcome-accounting.ts';

test('rejects a bank whose repaired control changes an oracle', async () => {
  const bank = JSON.parse(await Bun.file('scripts/chef/fixtures/sdlc-task-bank.json').text()) as TaskBank;
  const invalid = structuredClone(bank);
  invalid.tasks[0]!.permittedPaths.push('oracle.ts');
  invalid.tasks[0]!.repairedFiles['oracle.ts'] = 'process.exit(0);';
  expect(verifyTaskBank(invalid)).toContain('local-01 repairs its oracle: oracle.ts.');
  expect(() => materializeTask(invalid.tasks[0]!, process.cwd(), 'repaired')).toThrow(
    'local-01 repairs its oracle: oracle.ts.',
  );
});

test('read never initializes a missing accounting record', async () => {
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
