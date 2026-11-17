import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const directory = mkdtempSync(join(tmpdir(), 'outcome-budget-integration-'));
const path = join(directory, 'budget.json');
const script = join(process.cwd(), 'scripts/chef/outcome-accounting.ts');
const run = (...arguments_: string[]) => Bun.spawnSync(['bun', script, ...arguments_]);
const initialize = run('initialize', path, 'outcome', '10', 'owner');
const first = run('reserve', path, 'outcome', 'one', '6');
const denied = run('reserve', path, 'outcome', 'two', '5');
const restartedRead = run('read', path, 'outcome');
rmSync(directory, { recursive: true, force: true });

test('restart retains reservations and a denied reserve starts no dispatch', () => {
  expect(initialize.exitCode).toBe(0);
  expect(first.exitCode).toBe(0);
  expect(denied.exitCode).toBe(1);
  expect(restartedRead.exitCode).toBe(0);
  expect(new TextDecoder().decode(restartedRead.stdout)).toContain('"one":6');
});

test('two concurrent reservations cannot both exceed one persisted allowance', async () => {
  const concurrentDirectory = mkdtempSync(join(tmpdir(), 'outcome-budget-concurrent-'));
  const concurrentPath = join(concurrentDirectory, 'budget.json');
  run('initialize', concurrentPath, 'concurrent', '10', 'owner');
  const first = Bun.spawn(['bun', script, 'reserve', concurrentPath, 'concurrent', 'first', '6']);
  const second = Bun.spawn(['bun', script, 'reserve', concurrentPath, 'concurrent', 'second', '6']);
  const exits = await Promise.all([first.exited, second.exited]);
  const record = run('read', concurrentPath, 'concurrent');
  rmSync(concurrentDirectory, { recursive: true, force: true });
  expect(exits.toSorted((left, right) => left - right)).toEqual([0, 1]);
  expect(new TextDecoder().decode(record.stdout)).toMatch(
    /"reservations":\{"(?:first|second)":6\}/,
  );
});

test('an interrupted replacement leaves the prior complete record readable', () => {
  const interruptedDirectory = mkdtempSync(join(tmpdir(), 'outcome-budget-interrupted-'));
  const interruptedPath = join(interruptedDirectory, 'budget.json');
  run('initialize', interruptedPath, 'interrupted', '10', 'owner');
  writeFileSync(`${interruptedPath}.999.complete`, '{"version":1');
  const result = run('read', interruptedPath, 'interrupted');
  rmSync(interruptedDirectory, { recursive: true, force: true });
  expect(result.exitCode).toBe(0);
  expect(new TextDecoder().decode(result.stdout)).toContain('"spentTokens":0');
});
