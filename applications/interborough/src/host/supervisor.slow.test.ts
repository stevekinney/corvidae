/**
 * The host under the real supervisor, in the modes the scripts run them: `start` (`serve.ts`) and
 * `dev` (`dev.ts` under `bun --watch`). A restart request (`POST /host/restart`) must end the host
 * process and bring up another one on the same port; a run parked on a signal must still be parked
 * afterwards; and under `dev` a source edit must still restart the host in place. Each process is
 * started through the hang guard, its process ids come from the supervisor's own output, and every
 * one is ended and proven gone when its scenario is over. Each scenario runs at module scope, under
 * the hang guard, so none is on Bun's per-test clock; the tests assert on what it recorded. Nothing
 * asserts on how long anything takes.
 */
import { HUMAN_INPUT_SIGNAL } from '@lostgradient/plugin-demo';
import { spawnWithHangGuard } from '@lostgradient/testing/hang-guard';
import { waitUntil } from '@lostgradient/testing/wait-until';
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { enableDemoPlugin } from './demo-plugin.test-support.ts';
import { DEVELOPMENT_PLUGIN_FLAG } from './development-plugin-flag.ts';
import { HOST_RESTART_ROUTE } from './restart.ts';

const packageDirectory = join(import.meta.dir, '..', '..');
const supervisorEntry = join(import.meta.dir, 'supervisor.ts');

type Supervised = {
  readonly url: URL;
  readonly stdout: () => string;
  readonly stderr: () => string;
  /** The process ids of every host the supervisor has started, oldest first. */
  readonly pids: () => number[];
  readonly stop: () => Promise<void>;
};

/** How long the edited module takes to evaluate, so a reload outlasts the next edit on any host. */
const RELOAD_EVALUATION_MILLISECONDS = 2000;

const scratchDirectories: string[] = [];

async function scratch(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'interborough-supervisor-slow-'));
  scratchDirectories.push(directory);
  return directory;
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

/** Start `bun src/host/supervisor.ts <mode>` on a fresh home, a fresh port, and the given build. */
async function supervise(
  mode: 'serve' | 'dev',
  options: {
    readonly buildDirectory: string;
    readonly entry?: string;
    /** Plugin folders for `dev`, passed as `--plugin <path>`. */
    readonly plugins?: readonly string[];
  },
): Promise<Supervised> {
  const home = await scratch();
  await enableDemoPlugin(home);
  const port = await freePort();
  const child = spawnWithHangGuard(
    [
      process.execPath,
      supervisorEntry,
      mode,
      ...(options.entry === undefined ? [] : ['--entry', options.entry]),
      ...(options.plugins ?? []).flatMap((path) => [DEVELOPMENT_PLUGIN_FLAG, path]),
    ],
    {
      cwd: packageDirectory,
      env: {
        ...process.env,
        INTERBOROUGH_HOME: home,
        INTERBOROUGH_PORT: String(port),
        INTERBOROUGH_BUILD_DIRECTORY: options.buildDirectory,
      },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
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
      // The supervisor forwards the signal and waits, so its hosts are gone with it. Anything left
      // is one of ours, recorded from the supervisor's own output.
      for (const pid of pids()) if (alive(pid)) process.kill(pid, 'SIGKILL');
    },
  };
  return supervised;
}

afterAll(async () => {
  for (const directory of scratchDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

/** Run `scenario` against a supervised host, and end the supervisor and its hosts however it went. */
async function withSupervised<T>(
  supervised: Supervised,
  scenario: (supervised: Supervised) => Promise<T>,
): Promise<T> {
  try {
    return await scenario(supervised);
  } finally {
    await supervised.stop();
  }
}

async function stubBuild(): Promise<string> {
  const directory = join(await scratch(), 'build');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'index.html'), '<!doctype html><title>Interborough</title>');
  return directory;
}

/** Wait until the host answers on its port, which only a started host does. */
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

async function waitForStarts(supervised: Supervised, count: number): Promise<number[]> {
  await waitUntil(() => supervised.pids().length >= count, {
    message: `${count} host starts\n${supervised.stdout()}\n${supervised.stderr()}`,
    yieldTurn: () => Bun.sleep(50),
  });
  return supervised.pids();
}

/** Ask the host to restart, and say how it answered. */
async function requestRestart(supervised: Supervised): Promise<number> {
  const response = await fetch(new URL(HOST_RESTART_ROUTE, supervised.url), { method: 'POST' });
  return response.status;
}

/** What a restart did: the processes either side of it, and whether each was alive afterwards. */
type Restarted = {
  readonly status: number;
  readonly before: number;
  readonly after: number;
  readonly beforeAlive: boolean;
  readonly afterAlive: boolean;
};

/** Restart the host and wait for the new process to answer; the old one is gone by then. */
async function restart(supervised: Supervised): Promise<Restarted> {
  const before = supervised.pids().at(-1);
  if (before === undefined) throw new Error('The host has not started.');
  const starts = supervised.pids().length;
  const status = await requestRestart(supervised);
  const started = await waitForStarts(supervised, starts + 1);
  const after = started.at(-1);
  if (after === undefined) throw new Error('The host did not start again.');
  await waitForHost(supervised);
  return { status, before, after, beforeAlive: alive(before), afterAlive: alive(after) };
}

/** A `RunAgentInput` body for the AG-UI mount. */
function runBody(threadId: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    threadId,
    runId: `run-${crypto.randomUUID()}`,
    messages: [{ id: `user-${crypto.randomUUID()}`, role: 'user', content: 'Ship the release' }],
    tools: [],
    context: [],
    state: {},
    forwardedProps: {},
    ...extra,
  });
}

async function agUiStream(supervised: Supervised, body: string): Promise<string> {
  const response = await fetch(
    new URL('/bureau/ag-ui/agents/demo:request-human-input/run', supervised.url),
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body,
    },
  );
  return response.text();
}

/** The identifiers of the human waits the Bureau holds, from `bureau.reviews.list`. */
async function humanWaits(supervised: Supervised): Promise<string[]> {
  const response = await fetch(new URL('/bureau/jsonrpc', supervised.url), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'bureau.reviews.list', params: {} }),
  });
  const body = (await response.json()) as {
    result: { reviews: { id: string; kind: string; signalName?: string }[] };
  };
  return body.result.reviews
    .filter((review) => review.kind === 'human-wait' && review.signalName === HUMAN_INPUT_SIGNAL)
    .map((review) => review.id);
}

const interruptOf = (stream: string): string =>
  /"interrupts":\[\{"id":"([^"]+)"/.exec(stream)?.[1] ?? '';

// Under `start`: the production entry on a stub build.
const startRestart = await withSupervised(
  await supervise('serve', { buildDirectory: await stubBuild() }),
  async (supervised) => {
    await waitForHost(supervised);
    const first = supervised.pids().at(0);
    const restarted = await restart(supervised);
    const answer = await fetch(new URL('/host/paths', supervised.url));
    return { first, restarted, answerStatus: answer.status, stdout: supervised.stdout() };
  },
);

const startParkedRun = await withSupervised(
  await supervise('serve', { buildDirectory: await stubBuild() }),
  async (supervised) => {
    await waitForHost(supervised);
    const first = await agUiStream(supervised, runBody('thread-parked'));
    const waitingBefore = await humanWaits(supervised);
    const restarted = await restart(supervised);
    const waitingAfter = await humanWaits(supervised);
    // And the wait is a live one: answering it in the new process finishes the run.
    const answered = await agUiStream(
      supervised,
      runBody('thread-parked', {
        messages: [],
        resume: [
          {
            interruptId: interruptOf(first),
            status: 'resolved',
            payload: { decision: 'approve', answer: 'staging' },
          },
        ],
      }),
    );
    const waitingAfterAnswer = await humanWaits(supervised);
    return { first, waitingBefore, restarted, waitingAfter, answered, waitingAfterAnswer };
  },
);

describe('under `start`', () => {
  test('a restart request yields a new host process on the same port', () => {
    const { first, restarted, answerStatus, stdout } = startRestart;
    expect(restarted.status).toBe(202);
    expect(restarted.before).toBe(first!);
    expect(restarted.after).not.toBe(restarted.before);
    expect(restarted.beforeAlive).toBe(false);
    expect(restarted.afterAlive).toBe(true);
    // The same origin answers: the new process took the port the old one released.
    expect(answerStatus).toBe(200);
    expect(stdout).toContain('Interborough is listening on http://127.0.0.1:');
  });

  test('a run waiting on a signal before the restart is still waiting after it', () => {
    const { first, waitingBefore, restarted, waitingAfter, answered, waitingAfterAnswer } =
      startParkedRun;
    expect(first).toContain('"reason":"human-wait"');
    expect(waitingBefore).toHaveLength(1);
    expect(restarted.after).not.toBe(restarted.before);
    expect(waitingAfter).toEqual(waitingBefore);
    expect(answered).toContain('"type":"success"');
    expect(waitingAfterAnswer).toEqual([]);
  });
});

// Under `dev`: the real development entry, which builds into a scratch directory.
const devRestart = await withSupervised(
  await supervise('dev', { buildDirectory: join(await scratch(), 'build') }),
  async (supervised) => {
    await waitForHost(supervised);
    const restarted = await restart(supervised);
    const page = await fetch(new URL('/', supervised.url));
    return { restarted, pageStatus: page.status };
  },
);

// A source edit: the entry is a wrapper outside the package that imports the real `dev.ts` and a
// module of its own, so rewriting that module reloads the real host without touching the tree.
// The module takes a moment to evaluate, which is how a reload takes long enough to be abandoned
// by a second edit on any host, not only on a busy one.
const devReload = await (async () => {
  const directory = await scratch();
  const generationModule = join(directory, 'generation.ts');
  const entry = join(directory, 'entry.ts');
  const generationSource = (generation: number): string =>
    `await Bun.sleep(${RELOAD_EVALUATION_MILLISECONDS});\nconsole.info('Generation ${generation} loaded');\n`;
  await writeFile(generationModule, generationSource(1));
  await writeFile(
    entry,
    `import './generation.ts';\nimport ${JSON.stringify(join(import.meta.dir, 'dev.ts'))};\nconsole.info('Entry evaluated');\n`,
  );
  const supervised = await supervise('dev', {
    buildDirectory: join(directory, 'build'),
    entry,
  });
  const listening = (): number =>
    (supervised.stdout().match(/Interborough is listening/g) ?? []).length;
  return withSupervised(supervised, async () => {
    await waitForHost(supervised);
    const pid = supervised.pids().at(0);
    let edits = 0;

    // Bun watches the modules it has loaded once the first generation has run, and the entry
    // reports that line, so the edit is made after it. It is made once. Bun reloads the process as
    // soon as it sees an edit, and a second edit while the reload is loading abandons that load and
    // starts it again (COR-1944): rewriting the module every second until the second generation
    // appeared restarted the reload faster than a busy host could finish it. How long Bun takes to
    // notice the edit is Bun's, so the wait is for the reload and for nothing shorter.
    await waitUntil(() => supervised.stdout().includes('Entry evaluated'), {
      message: 'the first generation to finish evaluating',
      yieldTurn: () => Bun.sleep(50),
    });
    await writeFile(generationModule, generationSource(2));
    edits += 1;
    await waitUntil(() => supervised.stdout().includes('Generation 2 loaded'), {
      message: 'the edited module to load',
      yieldTurn: () => Bun.sleep(50),
    });
    await waitUntil(() => listening() >= 2, {
      message: 'the reloaded host to listen',
      yieldTurn: () => Bun.sleep(50),
    });
    await waitForHost(supervised);
    // A reload keeps the process: the supervisor was not involved.
    const pidsAfterReload = supervised.pids();

    // The reloaded host's exit code still reaches the supervisor.
    const restarted = await restart(supervised);
    return { pid, pidsAfterReload, restarted, edits };
  });
})();

// A plugin folder named with `--plugin` (COR-1881, probe B): `bun --watch` watches the plugin's
// `plugin.ts` because the host imports it, so one edit restarts the host in place and the new
// version is what runs. The entry is a wrapper that reports once the real `dev.ts` has finished
// evaluating, which is when Bun arms its file watch; the edit is made once after it, because a
// second edit during a reload abandons that reload (COR-1944).
const devPlugin = await (async () => {
  const directory = await scratch();
  const folder = join(directory, 'wip');
  const file = join(folder, 'plugin.ts');
  const source = (version: string): string =>
    `export default { name: 'wip', version: '${version}', description: 'Is being written.' };\n`;
  await mkdir(folder, { recursive: true });
  await writeFile(file, source('1.0.0'));
  const entry = join(directory, 'entry.ts');
  await writeFile(
    entry,
    `import ${JSON.stringify(join(import.meta.dir, 'dev.ts'))};\nconsole.info('Entry evaluated');\n`,
  );
  const supervised = await supervise('dev', {
    buildDirectory: join(directory, 'build'),
    entry,
    plugins: [folder],
  });
  /** The plugin as `GET /host/plugins` lists it now, or `undefined` while the host is between processes. */
  const listed = async () => {
    try {
      const response = await fetch(new URL('/host/plugins', supervised.url));
      const body = (await response.json()) as {
        plugins: {
          descriptor: { name: string; version: string };
          status: string;
          problems: { code: string; path?: string }[];
        }[];
      };
      return body.plugins.find((plugin) => plugin.descriptor.name === 'wip');
    } catch {
      return undefined;
    }
  };
  return withSupervised(supervised, async () => {
    await waitForHost(supervised);
    const pid = supervised.pids().at(0);
    const before = await listed();
    await waitUntil(() => supervised.stdout().includes('Entry evaluated'), {
      message: 'the first generation to finish evaluating',
      yieldTurn: () => Bun.sleep(50),
    });
    await writeFile(file, source('2.0.0'));
    await waitUntil(
      async () => {
        const current = await listed();
        return current?.descriptor.version === '2.0.0';
      },
      {
        message: `the edited plugin to be listed at 2.0.0\n${supervised.stdout()}\n${supervised.stderr()}`,
        yieldTurn: () => Bun.sleep(50),
      },
    );
    const after = await listed();
    return {
      folder,
      pid,
      pidsAfter: supervised.pids(),
      before,
      after,
      startupLines: supervised
        .stdout()
        .split('\n')
        .filter((line) => line.startsWith('Plugin wip@')),
    };
  });
})();

describe('under `dev`', () => {
  test('an edit to a --plugin folder’s plugin.ts restarts the host in place, and the new code is what runs', () => {
    expect(devPlugin.before).toMatchObject({
      descriptor: { version: '1.0.0' },
      status: 'running',
      problems: [{ code: 'development-source', path: devPlugin.folder }],
    });
    expect(devPlugin.after).toMatchObject({
      descriptor: { version: '2.0.0' },
      status: 'running',
      problems: [{ code: 'development-source', path: devPlugin.folder }],
    });
    // `bun --watch` reloaded the host itself: the supervisor started no second process.
    expect(devPlugin.pid).toBeDefined();
    expect(devPlugin.pidsAfter).toEqual([devPlugin.pid!]);
    // One startup line per plugin per start, each with its status and problem codes.
    expect(devPlugin.startupLines).toEqual([
      `Plugin wip@1.0.0 (folder: ${devPlugin.folder}): running; development-source`,
      `Plugin wip@2.0.0 (folder: ${devPlugin.folder}): running; development-source`,
    ]);
  });

  test('a restart request yields a new host process, here the real development entry', () => {
    expect(devRestart.restarted.status).toBe(202);
    expect(devRestart.restarted.after).not.toBe(devRestart.restarted.before);
    expect(devRestart.restarted.beforeAlive).toBe(false);
    expect(devRestart.pageStatus).toBe(200);
  });

  test('a source edit still reloads the real host in place, and a restart request after it still restarts it', () => {
    expect(devReload.pid).toBeDefined();
    // One edit, reloaded once: a second edit during the reload would abandon it (COR-1944).
    expect(devReload.edits).toBe(1);
    expect(devReload.pidsAfterReload).toEqual([devReload.pid!]);
    expect(devReload.restarted.status).toBe(202);
    expect(devReload.restarted.before).toBe(devReload.pid!);
    expect(devReload.restarted.after).not.toBe(devReload.pid!);
    expect(devReload.restarted.beforeAlive).toBe(false);
    expect(devReload.restarted.afterAlive).toBe(true);
  });
});
