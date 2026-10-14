import { describe, expect, it } from 'bun:test';
import { EventEmitter } from 'node:events';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { playwrightBaseImage, readRepositoryPins } from './baseline-provenance.ts';
import {
  DOCKERFILE_PATH,
  LOAD_WAIT_LIMIT_MILLISECONDS,
  applyBaselines,
  containerCommand,
  containerNameForRun,
  createDockerRunner,
  dockerArchitectureProblem,
  dockerBuildArguments,
  dockerRunArguments,
  normalizeDockerArchitecture,
  parseWrapperArguments,
  runContainerWithCleanup,
  terminateContainer,
  waitForHostLoad,
  type DockerRunner,
  type LoadReading,
} from './docker-baseline-runner.ts';

const reading = (load: number): LoadReading => ({ load, limit: 30, cpuCount: 10 });

describe('host load gate', () => {
  it('starts immediately when the load is at or under three times the CPU count', async () => {
    const result = await waitForHostLoad(false, {
      readLoad: () => reading(30),
      sleep: async () => {},
      log: () => {},
    });
    expect(result).toEqual({ ok: true, waitedMilliseconds: 0, reading: reading(30) });
  });

  it('refuses without --wait-for-load and prints the reading', async () => {
    const result = await waitForHostLoad(false, {
      readLoad: () => reading(56),
      sleep: async () => {},
      log: () => {},
    });
    if (result.ok) throw new Error('expected a refusal');
    expect(result.reason).toContain('1-minute load 56.00 against a limit of 30');
    expect(result.reason).toContain('--wait-for-load');
  });

  it('polls every minute and records the wait', async () => {
    const loads = [56, 40, 12];
    const sleeps: number[] = [];
    const messages: string[] = [];
    const result = await waitForHostLoad(true, {
      readLoad: () => reading(loads.shift() ?? 0),
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
      },
      log: (message) => messages.push(message),
    });
    expect(sleeps).toEqual([60_000, 60_000]);
    expect(result.ok).toBe(true);
    expect(result.waitedMilliseconds).toBe(120_000);
    expect(messages.at(-1)).toContain('settled after 2 minutes');
  });

  it('reports blocked after three hours above the limit', async () => {
    let sleeps = 0;
    const result = await waitForHostLoad(true, {
      readLoad: () => reading(56),
      sleep: async () => {
        sleeps += 1;
      },
      log: () => {},
    });
    if (result.ok) throw new Error('expected blocked');
    expect(sleeps).toBe(180);
    expect(result.waitedMilliseconds).toBe(LOAD_WAIT_LIMIT_MILLISECONDS);
    expect(result.reason).toContain('Blocked');
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

describe('container command and run arguments', () => {
  it('unpacks the archive, installs from the lockfile, and returns the suite status', () => {
    const command = containerCommand('update', ['--grep', "it's"]);
    expect(command).toStartWith(
      'mkdir -p /work && cd /work && tar -x && bun install --frozen-lockfile && touch /tmp/baseline-marker && bun run test:browser:update -- ',
    );
    expect(command).toContain(`'--grep' 'it'\\''s'`);
    expect(command.indexOf('status=$?')).toBeLessThan(command.indexOf('cp -R'));
    expect(command).toContain('-newer /tmp/baseline-marker > /out/regenerated.txt');
    expect(command).toContain('chown -R "$BASELINE_HOST_UID:$BASELINE_HOST_GID" /out');
    expect(command).toEndWith('exit $status');
    expect(containerCommand('visual', [])).toContain('bun run test:browser:visual; status=$?');
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

  it('parses the wrapper flags and forwards the rest', () => {
    expect(parseWrapperArguments(['--wait-for-load', '--source', 'abc', '--grep', 'x'])).toEqual({
      waitForLoad: true,
      source: 'abc',
      forwarded: ['--grep', 'x'],
    });
    expect(parseWrapperArguments(['--source=def']).source).toBe('def');
    expect(parseWrapperArguments([])).toEqual({
      waitForLoad: false,
      source: 'HEAD',
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

  it('turns a signal during a run into the signal status through a stubbed docker binary', async () => {
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

describe('applyBaselines', () => {
  it('copies only the listed baselines and provenance into the host tree', async () => {
    const root = mkdtempSync(join(tmpdir(), 'apply-baselines-'));
    const source = join(root, 'source');
    const target = join(root, 'target');
    for (const path of ['button/a.png', 'button/b.png', 'provenance.json']) {
      mkdirSync(join(source, path, '..'), { recursive: true });
      writeFileSync(join(source, path), `new ${path}`);
    }
    mkdirSync(join(target, 'button'), { recursive: true });
    writeFileSync(join(target, 'button/b.png'), 'committed b');
    await applyBaselines(source, target, ['button/a.png']);
    expect(readFileSync(join(target, 'button/a.png'), 'utf8')).toBe('new button/a.png');
    expect(readFileSync(join(target, 'button/b.png'), 'utf8')).toBe('committed b');
    expect(readFileSync(join(target, 'provenance.json'), 'utf8')).toBe('new provenance.json');
  });
});
