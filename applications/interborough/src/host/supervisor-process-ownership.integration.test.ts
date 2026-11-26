/**
 * What the supervisor does with the process it owns (COR-2757), at its own boundary: started in a
 * checkout it takes the scoped lease and retires it on a clean stop; `cleanup` retires only the
 * verified group of a supervisor that was killed, and does it harmlessly twice; a lease whose owner
 * pid was reused, or whose owner is another worktree's, is refused and leaves the unrelated process
 * alive; and a packaged supervisor started outside a checkout takes no lease and needs none of the
 * repository's scripts, because it is bundled apart from them and run from a directory with none.
 *
 * Each scenario runs at module scope, under the hang guard, so it is not on Bun's per-test clock;
 * the tests assert on what it recorded. The lease's own states are in the library's matrix
 * (`packages/process-lease`).
 */
import {
  isProcessAlive,
  processStartTime,
  readOwner,
  verifiedGate,
  type OwnerRecord,
} from '@lostgradient/process-lease';
import { runWithHangGuard, spawnWithHangGuard } from '@lostgradient/testing/hang-guard';
import { waitUntil } from '@lostgradient/testing/wait-until';
import { afterAll, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { isBuiltin } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { processEnvironment } from './environment-configuration.ts';
import { OWNERSHIP_READY_VARIABLE } from './supervisor-process-ownership.test-support.ts';
import { runSupervisor, supervisorLeaseIdentity } from './supervisor.ts';

const supervisorEntry = join(import.meta.dir, 'supervisor.ts');
const standInHost = join(import.meta.dir, 'supervisor-process-ownership.test-support.ts');
const leaseName = /^interborough-supervisor-[0-9a-f]{64}\.lock$/;

const scratchDirectories: string[] = [];
const livePids = new Set<number>();
afterAll(() => {
  for (const pid of livePids) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone, which is what cleanup wants.
    }
  }
  for (const directory of scratchDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function scratch(name: string): string {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), `interborough-ownership-${name}-`)));
  scratchDirectories.push(directory);
  return directory;
}

/** The parent's environment without anything that could point a child at real state. */
function scrubbedEnvironment(extra: Record<string, string>): Record<string, string> {
  const kept = Object.entries(processEnvironment()).filter(
    (entry): entry is [string, string] =>
      entry[1] !== undefined &&
      !entry[0].startsWith('INTERBOROUGH_') &&
      !entry[0].startsWith('GIT_') &&
      !entry[0].startsWith('OWNERSHIP_'),
  );
  return { ...Object.fromEntries(kept), ...extra };
}

type Started = {
  readonly supervisor: ReturnType<typeof spawnWithHangGuard>;
  readonly hostPid: number;
  readonly environment: Record<string, string>;
};

/** Start the real supervisor in `directory` around the stand-in host, once the host is running. */
async function startSupervisor(
  command: readonly string[],
  directory: string,
  home: string,
  extra: Record<string, string> = {},
): Promise<Started> {
  const ready = join(home, 'ready');
  mkdirSync(home, { recursive: true });
  const environment = scrubbedEnvironment({
    INTERBOROUGH_HOME: home,
    INTERBOROUGH_PORT: '0',
    [OWNERSHIP_READY_VARIABLE]: ready,
    ...extra,
  });
  const supervisor = spawnWithHangGuard([...command], {
    cwd: directory,
    env: environment,
    stdout: 'ignore',
    stderr: 'ignore',
  });
  livePids.add(supervisor.pid);
  await waitUntil(() => existsSync(ready), { message: 'the stand-in host to run' });
  const hostPid = Number(readFileSync(ready, 'utf8'));
  livePids.add(hostPid);
  return { supervisor, hostPid, environment };
}

function groupAlive(group: number): boolean {
  try {
    process.kill(-group, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function sleeper() {
  const child = spawnWithHangGuard([process.execPath, '-e', 'setInterval(() => {}, 1000)'], {
    stdout: 'ignore',
    stderr: 'ignore',
  });
  livePids.add(child.pid);
  return child;
}

const record = (cwd: string, extra: Partial<OwnerRecord>): OwnerRecord => ({
  pid: 99999999,
  command: 'seeded owner',
  cwd,
  acquiredAt: new Date().toISOString(),
  token: crypto.randomUUID(),
  ...extra,
});

// A checkout started cleanly takes the scoped lease and retires it on a clean stop.
const checkout = scratch('checkout');
const initialized = await runWithHangGuard(['git', 'init', '-q', checkout]);
if (initialized.exitCode !== 0) throw new Error('Could not initialize the disposable checkout.');
const clean = await startSupervisor(
  [process.execPath, supervisorEntry, 'dev', '--entry', standInHost],
  checkout,
  join(checkout, 'home'),
);
const cleanLeaseName = `interborough-supervisor-${supervisorLeaseIdentity(clean.environment, false, checkout)}.lock`;
const heldNames = readdirSync(join(checkout, 'tmp'));
const heldLease = await readOwner(join(checkout, 'tmp', cleanLeaseName));
const heldGroup = heldLease?.processGroup;
const heldGateVerified =
  heldLease !== undefined &&
  heldGroup !== undefined &&
  verifiedGate(heldGroup, heldLease.token) &&
  heldLease.processGroupStartedAt === processStartTime(heldGroup);
clean.supervisor.kill('SIGTERM');
const cleanExit = await clean.supervisor.exited;
const cleanLeaseGone = !existsSync(join(checkout, 'tmp', cleanLeaseName));
const cleanHostGone = !isProcessAlive(clean.hostPid);
const cleanGroupGone = heldGroup !== undefined && !groupAlive(heldGroup);

// A supervisor killed outright leaves its lease; cleanup retires its verified group, only that
// group, and a second cleanup finds nothing to do.
rmSync(join(checkout, 'home', 'ready'));
const killed = await startSupervisor(
  [process.execPath, supervisorEntry, 'dev', '--entry', standInHost],
  checkout,
  join(checkout, 'home'),
);
const killedLease = await readOwner(join(checkout, 'tmp', cleanLeaseName));
const killedGroup = killedLease?.processGroup;
const bystander = sleeper();
killed.supervisor.kill('SIGKILL');
await killed.supervisor.exited;
const orphanedHostAlive = isProcessAlive(killed.hostPid);
const cleanupCodes: number[] = [];
cleanupCodes.push(await runSupervisor(['cleanup'], undefined, { directory: checkout }));
const afterFirstCleanup = {
  leasePresent: existsSync(join(checkout, 'tmp', cleanLeaseName)),
  hostAlive: isProcessAlive(killed.hostPid),
  groupAlive: killedGroup !== undefined && groupAlive(killedGroup),
  bystanderAlive: bystander.exitCode === null && isProcessAlive(bystander.pid),
};
cleanupCodes.push(await runSupervisor(['cleanup'], undefined, { directory: checkout }));
const afterSecondCleanup = {
  bystanderAlive: bystander.exitCode === null && isProcessAlive(bystander.pid),
};
bystander.kill('SIGKILL');
await bystander.exited;

// A lease that cannot be proven this supervisor's own is refused, and nothing unrelated is touched.
async function cleanupRefusal(owner: (stranger: number, directory: string) => OwnerRecord) {
  const directory = scratch('refusal');
  mkdirSync(join(directory, 'tmp'));
  const stranger = sleeper();
  await waitUntil(() => processStartTime(stranger.pid) !== undefined, { message: 'a stranger' });
  const lock = join(directory, 'tmp', `interborough-supervisor-${'a'.repeat(64)}.lock`);
  mkdirSync(lock);
  const seeded = owner(stranger.pid, directory);
  writeFileSync(join(lock, 'owner.json'), JSON.stringify(seeded));
  const failure = await runSupervisor(['cleanup'], undefined, {
    directory,
    read: () => ({
      topLevel: directory,
      gitDirectory: join(directory, '.git'),
      commonDirectory: join(directory, '.git'),
    }),
  }).then(
    () => undefined,
    (error: unknown) => error,
  );
  const remaining = await readOwner(lock);
  const outcome = {
    refused: failure instanceof Error,
    recordKept: remaining?.token === seeded.token,
    strangerAlive: stranger.exitCode === null && isProcessAlive(stranger.pid),
  };
  stranger.kill('SIGKILL');
  await stranger.exited;
  return outcome;
}
const reusedPid = await cleanupRefusal((pid, directory) =>
  record(directory, { pid, pidStartedAt: 'an earlier incarnation of this pid' }),
);
const foreignOwner = await cleanupRefusal((pid, directory) =>
  record(join(dirname(directory), 'another-worktree'), {
    pid,
    pidStartedAt: processStartTime(pid) ?? 'unknown',
  }),
);

// A packaged supervisor outside a checkout: bundled apart from the repository, run from a directory
// with none of its files, in a directory that is not a git worktree at all.
const packagedRoot = scratch('packaged');
const packagedHostDirectory = join(packagedRoot, 'package', 'src', 'host');
const bundle = await Bun.build({
  entrypoints: [supervisorEntry],
  outdir: packagedHostDirectory,
  target: 'bun',
});
const bundlePath = join(packagedHostDirectory, 'supervisor.js');
const bundleImports = new Bun.Transpiler({ loader: 'js' })
  .scanImports(readFileSync(bundlePath, 'utf8'))
  .map((entry) => entry.path);
const outside = join(packagedRoot, 'outside');
mkdirSync(outside);
const packaged = await startSupervisor(
  [process.execPath, '--no-install', bundlePath, 'dev', '--entry', standInHost],
  outside,
  join(outside, 'home'),
  { GIT_CEILING_DIRECTORIES: packagedRoot },
);
const packagedWhileRunning = {
  entries: readdirSync(outside).toSorted(),
  hostAlive: isProcessAlive(packaged.hostPid),
};
packaged.supervisor.kill('SIGTERM');
const packagedExit = await packaged.supervisor.exited;
const packagedAfter = {
  entries: readdirSync(outside).toSorted(),
  hostGone: !isProcessAlive(packaged.hostPid),
};

describe('a supervisor started in a checkout', () => {
  test('holds exactly the scoped lease while it runs, owned by its verified gate group', () => {
    expect(heldNames.filter((name) => leaseName.test(name))).toEqual([cleanLeaseName]);
    expect(heldLease?.cwd).toBe(checkout);
    expect(heldLease?.pid).toBe(clean.supervisor.pid);
    expect(heldGateVerified).toBe(true);
  });

  test('retires the lease and its group on a clean stop', () => {
    expect(cleanExit).toBe(0);
    expect(cleanLeaseGone).toBe(true);
    expect(cleanHostGone).toBe(true);
    expect(cleanGroupGone).toBe(true);
  });
});

describe('cleanup after a killed supervisor', () => {
  test('retires the verified group and the lease, and nothing else', () => {
    expect(killedLease?.processGroup).toBeDefined();
    expect(orphanedHostAlive).toBe(true);
    expect(cleanupCodes).toEqual([0, 0]);
    expect(afterFirstCleanup).toEqual({
      leasePresent: false,
      hostAlive: false,
      groupAlive: false,
      bystanderAlive: true,
    });
  });

  test('is harmless when repeated', () => {
    expect(afterSecondCleanup.bystanderAlive).toBe(true);
  });
});

describe.each([
  ['a reused owner pid', reusedPid],
  ['an owner that is another worktree', foreignOwner],
])('cleanup of %s', (_name, outcome) => {
  test('fails closed, keeps the record, and leaves the unrelated process alive', () => {
    expect(outcome).toEqual({ refused: true, recordKept: true, strangerAlive: true });
  });
});

describe('a packaged supervisor outside a checkout', () => {
  test('is bundled with no import beyond the runtime, so it needs no script of the repository', () => {
    expect(bundle.success).toBe(true);
    expect(bundleImports.filter((path) => !isBuiltin(path) && !path.startsWith('bun:'))).toEqual(
      [],
    );
  });

  test('starts and stops without taking a lease or creating a checkout directory', () => {
    expect(packagedWhileRunning.hostAlive).toBe(true);
    expect(packagedWhileRunning.entries).toEqual(['home']);
    expect(packagedExit).toBe(0);
    expect(packagedAfter).toEqual({ entries: ['home'], hostGone: true });
  });
});
