import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runWithHangGuard, spawnWithHangGuard } from '../../testing/testing/src/hang-guard.ts';
import { rejectionOf } from '../../testing/testing/src/helpers/promise-outcome.ts';
import { waitUntil } from '../../testing/testing/src/wait-until.ts';
import { initialize, reserve, settle } from './outcome-budget.ts';

const script = join(process.cwd(), 'scripts/chef/outcome-accounting.ts');
const run = (...arguments_: string[]) => runWithHangGuard(['bun', script, ...arguments_]);

const allowanceSnapshotScenario = await (async () => {
  const directory = mkdtempSync(join(tmpdir(), 'outcome-budget-allowance-'));
  const allowance = { amount: 4, provenance: 'user' };
  try {
    const pending = initialize(join(directory, 'budget.json'), 'outcome', allowance);
    allowance.amount = -1;
    allowance.provenance = '';
    return await pending;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
})();

test('initialization snapshots a validated allowance before its first await', () => {
  expect(allowanceSnapshotScenario).toMatchObject({
    allowanceTokens: { amount: 4, provenance: 'user' },
  });
});

const restartScenario = await (async () => {
  const directory = mkdtempSync(join(tmpdir(), 'outcome-budget-integration-'));
  const path = join(directory, 'budget.json');
  const initialize = await run('initialize', path, 'outcome', '10', 'owner');
  const first = await run('reserve', path, 'outcome', 'one', '6');
  const denied = await run('reserve', path, 'outcome', 'two', '5');
  const restartedRead = await run('read', path, 'outcome');
  const readOutput = new TextDecoder().decode(restartedRead.stdout);
  rmSync(directory, { recursive: true, force: true });
  return { denied, first, initialize, readOutput, restartedRead };
})();

test('restart retains reservations and a denied reserve starts no dispatch', () => {
  const { denied, first, initialize, readOutput, restartedRead } = restartScenario;
  expect(initialize.exitCode).toBe(0);
  expect(first.exitCode).toBe(0);
  expect(denied.exitCode).toBe(1);
  expect(restartedRead.exitCode).toBe(0);
  expect(readOutput).toContain('"one":{"amount":6,"state":"reserved"}');
});

const concurrencyScenario = await (async () => {
  const concurrentDirectory = mkdtempSync(join(tmpdir(), 'outcome-budget-concurrent-'));
  const concurrentPath = join(concurrentDirectory, 'budget.json');
  await run('initialize', concurrentPath, 'concurrent', '10', 'owner');
  const first = spawnWithHangGuard([
    'bun',
    script,
    'reserve',
    concurrentPath,
    'concurrent',
    'first',
    '6',
  ]);
  const second = spawnWithHangGuard([
    'bun',
    script,
    'reserve',
    concurrentPath,
    'concurrent',
    'second',
    '6',
  ]);
  const exits = await Promise.all([first.exited, second.exited]);
  const record = await run('read', concurrentPath, 'concurrent');
  const recordOutput = new TextDecoder().decode(record.stdout);
  rmSync(concurrentDirectory, { recursive: true, force: true });
  return { exits, recordOutput };
})();

test('two concurrent reservations cannot both exceed one persisted allowance', () => {
  const { exits, recordOutput } = concurrencyScenario;
  expect(exits.toSorted((left, right) => left - right)).toEqual([0, 1]);
  expect(recordOutput).toMatch(
    /"operations":\{"(?:first|second)":\{"amount":6,"state":"reserved"\}\}/,
  );
});

const unknownUsageScenario = await (async () => {
  const directory = mkdtempSync(join(tmpdir(), 'outcome-budget-unknown-'));
  const path = join(directory, 'budget.json');
  await initialize(path, 'unknown');
  const admitted = await reserve(path, 'unknown', 'dispatch', 'unknown');
  const replay = await reserve(path, 'unknown', 'dispatch', 'unknown');
  const settled = await settle(path, 'unknown', 'dispatch', 'unknown');
  const allowancePath = join(directory, 'allowance.json');
  await initialize(allowancePath, 'allowance', { amount: 10, provenance: 'owner' });
  const unknownAllowanceError = await rejectionOf(
    reserve(allowancePath, 'allowance', 'dispatch', 'unknown'),
  );
  rmSync(directory, { recursive: true, force: true });
  return { admitted, replay, settled, unknownAllowanceError };
})();

test('unknown reservation and settlement retain their operation identities without an allowance', () => {
  const { admitted, replay, settled, unknownAllowanceError } = unknownUsageScenario;
  expect(admitted).toMatchObject({
    admission: 'admitted',
    record: { operations: { dispatch: { amount: 'unknown', state: 'reserved' } } },
  });
  expect(replay).toMatchObject({ admission: 'replay' });
  expect(settled).toMatchObject({
    spentTokens: 'unknown',
    operations: { dispatch: { actual: 'unknown', amount: 'unknown', state: 'settled' } },
  });
  expect((unknownAllowanceError as Error).message).toContain(
    'Unknown reservation cannot use an allowance',
  );
});

async function interruptReserveAtReplacement(
  path: string,
  operation: string,
  ready: string,
  afterRename: boolean,
): Promise<void> {
  const fixture = `${path}.${operation}.fixture.ts`;
  await writeFile(
    fixture,
    `import { rename, writeFile } from 'node:fs/promises';
import { reserve } from ${JSON.stringify(join(process.cwd(), 'scripts/chef/outcome-budget.ts'))};
const [path, operation, ready] = process.argv.slice(2);
await reserve(path!, 'interrupted', operation!, 4, {
  replace: async (temporary, destination) => {
    ${afterRename ? 'await rename(temporary, destination);' : ''}
    await writeFile(ready!, 'ready');
    await new Promise<void>(() => {});
  },
});
`,
  );
  const child = spawnWithHangGuard([process.execPath, fixture, path, operation, ready], {
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  try {
    await waitUntil(async () => await Bun.file(ready).exists(), {
      message: 'the reserve writer to reach its replacement barrier',
    });
    child.kill('SIGTERM');
    expect(await child.exited).toBe(143);
  } finally {
    await Bun.file(fixture).delete();
  }
}

async function interruptInitializeAtReplacement(
  path: string,
  ready: string,
  afterRename: boolean,
): Promise<void> {
  const fixture = `${path}.initialize.fixture.ts`;
  await writeFile(
    fixture,
    `import { rename, writeFile } from 'node:fs/promises';
import { initialize } from ${JSON.stringify(join(process.cwd(), 'scripts/chef/outcome-budget.ts'))};
const [path, ready] = process.argv.slice(2);
await initialize(path!, 'initialized', { amount: 10, provenance: 'owner' }, {
  replace: async (temporary, destination) => {
    ${afterRename ? 'await rename(temporary, destination);' : ''}
    await writeFile(ready!, 'ready');
    await new Promise<void>(() => {});
  },
});
`,
  );
  const child = spawnWithHangGuard([process.execPath, fixture, path, ready], {
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  try {
    await waitUntil(async () => await Bun.file(ready).exists(), {
      message: 'the initialize writer to reach its replacement barrier',
    });
    child.kill('SIGTERM');
    expect(await child.exited).toBe(143);
  } finally {
    await Bun.file(fixture).delete();
  }
}

const interruptedReserveScenario = await (async () => {
  const interruptedDirectory = mkdtempSync(join(tmpdir(), 'outcome-budget-interrupted-'));
  const interruptedPath = join(interruptedDirectory, 'budget.json');
  await run('initialize', interruptedPath, 'interrupted', '10', 'owner');
  const beforeRenameReady = join(interruptedDirectory, 'before-rename-ready');
  await interruptReserveAtReplacement(interruptedPath, 'before-rename', beforeRenameReady, false);
  const prior = await run('read', interruptedPath, 'interrupted');
  const afterRenameReady = join(interruptedDirectory, 'after-rename-ready');
  await interruptReserveAtReplacement(interruptedPath, 'after-rename', afterRenameReady, true);
  const next = await run('read', interruptedPath, 'interrupted');
  const priorOutput = new TextDecoder().decode(prior.stdout);
  const nextOutput = new TextDecoder().decode(next.stdout);
  rmSync(interruptedDirectory, { recursive: true, force: true });
  return { next, nextOutput, prior, priorOutput };
})();

test('interrupted real reserve replacement preserves either complete record', () => {
  const { next, nextOutput, prior, priorOutput } = interruptedReserveScenario;
  expect(prior.exitCode).toBe(0);
  expect(priorOutput).not.toContain('before-rename');
  expect(next.exitCode).toBe(0);
  expect(nextOutput).toContain('"after-rename":{"amount":4,"state":"reserved"}');
});

const interruptedInitializeScenario = await (async () => {
  const directory = mkdtempSync(join(tmpdir(), 'outcome-budget-initialize-'));
  const beforeRenamePath = join(directory, 'before-rename.json');
  await interruptInitializeAtReplacement(
    beforeRenamePath,
    join(directory, 'before-rename-ready'),
    false,
  );
  const resumed = await run('initialize', beforeRenamePath, 'initialized', '10', 'owner');
  const afterRenamePath = join(directory, 'after-rename.json');
  await interruptInitializeAtReplacement(
    afterRenamePath,
    join(directory, 'after-rename-ready'),
    true,
  );
  const next = await run('read', afterRenamePath, 'initialized');
  const resumedOutput = new TextDecoder().decode(resumed.stdout);
  const nextOutput = new TextDecoder().decode(next.stdout);
  rmSync(directory, { recursive: true, force: true });
  return { next, nextOutput, resumed, resumedOutput };
})();

test('interrupted initialization stages records before atomically replacing them', () => {
  const { next, nextOutput, resumed, resumedOutput } = interruptedInitializeScenario;
  expect(resumed.exitCode).toBe(0);
  expect(resumedOutput).toContain('"spentTokens":0');
  expect(next.exitCode).toBe(0);
  expect(nextOutput).toContain('"outcomeId":"initialized"');
});
