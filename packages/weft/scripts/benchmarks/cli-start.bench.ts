import { expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI_START_TARGET_MS = 5_000;

async function readHealthAddress(output: ReadableStream<Uint8Array>): Promise<string> {
  const reader = output.getReader();
  const decoder = new TextDecoder();
  let received = '';
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) throw new Error(`CLI exited before readiness: ${received}`);
      received += decoder.decode(next.value, { stream: true });
      const match = /Health check: (http:\/\/[^\s]+)\n/.exec(received);
      if (match?.[1]) return match[1];
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Performance claim moved out of `src/cold-start.test.ts`: the source CLI starts and answers a
 * health request within five seconds. The wall-clock target depends on host load, so it runs
 * through `test:benchmarks` rather than the default gate; the default-suite test keeps the
 * correctness half (the CLI starts and serves a 200) and its readiness deadline.
 */
it('starts the source CLI and serves a health request within five seconds', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'corvidae-cli-start-'));
  const started = performance.now();
  const child = Bun.spawn({
    cmd: [
      process.execPath,
      new URL('../../src/cli-main.ts', import.meta.url).pathname,
      '--port',
      '0',
      '--database',
      ':memory:',
      '--storage',
      'memory',
    ],
    env: { ...process.env, NODE_ENV: 'production', WEFT_HOME: directory },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    const address = await Promise.race([
      readHealthAddress(child.stdout),
      new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(
          () => reject(new Error('CLI readiness exceeded five seconds.')),
          CLI_START_TARGET_MS,
        );
      }),
    ]);
    const response = await fetch(address);
    expect(response.status).toBe(200);
    expect(performance.now() - started).toBeLessThan(CLI_START_TARGET_MS);
  } finally {
    clearTimeout(deadline);
    child.kill('SIGTERM');
    await child.exited;
    await rm(directory, { recursive: true, force: true });
  }
});
