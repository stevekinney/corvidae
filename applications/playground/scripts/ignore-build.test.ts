import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { COMPONENT_SOURCES } from '../src/component-sources.ts';
import {
  DISPLAYED_PACKAGES,
  PREVIEW_OPT_IN,
  decide,
  decideFromChanges,
  dependencyClosure,
  readWorkspaces,
} from './ignore-build.ts';

const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
const wrapperPath = join(scriptsDirectory, 'ignore-build.sh');
const vercelConfigPath = join(scriptsDirectory, '..', 'vercel.json');

let repository: string;
let base: string;

function git(...arguments_: string[]): string {
  const result = Bun.spawnSync(['git', ...arguments_], { cwd: repository });
  if (result.exitCode !== 0)
    throw new Error(`git ${arguments_.join(' ')}: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function packageMap(versions: Record<string, string>): string {
  return json({
    workspaces: Object.fromEntries(
      Object.entries(versions).map(([name, version]) => [name, { lastPublishedVersion: version }]),
    ),
  });
}

/**
 * A miniature of the repository's workspace graph. The playground depends on `@fixture/direct`,
 * which depends on `@fixture/transitive`, and has `@fixture/typescript`, which itself depends on
 * `@fixture/build-tool`, as a development dependency. `@fixture/unrelated` and the desktop
 * application are outside the closure.
 */
const FIXTURE_FILES: Record<string, string> = {
  'package.json': json({
    name: 'fixture-root',
    workspaces: ['applications/*', 'packages/*', 'internal/*'],
  }),
  'bun.lock': 'lock\n',
  'tsconfig.json': '{}\n',
  'turbo.json': '{}\n',
  'applications/playground/package.json': json({
    name: '@lostgradient/playground',
    dependencies: { '@fixture/direct': 'workspace:*', svelte: 'catalog:' },
    devDependencies: { '@fixture/typescript': 'workspace:*' },
  }),
  'applications/playground/src/page.ts': 'export {};\n',
  'applications/desktop/package.json': json({ name: '@fixture/desktop' }),
  'applications/desktop/src/main.ts': 'export {};\n',
  'packages/direct/package.json': json({
    name: '@fixture/direct',
    dependencies: { '@fixture/transitive': 'workspace:*' },
  }),
  'packages/direct/src/index.ts': 'export {};\n',
  'packages/transitive/package.json': json({ name: '@fixture/transitive' }),
  'packages/transitive/src/index.ts': 'export {};\n',
  'packages/unrelated/package.json': json({ name: '@fixture/unrelated' }),
  'packages/unrelated/src/index.ts': 'export {};\n',
  'packages/build-tool/package.json': json({ name: '@fixture/build-tool' }),
  'packages/build-tool/src/index.ts': 'export {};\n',
  'internal/typescript/package.json': json({
    name: '@fixture/typescript',
    dependencies: { '@fixture/build-tool': 'workspace:*' },
  }),
  'internal/typescript/base.json': '{}\n',
  'scripts/mirror/package-map.json': packageMap({
    '@lostgradient/cinder': '1.0.0',
    '@fixture/direct': '1.0.0',
    '@fixture/unrelated': '1.0.0',
  }),
  'scripts/mirror/sync.ts': 'export {};\n',
};

async function commitWriting(files: Record<string, string>): Promise<string> {
  git('checkout', '--quiet', '--detach', base);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(repository, path)), { recursive: true });
    await writeFile(join(repository, path), content);
  }
  git('add', '--all');
  git('commit', '--quiet', '--allow-empty', '-m', `write ${Object.keys(files).join(', ')}`);
  return git('rev-parse', 'HEAD');
}

/** Exit code of the wrapper, run from the application directory as Vercel runs it. */
function wrapperExit(environment: Record<string, string | undefined>, path?: string): number {
  const merged: Record<string, string> = {};
  for (const [key, value] of Object.entries({ ...process.env, ...environment })) {
    if (value !== undefined) merged[key] = value;
  }
  if (path !== undefined) merged['PATH'] = path;
  const result = Bun.spawnSync(['/bin/sh', wrapperPath], {
    cwd: join(repository, 'applications/playground'),
    env: merged,
  });
  return result.exitCode;
}

function productionExit(previous: string | undefined, current: string): number {
  return wrapperExit({
    VERCEL_ENV: 'production',
    VERCEL_GIT_PREVIOUS_SHA: previous,
    VERCEL_GIT_COMMIT_SHA: current,
  });
}

beforeAll(async () => {
  repository = await mkdtemp(join(tmpdir(), 'playground-ignore-build-'));
  git('init', '--quiet');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'test');
  for (const [path, content] of Object.entries(FIXTURE_FILES)) {
    await mkdir(dirname(join(repository, path)), { recursive: true });
    await writeFile(join(repository, path), content);
  }
  git('add', '--all');
  git('commit', '--quiet', '-m', 'base');
  base = git('rev-parse', 'HEAD');
});

afterAll(async () => {
  await rm(repository, { recursive: true, force: true });
});

describe('dependencyClosure', () => {
  test('reaches every workspace the playground depends on, through development dependencies too', () => {
    const closure = dependencyClosure(readWorkspaces(repository), '@lostgradient/playground');
    expect(closure.map((workspace) => workspace.directory)).toEqual([
      'applications/playground',
      'internal/typescript',
      'packages/build-tool',
      'packages/direct',
      'packages/transitive',
    ]);
  });

  test('matches the workspaces the real playground imports', () => {
    const repositoryRoot = join(scriptsDirectory, '..', '..', '..');
    const closure = dependencyClosure(readWorkspaces(repositoryRoot), '@lostgradient/playground');
    expect(closure.map((workspace) => workspace.directory)).toEqual([
      'applications/playground',
      'components/chat',
      'components/cinder',
      'components/editor',
      'internal/typescript',
      'packages/conversationalist',
      'packages/lifecycle',
      'packages/markdown',
      'packages/testing',
      'packages/tool-protocol',
    ]);
  });
});

describe('production deployments', () => {
  test.each([
    ['applications/playground/src/page.ts', 1],
    ['packages/direct/src/index.ts', 1],
    ['packages/transitive/src/index.ts', 1],
    ['internal/typescript/base.json', 1],
    ['bun.lock', 1],
    ['package.json', 1],
    ['tsconfig.json', 1],
    ['packages/unrelated/src/index.ts', 0],
    ['packages/build-tool/src/index.ts', 1],
    ['packages/direct/src/test-helpers.ts', 1],
    ['packages/direct/src/index.test.ts', 0],
    ['packages/direct/src/harness.test.svelte', 0],
    ['packages/direct/src/load.bench.ts', 0],
    ['applications/playground/src/page.spec.ts', 0],
    ['applications/playground/tests/shell.playwright.ts', 0],
    ['applications/playground/playwright.config.ts', 0],
    ['applications/desktop/src/main.ts', 0],
    ['scripts/mirror/sync.ts', 0],
    ['turbo.json', 0],
  ])('a commit changing only %s exits %i', async (path, expected) => {
    const changed =
      path === 'package.json'
        ? json({
            name: 'fixture-root',
            workspaces: ['applications/*', 'packages/*', 'internal/*'],
            private: true,
          })
        : `changed ${path}\n`;
    const head = await commitWriting({ [path]: changed });
    expect(productionExit(base, head)).toBe(expected);
  });

  test('builds when the package map records a new published version the documentation displays', async () => {
    const head = await commitWriting({
      'scripts/mirror/package-map.json': packageMap({
        '@lostgradient/cinder': '1.1.0',
        '@fixture/direct': '1.0.0',
        '@fixture/unrelated': '1.0.0',
      }),
    });
    expect(productionExit(base, head)).toBe(1);
  });

  test('skips when the package map changes only versions the documentation does not display', async () => {
    const head = await commitWriting({
      'scripts/mirror/package-map.json': packageMap({
        '@lostgradient/cinder': '1.0.0',
        '@fixture/direct': '1.1.0',
        '@fixture/unrelated': '2.0.0',
      }),
    });
    expect(productionExit(base, head)).toBe(0);
  });

  test('watches the published versions of exactly the packages the playground documents', () => {
    const displayed: readonly string[] = DISPLAYED_PACKAGES;
    expect(displayed.toSorted()).toEqual(
      COMPONENT_SOURCES.map((source) => source.packageName).toSorted(),
    );
  });

  test('builds when the package map cannot be parsed', async () => {
    const head = await commitWriting({ 'scripts/mirror/package-map.json': '{ not json' });
    expect(productionExit(base, head)).toBe(1);
  });

  test('builds when the workspace graph cannot be read', async () => {
    const head = await commitWriting({ 'package.json': '{ not json' });
    // The root manifest is itself a root input, so read the graph failure through the API too.
    expect(productionExit(base, head)).toBe(1);
    expect(
      decide('production', undefined, () => {
        throw new Error('unreadable workspace graph');
      }),
    ).toEqual({ build: true, reason: 'the change check failed: unreadable workspace graph' });
  });

  test('builds when there is no previous deployment to compare against', () => {
    expect(productionExit(undefined, base)).toBe(1);
  });

  // Vercel sets the previous SHA to the branch's last successful deployment. A force-push after
  // an amend or rebase orphans that commit, and a branch can also fall further behind than the
  // shallow clone reaches; either way the object is absent from the clone.
  test('builds when the previous deployment commit is not in the clone', () => {
    expect(productionExit('deadbeef'.repeat(5), base)).toBe(1);
  });

  test('builds whenever the comparison itself fails', () => {
    expect(productionExit(base, 'deadbeef'.repeat(5))).toBe(1);
  });
});

describe('preview deployments', () => {
  test('skip even when the export would change', async () => {
    const head = await commitWriting({ 'applications/playground/src/page.ts': 'changed\n' });
    expect(
      wrapperExit({
        VERCEL_ENV: 'preview',
        VERCEL_GIT_PREVIOUS_SHA: base,
        VERCEL_GIT_COMMIT_SHA: head,
        VERCEL_GIT_COMMIT_MESSAGE: 'Change a page',
      }),
    ).toBe(0);
  });

  test(`build when the commit subject contains ${PREVIEW_OPT_IN}`, async () => {
    const head = await commitWriting({ 'scripts/mirror/sync.ts': 'changed\n' });
    expect(
      wrapperExit({
        VERCEL_ENV: 'preview',
        VERCEL_GIT_PREVIOUS_SHA: base,
        VERCEL_GIT_COMMIT_SHA: head,
        VERCEL_GIT_COMMIT_MESSAGE: `Check the new layout ${PREVIEW_OPT_IN}\n\nDetails.`,
      }),
    ).toBe(1);
  });

  test('skip when only the commit body mentions the opt-in', async () => {
    const head = await commitWriting({ 'applications/playground/src/page.ts': 'changed\n' });
    expect(
      wrapperExit({
        VERCEL_ENV: 'preview',
        VERCEL_GIT_PREVIOUS_SHA: base,
        VERCEL_GIT_COMMIT_SHA: head,
        VERCEL_GIT_COMMIT_MESSAGE: `Describe previews\n\nThey build only with ${PREVIEW_OPT_IN}.`,
      }),
    ).toBe(0);
  });
});

describe('decideFromChanges', () => {
  const closure = dependencyClosure(
    [
      { name: '@lostgradient/playground', directory: 'applications/playground', manifest: {} },
      { name: '@fixture/other', directory: 'packages/other', manifest: {} },
    ],
    '@lostgradient/playground',
  );

  test('does not mistake a sibling directory sharing a prefix for a closure workspace', () => {
    const decision = decideFromChanges({
      changedFiles: ['applications/playground-legacy/index.ts'],
      closure,
      readPackageMaps: () => {
        throw new Error('the package map did not change');
      },
    });
    expect(decision.build).toBe(false);
  });
});

describe('ignore-build.sh', () => {
  test('builds when Bun is not on the PATH', async () => {
    const head = await commitWriting({ 'scripts/mirror/sync.ts': 'changed again\n' });
    const systemPath = '/usr/bin:/bin';
    // The premise: Bun is not installed in the system directories, as on a bare build image.
    expect(Bun.which('bun', { PATH: systemPath })).toBeNull();
    expect(
      wrapperExit(
        { VERCEL_ENV: 'production', VERCEL_GIT_PREVIOUS_SHA: base, VERCEL_GIT_COMMIT_SHA: head },
        systemPath,
      ),
    ).toBe(1);
  });

  test('builds when the decision script fails with any exit code other than 0', async () => {
    const head = await commitWriting({ 'scripts/mirror/sync.ts': 'changed once more\n' });
    const stubBin = await mkdtemp(join(tmpdir(), 'ignore-build-stub-bin-'));
    try {
      await writeFile(join(stubBin, 'bun'), '#!/bin/sh\nexit 3\n');
      await chmod(join(stubBin, 'bun'), 0o755);
      expect(
        wrapperExit(
          { VERCEL_ENV: 'production', VERCEL_GIT_PREVIOUS_SHA: base, VERCEL_GIT_COMMIT_SHA: head },
          `${stubBin}:/usr/bin:/bin`,
        ),
      ).toBe(1);
    } finally {
      await rm(stubBin, { recursive: true, force: true });
    }
  });

  test('is what vercel.json runs, within the 256-character limit Vercel enforces', async () => {
    const config = JSON.parse(await readFile(vercelConfigPath, 'utf8')) as Record<string, unknown>;
    for (const key of ['installCommand', 'buildCommand', 'ignoreCommand']) {
      expect(String(config[key]).length).toBeLessThanOrEqual(256);
    }
    expect(config['ignoreCommand']).toBe('sh scripts/ignore-build.sh');
  });
});
