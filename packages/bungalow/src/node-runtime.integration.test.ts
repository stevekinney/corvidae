/**
 * COR-2698: Bungalow runs on Node 22 or later with the portable lock injected. This runs
 * `node-runtime.test-support.ts` under `node --test` in a native Node child, against an S3 test
 * server hosted here (the server is built on `Bun.serve`), and checks how the portable lock and
 * the default `flock(2)` lock meet across a Bun and a Node process on one root.
 *
 * The Node binary is `BUNGALOW_NODE_BINARY` when set, so a run can pin a version
 * (`BUNGALOW_NODE_BINARY=$(mise which node@22) bun run test:slow`), and otherwise the first native
 * `node` on `PATH`, skipping Bun's own `node` shims.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import { runWithHangGuard, spawnWithHangGuard } from '@lostgradient/testing/hang-guard';
import { outcomeOf, rethrow } from '@lostgradient/testing/module-scope-scenario';
import { createS3TestServer } from '@lostgradient/testing/s3-server';
import { describe, expect, test } from 'bun:test';

import { openLocalBungalow } from './bungalow.ts';
import { processEnvironment } from './environment-configuration.ts';
import { BungalowLockedError } from './errors.ts';

const HERE = import.meta.dir;

/** Whether `candidate` is Node itself, not Bun answering to the name `node`. */
async function isNativeNode(candidate: string): Promise<boolean> {
  const identity = await runWithHangGuard([
    candidate,
    '--eval',
    'process.stdout.write(process.versions.bun ? "bun" : process.release.name)',
  ]);
  return identity.exitCode === 0 && identity.stdout.toString() === 'node';
}

async function resolveNode(): Promise<string> {
  const pinned = processEnvironment()['BUNGALOW_NODE_BINARY'];
  if (pinned !== undefined && pinned !== '') {
    if (await isNativeNode(pinned)) return pinned;
    throw new Error('BUNGALOW_NODE_BINARY does not name a native Node binary.');
  }
  const searchPath = processEnvironment()['PATH'] ?? '';
  for (const directory of searchPath.split(delimiter).filter(existsSync)) {
    const candidate = Bun.which('node', { PATH: directory });
    if (candidate !== null && (await isNativeNode(candidate))) return candidate;
  }
  throw new Error('The Node runtime tests need a native Node 22 or later on PATH.');
}

const node = await resolveNode();
const versionResult = await runWithHangGuard([node, '--version']);
const nodeVersion = versionResult.stdout.toString().trim();

// Every child runs here, at module scope, off Bun's per-test clock; each test rethrows its outcome.

/**
 * The Node suite, with a second Node process holding one root on the portable lock while it runs.
 * Afterwards the holder is killed with SIGKILL, so it releases nothing itself, and a third Node
 * process must then be admitted: only the kernel can have freed the lock.
 */
let holderAnswer = '';
let afterHolderDied = '';
const suite = await outcomeOf(async () => {
  const server = createS3TestServer({ bucket: 'node-bucket' });
  const heldRoot = temporaryRoot();
  try {
    const holder = await startHolder(node, heldRoot, 'portable');
    holderAnswer = holder.answer;
    try {
      const result = await runWithHangGuard(
        [node, '--test', '--test-reporter=tap', join(HERE, 'node-runtime.test-support.ts')],
        {
          env: {
            ...processEnvironment(),
            BUNGALOW_NODE_S3_ENDPOINT: server.endpoint,
            BUNGALOW_NODE_S3_BUCKET: server.bucket,
            BUNGALOW_NODE_HELD_ROOT: heldRoot,
            BUNGALOW_NODE_HOLDER_PID: String(holder.pid),
          },
        },
      );
      const output = result.stdout.toString();
      if (result.exitCode !== 0 || !/^# fail 0$/m.test(output) || /^# pass 0$/m.test(output)) {
        throw new Error(
          `node --test failed under ${nodeVersion}:\n${output}\n${result.stderr.toString()}`,
        );
      }
    } finally {
      await holder.stop();
    }
    const next = await startHolder(node, heldRoot, 'portable');
    afterHolderDied = next.answer;
    await next.stop();
  } finally {
    await server.stop();
    rmSync(heldRoot, { recursive: true, force: true });
  }
});

/** Start a holder of `root` under `runtime` and resolve with its first answer. */
async function startHolder(runtime: string, root: string, lock: 'portable' | 'default') {
  const child = spawnWithHangGuard(
    [runtime, join(HERE, 'node-lock-holder.test-support.ts'), root, lock],
    { stdin: 'pipe', stdout: 'pipe', stderr: 'inherit' },
  );
  const reader = child.stdout.getReader();
  let text = '';
  while (!text.includes('\n')) {
    const { done, value } = await reader.read();
    if (value !== undefined) text += new TextDecoder().decode(value);
    if (done) break;
  }
  return {
    pid: child.pid,
    answer: text.trim(),
    /** SIGKILL, with stdin still open, so the holder never runs its own `close()`. */
    async stop() {
      child.kill('SIGKILL');
      await child.exited;
    },
  };
}

function temporaryRoot(): string {
  return mkdtempSync(join(tmpdir(), 'bungalow-cross-runtime-'));
}

/** A Bun process holds the default lock; a Node process asks for the portable one. */
let nodeAnswerWhileBunHolds = '';
const bunHoldsDefault = await outcomeOf(async () => {
  const root = temporaryRoot();
  try {
    const home = await openLocalBungalow({ name: 'bungalow-node', root });
    try {
      const holder = await startHolder(node, root, 'portable');
      await holder.stop();
      nodeAnswerWhileBunHolds = holder.answer;
    } finally {
      home.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** A Node process holds the portable lock; this Bun process asks for the default one. */
let whileNodeHolds = { holder: '', holderPid: 0, outcome: '' };
const nodeHoldsPortable = await outcomeOf(async () => {
  const root = temporaryRoot();
  try {
    const holder = await startHolder(node, root, 'portable');
    try {
      let outcome: string;
      try {
        const home = await openLocalBungalow({ name: 'bungalow-node', root });
        home.close();
        outcome = 'HELD';
      } catch (error) {
        outcome =
          error instanceof BungalowLockedError
            ? `LOCKED ${error.holderProcessIdentifier}`
            : `ERROR ${error instanceof Error ? error.name : 'unknown'}`;
      }
      whileNodeHolds = { holder: holder.answer, holderPid: holder.pid, outcome };
    } finally {
      await holder.stop();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

describe(`Bungalow on native Node (${nodeVersion})`, () => {
  test('the Node subset passes under node --test', () => {
    rethrow(suite);
  });

  test('a SIGKILLed Node holder frees the portable lock for the next Node process', () => {
    rethrow(suite);
    expect(holderAnswer).toBe('HELD');
    expect(afterHolderDied).toBe('HELD');
  });
});

describe('the portable lock and the default lock on one root', () => {
  if (process.platform === 'darwin') {
    test('macOS: a Node opener on the portable lock is refused while Bun holds the default', () => {
      rethrow(bunHoldsDefault);
      expect(nodeAnswerWhileBunHolds).toBe(`LOCKED ${process.pid}`);
    });

    test('macOS: a Bun opener on the default lock is refused while Node holds the portable', () => {
      rethrow(nodeHoldsPortable);
      expect(whileNodeHolds.holder).toBe('HELD');
      expect(whileNodeHolds.outcome).toBe(`LOCKED ${whileNodeHolds.holderPid}`);
    });
  } else {
    // The documented gap: on Linux the portable lock is a socket the default `flock(2)` cannot
    // see, so each runtime holds the root at once. Asserted, so a change in either direction fails.
    test('Linux: the two locks do not see each other, as the README documents', () => {
      rethrow(bunHoldsDefault);
      expect(nodeAnswerWhileBunHolds).toBe('HELD');
      rethrow(nodeHoldsPortable);
      expect(whileNodeHolds).toMatchObject({ holder: 'HELD', outcome: 'HELD' });
    });
  }
});
