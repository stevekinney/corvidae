import { describe, expect, it } from 'bun:test';

import { spawnWithHangGuard } from '@lostgradient/testing/hang-guard';
import { throwingRejectionOf } from '@lostgradient/testing/promise-outcome';
import { outcomeOf, rethrow } from '@lostgradient/testing/module-scope-scenario';
import { formatGreetingRemotely, runRemoteWorkerExample } from '../src/index';

// This scenario spawns the example entry point as a real process, which takes seconds on a loaded host, so each scenario runs here at
// module scope, off Bun's five-second per-test clock; its test rethrows the outcome.

const scenario1 = await outcomeOf(async () => {
  const weftRoot = `${import.meta.dir}/../../..`;
  const proc = spawnWithHangGuard(['bun', 'examples/remote-worker/src/index.ts'], {
    cwd: weftRoot,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();

  expect(exitCode).toBe(0);
  // `serve({ port: 0 })` with no `publicOrigin`/`trustedHosts` configured
  // always logs its own startup warning — expected here, not a failure.
  // Anything else on stderr (a stack trace, an unhandled rejection) is not.
  expect(stderr.replace(/\[weft\] WARNING: MCP HTTP transport[^\n]*\n?/g, '')).toBe('');
  expect(stdout).toContain('"greeting": "Hello, Ada!');
});

describe('remote-worker example', () => {
  it('dispatches ctx.run() to a real RemoteWorker end to end, never falling back to a local implementation', async () => {
    const result = await runRemoteWorkerExample('Ada');

    expect(result.greeting).toBe(`Hello, Ada! (via ${result.workerId})`);
  });

  it('refuses to run the local stand-in for the remote activity', async () => {
    expect(
      await throwingRejectionOf(
        Promise.resolve().then(() => formatGreetingRemotely({ name: 'Ada' })),
      ),
    ).toThrow('formatGreetingRemotely must never run locally');
  });

  it('runs the CLI entry point (import.meta.main) when spawned directly, printing the remote result', () =>
    rethrow(scenario1));
});
