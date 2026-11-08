import { throwingRejectionOf } from '@lostgradient/testing/promise-outcome';
import { describe, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { validateInspection, validateInstalledUi } from './test-installed-release-browser.ts';
import { mcp, runFixtureAgent } from './test-installed-release-transport.ts';
import {
  parseInstalledReleaseArguments,
  parseRunStartedRunId,
  referencedAssets,
  runInstalled,
  runInstalledRelease,
  waitForHttp,
  waitForListening,
} from './test-installed-release.ts';

describe('installed-release harness arguments', () => {
  test('accepts archive mode and resolves the archive path', () => {
    expect(parseInstalledReleaseArguments(['--archive', './release.tar.gz'])).toEqual({
      mode: 'archive',
      archive: expect.stringMatching(/release\.tar\.gz$/),
    });
  });

  test('accepts command mode and resolves the executable path', () => {
    expect(parseInstalledReleaseArguments(['--command', './interborough'])).toEqual({
      mode: 'command',
      command: expect.stringMatching(/interborough$/),
    });
  });

  test('accepts a caller-selected evidence directory', () => {
    expect(
      parseInstalledReleaseArguments(['--command', './interborough', '--evidence', './evidence']),
    ).toMatchObject({
      evidence: expect.stringMatching(/evidence$/),
    });
  });

  test('extracts only the run identifier from a RUN_STARTED event', () => {
    expect(
      parseRunStartedRunId(
        'data: {"type":"RUN_STARTED","runId":"public-run-42","metadata":{"@lostgradient/bureau":{"runId":"run-42"}}}\n\n',
      ),
    ).toBe('run-42');
    expect(
      parseRunStartedRunId(
        'event: message\r\ndata: {"runId": "public-run-43", "type": "RUN_STARTED", "metadata": {"@lostgradient/bureau": {"runId": "run-43"}}}\r\n\r\n',
      ),
    ).toBe('run-43');
    expect(() => parseRunStartedRunId('data: {"type":"RUN_FINISHED"}\n\n')).toThrow('RUN_STARTED');
    expect(() => parseRunStartedRunId('data: {"type":"RUN_STARTED","runId":""}\n\n')).toThrow(
      'RUN_STARTED',
    );
    expect(() =>
      parseRunStartedRunId(
        'data: {"type":"RUN_STARTED","runId":"public-run-1","metadata":{"@lostgradient/bureau":{"runId":"run-1"}}}\n\ndata: {"type":"RUN_ERROR","message":"agent unavailable"}\n\n',
      ),
    ).toThrow('agent unavailable');
  });

  test('extracts shell JavaScript and CSS references for HTTP assertions', () => {
    expect(referencedAssets('<script src="/app.js"></script><link href="/app.css">')).toEqual([
      '/app.js',
      '/app.css',
    ]);
  });

  test('covers MCP JSON, SSE, HTTP, and malformed responses', async () => {
    const request = async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response('{"result":{"ok":true}}', { status: 200 });
    expect(await mcp('http://host', 1, 'tools/list', {}, request)).toEqual({
      result: { ok: true },
    });
    expect(
      await mcp(
        'http://host',
        1,
        'tools/list',
        {},
        async () => new Response('data: {"result":{"ok":true}}\n\n', { status: 200 }),
      ),
    ).toEqual({ result: { ok: true } });
    expect(
      await throwingRejectionOf(
        mcp('http://host', 1, 'tools/list', {}, async () => new Response('no', { status: 500 })),
      ),
    ).toThrow('returned 500');
    expect(
      await throwingRejectionOf(
        mcp('http://host', 1, 'tools/list', {}, async () => new Response('no', { status: 200 })),
      ),
    ).toThrow('no JSON');
  });

  test('covers fixture agent success, HTTP failure, and malformed RUN_STARTED', async () => {
    const request = async () =>
      new Response(
        'data: {"type":"RUN_STARTED","runId":"public-run-1","metadata":{"@lostgradient/bureau":{"runId":"run-1"}}}\n\n',
        { status: 200 },
      );
    expect(await runFixtureAgent('http://host', request)).toMatchObject({
      runId: 'run-1',
    });
    expect(
      await throwingRejectionOf(
        runFixtureAgent('http://host', async () => new Response('failed', { status: 503 })),
      ),
    ).toThrow('did not start');
    expect(
      await throwingRejectionOf(
        runFixtureAgent('http://host', async () => new Response('data: {}\n\n', { status: 200 })),
      ),
    ).toThrow('RUN_STARTED');
  });

  test('covers readiness success, child exit, and HTTP timeout branches', async () => {
    const readyProbe = {
      process: { exitCode: null } as ReturnType<typeof Bun.spawn>,
      output: () => 'Interborough is listening on http://127.0.0.1:43210',
      stdout: Promise.resolve(''),
      stderr: Promise.resolve(''),
    };
    expect(await waitForListening(readyProbe)).toMatchObject({ port: 43210 });
    const exitedProbe = {
      process: { exitCode: 1 } as ReturnType<typeof Bun.spawn>,
      output: () => 'failed',
      stdout: Promise.resolve(''),
      stderr: Promise.resolve('stderr'),
    };
    expect(await throwingRejectionOf(waitForListening(exitedProbe))).toThrow('exited 1');
    expect(await throwingRejectionOf(waitForHttp('http://127.0.0.1:9', 0))).toThrow('Timed out');
  });

  test('waits for HTTP readiness and times out without draining a live child', async () => {
    let requests = 0;
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      routes: {
        '/': () =>
          new Response(++requests === 1 ? 'pending' : 'ready', {
            status: requests === 1 ? 503 : 200,
          }),
        '/pending': new Response('pending', { status: 503 }),
      },
    });
    try {
      const ready = await waitForHttp(`http://127.0.0.1:${server.port}`);
      expect(ready.status).toBe(200);
      expect(
        await throwingRejectionOf(waitForHttp(`http://127.0.0.1:${server.port}/pending`, 0)),
      ).toThrow('Timed out');
      expect(
        await throwingRejectionOf(
          waitForListening(
            {
              process: { exitCode: null } as ReturnType<typeof Bun.spawn>,
              output: () => '',
              stdout: Promise.resolve(''),
              stderr: new Promise(() => {}),
              errorOutput: () => 'child still starting',
            },
            0,
          ),
        ),
      ).toThrow('did not listen');
      expect(
        await throwingRejectionOf(
          waitForListening(
            {
              process: { exitCode: null } as ReturnType<typeof Bun.spawn>,
              output: () => 'partial startup',
              stdout: Promise.resolve(''),
              stderr: new Promise(() => {}),
              errorOutput: () => 'child diagnostic',
            },
            0,
          ),
        ),
      ).toThrow(/partial startup[\s\S]*child diagnostic/);
    } finally {
      await server.stop(true);
    }
  });

  test('covers installed UI and inspection validation success/error branches', () => {
    const response = new Response('{}', { status: 200 });
    expect(validateInstalledUi(response, { html: '<main />', ui: { csp: {} } }, 'panel').html).toBe(
      '<main />',
    );
    expect(() =>
      validateInstalledUi(new Response('{}', { status: 503 }), {} as never, 'panel'),
    ).toThrow('returned 503');
    expect(() => validateInstalledUi(response, { html: '', ui: { csp: {} } }, 'panel')).toThrow(
      'omitted UI metadata',
    );
    expect(validateInspection(response, { result: { taskId: 'run-1' } })).toEqual({
      taskId: 'run-1',
    });
    expect(() => validateInspection(new Response('{}', { status: 500 }), {})).toThrow(
      'returned 500',
    );
    expect(() => validateInspection(response, { error: { message: 'no' } })).toThrow(
      'returned an error',
    );
    expect(() => validateInspection(response, {})).toThrow('returned an error');
  });

  test('orchestrates archive and relocation through injectable process seams', async () => {
    const calls: string[] = [];
    const evidenceDirectory = await mkdtemp(join(tmpdir(), 'installed-release-seam-'));
    try {
      const evidence = await runInstalledRelease(
        ['--archive', './fixture.tar.gz', '--evidence', evidenceDirectory],
        {
          unpack: async (_archive, prefix) => {
            const executable = `${prefix}/interborough/bin/interborough`;
            await mkdir(`${prefix}/interborough/bin`, { recursive: true });
            await mkdir(`${prefix}/interborough/share/interborough/plugin-runtime/node_modules`, {
              recursive: true,
            });
            await writeFile(executable, 'fixture');
            return { executable, sha256: 'fixture-hash' };
          },
          runInstalled: async (executable, prefix, relocated) => {
            await mkdir(`${prefix}/home/plugins`, { recursive: true });
            calls.push(`${relocated ? 'relocated' : 'initial'}:${executable}:${prefix}`);
            return [];
          },
        },
      );
      expect(calls).toHaveLength(2);
      expect(calls[0]).toContain('initial:');
      expect(calls[1]).toContain('relocated:');
      expect(evidence).toMatch(/installed-release-.*\.json$/);
    } finally {
      await rm(evidenceDirectory, { recursive: true, force: true });
    }
  });

  test('propagates readiness failures through the process seam', async () => {
    const root = await mkdtemp(join(tmpdir(), 'installed-release-process-seam-'));
    const process = {
      exitCode: null,
      exited: Promise.resolve(0),
      kill: () => true,
    } as unknown as ReturnType<typeof Bun.spawn>;
    const probe = {
      process,
      stdout: Promise.resolve(''),
      stderr: Promise.resolve(''),
      output: () => '',
    };
    try {
      expect(
        await throwingRejectionOf(
          runInstalled('/bin/true', root, false, 0, root, {
            spawn: () => probe,
            waitForListening: async () => ({ port: 43123, text: 'listening' }),
            waitForHttp: async () => {
              throw new Error('shell readiness failed');
            },
          }),
        ),
      ).toThrow('shell readiness failed');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('creates the real fixture and exercises the default process spawn', async () => {
    const root = await mkdtemp(join(tmpdir(), 'installed-release-default-process-'));
    const executable = join(root, 'bin', 'interborough');
    try {
      await mkdir(join(root, 'share/interborough/plugin-runtime/node_modules'), {
        recursive: true,
      });
      await mkdir(join(root, 'bin'), { recursive: true });
      await writeFile(
        executable,
        '#!/bin/sh\necho "Interborough is listening on http://127.0.0.1:43124"\n',
      );
      await chmod(executable, 0o755);
      expect(
        await throwingRejectionOf(
          runInstalled(executable, root, false, 0, undefined, {
            waitForHttp: async () => {
              throw new Error('fixture startup ended');
            },
          }),
        ),
      ).toThrow('fixture startup ended');
      expect(await Bun.file(join(root, 'home/plugins/installed-fixture/plugin.ts')).exists()).toBe(
        true,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('drives the full installed lifecycle through deterministic operations', async () => {
    const root = await mkdtemp(join(tmpdir(), 'installed-release-full-seam-'));
    const marker = join(root, 'tool-marker.txt');
    const process = {
      exitCode: null,
      exited: Promise.resolve(0),
      kill: () => true,
    } as unknown as ReturnType<typeof Bun.spawn>;
    const probe = {
      process,
      stdout: Promise.resolve(''),
      stderr: Promise.resolve(''),
      output: () =>
        'Interborough is listening on http://127.0.0.1:43123\n' +
        'Interborough is listening on http://127.0.0.1:43123\n' +
        'Started the host (process 999991)\nStarted the host (process 999992)',
    };
    const response = (body: unknown, status = 200) =>
      new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
    const fetcher = async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url.startsWith('http://127.0.0.1:') && new URL(url).pathname === '/')
        throw new TypeError('connection refused');
      if (url.includes('/ag-ui/')) {
        await writeFile(marker, 'fixture-owned-dependency');
        return response(
          'data: {"type":"RUN_STARTED","runId":"public-run-1","metadata":{"@lostgradient/bureau":{"runId":"run-1"}}}\n\ndata: {"type":"TEXT_MESSAGE_CONTENT","delta":"fixture greeted Ada"}\n',
        );
      }
      if (url.endsWith('/host/plugins'))
        return response({
          plugins: [{ descriptor: { name: 'installed-fixture' }, status: 'running' }],
          unloaded: [{ error: 'missing-installed-import' }],
        });
      if (url.endsWith('/host/mcp-apps'))
        return response({ apps: [{ plugin: 'installed-fixture', app: 'fixture-panel' }] });
      if (url.includes('/fixture-panel'))
        return response({ html: '<main>Installed fixture MCP panel</main>', ui: { csp: {} } });
      if (url.includes('/run-inspector'))
        return response({ html: '<div id="root"></div>', ui: { csp: {} } });
      if (url.endsWith('/bureau/mcp')) return response({ result: { taskId: 'run-1' } });
      if (url.endsWith('/host/restart')) return response({}, 202);
      return response({}, 200);
    };
    try {
      await runInstalled('/bin/true', root, false, 43123, root, {
        spawn: () => probe,
        waitForListening: async () => ({ port: 43123, text: 'listening' }),
        waitForHttp: async () => response('<script src="/app.js"></script><link href="/app.css">'),
        fetch: fetcher,
        assertBrowser: async () => undefined,
      });
      expect(await Bun.file(marker).text()).toBe('fixture-owned-dependency');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('rejects a missing or mixed mode', () => {
    for (const arguments_ of [
      [],
      ['--archive'],
      ['--command', ''],
      ['--archive', 'x', 'extra'],
      ['--other', 'x'],
      ['--archive', 'x', '--evidence'],
    ])
      expect(() => parseInstalledReleaseArguments(arguments_)).toThrow('Usage:');
  });
});
