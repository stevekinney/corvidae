import { expect, test } from 'bun:test';
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
