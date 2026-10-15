/* oxlint-disable -- COR-1522 throwaway spike: measures behavior, is not production code, and is deleted or promoted by the implementation. */
/**
 * Spike 2: evaluate a pause mechanism.
 *
 *   bun 2-evaluate.ts <candidate> [test ...]     tests: integrity flood cleanup exit tty (default: all)
 *
 * Candidates (see launch()):
 *   pipe-pull           Bun.spawn pipe; child.stdout read through a pull loop that stops calling read()
 *   pty-fs              own PTY (libc via bun:ffi), master O_NONBLOCK, node:fs createReadStream
 *   pty-fs-blocking     as above, master left blocking
 *   pty-net             own PTY, master wrapped in node:net Socket
 *   pty-tty             own PTY, master wrapped in node:tty ReadStream
 *   pty-bunfile         own PTY, Bun.file(masterFd).stream() through the pull loop
 *
 * Every test prints RESULT lines; a failing expectation prints FAIL and exits non-zero at the end.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, statSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnOnPty } from './own-pty.ts';
import { isNonBlocking, setWindowSize } from './pty-ffi.ts';
import {
  drainReader,
  fsReadStreamReader,
  netSocketReader,
  pullReader,
  ttyReadStreamReader,
  workerReader,
  type PausableReader,
} from './readers.ts';
import {
  cpuTimeOf,
  guard,
  killGroup,
  report,
  residentKilobytes,
  sha256OfCommand,
  sleep,
  stateOf,
} from './spike-support.ts';

// `--corpus-bytes=N` sizes the corpus (the repository forbids unregistered environment reads).
const rawArguments = process.argv.slice(2);
const corpusOption = rawArguments.find((argument) => argument.startsWith('--corpus-bytes='));
const corpusSize = corpusOption === undefined ? 12_000_000 : Number(corpusOption.split('=')[1]);
const [candidate = 'pipe-pull', ...requested] = rawArguments.filter(
  (argument) => !argument.startsWith('--'),
);
const tests =
  requested.length > 0 ? requested : ['throughput', 'integrity', 'flood', 'cleanup', 'exit', 'tty'];
guard({ maximumRssMegabytes: 600, maximumSeconds: 240 });

// A deterministic block-writing producer: `seq` writes a line at a time, which a terminal's line
// buffering turns into millions of tiny writes and measures the producer, not the reader.
const corpusDirectory = mkdtempSync(join(tmpdir(), 'cor-1522-'));
const corpusPath = join(corpusDirectory, 'corpus.txt');
spawnSync('sh', ['-c', `head -c ${corpusSize} /dev/urandom | base64 > '${corpusPath}'`]);
const corpusBytes = statSync(corpusPath).size;
process.on('exit', () => rmSync(corpusDirectory, { recursive: true, force: true }));

let failed = false;
const fail = (message: string): void => {
  failed = true;
  console.log(`FAIL ${candidate}: ${message}`);
};
const mb = (bytes: number): number => Math.round((bytes / 1048576) * 10) / 10;
const rssMb = (): number => Math.round((residentKilobytes(process.pid) ?? 0) / 1024);

type Launched = {
  pid: number;
  reader: PausableReader;
  exited: Promise<number | null>;
  signal: () => string | number | null;
  masterFd?: number;
  pair?: { masterFd: number; slavePath: string };
  kill(): void;
};

function launch(command: string[], onData: (chunk: Uint8Array) => void, size = [80, 24]): Launched {
  if (candidate === 'pipe-pull') {
    const child = Bun.spawn(command, {
      stdout: 'pipe',
      stderr: 'ignore',
      stdin: 'ignore',
      detached: true,
    });
    const reader = pullReader('pull', child.stdout as ReadableStream<Uint8Array>, onData);
    return {
      pid: child.pid,
      reader,
      exited: child.exited,
      signal: () => child.signalCode,
      kill: () => killGroup(child.pid),
    };
  }
  const nonBlocking = candidate !== 'pty-fs-blocking';
  const { child, pair } = spawnOnPty(command, {
    columns: size[0] ?? 80,
    rows: size[1] ?? 24,
    nonBlocking,
  });
  if (isNonBlocking(pair.masterFd) !== nonBlocking)
    throw new Error('master blocking mode is not what was requested');
  let reader: PausableReader;
  if (candidate === 'pty-fs' || candidate === 'pty-fs-blocking')
    reader = fsReadStreamReader(pair.masterFd, onData);
  else if (candidate === 'pty-drain') reader = drainReader(pair.masterFd, onData);
  else if (candidate === 'pty-worker') reader = workerReader(pair.masterFd, onData);
  else if (candidate === 'pty-net') reader = netSocketReader(pair.masterFd, onData);
  else if (candidate === 'pty-tty') reader = ttyReadStreamReader(pair.masterFd, onData);
  else if (candidate === 'pty-bunfile') {
    reader = pullReader(
      'bunfile',
      Bun.file(pair.masterFd).stream() as ReadableStream<Uint8Array>,
      onData,
    );
  } else throw new Error(`unknown candidate ${candidate}`);
  return {
    pid: child.pid,
    reader,
    exited: child.exited,
    signal: () => child.signalCode,
    pair,
    masterFd: pair.masterFd,
    kill: () => killGroup(child.pid),
  };
}

const isPty = candidate.startsWith('pty');

/** Count bytes other than carriage returns (a PTY turns \n into \r\n); hash the rest. */
function stripCarriageReturns(chunk: Uint8Array): Uint8Array {
  if (!isPty) return chunk;
  let has = false;
  for (let i = 0; i < chunk.length; i += 1)
    if (chunk[i] === 13) {
      has = true;
      break;
    }
  if (!has) return chunk;
  const out = new Uint8Array(chunk.length);
  let n = 0;
  for (let i = 0; i < chunk.length; i += 1) if (chunk[i] !== 13) out[n++] = chunk[i]!;
  return out.subarray(0, n);
}

async function integrity(): Promise<void> {
  const expected = sha256OfCommand(`cat '${corpusPath}'`);
  const hasher = new Bun.CryptoHasher('sha256');
  let received = 0;
  let sinceResume = 0;
  let peakRss = rssMb();
  let pauses = 0;
  let lastSample = 0;
  const started = performance.now();
  const run = launch(['cat', corpusPath], (chunk) => {
    const clean = stripCarriageReturns(chunk);
    hasher.update(clean);
    received += clean.length;
    sinceResume += chunk.length;
  });
  run.reader.resume();
  const driver = (async (): Promise<void> => {
    for (;;) {
      await sleep(5);
      // `ps` is a blocking spawn, so it is sampled rarely: sampling every tick would throttle the very reader under test.
      if (performance.now() - lastSample > 500) {
        lastSample = performance.now();
        peakRss = Math.max(peakRss, rssMb());
      }
      if (sinceResume >= 3 * 1048576) {
        run.reader.pause();
        pauses += 1;
        await sleep(pauses === 3 ? 1200 : 80);
        sinceResume = 0;
        run.reader.resume();
      }
    }
  })();
  const ended = await Promise.race([
    run.reader.done,
    sleep(60_000).then(() => ({ ok: false, error: 'TIMEOUT' })),
  ]);
  void driver;
  const seconds = (performance.now() - started) / 1000;
  const expectedBytes = corpusBytes;
  const digest = hasher.digest('hex');
  const exitCode = await Promise.race([run.exited, sleep(5000).then(() => 'TIMEOUT')]);
  const ok = ended.ok && digest === expected && received === expectedBytes;
  report(`${candidate}:integrity`, {
    ok,
    pauses,
    receivedMb: mb(received),
    expectedBytes,
    received,
    hashMatches: digest === expected,
    endState: ended,
    exitCode,
    seconds: Math.round(seconds * 10) / 10,
    throughputMbPerSecond: mb(received / seconds),
    peakHostRssMb: peakRss,
  });
  if (!ok) fail('integrity (count or hash mismatch, or no clean end)');
  run.kill();
}

async function throughput(): Promise<void> {
  let received = 0;
  const started = performance.now();
  const run = launch(['cat', corpusPath], (chunk) => {
    received += chunk.length;
  });
  run.reader.resume();
  const ended = await Promise.race([
    run.reader.done,
    sleep(60_000).then(() => ({ ok: false, error: 'TIMEOUT' })),
  ]);
  const seconds = (performance.now() - started) / 1000;
  report(`${candidate}:throughput`, {
    ok: ended.ok,
    receivedMb: mb(received),
    seconds: Math.round(seconds * 100) / 100,
    mbPerSecond: mb(received / seconds),
    endState: ended,
  });
  if (!ended.ok) fail('throughput run did not end cleanly');
  run.kill();
}

async function flood(): Promise<void> {
  let received = 0;
  let yesOnly = true;
  let lastDataAt = 0;
  let firstAfterResume: number | undefined;
  let resumedAt = 0;
  const run = launch(['yes'], (chunk) => {
    received += chunk.length;
    lastDataAt = performance.now();
    if (resumedAt > 0 && firstAfterResume === undefined) firstAfterResume = performance.now();
    // Spot check content: only y, newline and (PTY) carriage return bytes.
    for (let i = 0; i < chunk.length; i += Math.max(1, (chunk.length / 64) | 0)) {
      const byte = chunk[i]!;
      if (byte !== 121 && byte !== 10 && byte !== 13) yesOnly = false;
    }
  });
  run.reader.resume();
  while (received < 2 * 1048576) await sleep(5);
  const pausedAt = performance.now();
  const receivedAtPause = received;
  run.reader.pause();
  await sleep(500);
  const inFlightBytes = received - receivedAtPause;
  const quiesceMs = lastDataAt > pausedAt ? Math.round(lastDataAt - pausedAt) : 0;
  const rssBefore = rssMb();
  const bytesAtStart = received;
  const cpuBefore = cpuTimeOf(run.pid);
  const states: string[] = [];
  for (let i = 0; i < 6; i += 1) {
    await sleep(500);
    states.push(stateOf(run.pid));
  }
  const cpuAfter = cpuTimeOf(run.pid);
  const rssAfter = rssMb();
  const grewWhilePaused = received - bytesAtStart;
  // Resume: first byte latency and a burst.
  resumedAt = performance.now();
  run.reader.resume();
  const resumeStart = received;
  await sleep(1000);
  const resumeLatencyMs =
    firstAfterResume === undefined ? -1 : Math.round(firstAfterResume - resumedAt);
  const burst = received - resumeStart;
  // Pause again, to prove repeated cycles work.
  run.reader.pause();
  await sleep(300);
  const second = received;
  await sleep(700);
  const flatSecondPause = received === second;
  const alive = stateOf(run.pid) !== 'gone';
  const ok =
    grewWhilePaused === 0 &&
    rssAfter - rssBefore <= 5 &&
    burst > 65536 &&
    flatSecondPause &&
    yesOnly &&
    alive;
  report(`${candidate}:flood`, {
    ok,
    receivedAtPauseMb: mb(receivedAtPause),
    inFlightAfterPauseKb: Math.round(inFlightBytes / 1024),
    quiesceMs,
    grewWhilePausedBytes: grewWhilePaused,
    hostRssBeforeMb: rssBefore,
    hostRssAfterMb: rssAfter,
    producerStates: [...new Set(states)],
    producerCpuBefore: cpuBefore,
    producerCpuAfter: cpuAfter,
    resumeLatencyMs,
    burstAfterResumeMb: mb(burst),
    flatSecondPause,
    contentOnlyYes: yesOnly,
    alive,
  });
  if (!ok) fail('flood (bytes moved or memory grew while paused, or resume failed)');
  run.kill();
  await Promise.race([run.exited, sleep(3000)]);
}

async function cleanupOnce(resumeFirst: boolean): Promise<Record<string, unknown>> {
  let received = 0;
  const run = launch(['yes'], (chunk) => {
    received += chunk.length;
  });
  run.reader.resume();
  while (received < 1048576) await sleep(5);
  run.reader.pause();
  await sleep(300);
  const killedAt = performance.now();
  // Resuming first lets the reader drain what the kernel still holds, which a terminal needs to close.
  if (resumeFirst) run.reader.resume();
  run.kill();
  const exit = await Promise.race([run.exited, sleep(5000).then(() => 'TIMEOUT')]);
  const exitMs = Math.round(performance.now() - killedAt);
  run.reader.resume();
  const ended = await Promise.race([
    run.reader.done,
    sleep(5000).then(() => ({ ok: false, error: 'TIMEOUT' })),
  ]);
  const endMs = Math.round(performance.now() - killedAt);
  const gone = stateOf(run.pid) === 'gone';
  return {
    ok: exit !== 'TIMEOUT' && gone && ended.ok,
    resumeFirst,
    exit,
    exitMs,
    readerEnded: ended,
    readerEndMs: endMs,
    producerGone: gone,
  };
}

async function cleanup(): Promise<void> {
  const stillPaused = await cleanupOnce(false);
  const resumedFirst = await cleanupOnce(true);
  report(`${candidate}:cleanup`, {
    ok: stillPaused['ok'] && resumedFirst['ok'],
    stillPaused,
    resumedFirst,
  });
  if (!stillPaused['ok'] || !resumedFirst['ok']) fail('cleanup of a paused producer');
}

async function exitReporting(): Promise<void> {
  const collected: number[] = [];
  const run = launch(['/bin/sh', '-c', 'echo hi; exit 7'], (chunk) => collected.push(...chunk));
  run.reader.resume();
  const ended = await Promise.race([
    run.reader.done,
    sleep(5000).then(() => ({ ok: false, error: 'TIMEOUT' })),
  ]);
  const exit = await Promise.race([run.exited, sleep(5000).then(() => 'TIMEOUT')]);
  const text = Buffer.from(collected).toString();
  const sig = launch(['/bin/sh', '-c', 'kill -TERM $$'], () => undefined);
  sig.reader.resume();
  const sigExit = await Promise.race([sig.exited, sleep(5000).then(() => 'TIMEOUT')]);
  const spawnFailure = launch(
    ['/bin/sh', '-c', 'exec /nonexistent/definitely-not-here'],
    () => undefined,
  );
  spawnFailure.reader.resume();
  const failExit = await Promise.race([spawnFailure.exited, sleep(5000).then(() => 'TIMEOUT')]);
  const ok =
    ended.ok &&
    exit === 7 &&
    text.replace(/\r/g, '') === 'hi\n' &&
    sig.signal() === 'SIGTERM' &&
    failExit !== 'TIMEOUT';
  report(`${candidate}:exit`, {
    ok,
    readerEnded: ended,
    exit,
    text: JSON.stringify(text),
    signal: sig.signal(),
    sigExit,
    failExit,
  });
  if (!ok) fail('exit/EOF/signal reporting');
}

async function tty(): Promise<void> {
  if (!isPty) return;
  const chunks: number[] = [];
  const run = launch(
    [
      '/bin/sh',
      '-c',
      // pid==pgid: group leader. tpgid==pgid: this group is the terminal's foreground group (so it is the controlling tty).
      'echo "ids $(ps -o pid=,pgid=,tpgid= -p $$ | tr -s " ")"; echo "size $(stty size)"; ' +
        'echo "tty $(tty)"; (echo ctty-write > /dev/tty) 2>&1 && echo ctty-ok; ' +
        'trap \'echo "winch $(stty size)"\' WINCH; echo ready; i=0; while [ $i -lt 40 ]; do sleep 0.1; i=$((i+1)); done; ' +
        'read line; echo "input:$line"',
    ],
    (chunk) => chunks.push(...chunk),
    [132, 50],
  );
  run.reader.resume();
  const deadline = performance.now() + 4000;
  const text = (): string => Buffer.from(chunks).toString().replace(/\r/g, '');
  while (!text().includes('ready') && performance.now() < deadline) await sleep(20);
  if (run.pair) {
    setWindowSize(run.pair, 90, 33);
    await sleep(300);
    // Input arrives while output reading is paused: control paths must stay usable.
    run.reader.pause();
    writeSync(run.pair.masterFd, 'typed\n');
    await sleep(200);
    run.reader.resume();
  }
  await Promise.race([run.reader.done, sleep(8000)]);
  const out = text();
  const ids = /ids\s+(\d+)\s+(\d+)\s+(\d+)/.exec(out);
  const leader = ids !== null && ids[1] === ids[2];
  const foreground = ids !== null && ids[3] === ids[2];
  const ok =
    leader &&
    foreground &&
    out.includes('size 50 132') &&
    out.includes('ctty-ok') &&
    out.includes('winch 33 90') &&
    out.includes('input:typed');
  report(`${candidate}:tty`, {
    ok,
    leader,
    foregroundGroupMatches: foreground,
    out: JSON.stringify(out),
  });
  if (!ok) fail('session leadership / controlling tty / resize / input');
  run.kill();
}

async function idle(): Promise<void> {
  // Host cost of holding a quiet session: CPU while nothing is produced, and how fast a keystroke's
  // echo (input written, `cat` echoes it) and a fresh process's first byte reach the host.
  const startedAt = performance.now();
  let firstByteAt = 0;
  let echoSeenAt = 0;
  let sawEcho = false;
  const run = launch(
    isPty ? ['sh', '-c', 'echo first; exec cat'] : ['sh', '-c', 'echo first; sleep 30'],
    (chunk) => {
      if (firstByteAt === 0) firstByteAt = performance.now();
      if (Buffer.from(chunk).toString().includes('ping') && !sawEcho) {
        sawEcho = true;
        echoSeenAt = performance.now();
      }
    },
  );
  run.reader.resume();
  await sleep(300);
  const cpuBefore = process.cpuUsage();
  await sleep(3000);
  const cpu = process.cpuUsage(cpuBefore);
  const cpuMs = Math.round((cpu.user + cpu.system) / 1000);
  let echoLatencyMs = -1;
  if (isPty && run.pair) {
    const wroteAt = performance.now();
    writeSync(run.pair.masterFd, 'ping\n');
    for (let i = 0; i < 200 && !sawEcho; i += 1) await sleep(2);
    echoLatencyMs = sawEcho ? Math.round((echoSeenAt - wroteAt) * 10) / 10 : -1;
  }
  report(`${candidate}:idle`, {
    ok: true,
    idleHostCpuMsOver3s: cpuMs,
    startToFirstByteMs: firstByteAt === 0 ? -1 : Math.round(firstByteAt - startedAt),
    echoLatencyMs,
  });
  run.kill();
  await Promise.race([run.exited, sleep(3000)]);
}

const table: Record<string, () => Promise<void>> = {
  idle,
  throughput,
  integrity,
  flood,
  cleanup,
  exit: exitReporting,
  tty,
};
for (const name of tests) {
  try {
    await table[name]!();
  } catch (error) {
    fail(`${name} threw ${String(error)}`);
  }
}
console.log(failed ? `SUMMARY ${candidate} FAILED` : `SUMMARY ${candidate} OK`);
process.exit(failed ? 1 : 0);
