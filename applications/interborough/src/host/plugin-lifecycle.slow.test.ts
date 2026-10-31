/**
 * COR-1897, the success evidence of the Interborough plugins project: a folder plugin that
 * contributes one tool, one agent file, and the model that agent uses, lives through its whole
 * lifecycle in real host processes under the real supervisor (`supervisor.ts serve`).
 *
 * - The plugin is scaffolded with `bun scripts/create-plugin.ts` into the home's `plugins/` folder,
 *   then its `plugin.ts` is replaced so it supplies its own model: a provider `e2e` whose generate
 *   asks for the tool and then replies, and the catalog row `e2e/scripted`. The spawned host has no
 *   injected fake, so nothing but the plugin answers.
 * - It is listed by `GET /host/plugins` as `running`, and its agent `e2e:assistant` is listed.
 * - A chat with the agent runs the tool. The tool writes a marker file, so the run is proven from
 *   outside the process, and the answer carries the reply the script gave after the tool's result.
 * - `PUT /host/plugins/e2e` disables the plugin, `POST /host/restart` replaces the host process, and
 *   the new process lists the plugin as `disabled` and no longer lists the agent.
 * - A local registry is the only registry either process may reach, and it sees no request, because
 *   the supervisor starts every host with `--no-install`.
 *
 * Each scenario runs at module scope under the hang guard, so none is on Bun's per-test clock, and
 * nothing asserts on how long anything takes.
 */
import { openBungalow } from '@lostgradient/bungalow';
import { runWithHangGuard, spawnWithHangGuard } from '@lostgradient/testing/hang-guard';
import { waitUntil } from '@lostgradient/testing/wait-until';
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { HOST_RESTART_ROUTE } from './restart.ts';

const packageDirectory = join(import.meta.dir, '..', '..');
const repositoryRoot = join(packageDirectory, '..', '..');
const supervisorEntry = join(import.meta.dir, 'supervisor.ts');

const PLUGIN_NAME = 'e2e';
const AGENT_ID = `${PLUGIN_NAME}:assistant`;
const SECRET_KEY = 'e2e-api-key';
const REPLY_PREFIX = 'The e2e tool said: ';

const scratchDirectories: string[] = [];

afterAll(async () => {
  for (const directory of scratchDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

async function scratch(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  scratchDirectories.push(directory);
  return directory;
}

/** A local registry that answers every package with 404 and records the paths it was asked for. */
function startRegistry() {
  const requests: string[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: (request) => {
      requests.push(new URL(request.url).pathname);
      return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
    },
  });
  return { requests, url: `http://127.0.0.1:${server.port}/`, stop: () => server.stop(true) };
}

/** A port nobody holds right now. The supervised host takes it and keeps it across restarts. */
async function freePort(): Promise<number> {
  const probe = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('') });
  const port = probe.port;
  await probe.stop(true);
  if (port === undefined) throw new Error('The probe listener has no port.');
  return port;
}

function collect(stream: ReadableStream<Uint8Array>): () => string {
  let text = '';
  const decoder = new TextDecoder();
  void (async () => {
    for await (const chunk of stream) text += decoder.decode(chunk, { stream: true });
  })();
  return () => text;
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** The `plugin.ts` of the plugin: its tool, its provider and its one model row. */
const pluginSource = (
  marker: string,
): string => `import { definePlugin } from '@lostgradient/interborough-plugin';
import { createModelCatalog } from '@lostgradient/operative';
import { createTool } from 'armorer';
import { writeFile } from 'node:fs/promises';
import { z } from 'zod';

const seed = createModelCatalog().descriptors[0];
if (seed === undefined) throw new Error('The static catalog is empty.');

const CALL_ID = 'e2e-call-1';

export default definePlugin({
  name: '${PLUGIN_NAME}',
  version: '1.0.0',
  description: 'The end-to-end lifecycle plugin.',
  secrets: ['${SECRET_KEY}'],
  content: new URL('./content/', import.meta.url),
  setup: () => ({
    tools: [
      createTool({
        name: 'greet',
        description: 'Greets someone by name.',
        input: z.object({ name: z.string() }),
        metadata: { readOnly: true },
        execute: async ({ name }) => {
          await writeFile(${JSON.stringify(marker)}, name);
          return \`greeted \${name}\`;
        },
      }),
    ],
    providers: [
      {
        name: '${PLUGIN_NAME}',
        // The script follows the conversation, not a counter: once the tool's result is in it, the
        // model replies with it; before that it asks for the tool.
        generate: () => async ({ conversation }) => {
          const result = conversation
            .getMessages()
            .findLast((message) => message.toolResult?.callId === CALL_ID)?.toolResult;
          if (result !== undefined) {
            return { content: '${REPLY_PREFIX}' + String(result.content), toolCalls: [] };
          }
          // A provider names a plugin's tool \`plugin__name\`, the form its tool-name grammar allows.
          return {
            content: '',
            toolCalls: [{ id: CALL_ID, name: '${PLUGIN_NAME}__greet', arguments: { name: 'Ada' } }],
          };
        },
        stream: () => {
          throw new Error('The scripted provider does not stream.');
        },
        rows: [{ ...seed, provider: '${PLUGIN_NAME}', model: 'scripted', aliases: [] }],
      },
    ],
  }),
});
`;

/** The agent file the scaffold wrote, pointed at the scripted model. */
const agentSource = `---
name: ${PLUGIN_NAME} assistant
description: Greets people with the plugin's tool.
model: ${PLUGIN_NAME}/scripted
tools: [${PLUGIN_NAME}:greet]
---
You greet people with the ${PLUGIN_NAME}:greet tool.
`;

type Supervised = {
  readonly url: URL;
  readonly stdout: () => string;
  readonly stderr: () => string;
  /** The process ids of every host the supervisor has started, oldest first. */
  readonly pids: () => number[];
  readonly stop: () => Promise<void>;
};

/** Start `bun src/host/supervisor.ts serve` on `home`, with `registry` as the only registry. */
async function supervise(home: string, buildDirectory: string, registryUrl: string) {
  const port = await freePort();
  const child = spawnWithHangGuard([process.execPath, supervisorEntry, 'serve'], {
    cwd: packageDirectory,
    env: {
      ...process.env,
      INTERBOROUGH_HOME: home,
      INTERBOROUGH_PORT: String(port),
      INTERBOROUGH_BUILD_DIRECTORY: buildDirectory,
      BUN_CONFIG_REGISTRY: registryUrl,
    },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdout = collect(child.stdout);
  const stderr = collect(child.stderr);
  const pids = (): number[] =>
    [...stdout().matchAll(/Started the host \(process (\d+)\)\./g)].map((match) =>
      Number(match[1]),
    );
  const supervised: Supervised = {
    url: new URL(`http://127.0.0.1:${port}/`),
    stdout,
    stderr,
    pids,
    stop: async () => {
      child.kill('SIGTERM');
      await child.exited;
      for (const pid of pids()) if (alive(pid)) process.kill(pid, 'SIGKILL');
    },
  };
  return supervised;
}

async function waitForHost(supervised: Supervised): Promise<void> {
  await waitUntil(
    async () => {
      try {
        const response = await fetch(new URL('/host/paths', supervised.url));
        return response.status === 200;
      } catch {
        return false;
      }
    },
    {
      message: `the host to answer on ${supervised.url.href}\n${supervised.stdout()}\n${supervised.stderr()}`,
      yieldTurn: () => Bun.sleep(50),
    },
  );
}

type Standing = { descriptor: { name: string }; status: string; enabled: boolean };

async function standingOf(supervised: Supervised): Promise<Standing | undefined> {
  const response = await fetch(new URL('/host/plugins', supervised.url));
  const body = (await response.json()) as { plugins: Standing[] };
  return body.plugins.find((plugin) => plugin.descriptor.name === PLUGIN_NAME);
}

async function agentIds(supervised: Supervised): Promise<string[]> {
  const response = await fetch(new URL('/bureau/jsonrpc', supervised.url), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'bureau.agents.list', params: {} }),
  });
  const body = (await response.json()) as { result: { agents: { name: string }[] } };
  return body.result.agents.map((agent) => agent.name);
}

/** Chat with the agent through the AG-UI mount and return the event stream. */
async function chat(supervised: Supervised): Promise<string> {
  const response = await fetch(
    new URL(`/bureau/ag-ui/agents/${encodeURIComponent(AGENT_ID)}/run`, supervised.url),
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify({
        threadId: `thread-${crypto.randomUUID()}`,
        runId: `run-${crypto.randomUUID()}`,
        messages: [{ id: 'user-1', role: 'user', content: 'Greet Ada.' }],
        tools: [],
        context: [],
        state: {},
        forwardedProps: {},
      }),
    },
  );
  return response.text();
}

/** Scaffold the plugin with the real script, then make it supply its own model. */
async function scaffoldPlugin(home: string, marker: string): Promise<void> {
  const created = await runWithHangGuard(
    [process.execPath, 'scripts/create-plugin.ts', PLUGIN_NAME, '--to', join(home, 'plugins')],
    { cwd: repositoryRoot },
  );
  if (created.exitCode !== 0) throw new Error(`create-plugin failed: ${created.stderr.toString()}`);
  const folder = join(home, 'plugins', PLUGIN_NAME);
  await writeFile(join(folder, 'plugin.ts'), pluginSource(marker));
  await writeFile(join(folder, 'content', 'agents', 'assistant.md'), agentSource);
}

const home = await scratch('interborough-plugin-lifecycle-');
const buildDirectory = join(await scratch('interborough-plugin-lifecycle-build-'), 'build');
await Bun.write(join(buildDirectory, 'index.html'), '<!doctype html><title>Interborough</title>');
const marker = join(home, 'tool-ran.txt');
await scaffoldPlugin(home, marker);

// The key the plugin declares, written before the host starts: a provider offers its models once
// its secret is set. It is a fixture value and no credential for anything.
const bungalow = await openBungalow({
  name: 'interborough',
  environment: { INTERBOROUGH_HOME: home },
});
try {
  bungalow.writeSecret(SECRET_KEY, 'fixture-e2e-key-0c1f');
} finally {
  bungalow.close();
}

const registry = startRegistry();
const supervised = await supervise(home, buildDirectory, registry.url);

const lifecycle = await (async () => {
  try {
    await waitForHost(supervised);
    const firstPid = supervised.pids().at(0);
    const standingBefore = await standingOf(supervised);
    const agentsBefore = await agentIds(supervised);
    const stream = await chat(supervised);
    const markerWritten = existsSync(marker) ? await readFile(marker, 'utf8') : undefined;

    const disabled = await fetch(new URL(`/host/plugins/${PLUGIN_NAME}`, supervised.url), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    const restarting = await fetch(new URL(HOST_RESTART_ROUTE, supervised.url), {
      method: 'POST',
    });
    await waitUntil(() => supervised.pids().length >= 2, {
      message: `a second host start\n${supervised.stdout()}\n${supervised.stderr()}`,
      yieldTurn: () => Bun.sleep(50),
    });
    await waitForHost(supervised);
    const secondPid = supervised.pids().at(1);
    return {
      firstPid,
      secondPid,
      firstAlive: firstPid === undefined ? undefined : alive(firstPid),
      standingBefore,
      agentsBefore,
      stream,
      markerWritten,
      disableStatus: disabled.status,
      restartStatus: restarting.status,
      standingAfter: await standingOf(supervised),
      agentsAfter: await agentIds(supervised),
      diagnostics: `${supervised.stdout()}\n${supervised.stderr()}`,
    };
  } finally {
    await supervised.stop();
    await registry.stop();
  }
})();

describe('a scaffolded folder plugin through its whole lifecycle', () => {
  test('is listed as running, and its agent is listed', () => {
    expect(lifecycle.standingBefore).toMatchObject({ status: 'running', enabled: true });
    expect(lifecycle.agentsBefore).toContain(AGENT_ID);
  });

  test('has its agent run its tool, and the tool really ran', () => {
    expect(lifecycle.markerWritten).toBe('Ada');
    expect(lifecycle.stream).toContain(`${REPLY_PREFIX}greeted Ada`);
    expect(lifecycle.stream).toContain('"toolCallName":"e2e:greet"');
    expect(lifecycle.stream).toContain('"type":"RUN_FINISHED"');
  });

  test('is disabled by the route, and a restart replaces the host process', () => {
    expect(lifecycle.disableStatus).toBe(200);
    expect(lifecycle.restartStatus).toBe(202);
    expect(lifecycle.firstPid).toBeDefined();
    expect(lifecycle.secondPid).toBeDefined();
    expect(lifecycle.secondPid).not.toBe(lifecycle.firstPid);
    expect(lifecycle.firstAlive).toBe(false);
  });

  test('is listed as disabled by the new process, and its agent is gone', () => {
    expect(lifecycle.standingAfter).toMatchObject({ status: 'disabled', enabled: false });
    expect(lifecycle.agentsAfter).not.toContain(AGENT_ID);
  });

  test('made no registry request in either process', () => {
    expect(registry.requests).toEqual([]);
  });
});
