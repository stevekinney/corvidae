/**
 * The supervisor's process ownership comes from a runtime-safe library, never from the root
 * `scripts/` that schedule this repository's own checks (COR-2757). A packaged executable is
 * compiled from `cli.ts`, so a module either one reaches under the repository's `scripts/` or
 * `testing/` would ride along as a dependency on tooling that a source-absent install does not have.
 */
import { describe, expect, test } from 'bun:test';
import { realpathSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

const repository = realpathSync(join(import.meta.dir, '..', '..', '..', '..'));
const repositoryTooling = [join(repository, 'scripts') + sep, join(repository, 'testing') + sep];

async function bundledInputs(entry: string): Promise<string[]> {
  const result = await Bun.build({
    entrypoints: [join(import.meta.dir, entry)],
    target: 'bun',
    metafile: true,
    define: { INTERBOROUGH_RELEASE_VERSION: '"0.0.0"' },
  });
  expect(result.logs.filter((log) => log.level === 'error').map(String)).toEqual([]);
  expect(result.success).toBe(true);
  return Object.keys(result.metafile?.inputs ?? {}).map((path) => {
    const absolute = resolve(process.cwd(), path);
    try {
      return realpathSync(absolute);
    } catch {
      return absolute;
    }
  });
}

describe('the supervisor import closure', () => {
  test.each(['supervisor.ts', 'cli.ts'])(
    '%s reaches nothing under the repository scripts or testing directories',
    async (entry) => {
      const inputs = await bundledInputs(entry);
      expect(inputs.length).toBeGreaterThan(10);
      const reached = inputs
        .filter((path) => repositoryTooling.some((directory) => path.startsWith(directory)))
        .map((path) => relative(repository, path));
      expect(reached).toEqual([]);
    },
  );
});
