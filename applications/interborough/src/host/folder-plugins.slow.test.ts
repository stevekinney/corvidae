/**
 * COR-1881, the network probe: a folder plugin that imports a package nothing provides fails with
 * a message that names the specifier, and Bun asks no registry for it. The host runs with
 * `--no-install` (`supervisor.ts`), and `spawnWithHangGuard` starts every Bun child with it, so the
 * child here is started the way the host is.
 *
 * A control proves the probe can see a request at all. The same child, told `--install=force` (`auto` installs only where no `node_modules` is found, and the link is), must
 * reach the local registry: if `BUN_CONFIG_REGISTRY` were not honored, zero requests would prove
 * nothing. Each child runs at module scope under the hang guard, so none is on Bun's per-test clock.
 */
import { spawnWithHangGuard } from '@lostgradient/testing/hang-guard';
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scratch = mkdtempSync(join(tmpdir(), 'interborough-folder-plugins-'));

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const UNINSTALLED_SPECIFIER = 'interborough-uninstalled-package-for-cor-1881';

/** A local registry that answers every package with 404 and records the paths it was asked for. */
function startRegistry() {
  const requests: string[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: (request) => {
      requests.push(new URL(request.url).pathname);
      return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
    },
  });
  return { requests, url: `http://127.0.0.1:${server.port}/`, stop: () => server.stop(true) };
}

/** A plugins directory with one folder plugin that imports `specifier`. */
function pluginsImporting(specifier: string): string {
  const directory = mkdtempSync(join(scratch, 'plugins-'));
  const folder = join(directory, 'needy');
  mkdirSync(folder);
  writeFileSync(
    join(folder, 'plugin.ts'),
    `import '${specifier}';\nexport default { name: 'needy', version: '1.0.0', description: 'Needs a package.' };\n`,
  );
  return directory;
}

type Outcome = {
  readonly names: string[];
  readonly failures: string[];
  readonly requests: string[];
  readonly stderr: string;
};

/** Load the folder plugins under `directory` in a child, with a local registry as the only registry. */
async function loadInChild(directory: string, extraArguments: string[]): Promise<Outcome> {
  const registry = startRegistry();
  try {
    const child = spawnWithHangGuard(
      [
        process.execPath,
        ...extraArguments,
        join(import.meta.dir, 'folder-plugins-fixture.test-support.ts'),
        directory,
      ],
      {
        cwd: scratch,
        env: { ...process.env, BUN_CONFIG_REGISTRY: registry.url },
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    const [stdout, stderr] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    const reported = stdout.trim().split('\n').at(-1) ?? '';
    let parsed: { names: string[]; failures: string[] } = { names: [], failures: [] };
    try {
      parsed = JSON.parse(reported) as typeof parsed;
    } catch {
      // The child failed before it reported; `stderr` says why.
    }
    return { ...parsed, requests: registry.requests, stderr };
  } finally {
    await registry.stop();
  }
}

const withoutInstall = await loadInChild(pluginsImporting(UNINSTALLED_SPECIFIER), []);
const withInstall = await loadInChild(pluginsImporting(UNINSTALLED_SPECIFIER), ['--install=force']);

describe('a folder plugin that imports a package nothing provides', () => {
  test('fails to load with a message that names the specifier, and the host-side loader does not throw', () => {
    expect(withoutInstall.names).toEqual([]);
    expect(withoutInstall.failures).toHaveLength(1);
    expect(withoutInstall.failures[0]).toContain('The plugin folder "needy" could not be loaded');
    expect(withoutInstall.failures[0]).toContain(UNINSTALLED_SPECIFIER);
  });

  test('makes zero registry requests under --no-install', () => {
    expect(withoutInstall.requests).toEqual([]);
  });

  test('control: the same import reaches the registry when installs are allowed, so the probe can see a request', () => {
    expect(withInstall.requests.join('\n')).toContain(UNINSTALLED_SPECIFIER);
  });
});
