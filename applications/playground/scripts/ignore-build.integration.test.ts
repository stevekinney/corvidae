import { runWithHangGuard } from '@lostgradient/testing/hang-guard';
import { afterAll, describe, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PREVIEW_OPT_IN,
  decide,
  decideFromChanges,
  dependencyClosure,
  readWorkspaces,
} from './ignore-build.ts';

const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
const wrapperPath = join(scriptsDirectory, 'ignore-build.sh');
const vercelConfigPath = join(scriptsDirectory, '..', 'vercel.json');
const absentCommit = 'deadbeef'.repeat(5);

const repository = await mkdtemp(join(tmpdir(), 'playground-ignore-build-'));
afterAll(async () => {
  await rm(repository, { recursive: true, force: true });
});

async function git(...arguments_: string[]): Promise<string> {
  const result = await runWithHangGuard(['git', ...arguments_], { cwd: repository });
  if (result.exitCode !== 0)
    throw new Error(`git ${arguments_.join(' ')}: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

const ROOT_MANIFEST = {
  name: 'fixture-root',
  workspaces: ['applications/*', 'packages/*', 'internal/*'],
};

/**
 * A miniature of the repository's workspace graph. The playground depends on `@fixture/direct`,
 * which depends on `@fixture/transitive`, and has `@fixture/typescript`, which itself depends on
 * `@fixture/build-tool`, as a development dependency. `@fixture/unrelated` and the example
 * application are outside the closure.
 */
const FIXTURE_FILES: Record<string, string> = {
  'package.json': json(ROOT_MANIFEST),
  'bun.lock': 'lock\n',
  'tsconfig.json': '{}\n',
  'turbo.json': '{}\n',
  'applications/playground/package.json': json({
    name: '@lostgradient/playground',
    dependencies: { '@fixture/direct': 'workspace:*', svelte: 'catalog:' },
    devDependencies: { '@fixture/typescript': 'workspace:*' },
  }),
  'applications/playground/src/page.ts': 'export {};\n',
  'applications/example/package.json': json({ name: '@fixture/example' }),
  'applications/example/src/main.ts': 'export {};\n',
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
  'applications/playground/published-versions.json': json({
    lastPublishedVersions: { '@lostgradient/cinder': '1.0.0' },
  }),
  'scripts/outside-the-closure.ts': 'export {};\n',
};

async function writeFiles(files: Record<string, string>): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(repository, path)), { recursive: true });
    await writeFile(join(repository, path), content);
  }
}

async function commitBase(): Promise<string> {
  await git('init', '--quiet');
  await git('config', 'user.email', 'test@example.invalid');
  await git('config', 'user.name', 'test');
  await writeFiles(FIXTURE_FILES);
  await git('add', '--all');
  await git('commit', '--quiet', '-m', 'base');
  return await git('rev-parse', 'HEAD');
}

async function commitWriting(files: Record<string, string>): Promise<string> {
  await git('checkout', '--quiet', '--detach', base);
  await writeFiles(files);
  await git('add', '--all');
  await git('commit', '--quiet', '--allow-empty', '-m', `write ${Object.keys(files).join(', ')}`);
  return await git('rev-parse', 'HEAD');
}

async function commitRenaming(from: string, to: string): Promise<string> {
  await git('checkout', '--quiet', '--detach', base);
  await mkdir(dirname(join(repository, to)), { recursive: true });
  await git('mv', from, to);
  await git('commit', '--quiet', '-m', `move ${from} to ${to}`);
  return await git('rev-parse', 'HEAD');
}

/** Exit code of the wrapper, run from the application directory as Vercel runs it. */
async function wrapperExit(
  environment: Record<string, string | undefined>,
  path?: string,
): Promise<number | null> {
  const merged: Record<string, string> = {};
  for (const [key, value] of Object.entries({ ...process.env, ...environment })) {
    if (value !== undefined) merged[key] = value;
  }
  if (path !== undefined) merged['PATH'] = path;
  const result = await runWithHangGuard(['/bin/sh', wrapperPath], {
    cwd: join(repository, 'applications/playground'),
    env: merged,
  });
  return result.exitCode;
}

async function productionExit(
  previous: string | undefined,
  current: string,
  path?: string,
): Promise<number | null> {
  return wrapperExit(
    { VERCEL_ENV: 'production', VERCEL_GIT_PREVIOUS_SHA: previous, VERCEL_GIT_COMMIT_SHA: current },
    path,
  );
}

function previewExit(current: string, commitMessage: string): Promise<number | null> {
  return wrapperExit({
    VERCEL_ENV: 'preview',
    VERCEL_GIT_PREVIOUS_SHA: base,
    VERCEL_GIT_COMMIT_SHA: current,
    VERCEL_GIT_COMMIT_MESSAGE: commitMessage,
  });
}

/*
 * Every git commit and every run of the ignore step happens here, at module scope: each is a real
 * process, and running them inside the tests put each one on Bun's five-second per-test clock.
 * The tests below assert on the exit codes recorded here.
 */
const base = await commitBase();

const touchedPathCases = [
  ['applications/playground/src/page.ts', 1],
  ['applications/playground/published-versions.json', 1],
  ['packages/direct/src/index.ts', 1],
  ['packages/transitive/src/index.ts', 1],
  ['internal/typescript/base.json', 1],
  ['packages/build-tool/src/index.ts', 1],
  ['packages/direct/src/test-helpers.ts', 1],
  ['bun.lock', 1],
  ['tsconfig.json', 1],
  ['packages/direct/src/index.test.ts', 0],
  ['packages/direct/src/harness.test.svelte', 0],
  ['packages/direct/src/load.bench.ts', 0],
  ['applications/playground/src/page.spec.ts', 0],
  ['applications/playground/tests/shell.playwright.ts', 0],
  ['applications/playground/playwright.config.ts', 0],
  ['packages/unrelated/src/index.ts', 0],
  ['applications/example/src/main.ts', 0],
  ['scripts/outside-the-closure.ts', 0],
  ['turbo.json', 0],
] as const;
const touchedPathExits = new Map<string, number | null>();
for (const [path] of touchedPathCases) {
  touchedPathExits.set(
    path,
    await productionExit(base, await commitWriting({ [path]: `changed ${path}\n` })),
  );
}

const rootManifestExit = await productionExit(
  base,
  await commitWriting({ 'package.json': json({ ...ROOT_MANIFEST, private: true }) }),
);
const unparsableRootManifestExit = await productionExit(
  base,
  await commitWriting({ 'package.json': '{ not json' }),
);
// Git's rename detection would list only the destination of a file moved out of the closure.
const renamedOutOfClosureExit = await productionExit(
  base,
  await commitRenaming('packages/direct/src/index.ts', 'packages/unrelated/src/moved.ts'),
);
const exitWithoutPreviousDeployment = await productionExit(undefined, base);
const exitWithAbsentPreviousDeployment = await productionExit(absentCommit, base);
const exitWithAbsentCurrentCommit = await productionExit(base, absentCommit);

const pageChange = await commitWriting({ 'applications/playground/src/page.ts': 'changed\n' });
const unrelatedChange = await commitWriting({ 'scripts/outside-the-closure.ts': 'changed\n' });
const previewWithoutOptInExit = await previewExit(pageChange, 'Change a page');
const previewSubjectOptInExit = await previewExit(
  unrelatedChange,
  `Check the new layout ${PREVIEW_OPT_IN}\n\nDetails.`,
);
const previewBodyOnlyOptInExit = await previewExit(
  pageChange,
  `Describe previews\n\nThey build only with ${PREVIEW_OPT_IN}.`,
);

// A bare build image: the system directories, which hold no Bun.
const systemPath = '/usr/bin:/bin';
const bunInSystemPath = Bun.which('bun', { PATH: systemPath });
const missingBunExit = await productionExit(base, unrelatedChange, systemPath);

const stubBin = await mkdtemp(join(tmpdir(), 'ignore-build-stub-bin-'));
afterAll(async () => {
  await rm(stubBin, { recursive: true, force: true });
});
await writeFile(join(stubBin, 'bun'), '#!/bin/sh\nexit 3\n');
await chmod(join(stubBin, 'bun'), 0o755);
const failingScriptExit = await productionExit(base, unrelatedChange, `${stubBin}:${systemPath}`);

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
      'packages/armorer',
      'packages/conversationalist',
      'packages/cryptography',
      'packages/lifecycle',
      'packages/markdown',
      'testing/testing',
    ]);
  });
});

describe('production deployments', () => {
  test.each(touchedPathCases)('a commit changing only %s exits %i', (path, expected) => {
    expect(touchedPathExits.get(path)).toBe(expected);
  });

  test('builds when the root manifest changes', () => {
    expect(rootManifestExit).toBe(1);
  });

  test('builds when the workspace graph cannot be read', () => {
    expect(unparsableRootManifestExit).toBe(1);
    expect(
      decide('production', undefined, () => {
        throw new Error('unreadable workspace graph');
      }),
    ).toEqual({ build: true, reason: 'the change check failed: unreadable workspace graph' });
  });

  test('builds when a file moves out of the closure, which the deployed site loses', () => {
    expect(renamedOutOfClosureExit).toBe(1);
  });

  test('builds when there is no previous deployment to compare against', () => {
    expect(exitWithoutPreviousDeployment).toBe(1);
  });

  // Vercel sets the previous SHA to the branch's last successful deployment. A force-push after
  // an amend or rebase orphans that commit, and a branch can also fall further behind than the
  // shallow clone reaches; either way the object is absent from the clone.
  test('builds when the previous deployment commit is not in the clone', () => {
    expect(exitWithAbsentPreviousDeployment).toBe(1);
  });

  test('builds whenever the comparison itself fails', () => {
    expect(exitWithAbsentCurrentCommit).toBe(1);
  });
});

describe('preview deployments', () => {
  test('skip even when the export would change', () => {
    expect(previewWithoutOptInExit).toBe(0);
  });

  test(`build when the commit subject contains ${PREVIEW_OPT_IN}`, () => {
    expect(previewSubjectOptInExit).toBe(1);
  });

  test('skip when only the commit body mentions the opt-in', () => {
    expect(previewBodyOnlyOptInExit).toBe(0);
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
    });
    expect(decision.build).toBe(false);
  });

  // The file is new on the first deployment after a version is recorded, and edited afterwards:
  // both are a change to a playground source file, so neither needs a rule of its own.
  test('builds when the published versions file is added or edited', () => {
    const decision = decideFromChanges({
      changedFiles: ['applications/playground/published-versions.json'],
      closure,
    });
    expect(decision.build).toBe(true);
  });
});

describe('ignore-build.sh', () => {
  test('builds when Bun is not on the PATH', () => {
    // The premise: Bun is not installed in the system directories, as on a bare build image.
    expect(bunInSystemPath).toBeNull();
    expect(missingBunExit).toBe(1);
  });

  test('builds when the decision script fails with any exit code other than 0', () => {
    expect(failingScriptExit).toBe(1);
  });

  test('is what vercel.json runs, within the 256-character limit Vercel enforces', async () => {
    const config = JSON.parse(await readFile(vercelConfigPath, 'utf8')) as Record<string, unknown>;
    for (const key of ['installCommand', 'buildCommand', 'ignoreCommand']) {
      expect(String(config[key]).length).toBeLessThanOrEqual(256);
    }
    expect(config['ignoreCommand']).toBe('sh scripts/ignore-build.sh');
  });
});
