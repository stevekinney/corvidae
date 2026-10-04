import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';

/**
 * The workspace keeps executable repository tooling in its owning workspace's `scripts/`
 * directory; application source under `src/` is what the application itself runs. A module that
 * starts a server, prints results, and exits is tooling, so a `src/` module that decides at load
 * time whether it is the process entry (`import.meta.main`) has to be the application's own
 * entrypoint, which keeps its documented location.
 */
const applicationRoot = join(import.meta.dirname, '..');
const applicationEntrypoints = new Set(['src/playground-server.ts']);

describe('executable tooling placement', () => {
  it('keeps every process-entry module under src/ to the application entrypoint', async () => {
    const entrypoints: string[] = [];
    for await (const path of new Bun.Glob('src/**/*.ts').scan({
      cwd: applicationRoot,
      onlyFiles: true,
    })) {
      if (path.endsWith('.test.ts')) continue;
      const source = await Bun.file(join(applicationRoot, path)).text();
      if (/\bimport\.meta\.main\b/u.test(source) && !applicationEntrypoints.has(path)) {
        entrypoints.push(path);
      }
    }

    expect(entrypoints).toEqual([]);
  });

  it('runs the validation crawler from scripts/', async () => {
    const manifest = (await Bun.file(join(applicationRoot, 'package.json')).json()) as {
      scripts?: Record<string, string>;
    };
    expect(manifest.scripts?.['validate']).toBe('bun scripts/validate-playground.ts');
    expect(
      await Bun.file(join(applicationRoot, 'scripts', 'validate-playground.ts')).exists(),
    ).toBe(true);
  });
});
