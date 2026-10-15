import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { lstat, mkdtemp, readdir, readlink, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import ts from 'typescript';

import { sourceExportViolations } from './workspace-exports';

const root = join(import.meta.dir, '..');
const componentLibraries = ['cinder', 'chat', 'editor', 'weft-ui', 'terminal'];
const libraries = [
  'bureau',
  'operative',
  'armorer',
  'conversationalist',
  'memory',
  'skills',
  'tool-protocol',
  'embeddings',
  'cryptography',
  'evaluation',
  'lifecycle',
  'weft',
  'weft-ui',
  'cinder',
  'chat',
  'editor',
  'markdown',
  'testing',
  'terminal',
  'ventriloquist',
];

/**
 * COR-1284: every workspace's manifest `name` equals its public name — `@lostgradient/<name>` for
 * every workspace except `armorer` and `conversationalist`, which publish unscoped and so carry
 * their bare directory name instead. This is the single source of truth the tests below share,
 * rather than each re-deriving the rule (and the exceptions) from a scope-prefix check.
 */
const unscopedWorkspaceNames = new Set(['armorer', 'conversationalist']);
function publicWorkspaceName(directoryName: string): string {
  return unscopedWorkspaceNames.has(directoryName)
    ? directoryName
    : `@lostgradient/${directoryName}`;
}

/** The complete, exact set of current workspace names, per the COR-1284 ruling. */
const expectedWorkspaceNames = new Set([
  '@lostgradient/weft',
  '@lostgradient/weft-ui',
  '@lostgradient/cinder',
  '@lostgradient/chat',
  '@lostgradient/editor',
  '@lostgradient/markdown',
  '@lostgradient/operative',
  '@lostgradient/cryptography',
  '@lostgradient/embeddings',
  '@lostgradient/evaluation',
  '@lostgradient/tool-protocol',
  '@lostgradient/lifecycle',
  '@lostgradient/bureau',
  '@lostgradient/memory',
  '@lostgradient/skills',
  '@lostgradient/testing',
  '@lostgradient/typescript',
  '@lostgradient/playground',
  '@lostgradient/terminal',
  '@lostgradient/ventriloquist',
  'armorer',
  'conversationalist',
]);

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
  workspaces?: string[];
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
  const configurations = new Bun.Glob(
    '{packages,components}/*/**/{vite,svelte}.config.{ts,js,mts,mjs,cts,cjs}',
  );
  for await (const path of configurations.scan({ cwd: root, onlyFiles: true })) {
    if (!path.split('/').includes('node_modules')) paths.push(path);
  }
  return paths;
}

async function workspaceManifests(): Promise<Map<string, Manifest>> {
  const manifests = new Map<string, Manifest>();
  for (const directory of ['applications', 'components', 'packages', 'internal']) {
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

/**
 * Lists the untracked files git would version in a fixture with every workspace layout and a
 * personal excludes file. `git init` and `git ls-files` run here at module scope, off Bun's
 * five-second per-test clock; the test below asserts on the settled results.
 */
async function listVersionedFixtureSource() {
  const directory = await mkdtemp(join(tmpdir(), 'corvidae-source-ignores-'));
  try {
    await Bun.write(join(directory, '.gitignore'), Bun.file(join(root, '.gitignore')));
    const personalIgnore = join(directory, 'personal-ignore');
    await Bun.write(personalIgnore, 'Icon?\n');
    for (const workspace of ['applications/example', 'components/example', 'packages/example']) {
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
    const initialized = Bun.spawnSync(['git', 'init', '--quiet'], {
      timeout: 120_000,
      cwd: directory,
    });
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
      { timeout: 120_000, cwd: directory },
    );
    return { initialized, listed };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
const versionedFixtureSource = await listVersionedFixtureSource();

describe('internal workspace architecture', () => {
  test('validation runs root self-tests once and retains sequential quality and audit gates', async () => {
    const { scripts = {} } = await readManifest('.');
    // The whole chain runs under one host lock, so a validate keeps its place from lint to audit
    // instead of rejoining the queue at every stage. Its stages find the lock held by their parent
    // and reuse it rather than queueing behind it.
    const validationChain = scripts['validate']?.match(
      /^bun scripts\/run-exclusively\.ts '([^']+)'$/,
    );
    const validationStages = validationChain?.[1]?.split(' && ');
    expect(validationStages).toEqual([
      'bun run lint',
      'bun run typecheck',
      'bun run test',
      'bun run coverage',
      'bun run build',
      'bun run format:check',
      'bun run audit',
    ]);
    // The heavy stages queue behind one lock shared by every checkout on the host, so concurrent
    // agent sessions stop oversubscribing it and timing out unrelated tests.
    for (const stage of ['lint', 'typecheck', 'test', 'coverage', 'build']) {
      expect(scripts[stage], stage).toMatch(/^bun scripts\/run-exclusively\.ts '[^']+'$/);
    }
    // One turbo run, so the root self-tests and browser fixtures are cached like every package.
    expect(scripts['test']).toBe(
      "bun scripts/run-exclusively.ts 'turbo run test:self test test:browser-fixtures --concurrency=1'",
    );
    // Enumerated rather than recursive on purpose: `./scripts/**/*.test.ts` also matches
    // `scripts/browser-fixtures`, whose suites need `prepare-manifest.ts` first and run under
    // the separate `test:browser-fixtures` gate.
    expect(scripts['test:self']).toBe(
      'bun test ./scripts/*.test.ts ./scripts/mirror/*.test.ts ./scripts/terminal/*.test.ts',
    );
    // The guard runs `bun audit --audit-level=high` with only the exceptions registered in
    // scripts/audit-exceptions.ts, and fails when one goes stale, expires, or widens.
    expect(scripts['audit']).toBe('bun scripts/check-audit-exceptions.ts');
  });

  test('compiler configuration has a dedicated internal owner and two public presets', async () => {
    const configuration = await readManifest('internal/typescript');
    expect(configuration.name).toBe('@lostgradient/typescript');
    expect(configuration.private).toBe(true);
    expect(configuration.exports).toEqual({
      './library.json': './library.json',
      './browser.json': './browser.json',
    });
    expect(configuration.scripts).toBeUndefined();
    expect(await Bun.file(join(root, 'internal/typescript/base.json')).exists()).toBe(true);
    expect(await Bun.file(join(root, 'internal/typescript/server.json')).exists()).toBe(false);
    for (const preset of ['library.json', 'browser.json']) {
      const contents = await Bun.file(join(root, 'internal/typescript', preset)).json();
      expect(contents.extends).toBe('./base.json');
      expect(import.meta.resolve(`@lostgradient/typescript/${preset}`)).toEndWith(preset);
    }
    for (const privatePreset of ['base.json', 'server.json']) {
      expect(() => import.meta.resolve(`@lostgradient/typescript/${privatePreset}`)).toThrow();
    }
  });

  test('runtime and README contract references have durable root documentation', async () => {
    for (const filename of ['operative-type-safe-api.md', 'workflow-versioning.md']) {
      const document = Bun.file(join(root, 'documentation', filename));
      expect(await document.exists(), filename).toBe(true);
      expect(await document.text(), filename).toMatch(/^# /);
    }
  });

  test('every package and application has a README', async () => {
    for await (const manifestPath of new Bun.Glob(
      '{applications,components,packages,internal}/*/package.json',
    ).scan(root)) {
      const directory = dirname(manifestPath);
      const readme = Bun.file(join(root, directory, 'README.md'));
      expect(await readme.exists(), directory).toBe(true);
      expect(await readme.text(), directory).toMatch(/^# /);
    }
  });

  test('every executable workspace exposes consistent Bun quality scripts', async () => {
    for await (const manifestPath of new Bun.Glob(
      '{applications,components,packages}/*/package.json',
    ).scan(root)) {
      const directory = dirname(manifestPath);
      const manifest = await readManifest(directory);
      const scripts = manifest.scripts ?? {};

      for (const script of ['lint', 'lint:fix', 'test', 'typecheck']) {
        expect(scripts[script], `${directory}: ${script}`).toBeString();
      }
      expect(scripts['lint'], directory).toContain('oxlint --deny-warnings');
      expect(scripts['lint:fix'], directory).toContain('oxlint --deny-warnings --fix');
      if (directory === 'applications/playground') {
        // The playground isolates build-driving test files in fresh Bun processes, so its `test`
        // script names the runner, and the runner is what must spawn `bun test`.
        expect(scripts['test'], directory).toBe('bun scripts/run-tests.ts');
        expect(
          await Bun.file(join(root, directory, 'scripts/run-tests.ts')).text(),
          directory,
        ).toContain("['bun', 'test',");
      } else {
        expect(scripts['test'], directory).toMatch(/\bbun test\b/);
      }
      expect(scripts['typecheck'], directory).toMatch(/\b(?:svelte-check|tsc --noEmit)\b/);

      for (const [name, command] of Object.entries(scripts)) {
        expect(command, `${directory}: ${name}`).not.toMatch(/\b(?:deno|node|npm|npx|pnpm|yarn)\b/);
        expect(command, `${directory}: ${name}`).not.toMatch(/\bbun run (?:\.\.?\/)?\S+\.ts\b/);
      }
    }
  });

  test('browser test hosts have no application identity or Vite dependency', async () => {
    const manifests = await workspaceManifests();
    for (const name of ['weft-cli', 'weft-console', 'cinder-browser-fixtures']) {
      expect(manifests.has(`@lostgradient/${name}`)).toBe(false);
    }
    manifests.set('root', await readManifest('.'));
    for (const [name, manifest] of manifests) {
      const dependencies = { ...manifest.dependencies, ...manifest.devDependencies };
      expect(dependencies['vite'], name).toBeUndefined();
      expect(dependencies['@sveltejs/vite-plugin-svelte'], name).toBeUndefined();
    }
    const weft = manifests.get('@lostgradient/weft');
    expect(weft?.bin).toEqual({ weft: 'src/cli-main.ts', 'weft-mcp': 'src/cli-mcp.ts' });
  });
  test('component workspaces enforce browser source and separately check Bun tooling', async () => {
    for await (const path of new Bun.Glob('components/*/package.json').scan(root)) {
      const directory = dirname(path);
      const manifest = await readManifest(directory);
      const browserPath = join(root, directory, 'tsconfig.browser.json');
      const loaded = ts.readConfigFile(browserPath, ts.sys.readFile);
      expect(loaded.error, directory).toBeUndefined();
      const browser = ts.parseJsonConfigFileContent(loaded.config, ts.sys, dirname(browserPath));
      expect(browser.errors, directory).toEqual([]);
      expect(browser.options.types, directory).toEqual([]);
      expect(browser.options.lib, directory).toContain('lib.dom.d.ts');
      expect(browser.options.customConditions, directory).toContain('browser');
      expect(browser.options.strict, directory).toBe(true);
      expect(browser.fileNames.length, directory).toBeGreaterThan(0);
      expect(
        browser.fileNames.filter((file) => /\.(?:test|spec)\.ts$|\/scripts\//.test(file)),
        directory,
      ).toEqual([]);
      expect(manifest.scripts?.['typecheck'], directory).toContain(
        '--tsconfig ./tsconfig.browser.json',
      );
      expect(manifest.scripts?.['typecheck'], directory).toContain('--tsconfig ./tsconfig.json');
    }
  });
  test('locked workspace executable metadata matches existing manifest entrypoints', async () => {
    const lock = Bun.JSON5.parse(await Bun.file(join(root, 'bun.lock')).text()) as {
      workspaces: Record<string, Pick<Manifest, 'name' | 'bin'>>;
    };
    const rootManifest = await readManifest('.');
    expect(lock.workspaces['']?.name, 'Root workspace identity').toBe(rootManifest.name);
    const expectedPaths = [''];
    const manifestPaths = (rootManifest.workspaces ?? []).flatMap((pattern) =>
      Array.from(new Bun.Glob(`${pattern}/package.json`).scanSync(root)),
    );
    for (const path of manifestPaths) {
      const directory = dirname(path);
      expectedPaths.push(directory);
      const manifest = await readManifest(directory);
      expect(lock.workspaces[directory]?.name, directory).toBe(manifest.name);
      expect(lock.workspaces[directory]?.bin, directory).toEqual(manifest.bin);
      for (const entrypoint of Object.values(manifest.bin ?? {})) {
        expect(await Bun.file(join(root, directory, entrypoint)).exists(), entrypoint).toBe(true);
      }
    }
    expect(Object.keys(lock.workspaces).toSorted()).toEqual(expectedPaths.toSorted());
  });

  test('workspace source stays versioned despite personal ignore patterns', () => {
    const { initialized, listed } = versionedFixtureSource;
    expect(initialized.exitCode, initialized.stderr.toString()).toBe(0);
    expect(listed.exitCode, listed.stderr.toString()).toBe(0);
    const workspaceFiles = listed.stdout
      .toString()
      .trim()
      .split('\n')
      .filter((path) =>
        ['applications/', 'components/', 'packages/'].some((prefix) => path.startsWith(prefix)),
      );
    expect(workspaceFiles).toEqual([
      'applications/example/src/components/icons/index.test.ts',
      'applications/example/src/components/icons/index.ts',
      'components/example/src/components/icons/index.test.ts',
      'components/example/src/components/icons/index.ts',
      'packages/example/src/components/icons/index.test.ts',
      'packages/example/src/components/icons/index.ts',
    ]);
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

  test('the discovered workspace names are exactly the COR-1284 rule, no more and no fewer', async () => {
    const manifests = await workspaceManifests();
    expect(new Set(manifests.keys())).toEqual(expectedWorkspaceNames);
  });

  for (const library of libraries) {
    test(`${library} exposes source without a build or publication contract`, async () => {
      const directory = `${componentLibraries.includes(library) ? 'components' : 'packages'}/${library}`;
      const manifest = await readManifest(directory);
      expect(manifest.name).toBe(publicWorkspaceName(library));
      expect(manifest.private).toBe(true);
      expect(manifest.type).toBe('module');
      expect(
        sourceExportViolations(manifest.exports, (path) => existsSync(join(root, directory, path))),
        `${library} exports`,
      ).toEqual([]);
      expect(await Bun.file(join(root, directory, 'src/index.ts')).exists()).toBe(true);
      for (const command of ['lint', 'lint:fix', 'test', 'typecheck']) {
        expect(manifest.scripts?.[command], `${library}: ${command}`).toBeString();
      }
      for (const command of Object.keys(manifest.scripts ?? {})) {
        // COR-1351: evaluation's `release-gate` is the local evaluation gate COR-896
        // names. It decides whether evidence clears a gate; it builds, packs,
        // publishes, and releases nothing.
        if (library === 'evaluation' && command === 'release-gate') continue;
        expect(command).not.toMatch(/build|pack|publish|release|prepare|postinstall/);
      }
      expect(manifest.publishConfig).toBeUndefined();
      expect(manifest.main).toBeUndefined();
      expect(manifest.module).toBeUndefined();
      expect(manifest.types).toBeUndefined();
    });
  }

  test('every internal edge resolves and uses workspace:*', async () => {
    // The discriminator between an internal edge and an external dependency can no longer be a
    // scope prefix: COR-1284 made the internal and public names the same string, and the root
    // catalog carries an external @lostgradient/environmentalist alongside them, and armorer and
    // conversationalist are unscoped. Membership in the discovered workspace map is the only
    // discriminator that still distinguishes the two.
    const manifests = await workspaceManifests();
    for (const manifest of manifests.values()) {
      if (!unscopedWorkspaceNames.has(manifest.name)) {
        expect(manifest.name).toStartWith('@lostgradient/');
      }
      expect(manifest.private).toBe(true);
      for (const [name, version] of Object.entries({
        ...manifest.dependencies,
        ...manifest.devDependencies,
        ...manifest.peerDependencies,
      })) {
        if (!manifests.has(name)) continue;
        expect(version, `${manifest.name} -> ${name}`).toBe('workspace:*');
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
        if (manifests.has(dependency)) visit(dependency, [...ancestors, name]);
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
        if (workspaces.has(name)) continue;
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

  // The published Weft build classifies a module as test-only by filename suffix
  // (`sourcePath.endsWith('.test-support.ts')` over `src/**/*.ts`), and the root
  // lint policy keys its test-file override on the same `**/*.test-support.ts`
  // glob. A helper named `thing-test-support.ts` satisfies neither, so it is
  // linted as production source here and compiled into `dist/` downstream — the
  // failure only surfaces when the helper happens to import `bun:test`, which
  // leaves the quieter ones shipping silently. Assert the spelling rather than
  // the one file that was caught, so the whole naming class stays closed.
  test('Weft test-support helpers are named so the published build excludes them', async () => {
    const offenders: string[] = [];
    for await (const path of new Bun.Glob('**/*.ts').scan({
      cwd: join(root, 'packages/weft/src'),
      onlyFiles: true,
    })) {
      const basename = path.split('/').at(-1) ?? path;
      if (!basename.includes('test-support')) continue;
      if (basename.endsWith('.test-support.ts') || basename.endsWith('.test-support.test.ts')) {
        continue;
      }
      offenders.push(`packages/weft/src/${path}`);
    }
    expect(offenders).toEqual([]);
  });
});
