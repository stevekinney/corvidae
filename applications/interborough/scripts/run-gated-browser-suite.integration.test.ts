import { runWithHangGuard } from '@lostgradient/testing/hang-guard';
import { expect, test } from 'bun:test';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const directory = await mkdtemp(join(tmpdir(), 'gated-browser-retry-'));
const counter = join(directory, 'counter');
const executable = join(directory, 'bun');
let result: Awaited<ReturnType<typeof runWithHangGuard>>;
let counterContents: string;
try {
  await writeFile(
    executable,
    `#!/bin/sh\nif [ "$1" = "scripts/run-gated-browser-suite.ts" ]; then exec "${process.execPath}" "$@"; fi\nif [ ! -f "${counter}" ]; then touch "${counter}"; echo INTERBOROUGH_E2E_STARTUP_BIND_COLLISION >&2; exit 1; fi\necho second-attempt\n`,
  );
  await chmod(executable, 0o755);
  result = await runWithHangGuard(
    [process.execPath, 'scripts/run-gated-browser-suite.ts', '--grep', 'case'],
    {
      cwd: join(import.meta.dir, '..'),
      env: {
        ...process.env,
        PATH: `${directory}:${process.env['PATH'] ?? ''}`,
        INTERBOROUGH_E2E_PORT: '',
      },
    },
  );
  counterContents = await readFile(counter, 'utf8');
} finally {
  await rm(directory, { recursive: true, force: true });
}

test('the admitted launcher retries a startup bind collision through its process group', () => {
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toContain('second-attempt');
  expect(result.stderr.toString()).toContain('retrying with a fresh block');
  expect(counterContents).toBe('');
});
