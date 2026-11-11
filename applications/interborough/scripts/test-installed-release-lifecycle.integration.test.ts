import { runWithHangGuard } from '@lostgradient/testing/hang-guard';
import { outcomeOf, rethrow } from '@lostgradient/testing/module-scope-scenario';
import { rejectionOf, throwingRejectionOf } from '@lostgradient/testing/promise-outcome';
import { expect, spyOn, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createResponseDroppingProxy,
  interruptInstalledStream,
  verifyInstalledApproval,
  verifyStaleInstalledWorkflow,
  type InstalledFetch,
} from './test-installed-release-transport.ts';
import { runInstalled, runInstalledRelease } from './test-installed-release.ts';

test('response-dropping proxy preserves ordinary HTTP and records the committed mutation', async () => {
  const received: Array<{ method: string; body: string; host: string | null }> = [];
  const upstream = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      received.push({
        method: request.method,
        body: await request.text(),
        host: request.headers.get('host'),
      });
      return new Response('committed', { status: 201, headers: { 'x-fixture': 'forwarded' } });
    },
  });
  const proxy = createResponseDroppingProxy(upstream.url);
  try {
    for (const method of ['GET', 'HEAD', 'POST']) {
      const response = await fetch(new URL('/ordinary', proxy.server.url), {
        method,
        ...(method === 'POST' ? { body: 'ordinary' } : {}),
      });
      expect(response.status).toBe(201);
      expect(response.headers.get('x-fixture')).toBe('forwarded');
      expect(await response.text()).toBe(method === 'HEAD' ? '' : 'committed');
    }
    const readResponse = await fetch(new URL('/bureau/jsonrpc', proxy.server.url), {
      method: 'POST',
      body: '{"method":"bureau.agents.definitions.list"}',
    });
    expect(await readResponse.text()).toBe('committed');
    const body = '{"method":"bureau.agents.definitions.create"}';
    expect(
      await rejectionOf(
        fetch(new URL('/bureau/jsonrpc', proxy.server.url), { method: 'POST', body }).then(
          (response) => response.text(),
        ),
      ),
    ).toBeInstanceOf(Error);
    expect(proxy.requests).toEqual([body]);
    expect(proxy.upstreamStatus).toBe(201);
    expect(received).toHaveLength(5);
    expect(received.every((request) => request.host === upstream.url.host)).toBe(true);
    expect(received[2]?.body).toBe('ordinary');
  } finally {
    await proxy.server.stop(true);
    await upstream.stop(true);
  }
});

for (const [stage, response, message] of [
  [0, { exitCode: 1, stdout: '', stderr: 'denied' }, 'Could not read workflow'],
  [0, { exitCode: 0, stdout: '{}', stderr: '' }, 'did not return a current hash'],
  [1, { exitCode: 0, stdout: '', stderr: '' }, 'Stale installed mutation was not rejected'],
  [2, { exitCode: 1, stdout: '', stderr: '' }, 'changed durable workflow state'],
  [
    2,
    { exitCode: 0, stdout: '{"data":{"hash":"changed"}}', stderr: '' },
    'changed durable workflow state',
  ],
  [-1, { exitCode: 0, stdout: '', stderr: '' }, 'success'],
] as const) {
  test(`stale workflow ${stage}: ${message} (${response.exitCode})`, async () => {
    const commands: string[][] = [];
    const journey = verifyStaleInstalledWorkflow(async (arguments_) => {
      commands.push(arguments_);
      if (commands.length - 1 === stage) return response;
      return {
        exitCode: commands.length === 2 ? 4 : 0,
        stdout: '{"data":{"hash":"current"}}',
        stderr: '',
      };
    }, '/fixture/update.json');
    if (stage === -1) {
      expect(await journey).toEqual({ currentHash: 'current', staleExit: 4 });
      expect(commands).toHaveLength(3);
      expect(commands[1]).toEqual([
        'workflows',
        'update',
        'installed-cli-workflow',
        '--file',
        '/fixture/update.json',
        '--if-revision',
        '0'.repeat(64),
      ]);
      expect(commands[0]).toEqual(commands[2]);
    } else {
      expect(await throwingRejectionOf(journey)).toThrow(message);
      expect(commands).toHaveLength(stage + 1);
    }
  });
}

for (const [stage, response, message] of [
  [0, { exitCode: 0, stdout: '', stderr: '' }, 'Approval chat did not pause'],
  [0, { exitCode: 5, stdout: '', stderr: '' }, 'did not report a run identifier'],
  [1, { exitCode: 1, stdout: '', stderr: 'denied' }, 'Review list failed'],
  [1, { exitCode: 0, stdout: '{}', stderr: '' }, 'did not create a review'],
  [2, { exitCode: 1, stdout: '', stderr: 'denied' }, 'Review approval failed'],
  [2, { exitCode: 0, stdout: '{}', stderr: '' }, 'did not return a continuation'],
  [3, { exitCode: 1, stdout: 'completed', stderr: 'failed' }, 'did not complete'],
  [3, { exitCode: 0, stdout: 'running', stderr: '' }, 'did not complete'],
  [-1, { exitCode: 0, stdout: '', stderr: '' }, 'success'],
] as const) {
  test(`approval journey ${stage}: ${message} (${response.exitCode})`, async () => {
    const commands: string[][] = [];
    const results = [
      { exitCode: 5, stdout: 'run-original', stderr: '' },
      { exitCode: 0, stdout: '{"data":{"reviews":[{"id":"review-1"}]}}', stderr: '' },
      { exitCode: 0, stdout: '{"continuation":{"runId":"run-continuation"}}', stderr: '' },
      { exitCode: 0, stdout: 'completed', stderr: '' },
    ];
    const journey = verifyInstalledApproval(async (arguments_) => {
      commands.push(arguments_);
      return commands.length - 1 === stage ? response : results[commands.length - 1]!;
    });
    if (stage === -1) {
      expect(await journey).toEqual({ reviewId: 'review-1', runId: 'run-original' });
      expect(commands[2]).toEqual(['reviews', 'approve', 'review-1']);
      expect(commands[3]).toEqual([
        'runs',
        'watch',
        '--kind',
        'task',
        'run-continuation',
        '--output',
        'jsonl',
      ]);
    } else {
      expect(await throwingRejectionOf(journey)).toThrow(message);
      expect(commands).toHaveLength(stage + 1);
    }
  });
}

for (const mode of [
  'ready',
  'ended',
  'failed',
  'wrong-exit',
  'state-failed',
  'state-changed',
] as const) {
  test(`collects the interrupted stream child when ${mode}`, async () => {
    const signals: Array<string | number | undefined> = [];
    const exited = Promise.withResolvers<number>();
    let exitCode: number | null = null;
    const failure = new Error('stream failed');
    const stdout = new ReadableStream<Uint8Array<ArrayBuffer>>({
      start(controller) {
        if (mode === 'failed') controller.error(failure);
        else {
          for (const part of mode === 'ended' ? ['not ready'] : ['rea', 'dy\n'])
            controller.enqueue(new TextEncoder().encode(part));
          controller.close();
        }
      },
    });
    const child = {
      stdout,
      stderr: new Response('diagnostic').body!,
      exited: exited.promise,
      get exitCode() {
        return exitCode;
      },
      kill(signal?: string | number) {
        signals.push(signal);
        exitCode = mode === 'wrong-exit' ? 1 : signal === 'SIGINT' ? 130 : 143;
        exited.resolve(exitCode);
      },
    };
    const readState = async () => ({
      exitCode: mode === 'state-failed' ? 1 : 0,
      stdout: mode === 'state-changed' ? 'after' : 'before',
    });
    if (mode === 'ready')
      expect(await interruptInstalledStream(child, 'before', readState)).toEqual({ exitCode: 130 });
    else {
      const error = await rejectionOf(interruptInstalledStream(child, 'before', readState));
      if (mode === 'failed') expect(error).toBe(failure);
      else
        expect(error).toMatchObject({
          message:
            mode === 'ended'
              ? 'Compiled SIGINT stream never reached readiness: not ready'
              : mode === 'wrong-exit'
                ? 'Compiled SIGINT stream exited 1: diagnostic'
                : 'SIGINT stream changed durable mutation state',
        });
    }
    expect(signals).toEqual([mode === 'ended' || mode === 'failed' ? 'SIGTERM' : 'SIGINT']);
    expect(stdout.locked).toBe(false);
    expect(await child.exited).toBe(
      mode === 'wrong-exit' ? 1 : mode === 'ended' || mode === 'failed' ? 143 : 130,
    );
  });
}

async function exerciseJourney(fault: string, port = 43123, relocated = false) {
  const root = await mkdtemp(join(tmpdir(), 'installed-release-matrix-'));
  let restoreCertificate: (() => void) | undefined;
  let registryAttempt: Promise<Response> | undefined;
  let clock = 0;
  let spawns = 0;
  let agentRuns = 0;
  let readiness = 0;
  let actualPrincipals = 0;
  let scheduleReads = 0;
  let agentReads = 0;
  let authorityUrl = '';
  let killed = 0;
  let restarted = false;
  const commandFault = fault.startsWith('authority-');
  const home = commandFault ? join(root, 'home') : root;
  const marker = join(home, 'tool-marker.txt');
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
    if (path === '/host/panels')
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
    const executable = commandFault ? join(root, 'interborough') : '/bin/true';
    if (commandFault) await writeFile(executable, 'fixture');
    if (fault === 'authority-certificate') {
      const certificate = spyOn(Bun, 'spawnSync').mockReturnValue({
        exitCode: 1,
        stdout: Buffer.alloc(0),
        stderr: Buffer.from('certificate-fixture-failed'),
        success: false,
        pid: 0,
        resourceUsage: {
          contextSwitches: { voluntary: 0, involuntary: 0 },
          cpuTime: { user: 0n, system: 0n, total: 0n },
          maxRSS: 0,
          messages: { sent: 0, received: 0 },
          ops: { in: 0, out: 0 },
          shmSize: 0,
          signalCount: 0,
          swapCount: 0,
        },
      });
      restoreCertificate = () => certificate.mockRestore();
    }
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
    const result = await runInstalled(
      executable,
      root,
      relocated,
      port,
      commandFault ? undefined : root,
      {
        failAfterAuthority: async (urls) => {
          if (fault !== 'authority-nonmember') return;
          for (const url of urls) {
            const invalid = await fetch(new URL('/api/v1/principal', url), {
              headers: { 'x-api-key': 'invalid' },
            });
            expect(invalid.status).toBe(401);
            const response = await fetch(new URL('/api/v1/principal', url), {
              headers: { 'x-api-key': 'outsider' },
            });
            expect(response.status).toBe(403);
          }
          throw new Error('Authenticated non-member refused');
        },
        runCommand: async (
          _executable,
          arguments_,
          _home,
          _cwd,
          _registry,
          _input,
          environment,
        ) => {
          if (arguments_[0] === 'connection' && arguments_[2] === 'authority')
            authorityUrl = arguments_[arguments_.indexOf('--url') + 1]!;
          if (
            fault === 'authority-http-contract' &&
            environment?.['NODE_EXTRA_CA_CERTS'] !== undefined
          ) {
            const tls = { ca: await readFile(environment['NODE_EXTRA_CA_CERTS'], 'utf8') };
            const unauthorized = await fetch(`${authorityUrl}/host/status`, { tls });
            expect(unauthorized.status).toBe(401);
            const headers = { 'x-api-key': 'bob' };
            const status = await fetch(`${authorityUrl}/host/status`, { tls, headers });
            expect(await status.json()).toEqual({ deploymentId: 'deployment-bob' });
            for (const [method, expected] of [
              ['bureau.tasks.get', { result: { id: 'terminal', status: 'running' } }],
              [
                'bureau.tasks.cancel',
                { error: { message: 'read-only workspace fixture', data: { httpStatus: 403 } } },
              ],
            ] as const) {
              const rpc = await fetch(`${authorityUrl}/bureau/jsonrpc`, {
                tls,
                headers,
                method: 'POST',
                body: JSON.stringify({ method }),
              });
              expect(await rpc.json()).toEqual(expected);
            }
            const health = await fetch(`${authorityUrl}/health`, { tls, headers });
            expect(await health.json()).toEqual({ ok: true });
            return { exitCode: 9, stdout: '', stderr: 'fixture contract verified' };
          }
          if (arguments_.includes('--url') && arguments_[0] !== 'connection') {
            if (fault === 'authority-command-exit')
              return { exitCode: 9, stdout: '', stderr: 'injected command failure' };
            if (fault === 'authority-command-envelope')
              return { exitCode: 0, stdout: '{"schemaVersion":2}', stderr: '' };
            if (arguments_.includes('installed-cli-dropped-response-agent'))
              return {
                exitCode: fault === 'authority-dropped-success' ? 0 : 1,
                stdout: '',
                stderr: 'response dropped',
              };
            if (arguments_[0] === 'agents' && arguments_[1] === 'list') {
              agentReads += 1;
              if (
                (agentReads === 2 && fault === 'authority-agent-read') ||
                (agentReads === 3 && fault === 'authority-dropped-read')
              )
                return { exitCode: 9, stdout: '', stderr: 'injected agent read failure' };
              if (agentReads === 3 && fault !== 'authority-dropped-missing')
                return {
                  exitCode: 0,
                  stdout: '{"data":{"agents":[{"id":"installed-cli-dropped-response-agent"}]}}',
                  stderr: '',
                };
            }
            return { exitCode: 0, stdout: '{"schemaVersion":1,"data":{}}', stderr: '' };
          }
          const actualConnection = arguments_.find((argument) => argument.startsWith('actual-'));
          if (actualConnection !== undefined) {
            const stage =
              arguments_[0] === 'connection'
                ? actualConnection
                : arguments_[0] === 'whoami'
                  ? ++actualPrincipals === 1
                    ? 'actual-principal'
                    : 'actual-workspace'
                  : arguments_[1] === 'create'
                    ? 'actual-write'
                    : ++scheduleReads === 1
                      ? 'actual-read-before'
                      : 'actual-read-after';
            if (stage === 'actual-read-after' && fault === 'authority-actual-read-changed')
              return { exitCode: 0, stdout: '[{"id":"unexpected-schedule"}]', stderr: '' };
            if (fault === `authority-${stage}`)
              return {
                exitCode: stage === 'actual-write' || stage === 'actual-workspace' ? 0 : 9,
                stdout: '',
                stderr: 'injected actual authority failure',
              };
            return {
              exitCode: stage === 'actual-workspace' || stage === 'actual-write' ? 3 : 0,
              stdout:
                stage === 'actual-principal'
                  ? arguments_[arguments_.indexOf('--workspace') + 1]!
                  : '[]',
              stderr: '',
            };
          }
          const stage =
            arguments_[0] === 'connection'
              ? 'connection'
              : arguments_[0] === 'whoami'
                ? environment?.['NODE_EXTRA_CA_CERTS'] === undefined
                  ? 'untrusted'
                  : arguments_.includes('workspace-bob')
                    ? 'wrong-workspace'
                    : 'trusted'
                : arguments_.includes('dropped')
                  ? 'dropped'
                  : 'terminal';
          if (fault === `authority-${stage}`)
            return { exitCode: 9, stdout: '', stderr: 'injected command failure' };
          if (stage === 'untrusted')
            return { exitCode: 1, stdout: '', stderr: 'certificate rejected' };
          if (stage === 'wrong-workspace')
            return { exitCode: 3, stdout: '', stderr: 'workspace mismatch' };
          if (stage === 'dropped')
            return { exitCode: 1, stdout: '', stderr: 'missing terminal event' };
          return {
            exitCode: 0,
            stdout:
              stage === 'trusted' ? 'workspace-alice' : stage === 'terminal' ? 'completed' : '',
            stderr: '',
          };
        },
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
      },
    );
    expect(agentRuns).toBe(2);
    expect(spawns).toBe(2);
    return result;
  } finally {
    restoreCertificate?.();
    expect(killed).toBe(spawns);
    await rm(root, { recursive: true, force: true });
  }
}

const successfulJourney = await outcomeOf(async () => {
  const assertions = await exerciseJourney('', 0, true);
  expect(assertions.some((entry) => entry.assertion.includes('relocation preserved'))).toBe(true);
  expect(assertions.at(-1)?.details).toEqual({ requests: [] });
});
test('records successful ephemeral-port and relocated journeys', () => rethrow(successfulJourney));

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
  ['authority-http-contract', 'Trusted authority request failed'],
  ['authority-certificate', 'Could not create authority fixture certificate'],
  ['authority-nonmember', 'Authenticated non-member refused'],
  ['authority-dropped-success', 'Dropped-response mutation unexpectedly returned success'],
  ['authority-dropped-read', 'Could not read agents after dropped-response probe'],
  ['authority-dropped-unobserved', 'was not committed exactly once'],
  ['authority-dropped-missing', 'was not committed exactly once'],
  ['authority-command-exit', 'Installed CLI status exited 9'],
  ['authority-command-envelope', 'returned an invalid envelope'],
  ['authority-agent-read', 'Could not read agents before dropped-response probe'],
  ['authority-actual-alice', 'Actual authority connection failed'],
  ['authority-actual-principal', 'Actual workspace authentication failed'],
  ['authority-actual-workspace', 'Actual wrong workspace was accepted'],
  ['authority-actual-bob', 'Read-only authority connection failed'],
  ['authority-actual-admin-bob-host', 'Administrator host connection failed'],
  ['authority-actual-read-before', 'Administrator schedule read failed'],
  ['authority-actual-write', 'Read-only workspace accepted a schedule mutation'],
  ['authority-actual-read-changed', 'Read-only workspace mutation changed durable schedules'],
  ['authority-actual-read-after', 'Read-only workspace mutation changed durable schedules'],
  ['authority-connection', 'configure installed authority connection'],
  ['authority-untrusted', 'Untrusted authority request'],
  ['authority-trusted', 'Trusted authority request failed'],
  ['authority-wrong-workspace', 'Wrong workspace was not refused'],
  ['authority-terminal', 'Terminal installed watch failed'],
  ['authority-dropped', 'Dropped installed watch did not fail closed'],
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
  const outcome = await outcomeOf(async () => {
    expect(
      await throwingRejectionOf(
        exerciseJourney(fault, 43123, fault === 'deployment-marker' || fault === 'runtime-link'),
      ),
    ).toThrow(message);
  });
  test(`rejects ${fault} and cleans up every spawned process`, () => rethrow(outcome));
}

// spawn-free: the injected process and readiness failure stop execution before any real command.
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
    await writeFile(
      join(source, 'interborough/release.json'),
      JSON.stringify({ sourceSha: 'fixture-source' }),
    );
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
    const previous = process.env['CORVIDAE_EXPECTED_RELEASE_SHA'];
    process.env['CORVIDAE_EXPECTED_RELEASE_SHA'] = 'fixture-source';
    try {
      const bound = await Bun.file(await invoke()).json();
      expect(bound.assertions[0].details.manifest.sourceSha).toBe('fixture-source');
      process.env['CORVIDAE_EXPECTED_RELEASE_SHA'] = 'wrong-source';
      expect(await throwingRejectionOf(invoke())).toThrow('did not match wrong-source');
    } finally {
      if (previous === undefined) delete process.env['CORVIDAE_EXPECTED_RELEASE_SHA'];
      else process.env['CORVIDAE_EXPECTED_RELEASE_SHA'] = previous;
    }
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

test('records non-Error journey failures and removes the disposable installation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'installed-release-rejection-'));
  let prefix = '';
  const failure = 'external journey rejected';
  try {
    const outcome = await rejectionOf(
      runInstalledRelease(['--command', '/bin/true', '--evidence', root], {
        runInstalled: (_executable, directory) => {
          prefix = directory;
          return Promise.reject(failure);
        },
      }),
    );
    expect(outcome).toBe(failure);
    const files = await readdir(root);
    expect(files).toHaveLength(1);
    expect(files[0]).toStartWith('installed-release-failure-');
    const evidence = await Bun.file(join(root, files[0]!)).json();
    expect(evidence.failure).toBe(failure);
    expect(prefix).not.toBe('');
    expect(await rejectionOf(stat(prefix))).toMatchObject({ code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
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
