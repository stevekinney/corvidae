import { expect, test } from 'bun:test';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('the admitted launcher retries a startup bind collision through its process group', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gated-browser-retry-'));
  const counter = join(directory, 'counter');
  const executable = join(directory, 'bun');
  try {
    await writeFile(
      executable,
      `#!/bin/sh\nif [ "$1" = "scripts/run-gated-browser-suite.ts" ]; then exec "${process.execPath}" "$@"; fi\nif [ ! -f "${counter}" ]; then touch "${counter}"; echo INTERBOROUGH_E2E_STARTUP_BIND_COLLISION >&2; exit 1; fi\necho second-attempt\n`,
    );
    await chmod(executable, 0o755);
    const child = Bun.spawn(
      [process.execPath, 'scripts/run-gated-browser-suite.ts', '--grep', 'case'],
      {
        cwd: join(import.meta.dir, '..'),
        env: {
          ...process.env,
          PATH: `${directory}:${process.env['PATH'] ?? ''}`,
          INTERBOROUGH_E2E_PORT: '',
        },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(code).toBe(0);
    expect(stdout).toContain('second-attempt');
    expect(stderr).toContain('retrying with a fresh block');
    expect(await readFile(counter, 'utf8')).toBe('');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
