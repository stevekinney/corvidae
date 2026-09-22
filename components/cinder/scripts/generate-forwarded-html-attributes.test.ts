/**
 * `attributes:check` in the default `bun test` suite: the committed
 * `src/_internal/forwarded-html-attributes.generated.ts` must match what
 * `generate-forwarded-html-attributes.ts` produces from the `svelte/elements`
 * this workspace actually has installed. See that script's module doc for
 * why the file exists (COR-239).
 *
 * Runs the checker as a subprocess (`bun scripts/generate-forwarded-html-
 * attributes.ts --check`), not by importing and calling it in-process. This
 * package's `bun test` invocation passes `--conditions browser --conditions
 * svelte` (see `package.json`'s `test` script), and under those conditions a
 * statically-imported `prettier` resolves to its browser/standalone bundle
 * for this process — which has no `resolveConfig` — even though the CLI
 * script runs fine standalone. A subprocess gets its own default module
 * resolution, matching how `attributes:generate`/`attributes:check` actually
 * run outside a test.
 */

import { describe, expect, test } from 'bun:test';
import { GENERATED_FILE_PATH } from './generate-forwarded-html-attributes.ts';

describe('generated forwarded HTML attributes', () => {
  test('the committed file matches what svelte/elements currently declares', async () => {
    const scriptPath = new URL('./generate-forwarded-html-attributes.ts', import.meta.url).pathname;
    const proc = Bun.spawn(['bun', scriptPath, '--check'], {
      cwd: new URL('..', import.meta.url).pathname,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(
      exitCode,
      `attributes:check exited ${exitCode} against ${GENERATED_FILE_PATH}:\n${stdout}${stderr}`,
    ).toBe(0);
  });
});
