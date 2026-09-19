import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  assertInstallationCoverage,
  deleteScratchRepository,
  DryRunError,
  ensureScratchRepository,
  InstallationCoverageError,
  proveNpmPublishDryRun,
  runDryRun,
  runDryRunCommand,
  seedScratchRepository,
  waitForCheckRuns,
  type StageTransform,
} from './dry-run.ts';
import type {
  CommandRunner,
  CreatePullRequestInput,
  CreateRepositoryInput,
  GitHubApi,
  RepositoryRecord,
} from './github-api.ts';
import { runCommand, type CommandResult } from './packaging.ts';
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

function fakeRunner(overrides: { npmExitCode?: number } = {}): RunnerHarness {
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
    if (command[0] === 'npm') {
      return { ...base, exitCode: overrides.npmExitCode ?? 0, stdout: '+ package@1.0.0\n' };
    }
    return { ...base, exitCode: 0 };
  };
  return { run, commands, environments };
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
    await withWorkDirectory(async (workDirectory) => {
      await expect(
        runDryRun({
          api,
          corvidaeRoot: workDirectory,
          target: 'weft',
          workDirectory: join(workDirectory, 'clone'),
          corvidaeCommit: 'abc123',
          scratchRepository: validName,
          run: harness.run,
          stage: fakeStage('1.0.0'),
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
    const report = await withWorkDirectory((workDirectory) =>
      runDryRun({
        api,
        corvidaeRoot: workDirectory,
        target: 'weft',
        workDirectory: join(workDirectory, 'clone'),
        corvidaeCommit: 'abc123',
        scratchRepository: validName,
        run: harness.run,
        stage: fakeStage('1.0.0'),
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
  });

  test('pushes as the App, with the credential in the environment and never in a command', async () => {
    const { api } = fakeGitHub();
    const harness = fakeRunner();
    await withWorkDirectory((workDirectory) =>
      runDryRun({
        api,
        corvidaeRoot: workDirectory,
        target: 'weft',
        workDirectory: join(workDirectory, 'clone'),
        corvidaeCommit: 'abc123',
        scratchRepository: validName,
        run: harness.run,
        stage: fakeStage('1.0.0'),
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
    const clone = harness.commands.find((command) => command.includes('clone'));
    expect(clone?.join(' ')).not.toContain('Authorization');
  });

  test('keeps the scratch repository when asked, so a human can look at the pull request', async () => {
    const { api, calls } = fakeGitHub();
    const harness = fakeRunner();
    const report = await withWorkDirectory((workDirectory) =>
      runDryRun({
        api,
        corvidaeRoot: workDirectory,
        target: 'weft',
        workDirectory: join(workDirectory, 'clone'),
        corvidaeCommit: 'abc123',
        scratchRepository: validName,
        keep: true,
        run: harness.run,
        stage: fakeStage('1.0.0'),
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
          corvidaeCommit: 'abc123',
          scratchRepository: 'stevekinney/weft',
          run: fakeRunner().run,
          stage: fakeStage('1.0.0'),
        }),
      ).rejects.toThrow(ScratchGuardError);
    });
    expect(calls.coverageReads).toBe(0);
    expect(calls.created).toEqual([]);
  });
});

describe('proveNpmPublishDryRun', () => {
  async function probe(version: string, overrides: { npmExitCode?: number } = {}) {
    const harness = fakeRunner(overrides);
    const result = await withWorkDirectory(async (workDirectory) => {
      const outcome = await fakeStage(version)({
        corvidaeRoot: workDirectory,
        target: 'weft',
        directory: workDirectory,
      });
      const report = await proveNpmPublishDryRun({
        run: harness.run,
        workDirectory,
        outcome,
      }).catch((error: unknown) => error);
      return report;
    });
    return { result, harness };
  }

  test('runs npm publish --dry-run with scripts ignored and judges it by exit code', async () => {
    const { result, harness } = await probe('1.4.0');
    expect(result).toMatchObject({
      publicName: '@lostgradient/cryptography',
      version: '1.4.0',
      exitCode: 0,
    });
    expect(harness.commands.at(-1)).toEqual([
      'npm',
      'publish',
      '--dry-run',
      '--ignore-scripts',
      '--tag',
      'latest',
    ]);
  });

  test('names a tag for a prerelease version, which npm refuses to publish without one', async () => {
    const { harness } = await probe('2.0.0-rc.1');
    expect(harness.commands.at(-1)).toEqual([
      'npm',
      'publish',
      '--dry-run',
      '--ignore-scripts',
      '--tag',
      'next',
    ]);
  });

  test('fails when npm exits non-zero', async () => {
    const { result } = await probe('1.4.0', { npmExitCode: 1 });
    expect(result).toBeInstanceOf(DryRunError);
  });
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
    const checkRuns = await waitForCheckRuns({
      api: polling,
      scratchRepository: validName,
      ref: 'c0ffee',
      sleep: async () => {},
    });
    expect(reads).toBe(3);
    expect(checkRuns).toEqual([{ name: 'build', status: 'completed', conclusion: 'success' }]);
  });

  test('gives up after five attempts and reports what it has', async () => {
    let reads = 0;
    const { api } = fakeGitHub();
    const stuck: GitHubApi = {
      ...api,
      async readCheckRuns() {
        reads += 1;
        return [{ name: 'build', status: 'in_progress', conclusion: null }];
      },
    };
    const checkRuns = await waitForCheckRuns({
      api: stuck,
      scratchRepository: validName,
      ref: 'c0ffee',
      sleep: async () => {},
    });
    expect(reads).toBe(5);
    expect(checkRuns).toEqual([{ name: 'build', status: 'in_progress', conclusion: null }]);
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
      const localOnly: GitHubApi = {
        ...api,
        async pushEnvironment() {
          return {
            GIT_CONFIG_COUNT: '1',
            GIT_CONFIG_KEY_0: `url.${remote}.insteadOf`,
            GIT_CONFIG_VALUE_0: `https://github.com/${validName}.git`,
            GIT_ALLOW_PROTOCOL: 'file',
            GIT_TERMINAL_PROMPT: '0',
          };
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
});
