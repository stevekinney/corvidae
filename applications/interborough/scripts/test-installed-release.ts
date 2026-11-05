import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { assertInstalledAppsInChromium } from './test-installed-release-browser.ts';

const DEFAULT_EVIDENCE = 'tmp/chef/COR-2039';
const ARCHIVE_SHA = 'd80098b9f44a4edec43187dea42447bfc0eb67d08f368bac78121245242bd80f';
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
};
type Acceptance = {
  readonly assertion: string;
  readonly command: string;
  readonly exit: number;
  readonly details?: Record<string, unknown>;
};

const assertions: Acceptance[] = [];
const pass = (assertion: string, command: string, details?: Record<string, unknown>) =>
  assertions.push({ assertion, command, exit: 0, ...(details === undefined ? {} : { details }) });

export function parseRunStartedRunId(stream: string): string {
  const runId = stream.match(/"type":"RUN_STARTED"[^\n]*"runId":"([^"]+)"/)?.[1];
  if (runId === undefined) throw new Error('The AG-UI stream did not contain RUN_STARTED');
  return runId;
}

export function referencedAssets(html: string): string[] {
  return [...html.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)].map((match) => match[1]!);
}

function spawn(
  executable: string,
  arguments_: readonly string[],
  home: string,
  cwd: string,
): Probe {
  const process = Bun.spawn([executable, ...arguments_], {
    cwd,
    env: {
      PATH: '/usr/bin:/bin',
      HOME: home,
      INTERBOROUGH_HOME: home,
      npm_config_registry: 'http://127.0.0.1:9',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  let output = '';
  const stdout = (async () => {
    for await (const chunk of process.stdout) output += new TextDecoder().decode(chunk);
    return output;
  })();
  return { process, stdout, stderr: new Response(process.stderr).text(), output: () => output };
}

async function waitForListening(
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
      throw new Error(`Installed release did not listen: ${text}\n${await probe.stderr}`);
    await Bun.sleep(100);
  }
}

async function waitForHttp(url: string, timeout = TIMEOUT): Promise<Response> {
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
  const reservation = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response() });
  const port = reservation.port;
  await reservation.stop(true);
  if (port === undefined) throw new Error('Could not reserve a free port');
  return port;
}

async function writeFixture(home: string, executable: string, marker: string): Promise<void> {
  const plugins = join(home, 'plugins');
  await mkdir(plugins, { recursive: true });
  const runtime = resolve(
    dirname(await realpath(executable)),
    '..',
    'share',
    'interborough',
    'plugin-runtime',
    'node_modules',
  );
  const localDependencies = join(plugins, 'node_modules');
  await symlink(runtime, localDependencies, 'dir');
  const fixtureDirectory = join(plugins, 'installed-fixture');
  const fixtureDependency = join(fixtureDirectory, 'node_modules', 'fixture-dependency');
  await mkdir(fixtureDependency, { recursive: true });
  await writeFile(
    join(fixtureDependency, 'package.json'),
    '{"name":"fixture-dependency","type":"module","exports":"./index.ts"}\n',
  );
  await writeFile(
    join(fixtureDependency, 'index.ts'),
    'export const dependencyMarker = "fixture-owned-dependency";\n',
  );
  const source = `import { definePlugin } from '@lostgradient/interborough-plugin';
import { createModelCatalog } from '@lostgradient/operative';
import { createTool } from 'armorer';
import { writeFile } from 'node:fs/promises';
import { dependencyMarker } from 'fixture-dependency';
import { z } from 'zod';
const seed = createModelCatalog().descriptors[0];
if (seed === undefined) throw new Error('catalog unavailable');
const CALL_ID = 'installed-call-1';
export default definePlugin({ name: 'installed-fixture', version: '1.0.0', description: 'Installed release fixture', setup: () => ({
  tools: [createTool({ name: 'greet', description: 'Fixture greeting', input: z.object({ name: z.string() }), metadata: { readOnly: true }, execute: async ({ name }) => { await writeFile(${JSON.stringify(marker)}, dependencyMarker); return 'fixture greeted ' + name; } })],
  providers: [{ name: 'installed-fixture', generate: () => async ({ conversation }) => { const result = conversation.getMessages().findLast((message) => message.toolResult?.callId === CALL_ID)?.toolResult; return result === undefined ? { content: '', toolCalls: [{ id: CALL_ID, name: 'installed-fixture__greet', arguments: { name: 'Ada' } }] } : { content: 'Fixture result: ' + String(result.content), toolCalls: [] }; }, stream: () => { throw new Error('fixture provider does not stream'); }, rows: [{ ...seed, provider: 'installed-fixture', model: 'scripted', aliases: [] }] }],
  mcpApps: [{ name: 'fixture-panel', title: 'Fixture panel', description: 'Installed panel', uri: 'ui://installed-fixture/panel/v1', entry: new URL('./app.ts', import.meta.url), styles: '#root { color: green; }', allowedTools: ['bureau.workflows-list'], opensFromTool: 'bureau.workflows-list' }]
}) });
`;
  await writeFile(join(plugins, 'installed-fixture', 'plugin.ts'), source).catch(async () => {
    await mkdir(join(plugins, 'installed-fixture'), { recursive: true });
    await writeFile(join(plugins, 'installed-fixture', 'plugin.ts'), source);
  });
  await writeFile(
    join(plugins, 'installed-fixture', 'app.ts'),
    `document.body.innerHTML = '<main>Installed fixture MCP panel</main>';\n`,
  );
  await mkdir(join(home, 'plugins', 'installed-fixture', 'content', 'agents'), { recursive: true });
  await writeFile(
    join(home, 'plugins', 'installed-fixture', 'content', 'agents', 'assistant.md'),
    `---\nname: installed fixture assistant\nmodel: installed-fixture/scripted\ntools: [installed-fixture:greet]\n---\nUse the fixture greeting tool.\n`,
  );
  await mkdir(join(plugins, 'broken'), { recursive: true });
  await writeFile(
    join(plugins, 'broken', 'plugin.ts'),
    `import './missing-installed-import.ts';\nexport default {};\n`,
  );
}

async function mcp(
  url: string,
  id: number,
  method: string,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${url}/bureau/mcp`, {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      'mcp-protocol-version': '2025-03-26',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  if (!response.ok) throw new Error(`MCP ${method} returned ${response.status}`);
  const text = await response.text();
  const json = text.startsWith('{') ? text : text.match(/^data: (.*)$/m)?.[1];
  if (!json) throw new Error(`MCP ${method} returned no JSON`);
  return JSON.parse(json) as Record<string, unknown>;
}

async function runFixtureAgent(url: string): Promise<{ stream: string; runId: string }> {
  const response = await fetch(`${url}/bureau/ag-ui/agents/installed-fixture%3Aassistant/run`, {
    method: 'POST',
    headers: { accept: 'text/event-stream', 'content-type': 'application/json' },
    body: JSON.stringify({
      threadId: `thread-${crypto.randomUUID()}`,
      runId: `run-${crypto.randomUUID()}`,
      messages: [{ id: 'user-1', role: 'user', content: 'Greet Ada.' }],
      tools: [],
      context: [],
      state: {},
      forwardedProps: {},
    }),
  });
  const stream = await response.text();
  if (!response.ok) throw new Error(`Fixture agent did not start: ${stream.slice(0, 500)}`);
  return { stream, runId: parseRunStartedRunId(stream) };
}

async function runInstalled(
  executable: string,
  prefix: string,
  relocated = false,
  port = 0,
  existingHome?: string,
): Promise<void> {
  const home = existingHome ?? join(prefix, 'home');
  const cwd = join(prefix, 'unrelated-cwd');
  await mkdir(home, { recursive: true });
  await mkdir(cwd, { recursive: true });
  const marker = join(home, 'tool-marker.txt');
  if (existingHome === undefined) {
    await writeFile(join(home, 'deployment-id'), '01ARZ3NDEKTSV4RRFFQ69G5FAV\n');
    await writeFixture(home, executable, marker);
  }
  console.info(`starting ${executable} home=${home}`);
  const probe = spawn(executable, ['start', '--port', String(port), '--home', home], home, cwd);
  const listening = await waitForListening(probe);
  const url = `http://127.0.0.1:${listening.port}`;
  const shell = await waitForHttp(`${url}/`);
  const html = await shell.text();
  const assets = referencedAssets(html);
  if (assets.length < 2) throw new Error('Shell did not mount JavaScript and CSS');
  for (const path of assets) {
    const response = await fetch(`${url}${path}`);
    if (response.status !== 200) throw new Error(`${path} returned ${response.status}`);
  }
  pass('mounted shell and HTTP 200 JavaScript/CSS', `GET ${url}/`, {
    port: listening.port,
    sanitizedPath: '/usr/bin:/bin',
  });
  const pluginResponse = await fetch(`${url}/host/plugins`);
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
  const agent = await runFixtureAgent(url);
  if (!agent.stream.includes('fixture greeted Ada'))
    throw new Error('Fixture tool output was not deterministic');
  if (!(await Bun.file(marker).exists())) throw new Error('Fixture tool marker was not written');
  const appsResponse = await fetch(`${url}/host/mcp-apps`);
  const apps = (await appsResponse.json()) as {
    apps: Array<Record<string, unknown>>;
  };
  if (
    !apps.apps.some(
      (entry) => entry['plugin'] === 'installed-fixture' && entry['app'] === 'fixture-panel',
    )
  )
    throw new Error('Fixture MCP panel was not mounted');
  const panel = await fetch(`${url}/host/plugins/installed-fixture/apps/fixture-panel`);
  const panelText = await panel.text();
  if (!panelText.includes('Installed fixture MCP panel'))
    throw new Error('Fixture panel text missing');
  const panelHtml = panelText.startsWith('{')
    ? ((JSON.parse(panelText) as Record<string, unknown>)['html'] as string)
    : panelText;
  const run = await mcp(url, 2, 'tools/call', {
    name: 'bureau.tasks.inspect',
    arguments: { taskId: agent.runId },
  });
  if (!run['result'] && !run['error'])
    throw new Error('Built-in inspector did not answer for the fixture run');
  const inspector = await fetch(`${url}/host/plugins/inspectors/apps/run-inspector`);
  const inspectorText = await inspector.text();
  const inspectorPage = inspectorText.startsWith('{')
    ? (((JSON.parse(inspectorText) as Record<string, unknown>)['html'] as string | undefined) ?? '')
    : inspectorText;
  if (inspector.status !== 200 || !inspectorPage.includes('<div id="root">'))
    throw new Error(
      `Built-in inspector page missing (${inspector.status}): ${inspectorText.slice(0, 200)}`,
    );
  await assertInstalledAppsInChromium(url, panelHtml, inspectorPage, agent.runId, run['result']);
  pass(
    'Chromium rendered the installed shell, fixture MCP panel, and run inspector',
    `chromium ${url}`,
    {
      runId: agent.runId,
      assets: assets.length,
    },
  );
  pass(
    'SDK plugin, additional zod dependency, tool, panel, inspector, and broken import isolation',
    `GET ${url}/host/plugins`,
  );
  const status = await fetch(`${url}/host/status`);
  if (status.status !== 200) throw new Error('Host status unavailable');
  const restarted = await fetch(`${url}/host/restart`, { method: 'POST' });
  if (restarted.status !== 202) throw new Error(`Restart returned ${restarted.status}`);
  const restartStart = Date.now();
  let secondPort: number | undefined;
  while (secondPort === undefined && Date.now() - restartStart < TIMEOUT) {
    const matches = [
      ...probe.output().matchAll(/Interborough is listening on http:\/\/127\.0\.0\.1:(\d+)/g),
    ];
    if (matches.length > 1) secondPort = Number(matches[1]![1]);
    else await Bun.sleep(100);
  }
  if (secondPort === undefined)
    throw new Error(`Restart did not report a replacement port: ${probe.output()}`);
  if (port !== 0 && secondPort !== port)
    throw new Error(`Explicit port changed across restart: ${port} -> ${secondPort}`);
  const second = await waitForHttp(`http://127.0.0.1:${secondPort}`);
  if (!second.ok) throw new Error('Restart did not preserve listener');
  await Bun.sleep(300);
  const output = probe.output();
  const pids = [...output.matchAll(/Started the host \(process (\d+)\)/g)].map((match) =>
    Number(match[1]),
  );
  if (pids.length < 2 || pids[0] === pids[1]) throw new Error('Restart did not replace child PID');
  pass(
    'POST /host/restart changed child PID and preserved home/plugins',
    `POST ${url}/host/restart`,
    { pids, port: listening.port, replacementPort: secondPort },
  );
  probe.process.kill('SIGTERM');
  const exit = await probe.process.exited;
  if (exit !== 0) throw new Error(`SIGTERM exit was ${exit}`);
  await Bun.sleep(100);
  const recordedPids = pids;
  if (
    recordedPids.some((pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    })
  )
    throw new Error(`SIGTERM left a recorded child alive: ${recordedPids.join(',')}`);
  for (const listener of [`http://127.0.0.1:${listening.port}`, `http://127.0.0.1:${secondPort}`]) {
    let open = false;
    try {
      const response = await fetch(listener);
      open = response.ok;
    } catch {
      /* closed */
    }
    if (open) throw new Error(`Listener remained after SIGTERM: ${listener}`);
  }
  const reacquire = spawn(
    executable,
    ['start', '--port', String(secondPort), '--home', home],
    home,
    cwd,
  );
  await waitForListening(reacquire);
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
}

async function unpack(archive: string, prefix: string): Promise<string> {
  console.info(`unpacking ${archive}`);
  const hash = createHash('sha256')
    .update(await readFile(archive))
    .digest('hex');
  if (hash !== ARCHIVE_SHA)
    throw new Error(`Archive SHA-256 ${hash} does not match accepted ${ARCHIVE_SHA}`);
  const result = Bun.spawnSync(['tar', '-xzf', archive, '-C', prefix]);
  if (result.exitCode !== 0) throw new Error(`tar failed: ${result.stderr.toString()}`);
  pass('accepted archive SHA-256 and disposable unpack', `sha256sum ${archive}`, {
    sha256: hash,
    target: 'darwin-arm64',
  });
  return join(prefix, 'interborough', 'bin', 'interborough');
}

export async function runInstalledRelease(
  argv: readonly string[] = process.argv.slice(2),
): Promise<string> {
  const options = parseInstalledReleaseArguments(argv);
  const root = await mkdtemp(join(tmpdir(), 'interborough-installed-release-'));
  try {
    let executable: string;
    if (options.mode === 'archive') executable = await unpack(options.archive, root);
    else executable = options.command;
    await runInstalled(executable, root, false, await freePort());
    if (options.mode === 'archive') {
      const relocated = join(root, 'relocated');
      await mkdir(relocated, { recursive: true });
      await rename(join(root, 'interborough'), join(relocated, 'interborough'));
      const moved = join(relocated, 'interborough', 'bin', 'interborough');
      await rm(join(root, 'home', 'plugins', 'node_modules'), { recursive: true, force: true });
      await runInstalled(moved, relocated, true, 0, join(root, 'home'));
    }
    const evidenceDirectory = options.evidence ?? DEFAULT_EVIDENCE;
    const evidence = join(evidenceDirectory, `installed-release-${Date.now()}.json`);
    await mkdir(evidenceDirectory, { recursive: true });
    await writeFile(
      evidence,
      `${JSON.stringify({ archive: options.mode === 'archive' ? options.archive : undefined, assertions }, null, 2)}\n`,
    );
    return evidence;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

if (import.meta.main) console.info(await runInstalledRelease());
