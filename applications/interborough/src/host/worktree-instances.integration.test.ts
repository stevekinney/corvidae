/**
 * Two linked git worktrees of one repository each run their own Interborough (COR-2540): the
 * development supervisor, started in each with none of the `INTERBOROUGH_*` variables set, gives
 * each a home under its own `tmp/` and a free port; each host records the address it bound in that
 * home; and the CLI run from each worktree reaches that worktree's host, ahead of a saved connection
 * and of the default address, while a command given `--url` goes where it says.
 *
 * The repository is a temporary one with two worktrees of its own, so nothing here touches the
 * repository this file is in, and the child processes run with `HOME` and every `INTERBOROUGH_*` and
 * `GIT_*` variable replaced, so a derivation that failed to happen could never reach the owner's real
 * `~/.interborough`. The supervisor runs `serve.ts` as its entry, `dev` mode and all, on a stub
 * build, which is the host without the browser build the real `dev.ts` adds.
 *
 * Each scenario runs at module scope, under the hang guard, so it is not on Bun's per-test clock;
 * the tests assert on what it recorded. Nothing asserts on how long anything takes.
 */
import {
  HangGuardProgress,
  runWithHangGuard,
  spawnWithHangGuard,
} from '@lostgradient/testing/hang-guard';
import { waitUntil } from '@lostgradient/testing/wait-until';
import { afterAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifiedGate } from '../../../../scripts/owned-process-lease.ts';
import { processStartTime, readOwner } from '../../../../scripts/run-exclusively.ts';

import { executeCli } from './cli-client.ts';
import { processEnvironment } from './environment-configuration.ts';
import { instanceRecordPath, readInstanceRecord } from './instance-record.ts';
import { linkedWorktreeRoot, worktreeHome } from './worktree-instance.ts';

const supervisorEntry = join(import.meta.dir, 'supervisor.ts');
const serveEntry = join(import.meta.dir, 'serve.ts');
const cliEntry = join(import.meta.dir, 'cli.ts');

const scratchDirectories: string[] = [];
const livePids = new Set<number>();

afterAll(async () => {
  for (const pid of livePids) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone, which is what cleanup wants.
    }
  }
  for (const directory of scratchDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

/** The environment a child gets: the parent's, without anything that could point it at real state. */
function scrubbedEnvironment(
  fakeHome: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  const kept = Object.entries(processEnvironment()).filter(
    (entry): entry is [string, string] =>
      entry[1] !== undefined &&
      !entry[0].startsWith('INTERBOROUGH_') &&
      !entry[0].startsWith('GIT_') &&
      entry[0] !== 'HOME',
  );
  return { ...Object.fromEntries(kept), HOME: fakeHome, ...extra };
}

async function git(directory: string, fakeHome: string, ...args: string[]): Promise<void> {
  const result = await runWithHangGuard(
    [
      'git',
      '-c',
      'user.name=Interborough Test',
      '-c',
      'user.email=interborough-test@example.test',
      ...args,
    ],
    { cwd: directory, env: scrubbedEnvironment(fakeHome) },
  );
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr.toString()}`);
  }
}

type Supervised = {
  readonly directory: string;
  readonly pid: number;
  readonly stdout: () => string;
  readonly pids: () => number[];
  readonly exited: Promise<number>;
  readonly progress: HangGuardProgress;
  readonly stop: () => Promise<number>;
};

function collect(stream: ReadableStream<Uint8Array>): () => string {
  let text = '';
  const decoder = new TextDecoder();
  void (async () => {
    for await (const chunk of stream) text += decoder.decode(chunk, { stream: true });
  })();
  return () => text;
}

/** Start `bun supervisor.ts dev` in `directory` with no `INTERBOROUGH_*` variable but the build's. */
function supervise(directory: string, fakeHome: string, build: string): Supervised {
  const progress = new HangGuardProgress();
  const child = spawnWithHangGuard(
    [process.execPath, supervisorEntry, 'dev', '--entry', serveEntry],
    {
      cwd: directory,
      env: scrubbedEnvironment(fakeHome, { INTERBOROUGH_BUILD_DIRECTORY: build }),
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      progress,
    },
  );
  livePids.add(child.pid);
  const stdout = collect(child.stdout);
  collect(child.stderr);
  const pids = (): number[] =>
    [...stdout().matchAll(/Started the host \(process (\d+)\)\./g)].map((match) =>
      Number(match[1]),
    );
  for (const pid of pids()) livePids.add(pid);
  return {
    directory,
    pid: child.pid,
    stdout,
    pids,
    exited: child.exited,
    progress,
    stop: async () => {
      child.kill('SIGTERM');
      return child.exited;
    },
  };
}

const LISTENING = /^Interborough is listening on (http:\/\/127\.0\.0\.1:\d+)$/m;

async function listeningUrl(supervised: Supervised): Promise<string> {
  await waitUntil(() => LISTENING.test(supervised.stdout()), {
    message: `the host in ${supervised.directory} to report its address`,
    yieldTurn: () => Bun.sleep(50),
  });
  for (const pid of supervised.pids()) livePids.add(pid);
  return LISTENING.exec(supervised.stdout())![1]!;
}

/** Run the real CLI entry from `directory` and parse its JSON envelope. */
async function runCli(
  directory: string,
  fakeHome: string,
  ...args: string[]
): Promise<{ data: Record<string, unknown> }> {
  const child = spawnWithHangGuard([process.execPath, cliEntry, ...args, '--output', 'json'], {
    cwd: directory,
    env: scrubbedEnvironment(fakeHome),
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`interborough ${args.join(' ')} exited ${code}: ${stderr}`);
  return JSON.parse(stdout) as { data: Record<string, unknown> };
}

// The repository, its two linked worktrees, and the stub build the hosts serve.
const root = await realpath(await mkdtemp(join(tmpdir(), 'interborough-worktrees-')));
scratchDirectories.push(root);
const fakeHome = join(root, 'home');
const mainCheckout = join(root, 'main');
const first = join(root, 'first');
const second = join(root, 'second');
const build = join(root, 'build');
await mkdir(fakeHome);
await mkdir(mainCheckout);
await mkdir(build);
await writeFile(join(build, 'index.html'), '<!doctype html><title>Interborough</title>');
await git(mainCheckout, fakeHome, 'init', '-q', '-b', 'main');
await git(mainCheckout, fakeHome, 'commit', '-q', '--allow-empty', '-m', 'Start');
await git(mainCheckout, fakeHome, 'worktree', 'add', '-q', '-b', 'first', first);
await git(mainCheckout, fakeHome, 'worktree', 'add', '-q', '-b', 'second', second);
await mkdir(join(first, 'subdirectory'));

// Both hosts run at once, each under its own supervisor.
const supervisors = [
  supervise(first, fakeHome, build),
  supervise(second, fakeHome, build),
] as const;
const urls = await Promise.all(supervisors.map((supervisor) => listeningUrl(supervisor)));
const [firstUrl, secondUrl] = urls as [string, string];

const firstHome = worktreeHome(first);
const secondHome = worktreeHome(second);
const firstRecord = await readInstanceRecord(firstHome);
const secondRecord = await readInstanceRecord(secondHome);

/** Ask the operating system whether this exact process owns the TCP listener. */
async function ownsListener(pid: number, url: string): Promise<boolean> {
  const port = new URL(url).port;
  const result = await runWithHangGuard(
    ['lsof', '-nP', '-a', '-p', String(pid), `-iTCP:${port}`, '-sTCP:LISTEN', '-Fp'],
    { env: scrubbedEnvironment(fakeHome) },
  );
  if (result.exitCode !== 0 && result.exitCode !== 1)
    throw new Error(`Could not inspect listener ownership (exit ${result.exitCode}).`);
  return result.stdout.toString().split('\n').includes(`p${pid}`);
}

// The supervisor logs the protected gate leader; the instance record names the host inside its
// group. Capture the kernel group and durable owner identity while both hosts are still live.
const ownershipProofs = await Promise.all(
  supervisors.map(async (supervisor, index) => {
    const home = [firstHome, secondHome][index]!;
    const record = [firstRecord, secondRecord][index];
    if (record === undefined) throw new Error('The host did not record its instance.');
    const identity = createHash('sha256').update(home).digest('hex');
    const lease = await readOwner(
      join(supervisor.directory, 'tmp', `interborough-supervisor-${identity}.lock`),
    );
    if (lease === undefined || lease.processGroup === undefined)
      throw new Error('The supervisor did not publish its process-group lease.');
    const group = await runWithHangGuard(['ps', '-o', 'pgid=', '-p', String(record.pid)], {
      env: scrubbedEnvironment(fakeHome),
    });
    return {
      record,
      ownerPid: lease.pid,
      ownerStart: lease.pidStartedAt,
      actualOwnerStart: processStartTime(supervisor.pid),
      leader: lease.processGroup,
      leaderStart: lease.processGroupStartedAt,
      actualLeaderStart: processStartTime(lease.processGroup),
      hostStart: processStartTime(record.pid),
      hostGroup: group.exitCode === 0 ? Number(group.stdout.toString().trim()) : undefined,
      hostOwnsListener: await ownsListener(record.pid, record.url),
      gateOwnsListener: await ownsListener(lease.processGroup, record.url),
      siblingOwnsListener: await ownsListener(
        [firstRecord, secondRecord][1 - index]!.pid,
        record.url,
      ),
      gateVerified:
        typeof lease.token === 'string' && verifiedGate(lease.processGroup, lease.token),
      ownerDirectory: lease.cwd,
    };
  }),
);

// The CLI, run as the command a person types, from each worktree and from a subdirectory of one.
const firstStatus = await runCli(first, fakeHome, 'status');
const secondStatus = await runCli(second, fakeHome, 'status');
const subdirectoryStatus = await runCli(join(first, 'subdirectory'), fakeHome, 'status');
const firstMcp = await runCli(first, fakeHome, 'mcp');

// The record ahead of a saved connection that holds a credential, and the default address.
const preferencesPath = join(root, 'cli-preferences.json');
await writeFile(
  preferencesPath,
  JSON.stringify({
    connections: [
      {
        name: 'elsewhere',
        url: 'https://management.example.test',
        credentialReference: 'INTERBOROUGH_TEST_TOKEN',
      },
    ],
    activeConnection: 'elsewhere',
  }),
);
const credential = 'credential-that-must-not-reach-the-worktree-host';
const requestHeaders: Headers[] = [];
const recording = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  requestHeaders.push(new Headers(init?.headers));
  return fetch(input, init);
};
const fromFirst = await executeCli(['status', '--output', 'json'], {
  worktreeDirectory: first,
  preferencesPath,
  environment: { INTERBOROUGH_TEST_TOKEN: credential },
  fetch: recording,
});
const explicit = await executeCli(['status', '--output', 'json', '--url', secondUrl], {
  worktreeDirectory: first,
  environment: {},
  preferencesPath: join(root, 'no-such-preferences.json'),
});
const fromMain = await executeCli(['mcp', '--output', 'json'], {
  worktreeDirectory: mainCheckout,
  environment: {},
  preferencesPath: join(root, 'no-such-preferences.json'),
});

// A clean exit: the supervisors forward SIGTERM, the hosts close, and the records go.
const exitCodes = await Promise.all(supervisors.map((supervisor) => supervisor.stop()));
const recordsAfterExit = await Promise.all(
  [firstHome, secondHome].map((home) => readInstanceRecord(home)),
);
const filesAfterExit = await Promise.all(
  [firstHome, secondHome].map((home) =>
    readFile(instanceRecordPath(home), 'utf8').then(
      () => 'present',
      () => 'absent',
    ),
  ),
);

describe('two linked worktrees', () => {
  test('each runs its own host, on a free port of its own, and says which home and port it chose', () => {
    expect(new Set(urls).size).toBe(2);
    for (const address of urls) expect(new URL(address).port).not.toBe('7234');
    for (const [index, supervisor] of supervisors.entries()) {
      const output = supervisor.stdout();
      const directory = [first, second][index]!;
      expect(output).toContain(`${directory} is a linked git worktree`);
      expect(output).toContain(`its state lives in ${worktreeHome(directory)}`);
      expect(output).toContain(`it listens on port ${new URL(urls[index]!).port}`);
    }
  });

  test('each host’s own start lines name its derived home and address, and the connection lines carry that address', () => {
    for (const [index, supervisor] of supervisors.entries()) {
      const address = urls[index]!;
      const lines = supervisor.stdout().split('\n');
      const listening = lines.indexOf(`Interborough is listening on ${address}`);
      expect(listening).toBeGreaterThanOrEqual(0);
      expect(lines[listening + 1]).toBe(
        `Its state lives in ${worktreeHome([first, second][index]!)}`,
      );
      expect(lines.slice(listening + 2, listening + 6)).toEqual([
        `Interface: ${address}`,
        `API: ${address}/api`,
        `MCP: ${address}/bureau/mcp`,
        `CLI: --url ${address}`,
      ]);
    }
  });

  test('each keeps its state under its own tmp/, and the first host does not hold the second’s home', () => {
    expect(firstHome).toBe(join(first, 'tmp', 'interborough-dev'));
    expect(secondHome).toBe(join(second, 'tmp', 'interborough-dev'));
    expect(supervisors[0].stdout()).toContain(`Its state lives in ${firstHome}`);
    expect(supervisors[1].stdout()).toContain(`Its state lives in ${secondHome}`);
  });

  test('each host recorded the address it bound and its own process in its home', () => {
    for (const [index, proof] of ownershipProofs.entries()) {
      const supervisor = supervisors[index]!;
      expect(proof.record.url).toBe(urls[index]!);
      expect(proof.hostStart).toBeDefined();
      expect(proof.hostOwnsListener).toBe(true);
      expect(proof.gateOwnsListener).toBe(false);
      expect(proof.siblingOwnsListener).toBe(false);
      expect(proof.hostGroup).toBe(proof.leader);
      expect(proof.leader).toBe(supervisor.pids()[0]!);
      expect(proof.ownerPid).toBe(supervisor.pid);
      expect(proof.actualOwnerStart).toBeDefined();
      expect(proof.ownerStart).toBe(proof.actualOwnerStart);
      expect(proof.actualLeaderStart).toBeDefined();
      expect(proof.leaderStart).toBe(proof.actualLeaderStart);
      expect(proof.gateVerified).toBe(true);
      expect(proof.ownerDirectory).toBe(supervisor.directory);
    }
  });

  test('the CLI run from each worktree, with no --url, reaches that worktree’s host', () => {
    const reachedByFirst = (firstStatus.data['reachability'] as Record<string, unknown>)['url'];
    const reachedBySecond = (secondStatus.data['reachability'] as Record<string, unknown>)['url'];
    expect(reachedByFirst).toBe(firstUrl);
    expect(reachedBySecond).toBe(secondUrl);
    // From a directory inside the worktree too.
    expect((subdirectoryStatus.data['reachability'] as Record<string, unknown>)['url']).toBe(
      firstUrl,
    );
    // The two hosts are distinct deployments, each with its own home.
    const deployment = (status: { data: Record<string, unknown> }) =>
      (status.data['deployment'] as Record<string, unknown>)['identity'];
    expect(deployment(firstStatus)).not.toBe(deployment(secondStatus));
  });

  test('interborough mcp, run from a worktree, describes that worktree’s host', () => {
    expect(firstMcp.data['endpoint']).toBe(`${firstUrl}/bureau/mcp`);
  });
});

describe('where the CLI looks first', () => {
  test('the recorded instance beats the active saved connection, whose credential is never sent', () => {
    expect(fromFirst.exitCode).toBe(0);
    const data = (JSON.parse(fromFirst.stdout) as { data: Record<string, unknown> }).data;
    expect((data['reachability'] as Record<string, unknown>)['url']).toBe(firstUrl);
    expect(requestHeaders.length).toBeGreaterThan(0);
    for (const headers of requestHeaders) {
      expect(headers.get('authorization')).toBeNull();
      expect(headers.get('x-api-key')).toBeNull();
    }
    expect(fromFirst.stdout).not.toContain(credential);
  });

  test('an explicit --url beats the recorded instance', () => {
    expect(explicit.exitCode).toBe(0);
    const data = (JSON.parse(explicit.stdout) as { data: Record<string, unknown> }).data;
    expect((data['reachability'] as Record<string, unknown>)['url']).toBe(secondUrl);
  });

  test('the main checkout still defaults to port 7234', () => {
    expect(fromMain.exitCode).toBe(0);
    const data = (JSON.parse(fromMain.stdout) as { data: Record<string, unknown> }).data;
    expect(data['endpoint']).toBe('http://127.0.0.1:7234/bureau/mcp');
  });
});

describe('git’s own definition of a linked worktree', () => {
  test('the main checkout is not one, and each worktree and its subdirectories are', () => {
    expect(linkedWorktreeRoot(mainCheckout)).toBeUndefined();
    expect(linkedWorktreeRoot(first)).toBe(first);
    expect(linkedWorktreeRoot(join(first, 'subdirectory'))).toBe(first);
    expect(linkedWorktreeRoot(second)).toBe(second);
  });

  test('a directory outside every repository is not one', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'interborough-not-a-repository-'));
    scratchDirectories.push(outside);
    expect(linkedWorktreeRoot(outside)).toBeUndefined();
  });
});

describe('a clean exit', () => {
  test('ends each supervisor with code 0 and removes each host’s record', () => {
    expect(exitCodes).toEqual([0, 0]);
    expect(recordsAfterExit).toEqual([undefined, undefined]);
    expect(filesAfterExit).toEqual(['absent', 'absent']);
  });
});
