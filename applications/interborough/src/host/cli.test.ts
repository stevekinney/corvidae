import { runWithHangGuard, spawnWithHangGuard } from '@lostgradient/testing/hang-guard';
import { waitUntil } from '@lostgradient/testing/wait-until';
import { afterAll, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { HOST_RESTART_ROUTE, RESTART_EXIT_CODE } from './restart.ts';

const directory = mkdtempSync(join(tmpdir(), 'interborough-cli-'));
afterAll(() => rmSync(directory, { recursive: true, force: true }));
const executable = join(directory, 'bin', 'interborough');
const browser = join(directory, 'share', 'interborough', 'browser');
mkdirSync(browser, { recursive: true });
writeFileSync(join(browser, 'index.html'), '<!doctype html><title>Interborough</title>');
writeFileSync(join(directory, '.env'), 'INTERBOROUGH_PORT=invalid-dotenv-value\n');
const version = '1.2.3-test.4';
const build = await runWithHangGuard([
  process.execPath,
  'build',
  '--compile',
  '--no-compile-autoload-dotenv',
  '--no-compile-autoload-bunfig',
  '--compile-exec-argv=--no-install',
  '--define',
  `INTERBOROUGH_RELEASE_VERSION=${JSON.stringify(version)}`,
  '--loader',
  '.md:text',
  '--outfile',
  executable,
  join(import.meta.dir, 'cli.ts'),
]);
if (build.exitCode !== 0) throw new Error(build.stderr.toString());

const environment = { PATH: '', HOME: directory, NODE_ENV: 'production' };
const invoke = (arguments_: string[], env: Record<string, string> = {}) =>
  runWithHangGuard([executable, ...arguments_], {
    cwd: directory,
    env: { ...environment, ...env },
  });

const productionRequests: Request[] = [];
const productionServer = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    productionRequests.push(request.clone());
    if (request.headers.get('authorization') !== 'Bearer production-secret')
      return Response.json({ message: 'Forbidden' }, { status: 403 });
    if (new URL(request.url).pathname === '/host/status')
      return Response.json({
        deploymentId: 'production-deployment',
        incarnationId: 'production-incarnation',
        diagnostics: { providers: [] },
      });
    if (new URL(request.url).pathname === '/openrpc.json')
      return Response.json({ methods: [{ name: 'weft.alerts.list' }] });
    const body = (await request.json()) as { params?: unknown };
    return Response.json({ jsonrpc: '2.0', id: 'production', result: body.params });
  },
});
afterAll(() => productionServer.stop(true));

const untouched = join(directory, 'untouched');
const informationEnvironment = { INTERBOROUGH_HOME: untouched, INTERBOROUGH_PORT: 'bad' };
const help = await invoke(['--help'], informationEnvironment);
const startHelp = await invoke(['start', '--help'], informationEnvironment);
const release = await invoke(['--version'], informationEnvironment);
const startRelease = await invoke(['start', '--version'], informationEnvironment);
const createdHome = existsSync(untouched) || existsSync(join(directory, '.interborough'));
const productionConnection = await invoke(
  [
    'connection',
    'add',
    'production',
    '--url',
    `http://127.0.0.1:${productionServer.port}`,
    '--credential-reference',
    'INTERBOROUGH_TOKEN',
  ],
  { INTERBOROUGH_TOKEN: 'production-secret' },
);
const productionStatus = await invoke(['status', '--connection', 'production'], {
  INTERBOROUGH_TOKEN: 'production-secret',
});
const productionCall = spawnWithHangGuard(
  [
    executable,
    'api',
    'call',
    'weft.alerts.list',
    '--yes',
    '--connection',
    'production',
    '--input',
    '-',
  ],
  {
    cwd: directory,
    env: { ...environment, INTERBOROUGH_TOKEN: 'production-secret' },
    stdin: 'pipe',
  },
);
productionCall.stdin.write('{"revision":"r1","idempotencyKey":"i1"}');
productionCall.stdin.end();
const [productionCallStdout, productionCallStderr, productionCallExitCode] = await Promise.all([
  new Response(productionCall.stdout).text(),
  new Response(productionCall.stderr).text(),
  productionCall.exited,
]);

test('compiled help and version write stdout without validating or creating a home', () => {
  for (const result of [help, startHelp]) {
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain('Usage: interborough start');
    expect(result.stderr.toString()).toBe('');
  }
  for (const result of [release, startRelease]) {
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe(`${version}\n`);
    expect(result.stderr.toString()).toBe('');
  }
  expect(createdHome).toBe(false);
});

test('compiled commands use the production environment and preserve piped JSON parameters', () => {
  expect(productionConnection.exitCode).toBe(0);
  expect(productionStatus.exitCode).toBe(0);
  expect(productionStatus.stdout.toString()).toContain('production-deployment');
  expect(productionCallExitCode).toBe(0);
  expect(productionCallStderr).toBe('');
  expect(productionCallStdout).toContain('revision');
  expect(productionRequests[0]?.headers.get('authorization')).toBe('Bearer production-secret');
});

const invalidOptions = [
  ['--unknown'],
  ['--port'],
  ['--port', '--help'],
  ['--port', '0', '--port=1'],
  ['--port='],
  ['--port', '0x10'],
  ['--port', '65536'],
  ['--home='],
  ['--home', '.env'],
  ['--home', '.env/child'],
  ['--a2a-public-origin', 'http://agents.example.com'],
  ['--a2a-public-origin', 'https://agents.example.com/path'],
  ['extra'],
];
const invalidResults = [];
for (const options of invalidOptions) {
  invalidResults.push({ options, result: await invoke(['start', ...options]) });
}

test.each(invalidResults)('rejects $options before starting the host', ({ result }) => {
  expect(result.exitCode).toBe(2);
  expect(result.stdout.toString()).toBe('');
  expect(result.stderr.toString()).not.toBe('');
});

async function exerciseStart() {
  const running = spawnWithHangGuard([executable, 'start', '--port=0', '--home', 'relative-home'], {
    cwd: directory,
    env: { ...environment, INTERBOROUGH_PORT: 'bad', INTERBOROUGH_HOME: '.env' },
    stdout: 'pipe',
    stderr: 'inherit',
  });
  let output = '';
  const read = (async () => {
    for await (const chunk of running.stdout.pipeThrough(new TextDecoderStream())) output += chunk;
  })();
  const urls = () =>
    Array.from(
      output.matchAll(/^Interborough is listening on (http:\/\/127\.0\.0\.1:\d+)$/gm),
      (match) => match[1],
    );
  const waitForUrl = (count: number) =>
    waitUntil(() => urls().length === count, {
      message: 'the standalone host to report its listening URL',
      yieldTurn: () => Bun.sleep(25),
    });
  let evidence;
  try {
    await waitForUrl(1);
    const first = urls()[0];
    if (first === undefined) throw new Error('Missing startup URL.');
    const beforeStatus = await fetch(new URL('/host/status', first));
    const beforeIdentity = await beforeStatus.json();
    const homeCreated = existsSync(join(directory, 'relative-home'));
    const restart = await fetch(new URL(HOST_RESTART_ROUTE, first), { method: 'POST' });
    await waitForUrl(2);
    const second = urls()[1];
    if (second === undefined) throw new Error('Missing restarted URL.');
    const afterStatus = await fetch(new URL('/host/status', second));
    const afterIdentity = await afterStatus.json();
    const response = await fetch(second);
    evidence = {
      port: new URL(first).port,
      homeCreated,
      restartStatus: restart.status,
      beforeIdentity,
      afterIdentity,
      html: await response.text(),
    };
  } finally {
    running.kill('SIGTERM');
    await running.exited;
    await read;
  }
  return { ...evidence, exitCode: running.exitCode, output };
}

const started = await exerciseStart();
test('starts itself, resolves the port and relative home flags, restarts and forwards SIGTERM', () => {
  expect(started.port).not.toBe('0');
  expect(started.homeCreated).toBe(true);
  expect(started.restartStatus).toBe(202);
  expect(started.beforeIdentity.deploymentId).toBe(started.afterIdentity.deploymentId);
  expect(started.beforeIdentity.incarnationId).not.toBe(started.afterIdentity.incarnationId);
  expect(started.afterIdentity.diagnostics).toBeDefined();
  expect(JSON.stringify(started.afterIdentity)).not.toContain('secret');
  expect(started.html).toContain('<title>Interborough</title>');
  expect(started.exitCode).toBe(0);
  expect(started.output.match(/Started the host/g)).toHaveLength(2);
});

const startingFixture = join(directory, 'restart-during-start.test.ts');
const hostModule = JSON.stringify(join(import.meta.dir, 'host.ts'));
const serveModule = JSON.stringify(join(import.meta.dir, 'serve.ts'));
writeFileSync(
  startingFixture,
  `import { mock, test } from 'bun:test';
mock.module(${hostModule}, () => ({
  async startHost({ onRestartRequested }) {
    queueMicrotask(() => { void onRestartRequested(); });
    await new Promise((resolve) => setImmediate(resolve));
    return {
      url: new URL('http://127.0.0.1:7234'),
      database: { kind: 'postgres' },
      async close() { console.info('Closed the host after startup.'); },
    };
  },
}));
const { serveHost } = await import(${serveModule});
test('restart requested before startup resolves', async () => {
  await serveHost({}, '.');
  await new Promise((resolve) => setImmediate(resolve));
});
`,
);
const earlyRestart = await runWithHangGuard([process.execPath, 'test', startingFixture], {
  cwd: directory,
});

test('a restart received during startup closes the host before requesting a relaunch', () => {
  expect(earlyRestart.exitCode).toBe(RESTART_EXIT_CODE);
  expect(earlyRestart.stdout.toString()).toContain('Closed the host after startup.');
});
