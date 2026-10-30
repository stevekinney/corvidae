/**
 * The host under the real supervisor, in the modes the scripts run them: `start` (`serve.ts`) and
 * `dev` (`dev.ts` under `bun --watch`). A restart request (`POST /host/restart`) must end the host
 * process and bring up another one on the same port; a run parked on a signal must still be parked
 * afterwards; and under `dev` a source edit must still restart the host in place. Each process is
 * started through the hang guard, its process ids come from the supervisor's own output, and every
 * one is ended and proven gone when the test is over. Nothing asserts on how long anything takes.
 */
import { spawnWithHangGuard } from '@lostgradient/testing/hang-guard';
import { waitUntil } from '@lostgradient/testing/wait-until';
import { afterEach, describe, expect, test } from 'bun:test';
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

const running: Supervised[] = [];
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
  running.push(supervised);
  return supervised;
}

afterEach(async () => {
  for (const supervised of running.splice(0)) await supervised.stop();
  for (const directory of scratchDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

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

async function requestRestart(supervised: Supervised): Promise<void> {
  const response = await fetch(new URL(HOST_RESTART_ROUTE, supervised.url), { method: 'POST' });
  expect(response.status).toBe(202);
}

/** Restart the host and wait for the new process to answer; the old one is gone by then. */
async function restart(supervised: Supervised): Promise<{ before: number; after: number }> {
  const [before] = supervised.pids().slice(-1);
  if (before === undefined) throw new Error('The host has not started.');
  const starts = supervised.pids().length;
  await requestRestart(supervised);
  const started = await waitForStarts(supervised, starts + 1);
  const after = started.at(-1);
  if (after === undefined) throw new Error('The host did not start again.');
  await waitForHost(supervised);
  return { before, after };
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

describe('under `start`', () => {
  test('a restart request yields a new host process on the same port', async () => {
    const supervised = await supervise('serve', { buildDirectory: await stubBuild() });
    await waitForHost(supervised);
    const [first] = supervised.pids();

    const { before, after } = await restart(supervised);

    expect(before).toBe(first!);
    expect(after).not.toBe(before);
    expect(alive(before)).toBe(false);
    expect(alive(after)).toBe(true);
    // The same origin answers: the new process took the port the old one released.
    const answer = await fetch(new URL('/host/paths', supervised.url));
    expect(answer.status).toBe(200);
    expect(supervised.stdout()).toContain(`Interborough is listening on ${supervised.url.href}`);
  });

  test('a run waiting on a signal before the restart is still waiting after it', async () => {
    const supervised = await supervise('serve', { buildDirectory: await stubBuild() });
    await waitForHost(supervised);
    const first = await agUiStream(supervised, runBody('thread-parked'));
    expect(first).toContain('"reason":"human-wait"');
    const waiting = await humanWaits(supervised);
    expect(waiting).toHaveLength(1);

    const { before, after } = await restart(supervised);

    expect(after).not.toBe(before);
    expect(await humanWaits(supervised)).toEqual(waiting);
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
    expect(answered).toContain('"type":"success"');
    expect(await humanWaits(supervised)).toEqual([]);
  });
});

describe('under `dev`', () => {
  test('a restart request yields a new host process, here the real development entry', async () => {
    const buildDirectory = join(await scratch(), 'build');
    const supervised = await supervise('dev', { buildDirectory });
    await waitForHost(supervised);

    const { before, after } = await restart(supervised);

    expect(after).not.toBe(before);
    expect(alive(before)).toBe(false);
    const page = await fetch(new URL('/', supervised.url));
    expect(page.status).toBe(200);
  });

  test('a source edit still reloads the host in place, and a restart request after it still restarts it', async () => {
    // A stand-in host: it names its generation and exits 75 when it is asked to restart, as the
    // host does. The entry is outside the package, so rewriting its dependency reloads it without
    // touching the tree. (A real host's own reload is `bun --watch`'s, and the first test above
    // runs the real host under it.)
    const directory = await scratch();
    const generationModule = join(directory, 'generation.ts');
    const entry = join(directory, 'entry.ts');
    await writeFile(generationModule, 'export const generation = 1;\n');
    await writeFile(
      entry,
      `import { RESTART_EXIT_CODE } from ${JSON.stringify(join(import.meta.dir, 'restart.ts'))};
import { generation } from './generation.ts';

console.info('Generation ' + generation + ' is starting');
Bun.serve({
  hostname: '127.0.0.1',
  port: Number(process.env.INTERBOROUGH_PORT),
  fetch() {
    setImmediate(() => process.exit(RESTART_EXIT_CODE));
    return new Response(null, { status: 202 });
  },
});
console.info('Generation ' + generation + ' is listening');
`,
    );
    const supervised = await supervise('dev', { buildDirectory: await stubBuild(), entry });
    const output = (): string => `${supervised.stdout()}\n${supervised.stderr()}`;
    await waitUntil(() => supervised.stdout().includes('Generation 1 is listening'), {
      message: 'the first generation',
      yieldTurn: () => Bun.sleep(50),
    });
    const [pid] = supervised.pids();

    // Bun arms its file watch after the module has run, so a change made too early is missed: the
    // dependency is rewritten until the second generation starts.
    let rewrite = 0;
    await waitUntil(
      async () => {
        if (supervised.stdout().includes('Generation 2 is starting')) return true;
        await writeFile(generationModule, `export const generation = 2; // ${rewrite}\n`);
        rewrite += 1;
        await Bun.sleep(300);
        return false;
      },
      { message: 'the edited generation to start' },
    );
    await waitUntil(() => supervised.stdout().includes('Generation 2 is listening'), {
      message: 'the edited generation to listen',
      yieldTurn: () => Bun.sleep(50),
    });
    // A reload keeps the process: the supervisor was not involved.
    expect({ pids: supervised.pids(), output: output() }).toMatchObject({ pids: [pid!] });

    // The reloaded generation's exit code still reaches the supervisor.
    await requestRestart(supervised);
    const [, after] = await waitForStarts(supervised, 2);
    expect(after).not.toBe(pid!);
    expect(alive(pid!)).toBe(false);
    expect(supervised.stdout()).toContain('The host asked to restart. Starting it again.');
  });
});
