import { runWithHangGuard } from '@lostgradient/testing/hang-guard';
import { throwingRejectionOf } from '@lostgradient/testing/promise-outcome';
import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { InstalledFetch } from './test-installed-release-transport.ts';
import { runInstalled, runInstalledRelease } from './test-installed-release.ts';

async function exerciseJourney(fault: string, port = 43123, relocated = false) {
  const root = await mkdtemp(join(tmpdir(), 'installed-release-matrix-'));
  let registryAttempt: Promise<Response> | undefined;
  let clock = 0;
  let spawns = 0;
  let agentRuns = 0;
  let readiness = 0;
  let killed = 0;
  let restarted = false;
  const marker = join(root, 'tool-marker.txt');
  const response = (value: unknown, status = 200) =>
    new Response(typeof value === 'string' ? value : JSON.stringify(value), { status });
  const replacementPort = fault === 'changed-port' || port === 0 ? 43124 : 43123;
  const fetcher: InstalledFetch = async (input) => {
    const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
    if (path === '/') {
      if (fault === 'open-listener') return response('still listening', 503);
      throw new TypeError('connection refused');
    }
    if (path === '/app.js' || path === '/app.css')
      return response('', fault === 'asset-http' ? 404 : 200);
    if (path === '/host/plugins')
      return response({
        plugins: [
          {
            descriptor: { name: 'installed-fixture' },
            status: fault === 'plugin' ? 'failed' : 'running',
          },
        ],
        unloaded: fault === 'broken-plugin' ? [] : [{ error: 'missing-installed-import' }],
      });
    if (path.includes('/ag-ui/')) {
      agentRuns += 1;
      if (fault !== 'missing-tool-marker')
        await writeFile(
          marker,
          fault === 'dependency-marker' && agentRuns === 2
            ? 'wrong dependency'
            : 'fixture-owned-dependency',
        );
      const wrongOutput =
        fault === 'tool-output' || (fault === 'restart-tool-output' && agentRuns === 2);
      return response(
        `data: {"type":"RUN_STARTED","runId":"public-run-${agentRuns}","metadata":{"@lostgradient/bureau":{"runId":"run-${agentRuns}"}}}\n\ndata: ${JSON.stringify({ type: 'TEXT_MESSAGE_CONTENT', delta: wrongOutput ? 'wrong output' : 'fixture greeted Ada' })}\n`,
      );
    }
    if (path === '/host/mcp-apps')
      return response({
        apps:
          fault === 'missing-panel' ? [] : [{ plugin: 'installed-fixture', app: 'fixture-panel' }],
      });
    if (path.endsWith('/fixture-panel'))
      return response({
        html: fault === 'panel-text' ? 'wrong text' : 'Installed fixture MCP panel',
        ui: fault === 'panel-metadata' ? {} : { csp: {} },
      });
    if (path === '/bureau/mcp')
      return response(
        fault === 'inspection-error'
          ? { error: {} }
          : fault === 'inspection-empty'
            ? {}
            : fault === 'inspection-tool-error'
              ? { result: { isError: true } }
              : { result: { taskId: 'run-1' } },
      );
    if (path.endsWith('/run-inspector'))
      return response(
        { html: fault === 'inspector-html' ? '' : '<div id="root">', ui: { csp: {} } },
        fault === 'inspector-http' ? 404 : 200,
      );
    if (path === '/host/status') return response({}, fault === 'status' ? 500 : 200);
    if (path === '/host/restart') {
      restarted = true;
      return response({}, fault === 'restart-http' ? 500 : 202);
    }
    throw new Error(`Unexpected request: ${path}`);
  };
  try {
    if (relocated) {
      if (fault !== 'deployment-marker')
        await writeFile(join(root, 'deployment-id'), '01ARZ3NDEKTSV4RRFFQ69G5FAV\n');
      const target = join(
        root,
        fault === 'runtime-link' ? 'wrong-runtime' : 'plugin-runtime/node_modules/sdk',
      );
      await mkdir(target, { recursive: true });
      await mkdir(join(root, 'plugins/node_modules/@lostgradient'), { recursive: true });
      await symlink(target, join(root, 'plugins/node_modules/@lostgradient/interborough-plugin'));
    }
    const result = await runInstalled('/bin/true', root, relocated, port, root, {
      now: () => clock,
      sleep: async (milliseconds) => {
        clock += milliseconds === 100 ? 240_001 : milliseconds;
      },
      spawn: (_executable, _arguments, _home, _cwd, registryUrl) => {
        if (fault === 'registry') registryAttempt = fetch(registryUrl);
        spawns += 1;
        const code = fault === 'sigterm' ? 1 : fault === 'reacquire-exit' && spawns === 2 ? 2 : 0;
        let exitCode: number | null = null;
        const child = {
          get exitCode() {
            return exitCode;
          },
          exited: Promise.resolve(code),
          kill: () => {
            killed += 1;
            exitCode = code;
          },
        } as unknown as ReturnType<typeof Bun.spawn>;
        return {
          process: child,
          stdout: Promise.resolve(''),
          stderr: Promise.resolve(''),
          output: () => {
            const first = 'Interborough is listening on http://127.0.0.1:43123\n';
            if (!restarted || fault === 'restart-announcement') return first;
            const pids =
              fault === 'same-pid'
                ? [999991, 999991]
                : fault === 'missing-pid'
                  ? [999991]
                  : fault === 'alive-child'
                    ? [process.pid, 999992]
                    : [999991, 999992];
            return (
              first +
              `Interborough is listening on http://127.0.0.1:${replacementPort}\n` +
              pids.map((pid) => `Started the host (process ${pid})`).join('\n')
            );
          },
        };
      },
      waitForListening: async () => {
        await registryAttempt;
        if (fault === 'reacquire-readiness' && spawns === 2)
          throw new Error('reacquire readiness failed');
        return { port: 43123, text: 'listening' };
      },
      waitForHttp: async () => {
        readiness += 1;
        return response(
          fault === 'shell-assets'
            ? '<div>'
            : '<script src="/app.js"></script><link href="/app.css">',
          fault === 'restart-listener' && readiness === 2 ? 503 : 200,
        );
      },
      fetch: fetcher,
      assertBrowser: async () => {
        if (fault === 'browser') throw new Error('browser assertion failed');
      },
    });
    expect(agentRuns).toBe(2);
    expect(spawns).toBe(2);
    return result;
  } finally {
    expect(killed).toBe(spawns);
    await rm(root, { recursive: true, force: true });
  }
}

test('records successful ephemeral-port and relocated journeys', async () => {
  const assertions = await exerciseJourney('', 0, true);
  expect(assertions.some((entry) => entry.assertion.includes('relocation preserved'))).toBe(true);
  expect(assertions.at(-1)?.details).toEqual({ requests: [] });
});

for (const [fault, message] of [
  ['registry', 'attempted registry access'],
  ['shell-assets', 'Shell did not mount'],
  ['asset-http', '/app.js returned 404'],
  ['plugin', 'plugin isolation failed'],
  ['broken-plugin', 'plugin isolation failed'],
  ['tool-output', 'output was not deterministic'],
  ['missing-tool-marker', 'marker was not written'],
  ['missing-panel', 'panel was not mounted'],
  ['panel-text', 'text or UI metadata missing'],
  ['panel-metadata', 'text or UI metadata missing'],
  ['inspection-tool-error', 'did not answer'],
  ['inspection-empty', 'did not answer'],
  ['inspection-error', 'did not answer'],
  ['inspector-http', 'inspector page missing'],
  ['inspector-html', 'inspector page missing'],
  ['browser', 'browser assertion failed'],
  ['status', 'Host status unavailable'],
  ['restart-http', 'Restart returned 500'],
  ['restart-announcement', 'replacement port'],
  ['changed-port', 'Explicit port changed'],
  ['restart-listener', 'preserve listener'],
  ['restart-tool-output', 'Restarted fixture tool output'],
  ['dependency-marker', 'additional dependency'],
  ['missing-pid', 'replace child PID'],
  ['same-pid', 'replace child PID'],
  ['sigterm', 'SIGTERM exit was 1'],
  ['alive-child', 'recorded child alive'],
  ['open-listener', 'Listener remained'],
  ['reacquire-exit', 'State lock could not be reacquired'],
  ['reacquire-readiness', 'reacquire readiness failed'],
  ['deployment-marker', 'preserve deployment marker'],
  ['runtime-link', 'link target was'],
] as const) {
  test(`rejects ${fault} and cleans up every spawned process`, async () => {
    expect(
      await throwingRejectionOf(
        exerciseJourney(fault, 43123, fault === 'deployment-marker' || fault === 'runtime-link'),
      ),
    ).toThrow(message);
  });
}

test('stops and drains the child when initial readiness fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'installed-release-cleanup-'));
  let killed = false;
  let drained = false;
  const child = {
    exitCode: null,
    kill: () => {
      killed = true;
    },
    exited: Promise.resolve(0),
  } as unknown as ReturnType<typeof Bun.spawn>;
  try {
    expect(
      await throwingRejectionOf(
        runInstalled('/bin/true', root, false, 0, root, {
          spawn: () => ({
            process: child,
            output: () => '',
            stdout: Promise.resolve('').then((text) => {
              drained = true;
              return text;
            }),
            stderr: Promise.resolve(''),
          }),
          waitForListening: async () => {
            throw new Error('readiness failed');
          },
        }),
      ),
    ).toThrow('readiness failed');
    expect(killed).toBe(true);
    expect(drained).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const archiveScenario = await (async () => {
  const root = await mkdtemp(join(tmpdir(), 'installed-release-archive-test-'));
  try {
    const source = join(root, 'source');
    await mkdir(join(source, 'interborough/bin'), { recursive: true });
    await mkdir(join(source, 'interborough/share/interborough/plugin-runtime/node_modules'), {
      recursive: true,
    });
    await writeFile(join(source, 'interborough/bin/interborough'), 'fixture executable');
    const archive = join(root, 'fixture.tar.gz');
    const tar = await runWithHangGuard(['tar', '-czf', archive, '-C', source, 'interborough']);
    expect(tar.exitCode).toBe(0);
    const evidenceDirectory = join(root, 'evidence');
    const invoke = () =>
      runInstalledRelease(['--archive', archive, '--evidence', evidenceDirectory], {
        runInstalled: async (_executable, prefix, _relocated, _port, existingHome) => {
          await mkdir(join(existingHome ?? join(prefix, 'home'), 'plugins'), { recursive: true });
          return [];
        },
      });
    const first = await Bun.file(await invoke()).json();
    const second = await Bun.file(await invoke()).json();
    return { first, second };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
})();

test('verifies newly built archives and keeps evidence local to each invocation', () => {
  const { first, second } = archiveScenario;
  expect(first.assertions).toHaveLength(1);
  expect(second.assertions).toHaveLength(1);
  expect(first.assertions[0].details.sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(second.assertions[0].details.sha256).toBe(first.assertions[0].details.sha256);
});

test('runs command mode and cleans its disposable prefix on success and failure', async () => {
  let prefix = '';
  let evidence = '';
  try {
    evidence = await runInstalledRelease(['--command', '/bin/true'], {
      runInstalled: async (executable, directory, relocated, port) => {
        prefix = directory;
        expect(executable).toBe('/bin/true');
        expect(relocated).toBe(false);
        expect(port).toBeGreaterThan(0);
        return [];
      },
    });
    expect(await Bun.file(evidence).json()).toEqual({ assertions: [] });
    expect(await Bun.file(prefix).exists()).toBe(false);
    expect(
      await throwingRejectionOf(
        runInstalledRelease(['--command', '/bin/true'], {
          runInstalled: async (_executable, directory) => {
            prefix = directory;
            throw new Error('journey failed');
          },
        }),
      ),
    ).toThrow('journey failed');
    expect(await Bun.file(prefix).exists()).toBe(false);
  } finally {
    if (evidence) await rm(evidence, { force: true });
  }
});

test('rejects an unreadable archive instead of recording successful extraction', async () => {
  const root = await mkdtemp(join(tmpdir(), 'installed-release-invalid-archive-'));
  try {
    const archive = join(root, 'invalid.tar.gz');
    await writeFile(archive, 'not an archive');
    expect(await throwingRejectionOf(runInstalledRelease(['--archive', archive]))).toThrow(
      'tar failed',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
