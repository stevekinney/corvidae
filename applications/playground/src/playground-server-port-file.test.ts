import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { rejectionOf } from '@lostgradient/testing';

import { startServer } from './playground-server.ts';

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
    // A listener the failed start left behind would still hold the port, and binding it again would
    // throw EADDRINUSE.
    const rebound = Bun.serve({ port, fetch: () => new Response('') });
    expect(rebound.port).toBe(port);
    await rebound.stop(true);
  });
});
