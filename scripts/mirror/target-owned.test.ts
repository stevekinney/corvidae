import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertWritablePaths,
  findExpiredExceptions,
  findTargetOwner,
  loadTargetOwnedPolicy,
  normalizeTargetPath,
  TargetOwnedViolation,
  writeTransformOutput,
} from './target-owned.ts';

const guard = new URL('./target-owned.ts', import.meta.url).pathname;

const licenseNotice = 'MIT License\n\nCopyright (c) 2026 Steve Kinney\n';
const readme = '# weft\n\nPublished from corvidae.\n';

/** Files a target repository owns, seeded into the fixture clone and committed. */
const targetOwned: Record<string, string> = {
  LICENSE: licenseNotice,
  'README.md': '# Weft\n\nTarget-authored front page.\n',
  '.github/workflows/release.yaml': 'name: release\n',
  '.husky/pre-commit': 'bun run validate\n',
  'packages/weft/CHANGELOG.md': '# Changelog\n\n## 0.25.0\n',
};

/** Files the transform emits. The no-op case re-emits exactly these bytes. */
const transformOwned: Record<string, string> = {
  'packages/weft/README.md': readme,
  'packages/weft/LICENSE': licenseNotice,
  'packages/weft/src/index.ts': 'export const version = 1;\n',
};

async function runGit(directory: string, ...arguments_: string[]): Promise<string> {
  const process_ = Bun.spawn(['git', ...arguments_], {
    cwd: directory,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...Bun.env,
      GIT_AUTHOR_NAME: 'Fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'Fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
    },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process_.stdout).text(),
    new Response(process_.stderr).text(),
    process_.exited,
  ]);
  if (exitCode !== 0) throw new Error(`git ${arguments_.join(' ')} failed: ${stderr}`);
  return stdout;
}

/** Stands up a committed fixture target clone holding both target-owned and transform-owned files. */
async function withFixtureTarget(
  body: (directory: string) => Promise<void>,
  extraFiles: Record<string, string> = {},
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'corvidae-mirror-'));
  try {
    await runGit(directory, 'init', '--quiet', '--initial-branch=main');
    for (const [path, contents] of Object.entries({
      ...targetOwned,
      ...transformOwned,
      ...extraFiles,
    })) {
      await Bun.write(join(directory, path), contents);
    }
    await runGit(directory, 'add', '--all');
    await runGit(directory, 'commit', '--quiet', '--message', 'fixture target');
    expect(await runGit(directory, 'status', '--porcelain')).toBe('');
    await body(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe('mirror target-owned enumeration', () => {
  test('the committed enumeration parses, names both targets and carries no expired exception', async () => {
    const policy = await loadTargetOwnedPolicy();
    expect(policy.targets).toEqual(['weft', 'cinder']);
    expect(findExpiredExceptions(policy)).toEqual([]);
    expect(policy.paths.every((entry) => entry.reason.length > 0)).toBe(true);
  });

  test('root and per-package LICENSE are ruled on separately', async () => {
    const policy = await loadTargetOwnedPolicy();
    expect(findTargetOwner(policy, 'LICENSE', 'weft')?.glob).toBe('LICENSE');
    expect(findTargetOwner(policy, 'packages/weft/LICENSE', 'weft')).toBeUndefined();
    expect(findTargetOwner(policy, 'README.md', 'cinder')?.glob).toBe('README.md');
    expect(findTargetOwner(policy, 'packages/components/README.md', 'cinder')).toBeUndefined();
  });

  test('target-scoped entries only bind their own target', async () => {
    const policy = await loadTargetOwnedPolicy();
    expect(findTargetOwner(policy, 'SECURITY.md', 'weft')?.glob).toBe('SECURITY.md');
    expect(findTargetOwner(policy, 'SECURITY.md', 'cinder')).toBeUndefined();
  });

  test('an unknown target is rejected rather than silently permitting every path', async () => {
    const policy = await loadTargetOwnedPolicy();
    expect(() =>
      assertWritablePaths({ policy, target: 'tribunal', paths: ['packages/weft/README.md'] }),
    ).toThrow(/Unknown mirror target/);
  });

  test('paths escaping the target clone are rejected', () => {
    expect(() => normalizeTargetPath('../outside.txt')).toThrow(/escapes the target repository/);
    expect(() => normalizeTargetPath('/etc/passwd')).toThrow(/target-relative/);
    expect(normalizeTargetPath('packages/weft/./src/index.ts')).toBe('packages/weft/src/index.ts');
  });
});

describe('temporary exceptions', () => {
  const base = {
    documentation: 'fixture',
    targets: ['weft'],
    paths: [{ glob: 'LICENSE', reason: 'root license is target-owned' }],
    fields: { policy: 'fixture', entries: [] },
    openQuestions: [],
  };
  const exception = {
    glob: 'packages/weft/reference/**',
    reason: 'held target-owned for the duration of the reference migration',
    issue: 'COR-2000',
    expires: '2026-12-31',
  };
  const policy = { ...base, exceptions: { policy: 'fixture', entries: [exception] } };

  test('an unexpired exception adds to the protected set', () => {
    const now = new Date('2026-09-18T00:00:00Z');
    const match = findTargetOwner(policy, 'packages/weft/reference/api.md', 'weft', now);
    expect(match?.expires).toBe('2026-12-31');
    expect(match?.issue).toBe('COR-2000');
  });

  test('an expired exception fails the guard instead of lapsing into permanence', () => {
    const now = new Date('2027-01-01T00:00:00Z');
    expect(findExpiredExceptions(policy, now)).toEqual([exception]);
    expect(findTargetOwner(policy, 'packages/weft/reference/api.md', 'weft', now)).toBeUndefined();
    expect(() =>
      assertWritablePaths({ policy, target: 'weft', paths: ['packages/weft/src/index.ts'], now }),
    ).toThrow(TargetOwnedViolation);
  });
});

describe('change detection against a fixture target', () => {
  test('a no-op sync leaves git status --porcelain empty', async () => {
    await withFixtureTarget(async (directory) => {
      const policy = await loadTargetOwnedPolicy();
      const written = await writeTransformOutput({
        policy,
        target: 'weft',
        directory,
        files: transformOwned,
      });
      expect(written.toSorted()).toEqual(Object.keys(transformOwned).toSorted());
      expect(await runGit(directory, 'status', '--porcelain')).toBe('');
    });
  });

  test('a real change is still detected, so the empty status above is not vacuous', async () => {
    await withFixtureTarget(async (directory) => {
      const policy = await loadTargetOwnedPolicy();
      await writeTransformOutput({
        policy,
        target: 'weft',
        directory,
        files: { ...transformOwned, 'packages/weft/src/index.ts': 'export const version = 2;\n' },
      });
      expect(await runGit(directory, 'status', '--porcelain')).toContain(
        'packages/weft/src/index.ts',
      );
    });
  });
});

describe('the guard refuses target-owned writes', () => {
  test('the command line guard exits non-zero and leaves the target byte-identical', async () => {
    await withFixtureTarget(async (directory) => {
      const before = await Promise.all(
        Object.keys(targetOwned).map(async (path) => readFile(join(directory, path), 'utf8')),
      );
      const plan = join(directory, '..', `plan-${Bun.randomUUIDv7()}.json`);
      await Bun.write(
        plan,
        JSON.stringify({
          'packages/weft/src/index.ts': 'export const version = 2;\n',
          '.github/workflows/release.yaml': 'name: overwritten\n',
          LICENSE: 'Apache License\n',
        }),
      );
      try {
        const process_ = Bun.spawn(
          ['bun', guard, '--target', 'weft', '--directory', directory, '--plan', plan],
          { stdout: 'pipe', stderr: 'pipe' },
        );
        const [stderr, exitCode] = await Promise.all([
          new Response(process_.stderr).text(),
          process_.exited,
        ]);

        expect(exitCode).not.toBe(0);

        const after = await Promise.all(
          Object.keys(targetOwned).map(async (path) => readFile(join(directory, path), 'utf8')),
        );
        expect(after).toEqual(before);
        expect(await runGit(directory, 'status', '--porcelain')).toBe('');
        expect(stderr).toContain('.github/workflows/release.yaml');
        expect(stderr).toContain('LICENSE');
      } finally {
        await rm(plan, { force: true });
      }
    });
  });

  test('the whole plan is refused, so a permitted file in it is not written either', async () => {
    await withFixtureTarget(async (directory) => {
      const policy = await loadTargetOwnedPolicy();
      await expect(
        writeTransformOutput({
          policy,
          target: 'weft',
          directory,
          files: {
            'packages/weft/src/added.ts': 'export const added = true;\n',
            'packages/weft/CHANGELOG.md': '# Changelog\n\n## 9.9.9\n',
          },
        }),
      ).rejects.toThrow(TargetOwnedViolation);
      expect(await Bun.file(join(directory, 'packages/weft/src/added.ts')).exists()).toBe(false);
      expect(await runGit(directory, 'status', '--porcelain')).toBe('');
    });
  });
});
