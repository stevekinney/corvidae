import { describe, expect, it } from 'bun:test';

import { runRemoteWorkerExample } from '../src/index';

describe('remote-worker example', () => {
  it('dispatches ctx.run() to a real RemoteWorker end to end, never falling back to a local implementation', async () => {
    const result = await runRemoteWorkerExample('Ada');

    expect(result.greeting).toBe(`Hello, Ada! (via ${result.workerId})`);
  });

  it('runs the CLI entry point (import.meta.main) when spawned directly, printing the remote result', async () => {
    const weftRoot = `${import.meta.dir}/../../..`;
    const proc = Bun.spawn(['bun', 'examples/remote-worker/src/index.ts'], {
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
  }, 15_000);
});
