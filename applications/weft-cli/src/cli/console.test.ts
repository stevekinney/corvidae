import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'bun:test';

import { loadConsoleMount } from './console.ts';

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), 'weft-console-build-'));
  temporaryDirectories.push(path);
  return path;
}

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('console build mount', () => {
  it('serves the built index and exposes its assets directory', () => {
    const buildDirectory = temporaryDirectory();
    mkdirSync(join(buildDirectory, 'assets'));
    writeFileSync(join(buildDirectory, 'index.html'), '<!doctype html>');

    const mount = loadConsoleMount({ buildDirectory });

    expect(mount.dashboard).toBeInstanceOf(Response);
    expect(mount.dashboardAssets).toEqual({
      prefix: '/assets',
      directory: join(buildDirectory, 'assets'),
    });
  });

  it('finds the sibling console application independently of the working directory', () => {
    const root = realpathSync(temporaryDirectory());
    const cliDirectory = join(root, 'applications/weft-cli/src/cli');
    const buildDirectory = join(root, 'applications/weft-console/build');
    mkdirSync(cliDirectory, { recursive: true });
    mkdirSync(join(buildDirectory, 'assets'), { recursive: true });
    writeFileSync(join(buildDirectory, 'index.html'), '<!doctype html>Console');
    const modulePath = join(cliDirectory, 'console.ts');
    copyFileSync(join(import.meta.dir, 'console.ts'), modulePath);

    const result = Bun.spawnSync(
      [
        process.execPath,
        '--eval',
        `import { loadConsoleMount } from ${JSON.stringify(modulePath)};
       const mount = loadConsoleMount();
       console.log(JSON.stringify(mount.dashboardAssets));`,
      ],
      { cwd: root },
    );

    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(JSON.parse(result.stdout.toString())).toEqual({
      prefix: '/assets',
      directory: join(buildDirectory, 'assets'),
    });
  });

  it('reports the build command when application output is absent', () => {
    expect(() =>
      loadConsoleMount({ buildDirectory: join(tmpdir(), 'missing-weft-console') }),
    ).toThrow('bun run --filter=@repo/weft-console build');
  });
});
