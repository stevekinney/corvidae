import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runWithHangGuard } from '../../testing/testing/src/hang-guard.ts';
import { materializeTask, type TaskBank, type TaskControl } from './outcome-accounting.ts';

const scratch = mkdtempSync(join(tmpdir(), 'task-bank-local-'));
const bank = JSON.parse(await Bun.file('scripts/chef/fixtures/sdlc-task-bank.json').text()) as TaskBank;

async function execute(taskId: string, control: TaskControl): Promise<number | null> {
  const task = bank.tasks.find((entry) => entry.id === taskId);
  if (task === undefined) throw new Error(`Missing ${taskId}.`);
  const root = materializeTask(task, scratch, control);
  const result = await runWithHangGuard(['bun', '--no-install', ...task.oracleArgv], { cwd: root });
  return result.exitCode;
}

test('local fixtures reject buggy and empty candidates while accepting repairs', async () => {
  for (const taskId of ['local-01', 'local-02']) {
    expect(await execute(taskId, 'buggy')).toBe(1);
    expect(await execute(taskId, 'empty')).toBe(1);
    expect(await execute(taskId, 'repaired')).toBe(0);
  }
});

test('the materializer never allows an oracle replacement or filesystem escape', () => {
  const task = structuredClone(bank.tasks[0]!);
  task.repairedFiles['oracle.ts'] = 'process.exit(0);';
  expect(() => materializeTask(task, scratch, 'repaired')).toThrow('repairs unpermitted path');
  task.repairedFiles = {};
  task.files['../escape.ts'] = 'bad';
  expect(() => materializeTask(task, scratch, 'buggy')).toThrow('unsafe file path');
});

rmSync(scratch, { recursive: true, force: true });
