/**
 * Every way this repository starts Turborepo runs at one task-concurrency cap (COR-2368).
 *
 * A fixture workspace of eight independent tasks, each recording when it starts and ends, runs
 * through the four paths a worker or an agent uses: a bare `turbo run`, the environment the
 * `run-exclusively` wrapper builds, `scripts/affected-tests.ts`'s runner, and the command
 * `scripts/chef/focused-checks.ts` plans. The fixture takes its `concurrency` from this
 * repository's real `turbo.json`, so removing the key fails the bare paths. Every inherited
 * `TURBO_*` variable is dropped first: under `bun run validate` the wrapper's `TURBO_CONCURRENCY`
 * would otherwise cap the run and hide a missing configuration.
 *
 * A task holds for a fixed pause so that tasks the cap lets overlap do overlap. A loaded host can
 * start a task late and so only lower the peak the test sees, never raise it: the assertion is an
 * upper bound, so load cannot fail it and a cap that does not hold shows on a quiet host. Each
 * path runs once at module scope, where no per-test timeout applies, and its test rethrows what
 * the scenario recorded.
 */

import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { cpus, tmpdir, totalmem } from 'node:os';
import { join } from 'node:path';

import { spawnWithHangGuard } from '../testing/testing/src/hang-guard.ts';
import { turbo as runTurbo } from './affected-tests.ts';
import { planSteps } from './chef/focused-checks.ts';
import { outcomeOf, rethrow } from './module-scope-scenario.test-support.ts';
import { withTurborepoDefaults } from './run-exclusively.ts';

const root = join(import.meta.dir, '..');
const turboBinary = join(root, 'node_modules/.bin/turbo');
const taskCount = 8;

/** The percentage of processors `turbo.json` allows, as a number. */
function configuredPercentage(): number {
  const { concurrency } = JSON.parse(readFileSync(join(root, 'turbo.json'), 'utf8')) as {
    concurrency?: string;
  };
  expect(concurrency).toMatch(/^\d+%$/);
  return Number.parseInt(concurrency as string, 10);
}

/** The cap `turbo.json`'s percentage gives on this host: rounded down, and at least one. */
function configuredCap(): number {
  return Math.max(1, Math.floor((cpus().length * configuredPercentage()) / 100));
}

/** The environment of a run: no inherited `TURBO_*`, plus the log the fixture's tasks write. */
function cleanEnvironment(
  logPath: string,
  extra: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  const environment: Record<string, string | undefined> = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (key.startsWith('TURBO_')) delete environment[key];
  }
  return { ...environment, OVERLAP_LOG: logPath, ...extra };
}

async function createFixture(directory: string): Promise<void> {
  const repositoryConfiguration = JSON.parse(await readFile(join(root, 'turbo.json'), 'utf8')) as {
    concurrency?: string;
  };
  await writeFile(
    join(directory, 'package.json'),
    JSON.stringify({
      name: 'turbo-concurrency-fixture',
      private: true,
      workspaces: ['packages/*'],
      packageManager: 'bun@1.4.4',
    }),
  );
  await writeFile(
    join(directory, 'turbo.json'),
    JSON.stringify({
      $schema: 'https://turbo.build/schema.json',
      concurrency: repositoryConfiguration.concurrency,
      tasks: { work: { cache: false, passThroughEnv: ['OVERLAP_LOG'] } },
    }),
  );
  await writeFile(
    join(directory, 'record.ts'),
    `import { appendFileSync } from 'node:fs';
const log = process.env.OVERLAP_LOG!;
appendFileSync(log, \`start \${Date.now()}\\n\`);
await Bun.sleep(600);
appendFileSync(log, \`end \${Date.now()}\\n\`);
`,
  );
  for (let index = 1; index <= taskCount; index += 1) {
    await mkdir(join(directory, 'packages', `task-${index}`), { recursive: true });
    await writeFile(
      join(directory, 'packages', `task-${index}`, 'package.json'),
      JSON.stringify({
        name: `@fixture/task-${index}`,
        private: true,
        scripts: { work: 'bun ../../record.ts' },
      }),
    );
  }
  const install = spawnWithHangGuard([process.execPath, 'install'], {
    cwd: directory,
    stdout: 'ignore',
    stderr: 'ignore',
    env: cleanEnvironment(join(directory, 'overlap.log')),
  });
  expect(await install.exited).toBe(0);
  await mkdir(join(directory, 'node_modules/.bin'), { recursive: true });
  await symlink(turboBinary, join(directory, 'node_modules/.bin/turbo'));
}

/** The most tasks that ran at once, from the recorded starts and ends. */
async function peakOverlap(logPath: string): Promise<number> {
  const text = await readFile(logPath, 'utf8');
  const events = text
    .trim()
    .split('\n')
    .map((line) => {
      const [kind, at] = line.split(' ') as [string, string];
      return { delta: kind === 'start' ? 1 : -1, at: Number(at) };
    })
    // A start sorts before an end at the same millisecond, which can only overstate the peak.
    .toSorted((a, b) => a.at - b.at || b.delta - a.delta);
  expect(events.length).toBe(taskCount * 2);
  let running = 0;
  let peak = 0;
  for (const { delta } of events) {
    running += delta;
    peak = Math.max(peak, running);
  }
  return peak;
}

const directory = await mkdtemp(join(tmpdir(), 'corvidae-turbo-concurrency-'));
const logPath = join(directory, 'overlap.log');

/** Runs one path in the fixture and returns the peak overlap it produced. */
async function measure(
  start: (environment: Record<string, string | undefined>) => Promise<number> | number,
  extra?: Record<string, string | undefined>,
): Promise<number> {
  await writeFile(logPath, '');
  expect(await start(cleanEnvironment(logPath, extra))).toBe(0);
  return peakOverlap(logPath);
}

function spawnInFixture(
  command: string[],
  environment: Record<string, string | undefined>,
): Promise<number> {
  const child = spawnWithHangGuard(command, {
    cwd: directory,
    stdout: 'ignore',
    stderr: 'ignore',
    env: environment,
  });
  return child.exited;
}

const setup = await outcomeOf(() => createFixture(directory));

const bare = await outcomeOf(async () => {
  rethrow(setup);
  const peak = await measure((environment) =>
    spawnInFixture([turboBinary, 'run', 'work'], environment),
  );
  expect(peak).toBeLessThanOrEqual(configuredCap());
});

const wrapped = await outcomeOf(async () => {
  rethrow(setup);
  const host = { totalMemoryBytes: totalmem(), processors: cpus().length };
  for (const shared of [false, true]) {
    const concurrency = withTurborepoDefaults({}, host, shared)['TURBO_CONCURRENCY'];
    const peak = await measure((environment) =>
      spawnInFixture([turboBinary, 'run', 'work'], {
        ...environment,
        TURBO_CONCURRENCY: concurrency,
      }),
    );
    expect(peak).toBeLessThanOrEqual(Number(concurrency));
  }
});

const affectedTests = await outcomeOf(async () => {
  rethrow(setup);
  const peak = await measure((environment) => runTurbo(['work'], environment, directory));
  expect(peak).toBeLessThanOrEqual(configuredCap());
});

const focusedChecks = await outcomeOf(async () => {
  rethrow(setup);
  const step = planSteps({
    changed: ['packages/example/src/index.ts'],
    existing: [],
    workspaces: [{ name: '@fixture/example', directory: 'packages/example' }],
    base: 'origin/main',
    selectsIsolatedTest: false,
  }).find((planned) => planned.name === 'turbo');
  expect(step).toBeDefined();
  // The planned launcher and `run`, with the fixture's task in place of lint and type-check.
  const launcher = (step as { command: string[] }).command.slice(0, 3);
  expect(launcher).toEqual(['bunx', 'turbo', 'run']);
  const peak = await measure((environment) => spawnInFixture([...launcher, 'work'], environment));
  expect(peak).toBeLessThanOrEqual(configuredCap());
});

// Turborepo refuses to start persistent tasks unless its concurrency exceeds their count, and the
// percentage above gives one task on a host of five or fewer processors. `dev` runs outside the
// wrapper, so only its own flag (which beats the variable and `turbo.json`) keeps it startable.
const developmentScript = await outcomeOf(async () => {
  const { scripts } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };
  const command = scripts['dev'] as string;
  const dry = spawnWithHangGuard(
    [
      turboBinary,
      ...command
        .replace(/^turbo /, '')
        .split(' ')
        .filter((word) => !word.startsWith('--concurrency')),
      '--dry=json',
    ],
    { cwd: root, stdout: 'pipe', stderr: 'ignore', env: cleanEnvironment(logPath) },
  );
  const plan = JSON.parse(await new Response(dry.stdout).text()) as {
    tasks: { resolvedTaskDefinition: { persistent: boolean } }[];
  };
  const persistent = plan.tasks.filter((task) => task.resolvedTaskDefinition.persistent).length;
  expect(persistent).toBeGreaterThan(0);
  const concurrency = /--concurrency=(\d+)/.exec(command)?.[1];
  expect(concurrency).toBeDefined();
  expect(Number(concurrency)).toBeGreaterThan(persistent);
});

const explicitFlag = await outcomeOf(async () => {
  rethrow(setup);
  const peak = await measure((environment) =>
    spawnInFixture([turboBinary, 'run', 'work', '--concurrency=1'], environment),
  );
  expect(peak).toBe(1);
});

await rm(directory, { recursive: true, force: true });

test('the repository allows at most one task per three processors', () => {
  // One task per three processors is 4 on a 12-core host, the cap a worker may use.
  expect(configuredPercentage()).toBeLessThanOrEqual(34);
});

test('a bare turbo run stays within the configured cap', () => rethrow(bare));

test("a run under the wrapper's environment stays within its host-derived cap, half of it when shared", () =>
  rethrow(wrapped));

test("affected-tests.ts's runner stays within the configured cap", () => rethrow(affectedTests));

test('the command focused-checks.ts plans stays within the configured cap', () =>
  rethrow(focusedChecks));

test('the root dev script passes a concurrency above its persistent-task count', () =>
  rethrow(developmentScript));

test('an explicit --concurrency=1 still wins over the configured cap', () => rethrow(explicitFlag));
