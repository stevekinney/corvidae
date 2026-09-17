import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('the unit command discovers new nested tests without a maintained file list', async () => {
  const manifest = await Bun.file(new URL('../package.json', import.meta.url)).json();
  expect(manifest.scripts.test).toBe('bun test');
  const directory = await mkdtemp(join(tmpdir(), 'corvidae-test-discovery-'));
  try {
    const source =
      "import { test, expect } from 'bun:test'; test('discovered', () => expect(true).toBe(true));";
    await Bun.write(join(directory, 'root.test.ts'), source);
    await Bun.write(join(directory, 'nested/new.test.ts'), source);
    await Bun.write(
      join(directory, 'nested/browser.e2e.ts'),
      "throw new Error('Wrong test runner');",
    );
    const process = Bun.spawn([Bun.which('bun') ?? 'bun', 'test'], {
      cwd: directory,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [status, output] = await Promise.all([
      process.exited,
      new Response(process.stderr).text(),
    ]);
    expect(status, output).toBe(0);
    expect(output).toContain('2 pass');
    expect(output).not.toContain('Wrong test runner');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
