import { runWithHangGuard } from '@lostgradient/testing/hang-guard';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

type Manifest = {
  name: string;
  version?: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  [key: string]: unknown;
};
const repository = resolve(import.meta.dir, '../../..');
const readManifest = async (path: string) => JSON.parse(await readFile(path, 'utf8')) as Manifest;
const writeManifest = (path: string, value: unknown) =>
  writeFile(path, JSON.stringify(value, null, 2));

async function run(command: string[], cwd: string) {
  const result = await runWithHangGuard(command, { cwd });
  if (result.exitCode !== 0)
    throw new Error(
      `${command.join(' ')} failed: ${result.stderr.toString()}\n${result.stdout.toString()}`,
    );
}

/** Pack the package in a versioned fixture workspace, then install that tarball in a consumer. */
export async function installFixture() {
  const root = await mkdtemp(join(tmpdir(), 'api-key-settings-consumer-'));
  try {
    const rootManifest = await readManifest(join(repository, 'package.json'));
    const locations = new Map<string, string>();
    // The root `workspaces` globs are the one list of workspace locations.
    for (const pattern of rootManifest.workspaces as string[]) {
      for await (const manifestFile of new Bun.Glob(`${pattern}/package.json`).scan(repository)) {
        const relative = dirname(manifestFile);
        const manifest = await readManifest(join(repository, manifestFile));
        locations.set(manifest.name, relative);
      }
    }
    const selected = new Set<string>();
    const pending = ['@lostgradient/api-key-settings', '@lostgradient/cinder'];
    while (pending.length) {
      const name = pending.pop()!;
      if (selected.has(name)) continue;
      const directory = locations.get(name);
      if (!directory) throw new Error(`Missing fixture workspace ${name}`);
      selected.add(name);
      const manifest = await readManifest(join(repository, directory, 'package.json'));
      for (const [dependency, range] of Object.entries({
        ...manifest.dependencies,
        ...manifest.optionalDependencies,
        ...manifest.peerDependencies,
      }))
        if (range.startsWith('workspace:')) pending.push(dependency);
    }
    const workspaces: string[] = [];
    for (const name of selected) {
      const relative = locations.get(name)!;
      const destination = join(root, relative);
      await mkdir(dirname(destination), { recursive: true });
      await cp(join(repository, relative), destination, {
        recursive: true,
        filter: (path) =>
          !path
            .split('/')
            .some((part) => ['node_modules', '.types', '.git', 'coverage'].includes(part)),
      });
      const path = join(destination, 'package.json');
      const manifest = await readManifest(path);
      manifest.version = '0.0.0';
      delete manifest.devDependencies;
      await writeManifest(path, manifest);
      workspaces.push(relative);
    }
    const packageRoot = join(root, locations.get('@lostgradient/api-key-settings')!);
    const fixtureRoot = {
      name: 'api-key-settings-fixture',
      private: true,
      type: 'module',
      workspaces,
      catalog: rootManifest['catalog'],
      catalogs: rootManifest['catalogs'],
    };
    await writeManifest(join(root, 'package.json'), fixtureRoot);
    const tarball = join(root, 'api-key-settings.tgz');
    await run(
      [process.execPath, 'pm', 'pack', '--ignore-scripts', '--filename', tarball],
      packageRoot,
    );
    const consumer = join(root, 'consumer');
    await mkdir(consumer);
    await writeManifest(join(consumer, 'package.json'), {
      name: 'settings-consumer',
      private: true,
      type: 'module',
      dependencies: {
        '@lostgradient/api-key-settings': 'file:../api-key-settings.tgz',
        '@lostgradient/backchannel': 'workspace:*',
        '@lostgradient/cinder': 'workspace:*',
        '@tanstack/svelte-query': 'catalog:',
        svelte: 'catalog:',
      },
    });
    fixtureRoot.workspaces = [
      ...workspaces.filter((path) => join(root, path) !== packageRoot),
      'consumer',
    ];
    await writeManifest(join(root, 'package.json'), fixtureRoot);
    await run([process.execPath, 'install', '--ignore-scripts'], root);
    const fixture = join(repository, 'packages/api-key-settings/tests/fixture');
    await cp(join(fixture, 'Installed.svelte'), join(consumer, 'Installed.svelte'));
    await cp(join(fixture, 'installed-client.ts'), join(consumer, 'installed-client.ts'));
    return { root, consumer, cleanup: () => rm(root, { recursive: true, force: true }) };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
