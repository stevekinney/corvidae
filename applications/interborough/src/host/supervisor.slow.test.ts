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
import { spawnWithHangGuard } from '@lostgradient/testing/hang-guard';
import { waitUntil } from '@lostgradient/testing/wait-until';
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { HOST_RESTART_ROUTE } from './restart.ts';
import { HUMAN_INPUT_SIGNAL } from './seed.ts';

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
  options: { readonly buildDirectory: string; readonly entry?: string },
): Promise<Supervised> {
  const home = await scratch();
  const port = await freePort();
  const child = spawnWithHangGuard(
    [
      process.execPath,
      supervisorEntry,
      mode,
      ...(options.entry === undefined ? [] : ['--entry', options.entry]),
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
    new URL('/bureau/ag-ui/agents/request-human-input/run', supervised.url),
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
const devReload = await (async () => {
  const directory = await scratch();
  const generationModule = join(directory, 'generation.ts');
  const entry = join(directory, 'entry.ts');
  await writeFile(generationModule, "console.info('Generation 1 loaded');\n");
  await writeFile(
    entry,
    `import './generation.ts';\nimport ${JSON.stringify(join(import.meta.dir, 'dev.ts'))};\n`,
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

    // Bun arms its file watch after the module has run, so a change made too early is missed: the
    // module is rewritten until the second generation loads. It is not rewritten after that,
    // because every reload would abandon the start of the generation before it.
    let rewrite = 0;
    await waitUntil(
      async () => {
        if (supervised.stdout().includes('Generation 2 loaded')) return true;
        await writeFile(generationModule, `console.info('Generation 2 loaded'); // ${rewrite}\n`);
        rewrite += 1;
        await Bun.sleep(1000);
        return false;
      },
      { message: 'the edited module to load' },
    );
    await waitUntil(() => listening() >= 2, {
      message: 'the reloaded host to listen',
      yieldTurn: () => Bun.sleep(50),
    });
    await waitForHost(supervised);
    // A reload keeps the process: the supervisor was not involved.
    const pidsAfterReload = supervised.pids();

    // The reloaded host's exit code still reaches the supervisor.
    const restarted = await restart(supervised);
    return { pid, pidsAfterReload, restarted };
  });
})();

describe('under `dev`', () => {
  test('a restart request yields a new host process, here the real development entry', () => {
    expect(devRestart.restarted.status).toBe(202);
    expect(devRestart.restarted.after).not.toBe(devRestart.restarted.before);
    expect(devRestart.restarted.beforeAlive).toBe(false);
    expect(devRestart.pageStatus).toBe(200);
  });

  test('a source edit still reloads the real host in place, and a restart request after it still restarts it', () => {
    expect(devReload.pid).toBeDefined();
    expect(devReload.pidsAfterReload).toEqual([devReload.pid!]);
    expect(devReload.restarted.status).toBe(202);
    expect(devReload.restarted.before).toBe(devReload.pid!);
    expect(devReload.restarted.after).not.toBe(devReload.pid!);
    expect(devReload.restarted.beforeAlive).toBe(false);
    expect(devReload.restarted.afterAlive).toBe(true);
  });
});
