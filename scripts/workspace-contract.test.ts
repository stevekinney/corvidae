import { describe, expect, test } from 'bun:test';
import { lstat, mkdtemp, readdir, readlink, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';

const root = join(import.meta.dir, '..');
const libraries = [
  'bureau',
  'operative',
  'armorer',
  'conversationalist',
  'memory',
  'skills',
  'interoperability',
  'lifecycle',
  'weft',
  'weft-ui',
  'cinder',
  'chat',
  'editor',
  'markdown',
  'testing',
  'shared',
];

type Manifest = {
  name: string;
  private?: boolean;
  type?: string;
  exports?: Record<string, string>;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  catalog?: Record<string, string>;
  publishConfig?: unknown;
  main?: string;
  module?: string;
  types?: string;
  bin?: Record<string, string>;
};

async function readManifest(path: string): Promise<Manifest> {
  return Bun.file(join(root, path, 'package.json')).json();
}

async function libraryApplicationConfigurations(): Promise<string[]> {
  const paths: string[] = [];
  const configurations = new Bun.Glob('packages/*/**/{vite,svelte}.config.{ts,js,mts,mjs,cts,cjs}');
  for await (const path of configurations.scan({ cwd: root, onlyFiles: true })) {
    if (!path.split('/').includes('node_modules')) paths.push(path);
  }
  return paths;
}

async function workspaceManifests(): Promise<Map<string, Manifest>> {
  const manifests = new Map<string, Manifest>();
  for (const directory of ['applications', 'packages']) {
    for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const path = join(directory, entry.name);
      if (await Bun.file(join(root, path, 'package.json')).exists()) {
        const manifest = await readManifest(path);
        expect(manifests.has(manifest.name), `Duplicate workspace ${manifest.name}`).toBe(false);
        manifests.set(manifest.name, manifest);
      }
    }
  }
  return manifests;
}

describe('internal workspace architecture', () => {
  test('locked workspace executable metadata matches existing manifest entrypoints', async () => {
    const lock = Bun.JSON5.parse(await Bun.file(join(root, 'bun.lock')).text()) as {
      workspaces: Record<string, Pick<Manifest, 'name' | 'bin'>>;
    };
    const rootManifest = await readManifest('.');
    expect(lock.workspaces['']?.name, 'Root workspace identity').toBe(rootManifest.name);
    for await (const path of new Bun.Glob('{applications,packages}/*/package.json').scan(root)) {
      const directory = dirname(path);
      const manifest = await readManifest(directory);
      expect(lock.workspaces[directory]?.name, directory).toBe(manifest.name);
      expect(lock.workspaces[directory]?.bin, directory).toEqual(manifest.bin);
      for (const entrypoint of Object.values(manifest.bin ?? {})) {
        expect(await Bun.file(join(root, directory, entrypoint)).exists(), entrypoint).toBe(true);
      }
    }
  });

  test('workspace source stays versioned despite personal ignore patterns', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'corvidae-source-ignores-'));
    try {
      await Bun.write(join(directory, '.gitignore'), Bun.file(join(root, '.gitignore')));
      const personalIgnore = join(directory, 'personal-ignore');
      await Bun.write(personalIgnore, 'Icon?\n');
      for (const workspace of ['applications/example', 'packages/example']) {
        for (const path of [
          'src/components/icons/index.ts',
          'src/components/icons/index.test.ts',
          'src/components/icons/.env.local',
          'src/components/icons/private.pem',
          'src/node_modules/dependency/index.ts',
          'build/index.js',
          'coverage/index.html',
        ]) {
          await Bun.write(join(directory, workspace, path), '');
        }
      }
      const initialized = Bun.spawnSync(['git', 'init', '--quiet'], { cwd: directory });
      expect(initialized.exitCode, initialized.stderr.toString()).toBe(0);
      const listed = Bun.spawnSync(
        [
          'git',
          '-c',
          'core.ignoreCase=true',
          '-c',
          `core.excludesFile=${personalIgnore}`,
          'ls-files',
          '--others',
          '--exclude-standard',
        ],
        { cwd: directory },
      );
      expect(listed.exitCode, listed.stderr.toString()).toBe(0);
      const workspaceFiles = listed.stdout
        .toString()
        .trim()
        .split('\n')
        .filter((path) => path.startsWith('applications/') || path.startsWith('packages/'));
      expect(workspaceFiles).toEqual([
        'applications/example/src/components/icons/index.test.ts',
        'applications/example/src/components/icons/index.ts',
        'packages/example/src/components/icons/index.test.ts',
        'packages/example/src/components/icons/index.ts',
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('project skills have one canonical owner for both providers', async () => {
    for (const name of ['add-dependency', 'add-workspace', 'validate-monorepo']) {
      const canonicalDirectory = join(root, '.agents/skills', name);
      const canonicalStatus = await lstat(canonicalDirectory);
      expect(canonicalStatus.isSymbolicLink()).toBe(false);
      const canonicalFile = await realpath(join(canonicalDirectory, 'SKILL.md'));
      for (const provider of ['.claude', '.codex']) {
        const providerDirectory = join(root, provider, 'skills', name);
        const providerStatus = await lstat(providerDirectory);
        expect(providerStatus.isSymbolicLink()).toBe(true);
        expect(isAbsolute(await readlink(providerDirectory))).toBe(false);
        expect(await realpath(join(providerDirectory, 'SKILL.md'))).toBe(canonicalFile);
      }
    }
  });

  for (const library of libraries) {
    test(`${library} exposes source without a build or publication contract`, async () => {
      const manifest = await readManifest(`packages/${library}`);
      expect(manifest.name).toBe(`@repo/${library}`);
      expect(manifest.private).toBe(true);
      expect(manifest.type).toBe('module');
      expect(manifest.exports).toEqual({ '.': './src/index.ts' });
      expect(await Bun.file(join(root, 'packages', library, 'src/index.ts')).exists()).toBe(true);
      for (const command of ['lint', 'lint:fix', 'test', 'typecheck']) {
        expect(manifest.scripts?.[command], `${library}: ${command}`).toBeString();
      }
      for (const command of Object.keys(manifest.scripts ?? {})) {
        expect(command).not.toMatch(/build|pack|publish|release|prepare|postinstall/);
      }
      expect(manifest.publishConfig).toBeUndefined();
      expect(manifest.main).toBeUndefined();
      expect(manifest.module).toBeUndefined();
      expect(manifest.types).toBeUndefined();
    });
  }

  test('every internal edge resolves and uses workspace:*', async () => {
    const manifests = await workspaceManifests();
    for (const manifest of manifests.values()) {
      expect(manifest.name).toStartWith('@repo/');
      expect(manifest.private).toBe(true);
      for (const [name, version] of Object.entries({
        ...manifest.dependencies,
        ...manifest.devDependencies,
        ...manifest.peerDependencies,
      })) {
        expect(name).not.toMatch(/^@lostgradient\/|^@cinder\//);
        if (!name.startsWith('@repo/')) continue;
        expect(version, `${manifest.name} -> ${name}`).toBe('workspace:*');
        expect(manifests.has(name), `${manifest.name} -> missing ${name}`).toBe(true);
      }
    }
  });

  test('runtime, type and development dependency edges are acyclic', async () => {
    const manifests = await workspaceManifests();
    const complete = new Set<string>();
    function visit(name: string, ancestors: string[]): void {
      expect(ancestors, [...ancestors, name].join(' -> ')).not.toContain(name);
      if (complete.has(name)) return;
      const manifest = manifests.get(name);
      if (!manifest) throw new Error(`Missing workspace ${name}`);
      for (const dependency of Object.keys({
        ...manifest.dependencies,
        ...manifest.devDependencies,
        ...manifest.peerDependencies,
      })) {
        if (dependency.startsWith('@repo/')) visit(dependency, [...ancestors, name]);
      }
      complete.add(name);
    }
    for (const name of manifests.keys()) visit(name, []);
  });

  test('shared external versions come from the root catalog', async () => {
    const manifest = await readManifest('.');
    const versions = new Map<string, string[]>();
    const workspaces = await workspaceManifests();
    workspaces.set(manifest.name, manifest);
    for (const workspace of workspaces.values()) {
      for (const [name, version] of Object.entries({
        ...workspace.dependencies,
        ...workspace.devDependencies,
      })) {
        if (name.startsWith('@repo/')) continue;
        const declarations = versions.get(name) ?? [];
        declarations.push(version);
        versions.set(name, declarations);
        if (version === 'catalog:') expect(manifest.catalog?.[name], name).toBeString();
      }
    }
    for (const [name, declarations] of versions) {
      if (declarations.length > 1) {
        expect(
          declarations.every((version) => version === 'catalog:'),
          name,
        ).toBe(true);
      }
    }
  });

  test('only applications build, with no phantom upstream builds or cached watchers', async () => {
    expect(await libraryApplicationConfigurations()).toEqual([]);
    const configuration: {
      tasks: Record<
        string,
        {
          dependsOn?: string[];
          outputs?: string[];
          cache?: boolean;
          persistent?: boolean;
        }
      >;
    } = await Bun.file(join(root, 'turbo.json')).json();
    expect(configuration.tasks['build']?.dependsOn ?? []).not.toContain('^build');
    expect(configuration.tasks['build']?.outputs).toContain('.svelte-kit/**');
    expect(configuration.tasks['build']?.outputs).toContain('build/**');
    for (const task of Object.values(configuration.tasks)) {
      if (task.persistent) expect(task.cache).toBe(false);
    }
    const editorConfiguration: {
      tasks: Array<{ label: string; command: string; isBackground?: boolean }>;
    } = await Bun.file(join(root, '.vscode/tasks.json')).json();
    const testWatcher = editorConfiguration.tasks.find((task) => task.label === 'Test (Watch)');
    expect(testWatcher?.command).toContain('turbo watch test');
    expect(testWatcher?.command).not.toContain('--experimental-write-cache');
    expect(testWatcher?.isBackground).toBe(true);
    const application = await readManifest('applications/chat-room');
    expect(application.scripts?.['dev']).toContain('vite dev');
    expect(application.scripts?.['build']).toContain('vite build');
    expect(application.scripts?.['preview']).toContain('vite preview');
  });

  test('installation does not enable Git hooks or publishing', async () => {
    const manifests = await workspaceManifests();
    manifests.set('root', await readManifest('.'));
    for (const manifest of manifests.values()) {
      expect(manifest.scripts?.['prepare']).toBeUndefined();
      expect(manifest.scripts?.['postinstall']).toBeUndefined();
      for (const dependency of Object.keys({
        ...manifest.dependencies,
        ...manifest.devDependencies,
      })) {
        expect(dependency).not.toMatch(/^(lefthook|husky|lint-staged|@changesets\/.*)$/);
      }
    }
    expect(await Bun.file(join(root, 'lefthook.yml')).exists()).toBe(false);
    expect(
      await Bun.file(join(root, '.github/workflows/continuous-integration.yaml')).exists(),
    ).toBe(false);
  });
});
