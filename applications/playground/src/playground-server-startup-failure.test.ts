import { afterEach, beforeAll, describe, expect, it, mock } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { rejectionOf } from '@lostgradient/testing';

/**
 * `startServer` binds a socket and registers watchers before it warms anything, and a caller never
 * receives the disposer until it returns. Every way it can fail after that point has to release
 * both, or the failed start keeps the port reserved and the process alive. These tests live in a
 * file of their own because a failed start leaves the module's readiness flag false, and because
 * the second one replaces two modules before `playground-server.ts` is imported.
 */

// Snapshots of the real exports, taken before any mock is registered: `mock.module` also rewrites
// the live bindings of an already imported namespace, so spreading the namespace itself inside a
// factory recurses into the mock being built and the import never settles.
const actualFileWatcher = { ...(await import('./file-watcher.ts')) };
const actualSourceFingerprint = { ...(await import('./source-fingerprint.ts')) };

let watcherCloses = 0;
let fingerprintFailure: Error | null = null;

// A watcher the test can see closed, and a fingerprint that fails on demand. Both are installed
// before the server module is imported, so it binds to them.
mock.module('./file-watcher.ts', () => ({
  ...actualFileWatcher,
  startWatcher: () => [
    {
      close: () => {
        watcherCloses += 1;
      },
    },
  ],
}));
mock.module('./source-fingerprint.ts', () => ({
  ...actualSourceFingerprint,
  newestSourceMtimeMs: (repositoryRoot: string) => {
    if (fingerprintFailure !== null) throw fingerprintFailure;
    return actualSourceFingerprint.newestSourceMtimeMs(repositoryRoot);
  },
}));

type StartServer = typeof import('./playground-server.ts').startServer;
let startServer: StartServer;

beforeAll(async () => {
  ({ startServer } = await import('./playground-server.ts'));
});

/**
 * Record a variable's current value and return the function that puts it back,
 * deleting the variable when it was unset to begin with.
 */
function captureOriginal(name: string): () => void {
  const original = process.env[name];
  return () => {
    if (original === undefined) delete process.env[name];
    else process.env[name] = original;
  };
}

const restorePortFile = captureOriginal('PLAYGROUND_PORT_FILE');
let scratchDirectory: string | undefined;

afterEach(() => {
  restorePortFile();
  fingerprintFailure = null;
  watcherCloses = 0;
  if (scratchDirectory !== undefined) rmSync(scratchDirectory, { recursive: true, force: true });
  scratchDirectory = undefined;
});

/** A port nothing is listening on right now. */
async function freePort(): Promise<number> {
  const probe = Bun.serve({ port: 0, fetch: () => new Response('') });
  const { port } = probe;
  await probe.stop(true);
  if (port === undefined) throw new Error('the probe server reported no port');
  return port;
}

/** Bind `port` again, which throws `EADDRINUSE` while a failed start still holds it. */
async function expectPortReleased(port: number): Promise<void> {
  const rebound = Bun.serve({ port, fetch: () => new Response('') });
  expect(rebound.port).toBe(port);
  await rebound.stop(true);
}

describe('startServer when the port file cannot be written', () => {
  it('rejects and releases the port it had already bound', async () => {
    scratchDirectory = mkdtempSync(join(tmpdir(), 'playground-port-file-'));
    // A file where the port file's parent directory should be, so the write fails.
    const blocker = join(scratchDirectory, 'blocker');
    writeFileSync(blocker, 'not a directory');
    process.env['PLAYGROUND_PORT_FILE'] = join(blocker, 'playground.port');
    const port = await freePort();

    const failure = await rejectionOf(startServer(port));

    expect(failure).toBeInstanceOf(Error);
    await expectPortReleased(port);
  });
});

describe('startServer when the source fingerprint cannot be read during warmup', () => {
  it('rejects, closes the watchers it registered, and releases the port', async () => {
    delete process.env['PLAYGROUND_PORT_FILE'];
    fingerprintFailure = new Error('EIO: i/o error, scandir');
    const port = await freePort();

    const failure = await rejectionOf(startServer(port));

    expect(failure).toBe(fingerprintFailure);
    expect(watcherCloses).toBe(1);
    await expectPortReleased(port);
  });
});
