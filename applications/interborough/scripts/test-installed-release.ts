import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { openBungalow } from '@lostgradient/bungalow';
import { BUREAU_SCOPES } from '@lostgradient/bureau';
import { AUTHORIZATION_SCOPES, principalFromApiKey } from '@lostgradient/weft';
import { enableDemoPlugin } from '../src/host/demo-plugin-home.ts';
import { startHost } from '../src/host/host.ts';
import { expectedReleaseSourceSha, pluginIdentityBase } from './environment-configuration.ts';
import { assertInstalledAppsInChromium } from './test-installed-release-browser.ts';
import { linkPluginRuntime, writeFixture } from './test-installed-release-fixture.ts';
import {
  createResponseDroppingProxy,
  interruptInstalledStream,
  mcp,
  runFixtureAgent,
  verifyInstalledApproval,
  verifyStaleInstalledWorkflow,
  type InstalledFetch,
} from './test-installed-release-transport.ts';
export { parseRunStartedRunId } from './test-installed-release-transport.ts';

const DEFAULT_EVIDENCE = 'tmp/chef/COR-2039';
const TIMEOUT = 240_000;

export type InstalledReleaseArguments =
  | { readonly mode: 'archive'; readonly archive: string; readonly evidence?: string }
  | { readonly mode: 'command'; readonly command: string; readonly evidence?: string };

export function parseInstalledReleaseArguments(argv: readonly string[]): InstalledReleaseArguments {
  if (
    (argv.length !== 2 && argv.length !== 4) ||
    (argv[0] !== '--archive' && argv[0] !== '--command') ||
    argv[1]?.trim() === '' ||
    (argv.length === 4 && (argv[2] !== '--evidence' || argv[3]?.trim() === ''))
  )
    throw new Error(
      'Usage: bun scripts/test-installed-release.ts --archive <archive> | --command <executable>',
    );
  return {
    mode: argv[0] === '--archive' ? 'archive' : 'command',
    [argv[0] === '--archive' ? 'archive' : 'command']: resolve(argv[1]!),
    ...(argv.length === 4 ? { evidence: resolve(argv[3]!) } : {}),
  } as InstalledReleaseArguments;
}

type Child = ReturnType<typeof Bun.spawn>;
type Probe = {
  readonly process: Child;
  readonly stdout: Promise<string>;
  readonly stderr: Promise<string>;
  readonly output: () => string;
  readonly errorOutput?: () => string;
};
type Acceptance = {
  readonly assertion: string;
  readonly command: string;
  readonly exit: number;
  readonly details?: Record<string, unknown>;
};

let installedCommandTracePath: string | undefined;
const installedCommandTrace: Array<Record<string, unknown>> = [];

export function referencedAssets(html: string): string[] {
  return [...html.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)].map((match) => match[1]!);
}

export function spawn(
  executable: string,
  arguments_: readonly string[],
  home: string,
  cwd: string,
  registryUrl: string,
): Probe {
  const process = Bun.spawn([executable, ...arguments_], {
    cwd,
    env: {
      PATH: '/usr/bin:/bin',
      HOME: home,
      INTERBOROUGH_HOME: home,
      npm_config_registry: registryUrl,
      BUN_CONFIG_REGISTRY: registryUrl,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  let output = '';
  let errorOutput = '';
  const stdout = (async () => {
    for await (const chunk of process.stdout) {
      const text = new TextDecoder().decode(chunk);
      output += text;
    }
    return output;
  })();
  const stderr = (async () => {
    for await (const chunk of process.stderr) {
      const text = new TextDecoder().decode(chunk);
      errorOutput += text;
    }
    return errorOutput;
  })();
  return { process, stdout, stderr, output: () => output, errorOutput: () => errorOutput };
}

export async function waitForListening(
  probe: Probe,
  timeout = TIMEOUT,
): Promise<{ port: number; text: string }> {
  const start = Date.now();
  for (;;) {
    const text = probe.output();
    const match = text.match(/Interborough is listening on http:\/\/127\.0\.0\.1:(\d+)/);
    if (match) return { port: Number(match[1]), text };
    if (probe.process.exitCode !== null)
      throw new Error(
        `Installed release exited ${probe.process.exitCode}: ${text}\n${await probe.stderr}`,
      );
    if (Date.now() - start > timeout)
      throw new Error(
        `Installed release did not listen: ${text}\n` +
          `standard error:\n${probe.errorOutput?.() ?? '<unavailable>'}`,
      );
    await Bun.sleep(100);
  }
}

export async function waitForHttp(url: string, timeout = TIMEOUT): Promise<Response> {
  const start = Date.now();
  for (;;) {
    try {
      const response = await fetch(url);
      if (response.ok) return response;
    } catch {
      /* startup race */
    }
    if (Date.now() - start > timeout) throw new Error(`Timed out waiting for ${url}`);
    await Bun.sleep(100);
  }
}

async function freePort(): Promise<number> {
  const reservation = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    routes: { '/': new Response() },
  });
  const port = reservation.port;
  await reservation.stop(true);
  if (port === undefined) throw new Error('Could not reserve a free port');
  return port;
}

export type InstalledJourneyOperations = {
  readonly failAfterAuthority?: (hostUrls: readonly string[]) => void | Promise<void>;
  /** Optional deterministic command seam for exercising the CLI journey without replacing assertions. */
  readonly runCommand?: (
    executable: string,
    arguments_: readonly string[],
    home: string,
    cwd: string,
    registryUrl: string,
    input?: string,
    extraEnvironment?: Record<string, string>,
  ) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
  readonly spawn?: typeof spawn;
  readonly waitForListening?: typeof waitForListening;
  readonly waitForHttp?: typeof waitForHttp;
  readonly fetch?: InstalledFetch;
  readonly assertBrowser?: typeof assertInstalledAppsInChromium;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<unknown>;
  readonly isProcessAlive?: (pid: number) => boolean;
};

/** Run an installed command and collect its input, output, and exit settlement. */
export async function defaultRunInstalledCliCommand(
  executable: string,
  arguments_: readonly string[],
  home: string,
  cwd: string,
  registryUrl: string,
  input?: string,
  extraEnvironment: Record<string, string> = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = Bun.spawn([executable, ...arguments_], {
    cwd,
    env: {
      PATH: '/usr/bin:/bin',
      HOME: home,
      INTERBOROUGH_HOME: home,
      npm_config_registry: registryUrl,
      BUN_CONFIG_REGISTRY: registryUrl,
      ...extraEnvironment,
    },
    stdout: 'pipe',
    stderr: 'pipe',
    ...(input === undefined ? {} : { stdin: 'pipe' as const }),
  });
  const inputCompletion = (async () => {
    if (input !== undefined) {
      await child.stdin.write(input);
      await child.stdin.end();
    }
  })().then(
    () => ({ ok: true as const }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  const [stdout, stderr, exitCode, inputResult] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
    inputCompletion,
  ]);
  installedCommandTrace.push({
    arguments: arguments_,
    exitCode,
    stdout: stdout.slice(0, 4000),
    stderr: stderr.slice(0, 4000),
  });
  if (installedCommandTracePath !== undefined)
    await writeFile(
      installedCommandTracePath,
      `${JSON.stringify(installedCommandTrace, null, 2)}\n`,
    );
  if (!inputResult.ok)
    throw new Error(`Installed CLI stdin failed (exit ${exitCode}): ${stderr}`, {
      cause: inputResult.error,
    });
  return { exitCode, stdout, stderr };
}

export async function runInstalled(
  executable: string,
  prefix: string,
  relocated = false,
  port = 0,
  existingHome?: string,
  operations: InstalledJourneyOperations = {},
): Promise<Acceptance[]> {
  installedCommandTrace.length = 0;
  installedCommandTracePath = join(
    prefix,
    relocated ? 'installed-command-trace-relocated.json' : 'installed-command-trace.json',
  );
  const assertions: Acceptance[] = [];
  const pass = (assertion: string, command: string, details?: Record<string, unknown>) =>
    assertions.push({ assertion, command, exit: 0, ...(details === undefined ? {} : { details }) });

  const processOperations = {
    spawn: operations.spawn ?? spawn,
    waitForListening: operations.waitForListening ?? waitForListening,
    waitForHttp: operations.waitForHttp ?? waitForHttp,
    fetch: operations.fetch ?? fetch,
    assertBrowser: operations.assertBrowser ?? assertInstalledAppsInChromium,
    now: operations.now ?? Date.now,
    sleep: operations.sleep ?? Bun.sleep,
    isProcessAlive: operations.isProcessAlive ?? isProcessAlive,
  };
  const runInstalledCliCommand = operations.runCommand ?? defaultRunInstalledCliCommand;
  const home = existingHome ?? join(prefix, 'home');
  const cwd = join(prefix, 'unrelated-cwd');
  await mkdir(home, { recursive: true });
  await mkdir(cwd, { recursive: true });
  const marker = join(home, 'tool-marker.txt');
  if (existingHome === undefined) {
    await writeFile(join(home, 'deployment-id'), '01ARZ3NDEKTSV4RRFFQ69G5FAV\n');
    await writeFixture(home, executable, marker);
    await enableDemoPlugin(home);
  }
  console.info(`starting ${executable} home=${home}`);
  const probes: Probe[] = [];
  let authorityServerToClose:
    { stop: (closeActiveConnections?: boolean) => void | Promise<void> } | undefined;
  let actualAuthorityToClose:
    { stop: (closeActiveConnections?: boolean) => void | Promise<void> } | undefined;
  const actualHostsToClose: Array<{ host: { close: () => Promise<void> } }> = [];
  const registryRequests: string[] = [];
  const registry = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (request) => {
      registryRequests.push(request.url);
      return new Response('{}', { status: 404 });
    },
  });
  const registryUrl = registry.url.href;
  try {
    const probe = processOperations.spawn(
      executable,
      ['start', '--port', String(port), '--home', home],
      home,
      cwd,
      registryUrl,
    );
    probes.push(probe);
    const listening = await processOperations.waitForListening(probe);
    const url = `http://127.0.0.1:${listening.port}`;
    const shell = await processOperations.waitForHttp(`${url}/`);
    const html = await shell.text();
    const assets = referencedAssets(html);
    if (assets.length < 2) throw new Error('Shell did not mount JavaScript and CSS');
    for (const path of assets) {
      const response = await processOperations.fetch(`${url}${path}`);
      if (response.status !== 200) throw new Error(`${path} returned ${response.status}`);
    }
    pass('mounted shell and HTTP 200 JavaScript/CSS', `GET ${url}/`, {
      port: listening.port,
      sanitizedPath: '/usr/bin:/bin',
    });
    if (
      (operations.spawn === undefined || operations.runCommand !== undefined) &&
      executable.endsWith('/interborough')
    ) {
      const definitionFile = join(cwd, 'installed-cli-agent.json');
      const providerFile = join(cwd, 'installed-cli-provider.json');
      const scheduleFile = join(cwd, 'installed-cli-schedule.json');
      await writeFile(
        definitionFile,
        JSON.stringify({ model: 'installed-fixture/scripted', instructions: 'Use the fixture.' }),
      );
      await writeFile(providerFile, JSON.stringify({ configuration: {} }));
      await writeFile(
        scheduleFile,
        JSON.stringify({
          agentName: 'installed-cli-agent',
          spec: '* * * * *',
          input: 'hello',
          timeZone: 'UTC',
        }),
      );
      const cliJourneyResults: Record<string, unknown> = {};
      const commands: Array<{ args: string[]; json: boolean; input?: string }> = [
        { args: ['status'], json: true },
        { args: ['doctor'], json: true },
        { args: ['providers', 'list'], json: true },
        { args: ['agents', 'list'], json: true },
        { args: ['workflows', 'list'], json: true },
        { args: ['schedules', 'list'], json: true },
        { args: ['completion', 'bash'], json: false },
      ];
      if (existingHome === undefined) {
        commands.push(
          {
            args: [
              'providers',
              'connect',
              'installed-fixture',
              '--input-file',
              providerFile,
              '--secret-stdin',
            ],
            json: true,
            input: 'installed-fixture-secret\n',
          },
          {
            args: ['agents', 'create', 'installed-cli-agent', '--file', definitionFile],
            json: true,
          },
          { args: ['workflows', 'start', 'installed-cli-workflow', '--wait'], json: true },
          { args: ['schedules', 'create', '--file', scheduleFile], json: true },
          {
            args: ['chat', '--agent', 'installed-cli-agent', '--message', 'hello', '--no-input'],
            json: true,
          },
        );
      }
      if (existingHome === undefined) {
        const tlsDirectory = join(prefix, 'authority-tls');
        await mkdir(tlsDirectory, { recursive: true });
        const keyPath = join(tlsDirectory, 'key.pem');
        const certificatePath = join(tlsDirectory, 'certificate.pem');
        const certificate = Bun.spawnSync([
          'openssl',
          'req',
          '-x509',
          '-newkey',
          'rsa:2048',
          '-nodes',
          '-keyout',
          keyPath,
          '-out',
          certificatePath,
          '-days',
          '1',
          '-subj',
          '/CN=localhost',
        ]);
        if (certificate.exitCode !== 0)
          throw new Error(
            `Could not create authority fixture certificate: ${String(certificate.stderr)}`,
          );
        const authorityServer = Bun.serve({
          hostname: '127.0.0.1',
          port: 0,
          tls: { key: await readFile(keyPath), cert: await readFile(certificatePath) },
          async fetch(request) {
            const key = request.headers.get('x-api-key');
            if (key !== 'alice' && key !== 'bob')
              return Response.json({ message: 'unauthorized' }, { status: 401 });
            const pathname = new URL(request.url).pathname;
            if (pathname === '/api/v1/principal')
              return Response.json({
                result: {
                  workspace: {
                    actorId: key,
                    workspaceId: `workspace-${key}`,
                    capabilities: ['workspace:use'],
                  },
                },
              });
            if (pathname === '/host/status')
              return Response.json({ deploymentId: `deployment-${key}` });
            if (pathname === '/bureau/jsonrpc') {
              const body = (await request.json()) as { method?: string };
              if (body.method === 'bureau.tasks.get')
                return Response.json({ result: { id: 'terminal', status: 'running' } });
              return Response.json({
                error: { message: 'read-only workspace fixture', data: { httpStatus: 403 } },
              });
            }
            if (pathname === '/bureau/v1/subscriptions/bureau.tasks.events') {
              const taskId = new URL(request.url).searchParams.get('taskId');
              const stream = new TransformStream<Uint8Array, Uint8Array>();
              const writer = stream.writable.getWriter();
              const encoder = new TextEncoder();
              const events =
                taskId === 'dropped'
                  ? [{ kind: 'task.status', status: 'running' }]
                  : [
                      { kind: 'task.status', status: 'running' },
                      { kind: 'task.status', status: 'completed' },
                    ];
              void (async () => {
                for (const [index, event] of events.entries())
                  await writer.write(
                    encoder.encode(`id: event-${index}\ndata: ${JSON.stringify(event)}\n\n`),
                  );
                await writer.close();
              })();
              return new Response(stream.readable, {
                headers: { 'content-type': 'text/event-stream' },
              });
            }
            return Response.json({ ok: true });
          },
        });
        authorityServerToClose = authorityServer;
        const authorityUrl = `https://localhost:${authorityServer.port}`;
        const connection = await runInstalledCliCommand(
          executable,
          [
            'connection',
            'add',
            'authority',
            '--url',
            authorityUrl,
            '--credential-reference',
            'TOKEN',
          ],
          home,
          cwd,
          registryUrl,
        );
        if (connection.exitCode !== 0)
          throw new Error(
            `Could not configure installed authority connection: ${connection.stderr}`,
          );
        const untrusted = await runInstalledCliCommand(
          executable,
          ['whoami', '--connection', 'authority'],
          home,
          cwd,
          registryUrl,
          undefined,
          { TOKEN: 'alice' },
        );
        if (untrusted.exitCode !== 1 || !untrusted.stderr.includes('certificate'))
          throw new Error(
            `Untrusted authority request did not fail closed: ${untrusted.exitCode} ${untrusted.stderr}`,
          );
        const trusted = await runInstalledCliCommand(
          executable,
          ['whoami', '--connection', 'authority', '--workspace', 'workspace-alice'],
          home,
          cwd,
          registryUrl,
          undefined,
          { TOKEN: 'alice', NODE_EXTRA_CA_CERTS: certificatePath },
        );
        if (trusted.exitCode !== 0 || !trusted.stdout.includes('workspace-alice'))
          throw new Error(
            `Trusted authority request failed: ${trusted.exitCode} ${trusted.stderr}`,
          );
        const wrongWorkspace = await runInstalledCliCommand(
          executable,
          ['whoami', '--connection', 'authority', '--workspace', 'workspace-bob'],
          home,
          cwd,
          registryUrl,
          undefined,
          { TOKEN: 'alice', NODE_EXTRA_CA_CERTS: certificatePath },
        );
        if (wrongWorkspace.exitCode !== 3 || !wrongWorkspace.stderr.includes('workspace'))
          throw new Error(
            `Wrong workspace was not refused: ${wrongWorkspace.exitCode} ${wrongWorkspace.stderr}`,
          );
        const terminalWatch = await runInstalledCliCommand(
          executable,
          [
            'runs',
            'watch',
            '--kind',
            'task',
            'terminal',
            '--output',
            'jsonl',
            '--connection',
            'authority',
          ],
          home,
          cwd,
          registryUrl,
          undefined,
          { TOKEN: 'alice', NODE_EXTRA_CA_CERTS: certificatePath },
        );
        if (terminalWatch.exitCode !== 0 || !terminalWatch.stdout.includes('completed'))
          throw new Error(
            `Terminal installed watch failed: ${terminalWatch.exitCode} ${terminalWatch.stderr}`,
          );
        const droppedWatch = await runInstalledCliCommand(
          executable,
          [
            'runs',
            'watch',
            '--kind',
            'task',
            'dropped',
            '--output',
            'jsonl',
            '--connection',
            'authority',
          ],
          home,
          cwd,
          registryUrl,
          undefined,
          { TOKEN: 'alice', NODE_EXTRA_CA_CERTS: certificatePath },
        );
        if (droppedWatch.exitCode !== 1 || !droppedWatch.stderr.includes('terminal'))
          throw new Error(
            `Dropped installed watch did not fail closed: ${droppedWatch.exitCode} ${droppedWatch.stderr}`,
          );
        await authorityServer.stop(true);
        authorityServerToClose = undefined;

        const actualHosts = await Promise.all(
          ['alice', 'bob'].map(async (subject) => {
            const authorityHome = await mkdtemp(join(home, `authority-${subject}-`));
            const bungalow = await openBungalow({
              name: 'interborough',
              environment: { INTERBOROUGH_HOME: authorityHome },
            });
            const workspaceId = bungalow.workspaceId;
            bungalow.close();
            const host = await startHost({
              environment: { INTERBOROUGH_HOME: authorityHome },
              workspaceId,
              port: 0,
              workspaceAuthentication: {
                authentication: {
                  resolveApiKeyPrincipal: async (key) =>
                    key === subject || key === 'outsider' || (subject === 'bob' && key === 'alice')
                      ? principalFromApiKey({
                          subject: key,
                          scopes: [...AUTHORIZATION_SCOPES, ...BUREAU_SCOPES],
                        })
                      : null,
                },
                workspace: {
                  workspaceId,
                  resolveMembership: async ({ subject: member }) =>
                    member === subject || (subject === 'bob' && member === 'alice')
                      ? {
                          version: 1,
                          workspaceId,
                          actorId: member,
                          actorKind: 'user',
                          owner: `owner-${member}`,
                          membershipRevision: 'installed-fixture-v1',
                          capabilities:
                            member === 'alice'
                              ? ['workspace:use', 'workspace:manage']
                              : ['workspace:use'],
                        }
                      : null,
                },
              },
            });
            return { subject, workspaceId, host, home: authorityHome };
          }),
        );
        actualHostsToClose.push(...actualHosts);
        const actualAuthority = Bun.serve({
          hostname: '127.0.0.1',
          port: 0,
          tls: { key: await readFile(keyPath), cert: await readFile(certificatePath) },
          fetch: async (request) => {
            const key = request.headers.get('x-api-key');
            const selected = actualHosts.find((entry) => entry.subject === key);
            if (selected === undefined) return new Response('unauthorized', { status: 401 });
            const target = new URL(request.url);
            target.protocol = selected.host.url.protocol;
            target.hostname = selected.host.url.hostname;
            target.port = selected.host.url.port;
            const headers = new Headers(request.headers);
            headers.set('host', target.host);
            return fetch(target, {
              method: request.method,
              headers,
              ...(request.method === 'GET' || request.method === 'HEAD'
                ? {}
                : { body: await request.arrayBuffer() }),
            });
          },
        });
        actualAuthorityToClose = actualAuthority;
        await operations.failAfterAuthority?.(
          actualHosts.map((entry) => entry.host.url.toString()),
        );
        const actualUrl = `https://localhost:${actualAuthority.port}`;
        const aliceConnection = await runInstalledCliCommand(
          executable,
          [
            'connection',
            'add',
            'actual-alice',
            '--url',
            actualUrl,
            '--credential-reference',
            'TOKEN',
          ],
          home,
          cwd,
          registryUrl,
          undefined,
          { TOKEN: 'alice', NODE_EXTRA_CA_CERTS: certificatePath },
        );
        if (aliceConnection.exitCode !== 0)
          throw new Error(`Actual authority connection failed: ${aliceConnection.stderr}`);
        const actualTrusted = await runInstalledCliCommand(
          executable,
          ['whoami', '--connection', 'actual-alice', '--workspace', actualHosts[0]!.workspaceId],
          home,
          cwd,
          registryUrl,
          undefined,
          { TOKEN: 'alice', NODE_EXTRA_CA_CERTS: certificatePath },
        );
        if (
          actualTrusted.exitCode !== 0 ||
          !actualTrusted.stdout.includes(actualHosts[0]!.workspaceId)
        )
          throw new Error(
            `Actual workspace authentication failed: ${actualTrusted.exitCode} ${actualTrusted.stderr}`,
          );
        const actualWrongWorkspace = await runInstalledCliCommand(
          executable,
          ['whoami', '--connection', 'actual-alice', '--workspace', actualHosts[1]!.workspaceId],
          home,
          cwd,
          registryUrl,
          undefined,
          { TOKEN: 'alice', NODE_EXTRA_CA_CERTS: certificatePath },
        );
        if (actualWrongWorkspace.exitCode !== 3)
          throw new Error(`Actual wrong workspace was accepted: ${actualWrongWorkspace.exitCode}`);
        const bobConnection = await runInstalledCliCommand(
          executable,
          [
            'connection',
            'add',
            'actual-bob',
            '--url',
            actualUrl,
            '--credential-reference',
            'TOKEN',
          ],
          home,
          cwd,
          registryUrl,
        );
        if (bobConnection.exitCode !== 0)
          throw new Error(`Read-only authority connection failed: ${bobConnection.stderr}`);
        const adminConnection = await runInstalledCliCommand(
          executable,
          [
            'connection',
            'add',
            'actual-admin-bob-host',
            '--url',
            actualHosts[1]!.host.url.toString(),
            '--credential-reference',
            'TOKEN',
          ],
          home,
          cwd,
          registryUrl,
        );
        if (adminConnection.exitCode !== 0)
          throw new Error(`Administrator host connection failed: ${adminConnection.stderr}`);
        const readSchedules = () =>
          runInstalledCliCommand(
            executable,
            [
              'schedules',
              'list',
              '--connection',
              'actual-admin-bob-host',
              '--workspace',
              actualHosts[1]!.workspaceId,
              '--output',
              'json',
            ],
            home,
            cwd,
            registryUrl,
            undefined,
            { TOKEN: 'alice' },
          );
        const beforeBobMutation = await readSchedules();
        if (beforeBobMutation.exitCode !== 0)
          throw new Error(`Administrator schedule read failed: ${beforeBobMutation.stderr}`);
        const bobWrite = await runInstalledCliCommand(
          executable,
          [
            'schedules',
            'create',
            '--file',
            scheduleFile,
            '--connection',
            'actual-bob',
            '--workspace',
            actualHosts[1]!.workspaceId,
            '--output',
            'json',
          ],
          home,
          cwd,
          registryUrl,
          undefined,
          { TOKEN: 'bob', NODE_EXTRA_CA_CERTS: certificatePath },
        );
        if (bobWrite.exitCode === 0)
          throw new Error('Read-only workspace accepted a schedule mutation');
        const afterBobMutation = await readSchedules();
        if (afterBobMutation.exitCode !== 0 || afterBobMutation.stdout !== beforeBobMutation.stdout)
          throw new Error('Read-only workspace mutation changed durable schedules');
        await actualAuthority.stop(true);
        actualAuthorityToClose = undefined;
        await Promise.all(actualHosts.map((entry) => entry.host.close()));
        actualHostsToClose.length = 0;
        pass(
          'two real authenticated hosts derive deployment identities and reject cross-workspace access',
          'interborough whoami over installed TLS transport',
          {
            trustedWorkspace: actualHosts[0]!.workspaceId,
            refusedWorkspace: actualHosts[1]!.workspaceId,
            readOnlyMutationExit: bobWrite.exitCode,
          },
        );
        pass(
          'authenticated TLS authority handshake and wrong-workspace refusal',
          'interborough whoami over TLS',
          {
            trustedWorkspace: 'workspace-alice',
            refusedWorkspace: 'workspace-bob',
          },
        );
      }
      for (const command of commands) {
        const result = await runInstalledCliCommand(
          executable,
          [...command.args, ...(command.json ? ['--url', url, '--output', 'json'] : [])],
          home,
          cwd,
          registryUrl,
          command.input,
        );
        if (result.exitCode !== 0)
          throw new Error(
            `Installed CLI ${command.args.join(' ')} exited ${result.exitCode}: ${result.stderr}`,
          );
        if (command.json) {
          const payload = JSON.parse(result.stdout) as { schemaVersion?: number; data?: unknown };
          cliJourneyResults[command.args.join(' ')] = payload.data;
          if (payload.schemaVersion !== 1)
            throw new Error(`Installed CLI ${command.args.join(' ')} returned an invalid envelope`);
        }
      }
      if (existingHome === undefined) {
        const mutationDefinitionFile = join(cwd, 'installed-cli-dropped-response-agent.json');
        await writeFile(
          mutationDefinitionFile,
          JSON.stringify({ model: 'installed-fixture/scripted', instructions: 'Use the fixture.' }),
        );
        const beforeMutation = await runInstalledCliCommand(
          executable,
          ['agents', 'list', '--url', url, '--output', 'json'],
          home,
          cwd,
          registryUrl,
        );
        if (beforeMutation.exitCode !== 0)
          throw new Error(
            `Could not read agents before dropped-response probe: ${beforeMutation.stderr}`,
          );
        const responseProxy = createResponseDroppingProxy(
          new URL(`http://127.0.0.1:${listening.port}`),
        );
        const mutationProxy = responseProxy.server;
        const droppedMutationRequests = responseProxy.requests;
        try {
          const droppedMutation = await runInstalledCliCommand(
            executable,
            [
              'agents',
              'create',
              'installed-cli-dropped-response-agent',
              '--file',
              mutationDefinitionFile,
              '--url',
              `http://127.0.0.1:${mutationProxy.port}`,
              '--output',
              'json',
            ],
            home,
            cwd,
            registryUrl,
          );
          if (droppedMutation.exitCode === 0)
            throw new Error('Dropped-response mutation unexpectedly returned success');
          const beforeAgents =
            (JSON.parse(beforeMutation.stdout) as { data?: { agents?: unknown[] } }).data?.agents ??
            [];
          let afterAgents: unknown[] = [];
          for (let attempt = 0; attempt < 20; attempt += 1) {
            const afterMutation = await runInstalledCliCommand(
              executable,
              ['agents', 'list', '--url', url, '--output', 'json'],
              home,
              cwd,
              registryUrl,
            );
            if (afterMutation.exitCode !== 0)
              throw new Error(
                `Could not read agents after dropped-response probe: ${afterMutation.stderr}`,
              );
            afterAgents =
              (JSON.parse(afterMutation.stdout) as { data?: { agents?: unknown[] } }).data
                ?.agents ?? [];
            if (
              afterAgents.some((agent) =>
                JSON.stringify(agent).includes('installed-cli-dropped-response-agent'),
              )
            )
              break;
            await Bun.sleep(100);
          }
          const created = afterAgents.filter((agent) =>
            JSON.stringify(agent).includes('installed-cli-dropped-response-agent'),
          );
          if (
            droppedMutationRequests.length !== 1 ||
            created.length !== 1 ||
            afterAgents.length !== beforeAgents.length + 1
          )
            throw new Error(
              `Dropped-response mutation was not committed exactly once: status=${responseProxy.upstreamStatus} requests=${droppedMutationRequests.length} before=${beforeAgents.length} after=${afterAgents.length}`,
            );
          pass(
            'post-commit dropped response fails closed without retry and commits one entity',
            'agents create through response-dropping proxy',
            {
              upstreamStatus: responseProxy.upstreamStatus,
              requestCount: droppedMutationRequests.length,
              durableEntityCount: created.length,
            },
          );
        } finally {
          void mutationProxy.stop(true);
        }

        const beforeSigint = await runInstalledCliCommand(
          executable,
          ['agents', 'list', '--url', url, '--output', 'json'],
          home,
          cwd,
          registryUrl,
        );
        const streamServer = Bun.serve({
          hostname: '127.0.0.1',
          port: 0,
          fetch() {
            const stream = new TransformStream<Uint8Array, Uint8Array>();
            const writer = stream.writable.getWriter();
            void writer.write(
              new TextEncoder().encode(
                'data: {"type":"RUN_STARTED","runId":"installed-sigint-run"}\n\n' +
                  'data: {"type":"TEXT_MESSAGE_CONTENT","delta":"ready\\n"}\n\n',
              ),
            );
            return new Response(stream.readable, {
              headers: { 'content-type': 'text/event-stream' },
            });
          },
        });
        try {
          const sigint = Bun.spawn(
            [
              executable,
              'chat',
              '--agent',
              'installed-cli-agent',
              '--message',
              'sigint readiness',
              '--url',
              `http://127.0.0.1:${streamServer.port}`,
              '--no-input',
            ],
            {
              cwd,
              env: {
                PATH: '/usr/bin:/bin',
                HOME: home,
                INTERBOROUGH_HOME: home,
                npm_config_registry: registryUrl,
                BUN_CONFIG_REGISTRY: registryUrl,
              },
              stdout: 'pipe',
              stderr: 'pipe',
            },
          );
          const { exitCode } = await interruptInstalledStream(sigint, beforeSigint.stdout, () =>
            runInstalledCliCommand(
              executable,
              ['agents', 'list', '--url', url, '--output', 'json'],
              home,
              cwd,
              registryUrl,
            ),
          );
          pass(
            'compiled CLI stream reaches newline readiness, exits 130 on SIGINT, and preserves state',
            'chat stream readiness / SIGINT',
            { exitCode, durableStateUnchanged: true },
          );
        } finally {
          void streamServer.stop(true);
        }

        const workflowUpdateFile = join(cwd, 'installed-cli-workflow-update.json');
        await writeFile(
          workflowUpdateFile,
          JSON.stringify({
            trigger: { kind: 'manual' },
            steps: [
              {
                kind: 'activity',
                handler: 'agent',
                input: { agent: 'installed-fixture:assistant', message: 'workflow hello' },
              },
            ],
          }),
        );
        const staleWorkflow = await verifyStaleInstalledWorkflow(
          (arguments_) =>
            runInstalledCliCommand(
              executable,
              [...arguments_, '--url', url],
              home,
              cwd,
              registryUrl,
            ),
          workflowUpdateFile,
        );
        pass(
          'installed mutations reject stale revisions without retry',
          'workflows update --if-revision',
          staleWorkflow,
        );
        const { reviewId, runId } = await verifyInstalledApproval((arguments_) =>
          runInstalledCliCommand(executable, [...arguments_, '--url', url], home, cwd, registryUrl),
        );
        pass(
          'installed CLI approval resolves a durable task to its terminal result',
          'chat / reviews approve / runs watch',
          {
            reviewId,
            runId,
          },
        );
      }
      pass(
        'installed CLI status, diagnosis, provider, definition, workflow, and schedule journeys',
        'interborough CLI JSON commands',
        { commands: Object.keys(cliJourneyResults), results: cliJourneyResults },
      );
    }
    const pluginResponse = await processOperations.fetch(`${url}/host/plugins`);
    const plugins = (await pluginResponse.json()) as {
      plugins: Array<Record<string, unknown>>;
      unloaded: Array<Record<string, unknown>>;
    };
    const fixture = plugins.plugins.find(
      (entry) => (entry['descriptor'] as Record<string, unknown>)?.['name'] === 'installed-fixture',
    );
    if (
      (fixture?.['status'] as string) !== 'running' ||
      !plugins.unloaded.some((entry) => JSON.stringify(entry).includes('missing-installed-import'))
    )
      throw new Error(`Fixture/broken plugin isolation failed: ${JSON.stringify(plugins)}`);
    const agent = await runFixtureAgent(url, processOperations.fetch);
    if (!agent.stream.includes('fixture greeted Ada'))
      throw new Error('Fixture tool output was not deterministic');
    if (!(await Bun.file(marker).exists())) throw new Error('Fixture tool marker was not written');
    const appsResponse = await processOperations.fetch(`${url}/host/panels`);
    const apps = (await appsResponse.json()) as {
      apps: Array<Record<string, unknown>>;
    };
    if (
      !apps.apps.some(
        (entry) => entry['plugin'] === 'installed-fixture' && entry['app'] === 'fixture-panel',
      )
    )
      throw new Error('Fixture MCP panel was not mounted');
    const panel = await processOperations.fetch(
      `${url}/host/plugins/installed-fixture/apps/fixture-panel`,
    );
    const panelPayload = (await panel.json()) as { html?: string; ui?: { csp?: unknown } };
    if (
      !panelPayload.html?.includes('Installed fixture MCP panel') ||
      panelPayload.ui?.csp === undefined
    )
      throw new Error('Fixture panel text or UI metadata missing');
    const run = await mcp(
      url,
      2,
      'tools/call',
      {
        name: 'bureau.tasks.inspect',
        arguments: { taskId: agent.runId },
      },
      processOperations.fetch,
    );
    const inspection = run['result'] as { isError?: boolean } | undefined;
    if (inspection === undefined || inspection.isError === true || run['error'] !== undefined)
      throw new Error('Built-in inspector did not answer for the fixture run');
    const inspector = await processOperations.fetch(
      `${url}/host/plugins/inspectors/apps/run-inspector`,
    );
    const inspectorPayload = (await inspector.json()) as { html?: string; ui?: { csp?: unknown } };
    if (inspector.status !== 200 || !inspectorPayload.html?.includes('<div id="root">'))
      throw new Error(`Built-in inspector page missing (${inspector.status})`);
    await processOperations.assertBrowser(
      url,
      `${url}/host/plugins/installed-fixture/apps/fixture-panel`,
      `${url}/host/plugins/inspectors/apps/run-inspector`,
      agent.runId,
    );
    pass(
      'Chromium rendered the installed shell, fixture MCP panel, and run inspector',
      `chromium ${url}`,
      {
        runId: agent.runId,
        assets: assets.length,
      },
    );
    pass(
      'SDK plugin, fixture-owned additional dependency, tool, panel, inspector, and broken import isolation',
      `GET ${url}/host/plugins`,
    );
    const status = await processOperations.fetch(`${url}/host/status`);
    if (status.status !== 200) throw new Error('Host status unavailable');
    const restarted = await processOperations.fetch(`${url}/host/restart`, { method: 'POST' });
    if (restarted.status !== 202) throw new Error(`Restart returned ${restarted.status}`);
    const restartStart = processOperations.now();
    let secondPort: number | undefined;
    while (secondPort === undefined && processOperations.now() - restartStart < TIMEOUT) {
      const matches = [
        ...probe.output().matchAll(/Interborough is listening on http:\/\/127\.0\.0\.1:(\d+)/g),
      ];
      if (matches.length > 1) secondPort = Number(matches[1]![1]);
      else await processOperations.sleep(100);
    }
    if (secondPort === undefined)
      throw new Error(`Restart did not report a replacement port: ${probe.output()}`);
    if (port !== 0 && secondPort !== port)
      throw new Error(`Explicit port changed across restart: ${port} -> ${secondPort}`);
    const second = await processOperations.waitForHttp(`http://127.0.0.1:${secondPort}`);
    if (!second.ok) throw new Error('Restart did not preserve listener');
    const restartedAgent = await runFixtureAgent(
      `http://127.0.0.1:${secondPort}`,
      processOperations.fetch,
    );
    if (!restartedAgent.stream.includes('fixture greeted Ada'))
      throw new Error('Restarted fixture tool output was not deterministic');
    if ((await readFile(marker, 'utf8')) !== 'fixture-owned-dependency')
      throw new Error('Restarted fixture tool did not resolve its additional dependency');
    await processOperations.sleep(300);
    const output = probe.output();
    const pids = [...output.matchAll(/Started the host \(process (\d+)\)/g)].map((match) =>
      Number(match[1]),
    );
    if (pids.length < 2 || pids[0] === pids[1])
      throw new Error('Restart did not replace child PID');
    pass(
      'POST /host/restart changed child PID and preserved home/plugins',
      `POST ${url}/host/restart`,
      { pids, port: listening.port, replacementPort: secondPort },
    );
    probe.process.kill('SIGTERM');
    const exit = await probe.process.exited;
    if (exit !== 0) throw new Error(`SIGTERM exit was ${exit}`);
    await processOperations.sleep(100);
    const recordedPids = pids;
    if (recordedPids.some(processOperations.isProcessAlive))
      throw new Error(`SIGTERM left a recorded child alive: ${recordedPids.join(',')}`);
    for (const listener of [
      `http://127.0.0.1:${listening.port}`,
      `http://127.0.0.1:${secondPort}`,
    ]) {
      let open = false;
      try {
        await processOperations.fetch(listener);
        open = true;
      } catch {
        /* closed */
      }
      if (open) throw new Error(`Listener remained after SIGTERM: ${listener}`);
    }
    const reacquire = processOperations.spawn(
      executable,
      ['start', '--port', String(secondPort), '--home', home],
      home,
      cwd,
      registryUrl,
    );
    probes.push(reacquire);
    await processOperations.waitForListening(reacquire);
    reacquire.process.kill('SIGTERM');
    if ((await reacquire.process.exited) !== 0)
      throw new Error('State lock could not be reacquired after clean shutdown');
    pass(
      'SIGTERM returned 0 and closed supervised process tree/listener',
      'SIGTERM installed command',
      { exit },
    );
    if (relocated) {
      const deploymentMarker = join(home, 'deployment-id');
      if (!(await Bun.file(deploymentMarker).exists()))
        throw new Error('Relocation did not preserve deployment marker');
      const link = join(home, 'plugins', 'node_modules', '@lostgradient', 'interborough-plugin');
      const target = await realpath(link);
      if (!target.includes('plugin-runtime/node_modules'))
        throw new Error(`Plugin dependency link target was ${target}`);
      pass(
        'relocation preserved home marker and dependency link target',
        'realpath plugins/node_modules',
        { marker: deploymentMarker, target },
      );
    }
    if (registryRequests.length !== 0)
      throw new Error(
        `Installed release attempted registry access: ${registryRequests.join(', ')}`,
      );
    pass('no package registry requests during installed lifecycle', 'local rejecting registry', {
      requests: registryRequests,
    });
    return assertions;
  } finally {
    installedCommandTracePath = undefined;
    await actualAuthorityToClose?.stop(true);
    await Promise.all(actualHostsToClose.map((entry) => entry.host.close()));
    await authorityServerToClose?.stop(true);
    await registry.stop(true);
    for (const child of probes) {
      if (child.process.exitCode === null) child.process.kill('SIGTERM');
      await child.process.exited;
      await Promise.all([child.stdout, child.stderr]);
    }
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function unpack(
  archive: string,
  prefix: string,
): Promise<{ executable: string; sha256: string; manifest: Record<string, unknown> }> {
  const sha256 = createHash('sha256')
    .update(await readFile(archive))
    .digest('hex');
  const result = Bun.spawnSync(['tar', '-xzf', archive, '-C', prefix]);
  if (result.exitCode !== 0) throw new Error(`tar failed: ${result.stderr.toString()}`);
  const manifest = JSON.parse(
    await readFile(join(prefix, 'interborough', 'release.json'), 'utf8'),
  ) as Record<string, unknown>;
  const expected = expectedReleaseSourceSha();
  if (expected !== undefined && manifest['sourceSha'] !== expected)
    throw new Error(
      `Archive source SHA ${String(manifest['sourceSha'])} did not match ${expected}`,
    );
  return { executable: join(prefix, 'interborough', 'bin', 'interborough'), sha256, manifest };
}

export type InstalledReleaseOperations = {
  readonly unpack?: typeof unpack;
  readonly runInstalled?: typeof runInstalled;
};

export async function runInstalledRelease(
  argv: readonly string[] = process.argv.slice(2),
  operations: InstalledReleaseOperations = {},
): Promise<string> {
  const options = parseInstalledReleaseArguments(argv);
  const assertions: Acceptance[] = [];
  const unpackOperation = operations.unpack ?? unpack;
  const runOperation = operations.runInstalled ?? runInstalled;
  const root = await mkdtemp(join(tmpdir(), 'interborough-installed-release-'));
  try {
    let executable: string;
    if (options.mode === 'archive') {
      const archive = await unpackOperation(options.archive, root);
      executable = archive.executable;
      assertions.push({
        assertion: 'archive SHA-256 and disposable unpack',
        command: `sha256sum ${options.archive}`,
        exit: 0,
        details: {
          sha256: archive.sha256,
          manifest: archive.manifest,
          runtime: { bun: Bun.version, platform: process.platform, architecture: process.arch },
          environment: { path: '/usr/bin:/bin', registryDisabled: true },
        },
      });
    } else executable = options.command;
    assertions.push(...(await runOperation(executable, root, false, await freePort())));
    if (options.mode === 'archive') {
      const relocated = join(root, 'relocated');
      await mkdir(relocated, { recursive: true });
      await rename(join(root, 'interborough'), join(relocated, 'interborough'));
      const moved = join(relocated, 'interborough', 'bin', 'interborough');
      await rm(join(root, 'home', 'plugins', 'node_modules'), { recursive: true, force: true });
      const movedRuntime = resolve(
        dirname(await realpath(moved)),
        '..',
        'share',
        'interborough',
        'plugin-runtime',
        'node_modules',
      );
      await linkPluginRuntime(join(root, 'home'), movedRuntime);
      assertions.push(...(await runOperation(moved, relocated, true, 0, join(root, 'home'))));
    }
    const evidenceDirectory = options.evidence ?? DEFAULT_EVIDENCE;
    const evidence = join(evidenceDirectory, `installed-release-${Date.now()}.json`);
    await mkdir(evidenceDirectory, { recursive: true });
    await writeFile(
      evidence,
      `${JSON.stringify({ archive: options.mode === 'archive' ? options.archive : undefined, assertions }, null, 2)}\n`,
    );
    return evidence;
  } catch (error) {
    const evidenceDirectory = options.evidence ?? DEFAULT_EVIDENCE;
    await mkdir(evidenceDirectory, { recursive: true });
    const evidence = join(evidenceDirectory, `installed-release-failure-${Date.now()}.json`);
    const tracePath = join(root, 'installed-command-trace.json');
    const trace = (await Bun.file(tracePath).exists())
      ? await readFile(tracePath, 'utf8')
      : undefined;
    const relocatedTracePath = join(root, 'relocated', 'installed-command-trace-relocated.json');
    const relocatedTrace = (await Bun.file(relocatedTracePath).exists())
      ? await readFile(relocatedTracePath, 'utf8')
      : undefined;
    await writeFile(
      evidence,
      `${JSON.stringify(
        {
          archive: options.mode === 'archive' ? options.archive : undefined,
          failure:
            error instanceof Error
              ? { name: error.name, message: error.message, stack: error.stack }
              : String(error),
          source: pluginIdentityBase(),
          commandTrace: trace === undefined ? undefined : JSON.parse(trace),
          relocatedCommandTrace:
            relocatedTrace === undefined ? undefined : JSON.parse(relocatedTrace),
        },
        null,
        2,
      )}\n`,
    );
    throw error;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

if (import.meta.main) console.info(await runInstalledRelease());
