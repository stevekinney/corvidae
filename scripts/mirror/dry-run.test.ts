import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  assertInstallationCoverage,
  CheckRunFailureError,
  CheckRunTimeoutError,
  deleteScratchRepository,
  ensureScratchRepository,
  InstallationCoverageError,
  runDryRun,
  runDryRunCommand,
  seedScratchRepository,
  waitForCheckRuns,
  type StageTransform,
} from './dry-run.ts';
import type {
  CheckRunRecord,
  CreatePullRequestInput,
  CreateRepositoryInput,
  GitHubApi,
  RepositoryRecord,
} from './github-api.ts';
import { runCommand, type CommandResult, type CommandRunner } from './packaging.ts';
import type { proveNpmPublishDryRun, PublishProbe } from './publish-rehearsal.ts';
import {
  scratchDescription,
  ScratchGuardError,
  scratchRepositoryName,
} from './scratch-repository.ts';
import type { StageOutcome } from './sync.ts';

/**
 * Every test here drives the real driver against a fake GitHub.
 *
 * Nothing in this file can mutate a real repository, because the only GitHub surface the driver
 * has is the injected `GitHubApi`, and the only implementation this file constructs records calls
 * into an array. The guard under test is the one the live run calls: these tests import
 * `deleteScratchRepository` itself rather than restating its assertions.
 *
 * The fake records a `deleted` list, and a guard test is only meaningful if it asserts that list
 * stayed empty — "it threw" is not the same claim as "it did not delete".
 */

const validName = 'stevekinney/mirror-dryrun-20260919';

interface Recorded {
  read: string[];
  created: CreateRepositoryInput[];
  pullRequests: CreatePullRequestInput[];
  deleted: string[];
  coverageReads: number;
}

interface FakeOptions {
  repositories?: Record<string, RepositoryRecord>;
  repositorySelection?: string;
  reachable?: readonly string[];
}

function scratchRecord(overrides: Partial<RepositoryRecord> = {}): RepositoryRecord {
  return {
    fullName: validName,
    description: scratchDescription,
    private: false,
    htmlUrl: `https://github.com/${validName}`,
    defaultBranch: 'main',
    ...overrides,
  };
}

function fakeGitHub(options: FakeOptions = {}): { api: GitHubApi; calls: Recorded } {
  const repositories = { ...options.repositories };
  const calls: Recorded = {
    read: [],
    created: [],
    pullRequests: [],
    deleted: [],
    coverageReads: 0,
  };
  const api: GitHubApi = {
    async readInstallationCoverage() {
      calls.coverageReads += 1;
      return {
        repositorySelection: options.repositorySelection ?? 'selected',
        repositories: options.reachable ?? [validName],
      };
    },
    async readRepository(fullName) {
      calls.read.push(fullName);
      return repositories[fullName];
    },
    async createRepository(input) {
      calls.created.push(input);
      const created = scratchRecord({
        fullName: input.fullName,
        description: input.description,
        htmlUrl: `https://github.com/${input.fullName}`,
      });
      repositories[input.fullName] = created;
      return created;
    },
    async createPullRequest(input) {
      calls.pullRequests.push(input);
      return {
        number: 1,
        htmlUrl: `https://github.com/${input.fullName}/pull/1`,
        headSha: 'c0ffee',
      };
    },
    async readCheckRuns() {
      return [{ name: 'build', status: 'completed', conclusion: 'success' }];
    },
    async deleteRepository(fullName) {
      calls.deleted.push(fullName);
      delete repositories[fullName];
    },
    async pushEnvironment() {
      return {
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'http.https://github.com/.extraHeader',
        GIT_CONFIG_VALUE_0: 'Authorization: Basic app-token',
      };
    },
    async accountPushEnvironment() {
      return {
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'http.https://github.com/.extraHeader',
        GIT_CONFIG_VALUE_0: 'Authorization: Basic account-token',
      };
    },
  };
  return { api, calls };
}

describe('scratchRepositoryName', () => {
  test('pins the name to the owner, the prefix and a UTC date stamp', () => {
    expect(scratchRepositoryName(new Date('2026-09-19T23:30:00Z'))).toBe(validName);
    expect(scratchRepositoryName(new Date('2026-01-02T00:00:00Z'))).toBe(
      'stevekinney/mirror-dryrun-20260102',
    );
  });

  test('produces a name the guard accepts', async () => {
    const generated = scratchRepositoryName(new Date('2026-09-19T12:00:00Z'));
    const { api, calls } = fakeGitHub({ repositories: { [generated]: scratchRecord() } });
    await deleteScratchRepository(api, generated);
    expect(calls.deleted).toEqual([generated]);
  });
});

describe('deleteScratchRepository', () => {
  test('deletes exactly the scratch repository when both assertions hold', async () => {
    const { api, calls } = fakeGitHub({ repositories: { [validName]: scratchRecord() } });
    await deleteScratchRepository(api, validName);
    expect(calls.deleted).toEqual([validName]);
  });

  test.each([
    ['a real repository', 'stevekinney/weft'],
    ['another real repository', 'stevekinney/cinder'],
    ['a different owner', 'someoneelse/mirror-dryrun-20260919'],
    ['a name that merely contains the pattern', 'stevekinney/mirror-dryrun-20260919-production'],
    ['a name with the pattern as a suffix', 'stevekinney/weft-mirror-dryrun-20260919'],
    ['a prefixed name', 'evil/stevekinney/mirror-dryrun-20260919'],
    ['leading whitespace', ' stevekinney/mirror-dryrun-20260919'],
    ['trailing whitespace', 'stevekinney/mirror-dryrun-20260919 '],
    ['a trailing newline', 'stevekinney/mirror-dryrun-20260919\n'],
    ['an empty name', ''],
    ['a whitespace-only name', '   '],
    ['too few digits', 'stevekinney/mirror-dryrun-2026919'],
    ['too many digits', 'stevekinney/mirror-dryrun-202609190'],
    ['no date at all', 'stevekinney/mirror-dryrun-'],
  ])('refuses %s without reading or deleting anything', async (_label, target) => {
    const { api, calls } = fakeGitHub({
      repositories: { [target]: scratchRecord({ fullName: target }) },
    });
    await expect(deleteScratchRepository(api, target)).rejects.toThrow(ScratchGuardError);
    expect(calls.deleted).toEqual([]);
    expect(calls.read).toEqual([]);
  });

  test.each([
    ['a month that does not exist', 'stevekinney/mirror-dryrun-20261319'],
    ['a day that does not exist', 'stevekinney/mirror-dryrun-20260932'],
    ['an all-zero stamp', 'stevekinney/mirror-dryrun-00000000'],
  ])('refuses %s because no run produces that name', async (_label, target) => {
    const { api, calls } = fakeGitHub({
      repositories: { [target]: scratchRecord({ fullName: target }) },
    });
    await expect(deleteScratchRepository(api, target)).rejects.toThrow(/not a calendar date/);
    expect(calls.deleted).toEqual([]);
  });

  test.each([
    ['a trailing space', `${scratchDescription} `],
    ['a leading space', ` ${scratchDescription}`],
    ['different case', 'Mirror Dry Run, Safe To Delete'],
    ['different punctuation', 'mirror dry run safe to delete'],
    ['an empty description', ''],
    ['an unrelated description', 'Weft, a durable workflow engine'],
  ])('refuses a description with %s', async (_label, description) => {
    const { api, calls } = fakeGitHub({
      repositories: { [validName]: scratchRecord({ description }) },
    });
    await expect(deleteScratchRepository(api, validName)).rejects.toThrow(ScratchGuardError);
    expect(calls.deleted).toEqual([]);
  });

  test('refuses a repository whose description is null', async () => {
    const { api, calls } = fakeGitHub({
      repositories: { [validName]: scratchRecord({ description: null }) },
    });
    await expect(deleteScratchRepository(api, validName)).rejects.toThrow(ScratchGuardError);
    expect(calls.deleted).toEqual([]);
  });

  test('refuses when GitHub has no such repository', async () => {
    const { api, calls } = fakeGitHub();
    await expect(deleteScratchRepository(api, validName)).rejects.toThrow(/no such repository/);
    expect(calls.deleted).toEqual([]);
  });

  test('refuses when the name redirects to a repository under another name', async () => {
    const { api, calls } = fakeGitHub({
      repositories: {
        [validName]: scratchRecord({ fullName: 'stevekinney/weft' }),
      },
    });
    await expect(deleteScratchRepository(api, validName)).rejects.toThrow(/redirects/);
    expect(calls.deleted).toEqual([]);
  });

  test('refuses a private repository', async () => {
    const { api, calls } = fakeGitHub({
      repositories: { [validName]: scratchRecord({ private: true }) },
    });
    await expect(deleteScratchRepository(api, validName)).rejects.toThrow(/private/);
    expect(calls.deleted).toEqual([]);
  });

  test('reads the description from GitHub rather than from the caller', async () => {
    // The caller passes a name and nothing else, so no argument can assert a description that the
    // repository does not actually carry.
    const { api, calls } = fakeGitHub({
      repositories: { [validName]: scratchRecord({ description: 'something else' }) },
    });
    await expect(deleteScratchRepository(api, validName)).rejects.toThrow(ScratchGuardError);
    expect(calls.read).toEqual([validName]);
    expect(calls.deleted).toEqual([]);
  });
});

describe('ensureScratchRepository', () => {
  test('creates a public repository carrying the sentinel description', async () => {
    const { api, calls } = fakeGitHub();
    const repository = await ensureScratchRepository(api, validName);
    expect(calls.created).toEqual([{ fullName: validName, description: scratchDescription }]);
    expect(repository.fullName).toBe(validName);
  });

  test('adopts a repository a previous phase created', async () => {
    const { api, calls } = fakeGitHub({ repositories: { [validName]: scratchRecord() } });
    const repository = await ensureScratchRepository(api, validName);
    expect(calls.created).toEqual([]);
    expect(repository.htmlUrl).toBe(`https://github.com/${validName}`);
  });

  test('refuses to adopt a repository that is not the scratch repository', async () => {
    const { api, calls } = fakeGitHub({
      repositories: { [validName]: scratchRecord({ description: 'a real project' }) },
    });
    await expect(ensureScratchRepository(api, validName)).rejects.toThrow(ScratchGuardError);
    expect(calls.created).toEqual([]);
  });

  test('refuses to create anything under a name the guard rejects', async () => {
    const { api, calls } = fakeGitHub();
    await expect(ensureScratchRepository(api, 'stevekinney/weft')).rejects.toThrow(
      ScratchGuardError,
    );
    expect(calls.created).toEqual([]);
    expect(calls.read).toEqual([]);
  });
});

describe('assertInstallationCoverage', () => {
  test('passes when the installation reaches every repository', async () => {
    const { api } = fakeGitHub({ repositorySelection: 'all', reachable: [] });
    const coverage = await assertInstallationCoverage(api, validName);
    expect(coverage.repositorySelection).toBe('all');
  });

  test('passes when the selected installation lists the scratch repository', async () => {
    const { api } = fakeGitHub({ reachable: ['stevekinney/corvidae', validName] });
    await expect(assertInstallationCoverage(api, validName)).resolves.toBeDefined();
  });

  test('refuses, naming the scratch repository and the browser step, when it does not', async () => {
    const { api } = fakeGitHub({
      reachable: ['stevekinney/corvidae', 'stevekinney/weft', 'stevekinney/cinder'],
    });
    const failure = await assertInstallationCoverage(api, validName).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(InstallationCoverageError);
    const message = failure instanceof Error ? failure.message : '';
    expect(message).toContain(validName);
    expect(message).toContain('4997180');
    expect(message).toContain('162905409');
    expect(message).toContain('https://github.com/settings/installations/162905409');
    expect(message).toContain('stevekinney/weft');
    expect(message).toContain('--phase create');
    expect(message).toContain('403');
  });
});

interface RunnerHarness {
  run: CommandRunner;
  commands: string[][];
  environments: (Record<string, string | undefined> | undefined)[];
}

function fakeRunner(): RunnerHarness {
  const commands: string[][] = [];
  const environments: (Record<string, string | undefined> | undefined)[] = [];
  const run: CommandRunner = async (command, options): Promise<CommandResult> => {
    commands.push([...command]);
    environments.push(options.env);
    const joined = command.join(' ');
    const base = { command: joined, stdout: '', stderr: '' };
    if (joined.includes('status --porcelain')) {
      return { ...base, exitCode: 0, stdout: ' M packages/cryptography/src/index.ts\n' };
    }
    return { ...base, exitCode: 0 };
  };
  return { run, commands, environments };
}

interface ProbeHarness {
  probe: typeof proveNpmPublishDryRun;
  calls: {
    workDirectory: string;
    scratchDirectory: string;
    published: string[];
    version: string | undefined;
  }[];
}

/**
 * A stand-in for the publish probe that records what the driver handed it.
 *
 * The probe itself builds, packs and lints a real package; that is
 * `publish-rehearsal.test.ts`'s subject. What matters here is that the driver runs it against the
 * tree the transform just staged, with a tarball destination outside that tree, and only after
 * the pull request exists.
 */
function fakeProbe(): ProbeHarness {
  const calls: ProbeHarness['calls'] = [];
  const probe: typeof proveNpmPublishDryRun = async (options) => {
    calls.push({
      workDirectory: options.workDirectory,
      scratchDirectory: options.scratchDirectory,
      published: options.outcome.plan.published.map((entry) => entry.publicName),
      version: options.version,
    });
    return {
      publicName: '@lostgradient/cryptography',
      version: options.version ?? '1.0.0',
      treeVersion: '1.0.0',
      command: 'npm publish --dry-run --ignore-scripts --tag latest --json',
      exitCode: 0,
      tarball: join(options.scratchDirectory, 'tarballs', 'cryptography-1.0.0.tgz'),
      buildExitCode: 0,
      publintExitCode: 0,
      typeResolutionExitCode: 0,
      entries: ['dist/index.js', 'package.json'],
      entryPoints: ['dist/index.js'],
    } satisfies PublishProbe;
  };
  return { probe, calls };
}

/**
 * A transform that writes the one manifest the publish probe reads and reports the surface it
 * would have planned. The real `stageSurface` has its own coverage in `sync.test.ts`; what is
 * under test here is the order the driver puts the steps in and the guards around them.
 */
function fakeStage(version: string): StageTransform {
  return async ({ directory }) => {
    await Bun.write(
      join(directory, 'packages/cryptography/package.json'),
      JSON.stringify({ name: '@lostgradient/cryptography', version }),
    );
    return {
      plan: {
        published: [
          { publicName: '@lostgradient/cryptography', directory: 'packages/cryptography' },
        ],
      },
      written: ['packages/cryptography/src/index.ts'],
      deleted: [],
    } as unknown as StageOutcome;
  };
}

async function withWorkDirectory<T>(body: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), 'mirror-dry-run-'));
  try {
    return await body(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe('runDryRun', () => {
  test('checks installation coverage before creating anything', async () => {
    const { api, calls } = fakeGitHub({ reachable: ['stevekinney/corvidae'] });
    const harness = fakeRunner();
    const probes = fakeProbe();
    await withWorkDirectory(async (workDirectory) => {
      await expect(
        runDryRun({
          api,
          corvidaeRoot: workDirectory,
          target: 'weft',
          workDirectory: join(workDirectory, 'clone'),
          scratchDirectory: join(workDirectory, 'scratch'),
          corvidaeCommit: 'abc123',
          scratchRepository: validName,
          run: harness.run,
          stage: fakeStage('1.0.0'),
          probe: probes.probe,
        }),
      ).rejects.toThrow(InstallationCoverageError);
    });
    expect(calls.coverageReads).toBe(1);
    expect(calls.created).toEqual([]);
    expect(calls.deleted).toEqual([]);
    expect(harness.commands).toEqual([]);
  });

  test('runs the whole round trip in order and deletes the scratch repository', async () => {
    const { api, calls } = fakeGitHub();
    const harness = fakeRunner();
    const probes = fakeProbe();
    const report = await withWorkDirectory((workDirectory) =>
      runDryRun({
        api,
        corvidaeRoot: workDirectory,
        target: 'weft',
        workDirectory: join(workDirectory, 'clone'),
        scratchDirectory: join(workDirectory, 'scratch'),
        corvidaeCommit: 'abc123',
        scratchRepository: validName,
        run: harness.run,
        stage: fakeStage('1.0.0'),
        probe: probes.probe,
      }),
    );

    expect(calls.created).toEqual([{ fullName: validName, description: scratchDescription }]);
    expect(calls.pullRequests).toEqual([
      {
        fullName: validName,
        base: 'main',
        head: 'mirror-dry-run-20260919',
        title: 'Mirror dry run for weft',
        body: expect.stringContaining('Corvidae-Commit: abc123'),
      },
    ]);
    expect(report.pullRequest.number).toBe(1);
    expect(report.checkRuns).toEqual([
      { name: 'build', status: 'completed', conclusion: 'success' },
    ]);
    expect(report.deleted).toBe(true);
    expect(calls.deleted).toEqual([validName]);

    const joined = harness.commands.map((command) => command.join(' '));
    expect(joined.some((command) => command.includes('clone --depth 1'))).toBe(true);
    expect(joined).toContain(
      'git remote set-url origin https://github.com/stevekinney/mirror-dryrun-20260919.git',
    );
    expect(joined).toContain('git push origin HEAD:refs/heads/main');
    expect(joined).toContain('git checkout -b mirror-dry-run-20260919');
    expect(joined).toContain('git push origin HEAD:refs/heads/mirror-dry-run-20260919');

    // The probe is handed the staged clone and a tarball destination outside it. A destination
    // inside the clone would put a `.tgz` in `git status` on the next run, and a probe pointed
    // anywhere but the staged tree would prove a publish of something the transform did not make.
    expect(probes.calls).toEqual([
      {
        workDirectory: expect.stringContaining('clone'),
        scratchDirectory: expect.stringContaining('scratch'),
        published: ['@lostgradient/cryptography'],
        version: undefined,
      },
    ]);
    expect(probes.calls[0]?.scratchDirectory.startsWith(`${probes.calls[0]?.workDirectory}/`)).toBe(
      false,
    );
    expect(report.publish.entries).toEqual(['dist/index.js', 'package.json']);
  });

  test('pushes as the App, with the credential in the environment and never in a command', async () => {
    const { api } = fakeGitHub();
    const harness = fakeRunner();
    const probes = fakeProbe();
    await withWorkDirectory((workDirectory) =>
      runDryRun({
        api,
        corvidaeRoot: workDirectory,
        target: 'weft',
        workDirectory: join(workDirectory, 'clone'),
        scratchDirectory: join(workDirectory, 'scratch'),
        corvidaeCommit: 'abc123',
        scratchRepository: validName,
        run: harness.run,
        stage: fakeStage('1.0.0'),
        probe: probes.probe,
      }),
    );
    const pushes = harness.commands
      .map((command, index) => ({ command, environment: harness.environments[index] }))
      .filter(({ command }) => command.includes('push'));
    expect(pushes).toHaveLength(2);
    for (const { command, environment } of pushes) {
      expect(environment?.['GIT_CONFIG_VALUE_0']).toContain('Authorization: Basic');
      expect(command.join(' ')).not.toContain('Authorization');
    }

    // The two pushes carry different credentials on purpose, and which one goes where is the
    // whole claim. The seed carries the target's `.github/workflows/**`, which GitHub refuses
    // from an App without the `workflows` permission this App deliberately does not hold; the
    // transform branch is the push COR-1191 exists to prove the App can make. Asserting only
    // "both are authenticated" would pass with the routing reversed.
    expect(pushes.map(({ environment }) => environment?.['GIT_CONFIG_VALUE_0'])).toEqual([
      'Authorization: Basic account-token',
      'Authorization: Basic app-token',
    ]);
    const clone = harness.commands.find((command) => command.includes('clone'));
    expect(clone?.join(' ')).not.toContain('Authorization');
  });

  test('keeps the scratch repository when asked, so a human can look at the pull request', async () => {
    const { api, calls } = fakeGitHub();
    const harness = fakeRunner();
    const probes = fakeProbe();
    const report = await withWorkDirectory((workDirectory) =>
      runDryRun({
        api,
        corvidaeRoot: workDirectory,
        target: 'weft',
        workDirectory: join(workDirectory, 'clone'),
        scratchDirectory: join(workDirectory, 'scratch'),
        corvidaeCommit: 'abc123',
        scratchRepository: validName,
        keep: true,
        run: harness.run,
        stage: fakeStage('1.0.0'),
        probe: probes.probe,
      }),
    );
    expect(report.deleted).toBe(false);
    expect(calls.deleted).toEqual([]);
  });

  test('refuses a scratch repository name the guard rejects before reaching GitHub', async () => {
    const { api, calls } = fakeGitHub();
    await withWorkDirectory(async (workDirectory) => {
      await expect(
        runDryRun({
          api,
          corvidaeRoot: workDirectory,
          target: 'weft',
          workDirectory: join(workDirectory, 'clone'),
          scratchDirectory: join(workDirectory, 'scratch'),
          corvidaeCommit: 'abc123',
          scratchRepository: 'stevekinney/weft',
          run: fakeRunner().run,
          stage: fakeStage('1.0.0'),
          probe: fakeProbe().probe,
        }),
      ).rejects.toThrow(ScratchGuardError);
    });
    expect(calls.coverageReads).toBe(0);
    expect(calls.created).toEqual([]);
  });
});

/**
 * Drive the real driver against a fake whose CI answers whatever a test needs.
 *
 * The GitHub fake is spread rather than rebuilt, so `deleteRepository` is still the original
 * closure and `calls.deleted` still records. That matters: "the run failed" and "the repository
 * survived" are two different claims, and a test that only asserts the first would pass against a
 * driver that threw *after* deleting the evidence.
 */
async function runWithCheckRuns(options: {
  checkRuns: readonly CheckRunRecord[];
  appearanceAttempts?: number;
  completionAttempts?: number;
}): Promise<{ failure: unknown; calls: Recorded; probes: ProbeHarness }> {
  const { api, calls } = fakeGitHub();
  const harness = fakeRunner();
  const probes = fakeProbe();
  const answering: GitHubApi = {
    ...api,
    async readCheckRuns() {
      return options.checkRuns;
    },
  };
  const failure = await withWorkDirectory((workDirectory) =>
    runDryRun({
      api: answering,
      corvidaeRoot: workDirectory,
      target: 'weft',
      workDirectory: join(workDirectory, 'clone'),
      scratchDirectory: join(workDirectory, 'scratch'),
      corvidaeCommit: 'abc123',
      scratchRepository: validName,
      run: harness.run,
      stage: fakeStage('1.0.0'),
      probe: probes.probe,
      checkRunAppearanceAttempts: options.appearanceAttempts ?? 2,
      checkRunCompletionAttempts: options.completionAttempts ?? 3,
      sleep: async () => {},
    }),
  ).then(
    () => undefined,
    (error: unknown) => error,
  );
  return { failure, calls, probes };
}

/**
 * The gate COR-1191 needs, which the driver did not have.
 *
 * A live run of this driver exited 0 against a pull request on which `audit` had completed
 * `failure` and seventeen other checks had never finished, and then deleted the repository that
 * held the only record of why. Each test here fails one of those two ways and asserts both halves
 * of the fix: the run refuses, and the scratch repository is still there to read.
 */
describe('runDryRun check run verdict', () => {
  test('fails the run and keeps the scratch repository when a check run completes with failure', async () => {
    const { failure, calls, probes } = await runWithCheckRuns({
      checkRuns: [
        { name: 'build', status: 'completed', conclusion: 'success' },
        { name: 'audit', status: 'completed', conclusion: 'failure' },
      ],
    });
    expect(failure).toBeInstanceOf(CheckRunFailureError);
    const message = failure instanceof Error ? failure.message : '';
    expect(message).toContain('audit: failure');
    expect(message).toContain(`https://github.com/${validName}/pull/1`);
    expect(message).toContain(`--phase delete --scratch-repository ${validName}`);
    // The whole point: the repository that holds the failing run's logs is still there.
    expect(calls.deleted).toEqual([]);
    // And the refusal happened before the publish rehearsal, so the failure that is reported is
    // the CI failure rather than whatever the probe would have said about it afterwards.
    expect(probes.calls).toEqual([]);
  });

  test('fails the run and keeps the scratch repository when check runs never finish', async () => {
    const { failure, calls } = await runWithCheckRuns({
      checkRuns: [
        { name: 'ui-e2e', status: 'queued', conclusion: null },
        { name: 'postgres-test', status: 'in_progress', conclusion: null },
      ],
    });
    expect(failure).toBeInstanceOf(CheckRunTimeoutError);
    const message = failure instanceof Error ? failure.message : '';
    expect(message).toContain('2 of 2 check run(s)');
    expect(message).toContain('ui-e2e: queued');
    expect(message).toContain('postgres-test: in_progress');
    expect(message).toContain(`--phase delete --scratch-repository ${validName}`);
    expect(calls.deleted).toEqual([]);
  });

  test('fails the run and keeps the scratch repository when no check run ever appears', async () => {
    const { failure, calls } = await runWithCheckRuns({ checkRuns: [] });
    expect(failure).toBeInstanceOf(CheckRunTimeoutError);
    const message = failure instanceof Error ? failure.message : '';
    expect(message).toContain('No check run appeared');
    expect(message).toContain(`https://github.com/${validName}/pull/1`);
    expect(calls.deleted).toEqual([]);
  });

  test('fails the run when a check run completes without saying how', async () => {
    const { failure, calls } = await runWithCheckRuns({
      checkRuns: [{ name: 'build', status: 'completed', conclusion: null }],
    });
    expect(failure).toBeInstanceOf(CheckRunFailureError);
    expect(failure instanceof Error ? failure.message : '').toContain(
      'build: completed without a conclusion',
    );
    expect(calls.deleted).toEqual([]);
  });

  test.each([['cancelled'], ['timed_out'], ['action_required'], ['stale']])(
    'fails the run on a check run concluded %s',
    async (conclusion) => {
      const { failure, calls } = await runWithCheckRuns({
        checkRuns: [{ name: 'build', status: 'completed', conclusion }],
      });
      expect(failure).toBeInstanceOf(CheckRunFailureError);
      expect(calls.deleted).toEqual([]);
    },
  );

  /**
   * GitHub's own required-check semantics treat both of these as satisfying a required check, so
   * refusing them here would make this driver stricter than the branch protection it rehearses.
   */
  test.each([['skipped'], ['neutral']])(
    'passes a check run concluded %s, as a required check would',
    async (conclusion) => {
      const { failure, calls } = await runWithCheckRuns({
        checkRuns: [
          { name: 'build', status: 'completed', conclusion: 'success' },
          { name: 'browser-smoke', status: 'completed', conclusion },
        ],
      });
      expect(failure).toBeUndefined();
      expect(calls.deleted).toEqual([validName]);
    },
  );
});

describe('waitForCheckRuns', () => {
  test('polls until every check run is completed', async () => {
    const answers = [
      [],
      [{ name: 'build', status: 'queued', conclusion: null }],
      [{ name: 'build', status: 'completed', conclusion: 'success' }],
    ];
    let reads = 0;
    const { api } = fakeGitHub();
    const polling: GitHubApi = {
      ...api,
      async readCheckRuns() {
        const answer = answers[Math.min(reads, answers.length - 1)] ?? [];
        reads += 1;
        return answer;
      },
    };
    const wait = await waitForCheckRuns({
      api: polling,
      scratchRepository: validName,
      ref: 'c0ffee',
      sleep: async () => {},
    });
    expect(reads).toBe(3);
    expect(wait.stop).toBe('completed');
    expect(wait.checkRuns).toEqual([{ name: 'build', status: 'completed', conclusion: 'success' }]);
  });

  /**
   * The bound elapsing is reported as its own outcome rather than as a list of unfinished checks
   * that reads exactly like a list of finished ones. `assertCheckRunsPassed` turns it into a
   * refusal; what is pinned here is that the poll says which bound it hit.
   */
  test('reports the completion bound elapsing rather than calling unfinished checks a result', async () => {
    let reads = 0;
    const { api } = fakeGitHub();
    const stuck: GitHubApi = {
      ...api,
      async readCheckRuns() {
        reads += 1;
        return [{ name: 'build', status: 'in_progress', conclusion: null }];
      },
    };
    const wait = await waitForCheckRuns({
      api: stuck,
      scratchRepository: validName,
      ref: 'c0ffee',
      appearanceAttempts: 2,
      completionAttempts: 5,
      sleep: async () => {},
    });
    expect(reads).toBe(5);
    expect(wait.stop).toBe('never-completed');
    expect(wait.checkRuns).toEqual([{ name: 'build', status: 'in_progress', conclusion: null }]);
  });

  /**
   * The appearance bound is the short one and it is separate on purpose: a head commit carrying
   * no check run at all is a workflow that never triggered, which is diagnosed differently from a
   * workflow that is slow, and waiting the full completion bound to say so wastes half an hour on
   * a question answered in the first minute.
   */
  test('stops at the shorter appearance bound when no check run ever appears', async () => {
    let reads = 0;
    const { api } = fakeGitHub();
    const silent: GitHubApi = {
      ...api,
      async readCheckRuns() {
        reads += 1;
        return [];
      },
    };
    const wait = await waitForCheckRuns({
      api: silent,
      scratchRepository: validName,
      ref: 'c0ffee',
      appearanceAttempts: 3,
      completionAttempts: 50,
      sleep: async () => {},
    });
    expect(reads).toBe(3);
    expect(wait.stop).toBe('never-appeared');
    expect(wait.checkRuns).toEqual([]);
  });

  test('never applies a completion bound shorter than the appearance bound', async () => {
    let reads = 0;
    const { api } = fakeGitHub();
    const silent: GitHubApi = {
      ...api,
      async readCheckRuns() {
        reads += 1;
        return [];
      },
    };
    const wait = await waitForCheckRuns({
      api: silent,
      scratchRepository: validName,
      ref: 'c0ffee',
      appearanceAttempts: 4,
      completionAttempts: 1,
      sleep: async () => {},
    });
    expect(reads).toBe(4);
    expect(wait.stop).toBe('never-appeared');
  });

  test('reports the wait a live run would have spent, so a timeout can name it', async () => {
    const { api } = fakeGitHub();
    const stuck: GitHubApi = {
      ...api,
      async readCheckRuns() {
        return [{ name: 'build', status: 'queued', conclusion: null }];
      },
    };
    const wait = await waitForCheckRuns({
      api: stuck,
      scratchRepository: validName,
      ref: 'c0ffee',
      appearanceAttempts: 2,
      completionAttempts: 7,
      delayMilliseconds: 10_000,
      sleep: async () => {},
    });
    // Six sleeps between seven reads, at ten seconds each.
    expect(wait.waitedMilliseconds).toBe(60_000);
  });
});

describe('seedScratchRepository', () => {
  /**
   * The seed step against real git, because this is the one part of the live path a fake runner
   * hides. A shallow tip cannot be pushed to a remote that lacks its parent — GitHub answers
   * `shallow update not allowed` — so the orphan commit is load-bearing and only real git can say
   * whether it works.
   *
   * The push cannot reach GitHub. `pushEnvironment` rewrites the scratch URL onto a local bare
   * repository, and it also restricts git to the `file` transport, so an https push is refused
   * outright rather than attempted.
   */
  test('pushes the seeded tree to the base branch without a shallow update', async () => {
    await withWorkDirectory(async (root) => {
      const source = join(root, 'source');
      const remote = join(root, 'remote.git');
      const work = join(root, 'work');
      const environment = {
        ...Bun.env,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_SYSTEM: '/dev/null',
        GIT_AUTHOR_NAME: 'Fixture',
        GIT_AUTHOR_EMAIL: 'fixture@corvidae.invalid',
        GIT_COMMITTER_NAME: 'Fixture',
        GIT_COMMITTER_EMAIL: 'fixture@corvidae.invalid',
      };
      await Bun.write(join(source, 'scripts/build.ts'), 'export {};\n');
      for (const command of [
        ['git', 'init', '--quiet', source],
        ['git', '-C', source, 'add', '--all'],
        ['git', '-C', source, 'commit', '--quiet', '--message', 'target-owned build input'],
        ['git', 'init', '--quiet', '--bare', remote],
      ]) {
        const result = await runCommand(command, { cwd: root, env: environment });
        expect(result.exitCode).toBe(0);
      }

      const { api } = fakeGitHub();
      // The seed pushes as the *account*, so this is the environment the seed actually uses.
      // `pushEnvironment` is overridden identically so a future change routing the seed back
      // through the App cannot silently reach the real github.com from this test.
      const localRemote = {
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: `url.${remote}.insteadOf`,
        GIT_CONFIG_VALUE_0: `https://github.com/${validName}.git`,
        GIT_ALLOW_PROTOCOL: 'file',
        GIT_TERMINAL_PROMPT: '0',
      };
      const localOnly: GitHubApi = {
        ...api,
        async pushEnvironment() {
          return localRemote;
        },
        async accountPushEnvironment() {
          return localRemote;
        },
      };

      await seedScratchRepository({
        run: runCommand,
        api: localOnly,
        target: 'weft',
        seedRemote: `file://${source}`,
        scratchRepository: validName,
        workDirectory: work,
      });

      const log = await runCommand(['git', '-C', remote, 'log', '--format=%s %P', 'main'], {
        cwd: root,
        env: environment,
      });
      expect(log.exitCode).toBe(0);
      // One commit, and no parent: an orphan is what makes the push complete.
      expect(log.stdout.trim()).toBe(`Seed weft from file://${source}`);
      const tree = await runCommand(['git', '-C', remote, 'ls-tree', '-r', '--name-only', 'main'], {
        cwd: root,
        env: environment,
      });
      expect(tree.stdout.trim()).toBe('scripts/build.ts');
    });
  });
});

describe('runDryRunCommand', () => {
  test('refuses a delete aimed at a real repository and exits 1', async () => {
    const { api, calls } = fakeGitHub({ repositories: { 'stevekinney/weft': scratchRecord() } });
    const code = await runDryRunCommand(
      ['--phase', 'delete', '--scratch-repository', 'stevekinney/weft'],
      api,
    );
    expect(code).toBe(1);
    expect(calls.deleted).toEqual([]);
  });

  test('deletes the scratch repository when the phase is pointed at it', async () => {
    const { api, calls } = fakeGitHub({ repositories: { [validName]: scratchRecord() } });
    const code = await runDryRunCommand(
      ['--phase', 'delete', '--scratch-repository', validName],
      api,
    );
    expect(code).toBe(0);
    expect(calls.deleted).toEqual([validName]);
  });

  test('reports the coverage refusal from the preflight phase', async () => {
    const { api, calls } = fakeGitHub({ reachable: ['stevekinney/corvidae'] });
    const code = await runDryRunCommand(
      ['--phase', 'preflight', '--scratch-repository', validName],
      api,
    );
    expect(code).toBe(1);
    expect(calls.created).toEqual([]);
  });

  test('rejects an unknown phase without touching GitHub', async () => {
    const { api, calls } = fakeGitHub();
    expect(await runDryRunCommand(['--phase', 'nuke'], api)).toBe(1);
    expect(calls.deleted).toEqual([]);
    expect(calls.created).toEqual([]);
  });

  /**
   * `--check-run-timeout-minutes` is the knob that exists so the completion bound can be set from
   * an observed CI duration rather than from the default's estimate. A value that is not a
   * duration has to be refused before the run starts: silently falling back to the default would
   * let someone believe they had widened a bound they had not, and the run that then timed out
   * would be diagnosed against a number nobody chose.
   */
  test.each([
    ['a word', 'abc'],
    ['zero', '0'],
    ['a negative duration', '-5'],
    ['an empty value', ''],
  ])('refuses %s for --check-run-timeout-minutes before the run starts', async (_label, value) => {
    const { api, calls } = fakeGitHub();
    const original = process.stderr.write.bind(process.stderr);
    let captured = '';
    process.stderr.write = (chunk: unknown) => {
      captured += String(chunk);
      return true;
    };
    try {
      const code = await runDryRunCommand(
        [
          '--phase',
          'all',
          '--target',
          'weft',
          '--scratch-repository',
          validName,
          '--work',
          '/nonexistent/work',
          '--scratch',
          '/nonexistent/scratch',
          '--corvidae-commit',
          'abc123',
          '--check-run-timeout-minutes',
          value,
        ],
        api,
      );
      expect(code).toBe(1);
    } finally {
      process.stderr.write = original;
    }
    // The message names the option, so this cannot pass on some other refusal that also exits 1.
    expect(captured).toContain('--check-run-timeout-minutes must be a positive number');
    // And nothing reached GitHub, so no repository was created for a run that could not start.
    expect(calls.coverageReads).toBe(0);
    expect(calls.created).toEqual([]);
    expect(calls.deleted).toEqual([]);
  });
});
