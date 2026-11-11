import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { spawnWithHangGuard } from '../testing/testing/src/hang-guard.ts';
import { waitUntil } from '../testing/testing/src/wait-until.ts';
import { slotDirectory, type SlotOwner } from './bun-test-pool.ts';
import {
  parseHostSlotsArguments,
  withHostSlots,
  type HostSlots,
  type HostSlotsOptions,
} from './host-slots.ts';
import { outcomeOf, rethrow } from './module-scope-scenario.test-support.ts';
import { ownerFileName } from './run-exclusively.ts';

/**
 * The host-slot helper's scenarios. Each owns a scratch pool, never the real Git common directory,
 * and reads the real process table, since a holder is judged by its real pid and start time. Every
 * scenario runs once at module scope, where no per-test clock applies, and its test rethrows what
 * it recorded; waiting is on state, through `waitUntil` and a poll that yields a turn instead of
 * sleeping (COR-1392, COR-1507).
 */
const scratchDirectories: string[] = [];
const processGroups: number[] = [];

afterAll(async () => {
  for (const group of processGroups) killGroup(group);
  for (const directory of scratchDirectories) await rm(directory, { recursive: true, force: true });
});

function killGroup(processGroup: number): void {
  try {
    process.kill(-processGroup, 'SIGKILL');
  } catch {
    // Already gone.
  }
}

function isGroupAlive(processGroup: number): boolean {
  try {
    process.kill(-processGroup, 0);
    return true;
  } catch {
    return false;
  }
}

/** A waiter's poll: one filesystem round trip, which lets every other waiter run, and no clock. */
const turn = async (): Promise<void> => {
  await stat(tmpdir());
};

const neverSleep = async (): Promise<void> => {
  throw new Error('the run waited for slots');
};

function inScratchPool(body: (pool: string) => Promise<void>): Promise<unknown> {
  return outcomeOf(async () => {
    const directory = await mkdtemp(join(tmpdir(), 'corvidae-host-slots-'));
    scratchDirectories.push(directory);
    await body(join(directory, 'pool'));
  });
}

function poolOptions(pool: string, size: number, more: HostSlotsOptions = {}): HostSlotsOptions {
  return { poolDirectory: pool, size, environment: {}, sleep: turn, report: () => {}, ...more };
}

async function heldSlots(pool: string): Promise<number> {
  const names = await readdir(pool).catch(() => [] as string[]);
  return names.filter((name) => /^slot-\d+$/.test(name)).length;
}

async function slotOwner(pool: string, index: number): Promise<SlotOwner | undefined> {
  const contents = await readFile(join(slotDirectory(pool, index), ownerFileName), 'utf8').catch(
    () => '',
  );
  return contents === '' ? undefined : (JSON.parse(contents) as SlotOwner);
}

/** Writes a fixture beside the pool that runs `body` with the helper imported, and starts it. */
async function startFixture(pool: string, body: string) {
  const fixture = join(pool, '..', 'holder.ts');
  await writeFile(
    fixture,
    `import { runWithHostSlots, withHostSlots } from ${JSON.stringify(join(import.meta.dir, 'host-slots.ts'))};
const options = { poolDirectory: process.argv[2], size: 2, report: () => {} };
${body}
`,
  );
  return spawnWithHangGuard([process.execPath, fixture, pool], {
    stdio: ['ignore', 'ignore', 'inherit'],
  });
}

const secondHolderWaitsForTheFirst = await inScratchPool(async (pool) => {
  const { promise: firstMayFinish, resolve: finishFirst } = Promise.withResolvers<void>();
  const { promise: firstHolds, resolve: markFirstHolds } = Promise.withResolvers<void>();
  const first = withHostSlots(
    2,
    async (slots) => {
      markFirstHolds();
      await firstMayFinish;
      return slots;
    },
    poolOptions(pool, 2),
  );
  await firstHolds;
  let secondWaited = false;
  let secondRan = false;
  const second = withHostSlots(
    1,
    async (slots) => {
      secondRan = true;
      return { slots, held: await heldSlots(pool) };
    },
    poolOptions(pool, 2, {
      report: (line) => {
        if (line.includes('waiting for 1 of 2 test slots')) secondWaited = true;
      },
    }),
  );
  await waitUntil(() => secondWaited, { message: 'the second holder waits on the first' });
  expect(secondRan).toBe(false);
  expect(await heldSlots(pool)).toBe(2);
  finishFirst();
  const firstSlots = await first;
  expect(firstSlots.count).toBe(2);
  const outcome = await second;
  expect(outcome.slots.admission).toBe('held');
  expect(outcome.slots.count).toBe(1);
  expect(outcome.held).toBe(1);
  expect(await heldSlots(pool)).toBe(0);
});

const nestedRunDoesNotDoubleAdmit = await inScratchPool(async (pool) => {
  const outcome = await withHostSlots(
    2,
    async (outer) => {
      const inner = await withHostSlots(3, async (slots) => slots, {
        ...poolOptions(pool, 2, { sleep: neverSleep }),
        environment: outer.environment,
      });
      return { outer, inner, held: await heldSlots(pool) };
    },
    poolOptions(pool, 2),
  );
  expect(outcome.outer.admission).toBe('held');
  expect(outcome.inner.admission).toBe('nested');
  // The nested run keeps the parent's slots busy, never more than the parent holds.
  expect(outcome.inner.count).toBe(2);
  expect(outcome.inner.environment).toEqual(outcome.outer.environment);
  expect(outcome.held).toBe(2);
});

const staleTokenDoesNotBypass = await inScratchPool(async (pool) => {
  let observed: HostSlots | undefined;
  await withHostSlots(
    1,
    async (slots) => {
      observed = slots;
    },
    poolOptions(pool, 2, {
      environment: { CORVIDAE_TEST_SLOTS_TOKEN: 'a token no live slot names' },
    }),
  );
  expect(observed?.admission).toBe('held');
});

const killedHolderIsReclaimed = await inScratchPool(async (pool) => {
  const holder = await startFixture(
    pool,
    'await withHostSlots(2, () => new Promise(() => {}), options);',
  );
  await waitUntil(
    async () => {
      const owner = await slotOwner(pool, 1);
      return owner?.pid === holder.pid;
    },
    { message: 'the holder took both slots' },
  );
  holder.kill('SIGKILL');
  await holder.exited;
  const reclaimed = await withHostSlots(
    2,
    async (slots) => ({ slots, owner: await slotOwner(pool, 0) }),
    poolOptions(pool, 2),
  );
  expect(reclaimed.slots.admission).toBe('held');
  expect(reclaimed.slots.count).toBe(2);
  expect(reclaimed.owner?.pid).toBe(process.pid);
});

const killedWrapperKeepsSlotsWhileItsGroupLives = await inScratchPool(async (pool) => {
  const wrapper = await startFixture(
    pool,
    "process.exitCode = await runWithHostSlots(2, ['sh', '-c', 'exec tail -f /dev/null'], options);",
  );
  let processGroup: number | undefined;
  await waitUntil(
    async () => {
      const owner = await slotOwner(pool, 1);
      processGroup = owner?.processGroup;
      return processGroup !== undefined;
    },
    { message: 'the wrapper recorded its command group' },
  );
  if (processGroup === undefined) throw new Error('unreachable');
  processGroups.push(processGroup);
  wrapper.kill('SIGKILL');
  await wrapper.exited;
  expect(isGroupAlive(processGroup)).toBe(true);
  // The group still runs, so its slots are still held: the next run waits for them.
  let waiting = false;
  let ran = false;
  const next = withHostSlots(
    2,
    async (slots) => {
      ran = true;
      return slots;
    },
    poolOptions(pool, 2, {
      report: (line) => {
        if (line.includes('waiting for 2 of 2 test slots')) waiting = true;
      },
    }),
  );
  await waitUntil(() => waiting, { message: "the next run waits on the killed wrapper's group" });
  expect(ran).toBe(false);
  killGroup(processGroup);
  const afterwards = await next;
  expect(afterwards.admission).toBe('held');
  expect(afterwards.count).toBe(2);
});

describe('host slots', () => {
  test('a second concurrent holder waits, and proceeds once the first releases', () =>
    rethrow(secondHolderWaitsForTheFirst));
  test('a run nested in a holder runs inside its slots instead of acquiring more', () =>
    rethrow(nestedRunDoesNotDoubleAdmit));
  test('a token naming no live holder does not bypass the pool', () =>
    rethrow(staleTokenDoesNotBypass));
  test('a holder killed outright has its slots reclaimed by the next run', () =>
    rethrow(killedHolderIsReclaimed));
  test('a killed wrapper keeps its slots while its command group lives, then frees them', () =>
    rethrow(killedWrapperKeepsSlotsWhileItsGroupLives));

  test('parses the slot count and the command', () => {
    expect(parseHostSlotsArguments(['--slots=4', '--', 'bun', 'x'])).toEqual({
      slots: 4,
      command: ['bun', 'x'],
    });
    for (const invalid of [
      ['--slots=0', '--', 'x'],
      ['--slots=2'],
      ['--', 'x'],
      ['--slots=2', '--'],
    ]) {
      expect(parseHostSlotsArguments(invalid)).toHaveProperty('error');
    }
  });

  test('every Playwright script outside the host lock takes host slots', async () => {
    const root = join(import.meta.dir, '..');
    const manifests = ['package.json'];
    for await (const path of new Bun.Glob(
      '{applications,components,packages,testing,internal,plugins}/*/package.json',
    ).scan({ cwd: root })) {
      manifests.push(path);
    }
    const uncovered: string[] = [];
    let checked = 0;
    for (const manifest of manifests) {
      const parsed: { scripts?: Record<string, string> } = await Bun.file(
        join(root, manifest),
      ).json();
      for (const [name, command] of Object.entries(parsed.scripts ?? {})) {
        if (!/playwright test|run-terminal-browser\.ts/.test(command)) continue;
        checked += 1;
        const locked = /run-exclusively\.ts '/.test(command);
        if (!locked && !/host-slots\.ts --slots=\d+ -- /.test(command)) {
          uncovered.push(`${manifest} ${name}`);
        }
      }
    }
    expect(checked).toBeGreaterThan(0);
    expect(uncovered).toEqual([]);
  });
});
