import { runWithHangGuard } from '@lostgradient/testing/hang-guard';
import { describe, expect, it } from 'bun:test';
import { EventEmitter } from 'node:events';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { outcomeOf, rethrow } from '../../module-scope-scenario.test-support.ts';
import {
  REPOSITORY_ROOT,
  createBaselineProvenance,
  playwrightBaseImage,
  readRepositoryPins,
} from './baseline-provenance.ts';
import {
  DOCKERFILE_PATH,
  applyBaselines,
  containerCommand,
  containerNameForRun,
  createDockerRunner,
  describeHostLoad,
  dockerArchitectureProblem,
  dockerBuildArguments,
  dockerRunArguments,
  extractCommitArchive,
  normalizeDockerArchitecture,
  parseWrapperArguments,
  readHostLoad,
  runContainerWithCleanup,
  terminateContainer,
  type DockerRunner,
} from './docker-baseline-runner.ts';

// `git archive` and `tar` are real processes, so these scenarios also run once at module scope.
const archivedPath = 'scripts/browser-fixtures/visual-baselines.md';
const extractCommitArchiveOutcome = await outcomeOf(async () => {
  const root = mkdtempSync(join(tmpdir(), 'extract-commit-archive-'));
  try {
    const destination = join(root, 'committed');
    mkdirSync(destination);
    const tarPath = join(root, 'committed.tar');
    extractCommitArchive('HEAD', tarPath, [archivedPath], destination);
    expect(existsSync(join(destination, archivedPath))).toBe(true);
    expect(existsSync(tarPath)).toBe(false);

    const failedTarPath = join(root, 'failed.tar');
    expect(() =>
      extractCommitArchive('HEAD', failedTarPath, [archivedPath], join(root, 'missing')),
    ).toThrow(/Extracting/);
    expect(existsSync(failedTarPath)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// The stub docker binary is a real shell process, so this scenario runs once at module scope,
// off the per-test clock (COR-1507), and its test rethrows what it recorded.
const stubbedDockerSignalOutcome = await outcomeOf(async () => {
  const directory = mkdtempSync(join(tmpdir(), 'docker-stub-'));
  const log = join(directory, 'calls.log');
  const stub = join(directory, 'docker');
  // `run` blocks until `kill` drops a file; every call is logged with its stdin size.
  writeFileSync(
    stub,
    [
      '#!/bin/sh',
      `echo "$*" >> '${log}'`,
      'if [ "$1" = "run" ]; then',
      `  wc -c | tr -d ' ' >> '${log}'`,
      `  while [ ! -f '${directory}/killed' ]; do sleep 0.05; done`,
      '  exit 137',
      'fi',
      `if [ "$1" = "kill" ]; then touch '${directory}/killed'; fi`,
      'exit 0',
      '',
    ].join('\n'),
  );
  chmodSync(stub, 0o755);
  const input = join(directory, 'source.tar');
  writeFileSync(input, 'archive-bytes');
  const signals = new EventEmitter();
  const run = runContainerWithCleanup(
    createDockerRunner(stub),
    ['run', '--name', 'corvidae-baselines-test'],
    'corvidae-baselines-test',
    input,
    signals as unknown as Pick<NodeJS.Process, 'once' | 'off'>,
  );
  while (!existsSync(log) || !readFileSync(log, 'utf8').includes('13')) await Bun.sleep(20);
  signals.emit('SIGINT');
  expect(await run).toBe(130);
  expect(readFileSync(log, 'utf8').split('\n')).toEqual([
    'run --name corvidae-baselines-test',
    '13',
    'kill corvidae-baselines-test',
    '',
  ]);
  expect(signals.listenerCount('SIGINT')).toBe(0);
  expect(signals.listenerCount('SIGTERM')).toBe(0);
});

describe('host load record', () => {
  // Host load never blocks a run (COR-1512); each run records it instead.
  it('reads the 1-minute load average and the logical CPU count', () => {
    expect(readHostLoad(() => [56.25, 40, 30], 10)).toEqual({
      oneMinuteLoad: 56.25,
      logicalCpus: 10,
    });
    expect(readHostLoad(() => [], 4)).toEqual({ oneMinuteLoad: 0, logicalCpus: 4 });
  });

  it('describes a reading for the run output', () => {
    expect(describeHostLoad({ oneMinuteLoad: 11.5, logicalCpus: 10 })).toBe(
      '1-minute load 11.50 on 10 logical CPUs',
    );
  });
});

describe('docker architecture guard', () => {
  it('normalizes daemon architecture names', () => {
    expect(normalizeDockerArchitecture('aarch64\n')).toBe('arm64');
    expect(normalizeDockerArchitecture('x86_64')).toBe('x64');
  });

  it('accepts only a native arm64 daemon', () => {
    expect(dockerArchitectureProblem('arm64')).toBeUndefined();
    expect(dockerArchitectureProblem('x64')).toContain('native arm64');
    expect(dockerArchitectureProblem(undefined)).toContain('<unavailable>');
  });
});

describe('lockfile pins', () => {
  const pins = readRepositoryPins();

  it('passes the bun.lock Playwright version and the packageManager Bun as build arguments', () => {
    const dockerArguments = dockerBuildArguments(pins, 'image:tag');
    expect(dockerArguments).toContain(`PLAYWRIGHT_VERSION=${pins.playwrightVersion}`);
    expect(dockerArguments).toContain(`BUN_VERSION=${pins.bunVersion}`);
    expect(dockerArguments.slice(0, 3)).toEqual(['build', '--platform', 'linux/arm64']);
    expect(dockerArguments.at(-1)).toBe('-');
  });

  it('builds the Dockerfile from the lockfile version alone, never a typed tag', () => {
    const dockerfile = readFileSync(DOCKERFILE_PATH, 'utf8');
    const from = /^FROM (\S+)$/m.exec(dockerfile)?.[1];
    expect(from).toBe('mcr.microsoft.com/playwright:v${PLAYWRIGHT_VERSION}-jammy');
    expect(from?.replace('${PLAYWRIGHT_VERSION}', pins.playwrightVersion)).toBe(
      playwrightBaseImage(pins.playwrightVersion),
    );
    expect(dockerfile).toContain('ENV BASELINE_PLAYWRIGHT_VERSION=${PLAYWRIGHT_VERSION}');
    expect(dockerfile).toContain('ENV BASELINE_DOCKER=1');
    expect(dockerfile).not.toMatch(/\d+\.\d+\.\d+/);
  });
});

// List through the same scoped arguments both Docker modes pass to Playwright. No browser starts.
const screenshotSelection = await outcomeOf(async () => {
  const directory = mkdtempSync(join(tmpdir(), 'renderer-selection-'));
  try {
    const prepared = await runWithHangGuard(
      ['bun', 'scripts/browser-fixtures/scripts/prepare-manifest.ts'],
      { cwd: REPOSITORY_ROOT },
    );
    expect(prepared.exitCode, prepared.stderr.toString()).toBe(0);
    for (const scope of ['collapsible', 'popover,mega-menu,tooltip']) {
      const listName = 'component-screenshots.txt';
      for (const mode of ['update', 'visual'] as const) {
        expect(
          containerCommand(mode, [], { componentScope: scope, outputDirectory: directory }),
        ).toContain(
          `bun run test:browser:${mode} -- '--reporter=line,json' '--test-list' '/out/${listName}'`,
        );
      }
      const discovery = await runWithHangGuard(
        [
          'bun',
          '--bun',
          'playwright',
          'test',
          '--config',
          'scripts/browser-fixtures/playwright.config.ts',
          '--list',
          '--reporter=list',
          '--test-list',
          join(directory, listName),
        ],
        { cwd: REPOSITORY_ROOT, env: { ...process.env, CINDER_TEST_COMPONENTS: scope } },
      );
      expect(discovery.exitCode, discovery.stderr.toString()).toBe(0);
      const titles = discovery.stdout
        .toString()
        .split('\n')
        .filter((line) => line.includes('[chromium]'));
      if (scope === 'collapsible') {
        const cases = ['light', 'dark'].flatMap((theme) =>
          ['mobile', 'tablet', 'desktop'].map(
            (viewport) => `collapsible › ${theme}-${viewport}-assertion`,
          ),
        );
        expect(titles.map((title) => title.split(' › ').slice(2).join(' › ')).toSorted()).toEqual(
          cases.toSorted(),
        );
      } else {
        expect(
          titles
            .filter((title) => !title.includes('components-sweep.playwright.ts'))
            .map((title) => title.slice(title.lastIndexOf(' › ') + 3))
            .toSorted(),
        ).toEqual([
          'Accessibility shortcut alternatives wrap without overflowing',
          'nested submenu keyboard navigation enters, traverses, and exits',
          'popover anchors inside transformed and scrolled preview shells',
          'tooltip anchors inside transformed and scrolled preview shells',
        ]);
        expect(titles.some((title) => title.includes(' › popover › '))).toBe(true);
        expect(titles.some((title) => title.includes(' › collapsible › '))).toBe(false);
      }
      expect(discovery.stdout.toString()).toContain(`Total: ${titles.length} tests`);
    }
    expect(
      containerCommand('visual', [], { componentScope: ' , ', outputDirectory: directory }),
    ).toBe(containerCommand('visual', []));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it('selects only the requested screenshot cases in the Docker renderer', () =>
  rethrow(screenshotSelection));

describe('container command and run arguments', () => {
  it('prepares generated fixture inputs from the archive and returns the suite status', () => {
    const command = containerCommand('update', ['--grep', "it's"]);
    const preparation =
      'bun run --filter @lostgradient/cinder metadata && bun scripts/browser-fixtures/scripts/prepare-manifest.ts';
    expect(command).toStartWith(
      `mkdir -p /work && cd /work && tar -x && bun install --frozen-lockfile && ${preparation} && find scripts/browser-fixtures/snapshots/chromium/linux -name '*.png' -delete && touch /tmp/baseline-marker && bun run test:browser:update -- `,
    );
    expect(command).toContain(`-- '--reporter=line,json' '--grep' 'it'\\''s'`);
    expect(command.indexOf('status=$?')).toBeLessThan(command.indexOf('cp -R'));
    expect(command).toContain('-newer /tmp/baseline-marker > /out/regenerated.txt');
    expect(command).toContain('/out/manifest.json');
    expect(command).toContain('chown -R "$BASELINE_HOST_UID:$BASELINE_HOST_GID" /out');
    expect(command).toEndWith('exit $status');
    // Regression (COR-1512): a matching baseline is never rewritten in place, so an
    // update must start from no baselines or unchanged ones look like orphans.
    expect(containerCommand('visual', [])).not.toContain('-delete');
    expect(containerCommand('visual', [])).toContain(preparation);
    expect(containerCommand('visual', [])).toContain(
      "bun run test:browser:visual -- '--reporter=line,json'; status=$?",
    );
  });

  it('mounts only the output directory and names the container for cleanup', () => {
    const dockerArguments = dockerRunArguments({
      containerName: 'corvidae-baselines-1-2',
      imageTag: 'image:tag',
      outputDirectory: '/tmp/out',
      command: 'true',
      environment: { BASELINE_SOURCE_SHA: 'abc', EMPTY: '', UNSET: undefined },
    });
    expect(dockerArguments).toEqual([
      'run',
      '--interactive',
      '--rm',
      '--init',
      '--name',
      'corvidae-baselines-1-2',
      '--platform',
      'linux/arm64',
      '--env',
      'BASELINE_SOURCE_SHA=abc',
      '--volume',
      '/tmp/out:/out',
      'image:tag',
      'true',
    ]);
    expect(containerNameForRun(1, 2)).toBe('corvidae-baselines-1-2');
  });

  it('limits the container to the processors its run holds host slots for', () => {
    expect(
      dockerRunArguments({
        containerName: 'corvidae-baselines-1-2',
        cpus: 4,
        imageTag: 'image:tag',
        outputDirectory: '/tmp/out',
        command: 'true',
        environment: {},
      }),
    ).toEqual([
      'run',
      '--interactive',
      '--rm',
      '--init',
      '--name',
      'corvidae-baselines-1-2',
      '--platform',
      'linux/arm64',
      '--cpus',
      '4',
      '--volume',
      '/tmp/out:/out',
      'image:tag',
      'true',
    ]);
  });

  it('parses the wrapper flags and forwards the rest', () => {
    expect(
      parseWrapperArguments(['--source', 'abc', '--accept-behavioural-failures', '--grep', 'x']),
    ).toEqual({
      source: 'abc',
      acceptBehaviouralFailures: true,
      forwarded: ['--grep', 'x'],
    });
    expect(parseWrapperArguments(['--source=def']).source).toBe('def');
    expect(parseWrapperArguments([])).toEqual({
      source: 'HEAD',
      acceptBehaviouralFailures: false,
      forwarded: [],
    });
  });
});

describe('kill on signal', () => {
  it('kills the named container, waits for the run, and returns 128 + signal', async () => {
    const calls: string[][] = [];
    let waited = false;
    const docker: DockerRunner = async (dockerArguments) => {
      calls.push([...dockerArguments]);
      return 0;
    };
    const code = await terminateContainer('SIGTERM', 'corvidae-baselines-1-2', {
      docker,
      waitForRunExit: async () => {
        waited = true;
        return 137;
      },
    });
    expect(calls).toEqual([['kill', 'corvidae-baselines-1-2']]);
    expect(waited).toBe(true);
    expect(code).toBe(143);
    expect(
      await terminateContainer('SIGINT', 'name', { docker, waitForRunExit: async () => 137 }),
    ).toBe(130);
  });

  it('turns a signal during a run into the signal status through a stubbed docker binary', () => {
    rethrow(stubbedDockerSignalOutcome);
  });

  it('returns the container status when no signal arrives', async () => {
    const docker: DockerRunner = async () => 3;
    const signals = new EventEmitter();
    expect(
      await runContainerWithCleanup(
        docker,
        ['run'],
        'name',
        '/dev/null',
        signals as unknown as Pick<NodeJS.Process, 'once' | 'off'>,
      ),
    ).toBe(3);
  });
});

describe('extractCommitArchive', () => {
  // A kept run directory once carried this archive after the run, ~33 MB each.
  it('extracts the commit and deletes the archive, whether or not extraction succeeds', () => {
    rethrow(extractCommitArchiveOutcome);
  });
});

describe('applyBaselines', () => {
  it('copies the listed baselines, writes the given provenance, and deletes the orphans', async () => {
    const root = mkdtempSync(join(tmpdir(), 'apply-baselines-'));
    const source = join(root, 'source');
    const target = join(root, 'target');
    for (const path of ['button/a.png', 'button/b.png', 'provenance.json']) {
      mkdirSync(join(source, path, '..'), { recursive: true });
      writeFileSync(join(source, path), `new ${path}`);
    }
    mkdirSync(join(target, 'button'), { recursive: true });
    writeFileSync(join(target, 'button/b.png'), 'committed b');
    writeFileSync(join(target, 'button/orphan-default.png'), 'orphan');
    const provenance = createBaselineProvenance({
      componentScope: 'all',
      renderedSourceSha: 'a'.repeat(40),
      playwrightVersion: '1.63.0',
      osCodename: 'jammy',
      architecture: 'arm64',
      dockerImageTag: 'corvidae-browser-fixtures:1.63.0-jammy-arm64',
      suiteExitCode: 0,
    });
    await applyBaselines(
      source,
      target,
      ['button/a.png'],
      ['button/orphan-default.png'],
      provenance,
    );
    expect(existsSync(join(target, 'button/orphan-default.png'))).toBe(false);
    expect(readFileSync(join(target, 'button/a.png'), 'utf8')).toBe('new button/a.png');
    expect(readFileSync(join(target, 'button/b.png'), 'utf8')).toBe('committed b');
    expect(readFileSync(join(target, 'provenance.json'), 'utf8')).toBe(
      `${JSON.stringify(provenance, null, 2)}\n`,
    );
  });
});
