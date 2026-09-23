import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mirrorTargets } from './manifests.ts';
import {
  assertNoEmissionsIntoRetired,
  assertRetirementsCoherent,
  assertWritablePaths,
  collectRetiredPaths,
  findExpiredExceptions,
  findTargetOwner,
  loadTargetOwnedPolicy,
  normalizeTargetPath,
  retiredDirectoriesFor,
  RetirementCollisionError,
  RetirementError,
  type TargetOwnedPolicy,
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
  test('the committed enumeration parses, names every target and carries no expired exception', async () => {
    const policy = await loadTargetOwnedPolicy();
    expect(policy.targets).toEqual(['weft', 'cinder', 'agent-bureau']);
    // The enumeration's own `targets` list and the transform's are the same set or the guard is
    // scoped to a repository the transform never plans, which no entry's `targets` would reveal.
    expect(policy.targets.toSorted()).toEqual([...mirrorTargets].toSorted());
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

  test('the narrowed .github/** enumeration still protects each target release workflow, but never refuses the transform-emitted mirror-verify.yaml', async () => {
    const policy = await loadTargetOwnedPolicy();
    for (const target of ['weft', 'cinder'] as const) {
      expect(findTargetOwner(policy, '.github/workflows/release.yaml', target)?.glob).toBe(
        '.github/workflows/release.yaml',
      );
      // COR-1286's own requirement: the plan for a target includes this path among its files, so
      // the guard must let the transform write it.
      expect(
        findTargetOwner(policy, '.github/workflows/mirror-verify.yaml', target),
      ).toBeUndefined();
    }
    expect(findTargetOwner(policy, '.github/workflows/pr-title.yaml', 'weft')?.glob).toBe(
      '.github/workflows/pr-title.yaml',
    );
    expect(findTargetOwner(policy, '.github/workflows/pr-title.yaml', 'cinder')).toBeUndefined();
    expect(findTargetOwner(policy, '.github/workflows/release-manual.yaml', 'cinder')?.glob).toBe(
      '.github/workflows/release-manual.yaml',
    );
    expect(
      findTargetOwner(policy, '.github/workflows/deploy-playground.yaml', 'cinder')?.glob,
    ).toBe('.github/workflows/deploy-playground.yaml');
    // The two retired workflow files are no longer target-owned at all — they are deleted by
    // `retired`, not preserved by `paths`. Both guards agree they are not writable/preservable the
    // same way, which is why `assertRetirementsCoherent` does not refuse them as a collision.
    expect(findTargetOwner(policy, '.github/workflows/ci.yaml', 'weft')).toBeUndefined();
    expect(findTargetOwner(policy, '.github/workflows/verify-jsdoc.yaml', 'weft')).toBeUndefined();
  });

  test('weft’s surviving release and packaging scripts are the target’s own, and the emitted generator files are not', async () => {
    const policy = await loadTargetOwnedPolicy();
    for (const file of [
      'verify-tree-shaking.ts',
      'verify-release-version.ts',
      'pr-title.ts',
      'validate-package-consumers.ts',
    ]) {
      expect(findTargetOwner(policy, `packages/weft/scripts/${file}`, 'weft')?.glob).toBe(
        `packages/weft/scripts/${file}`,
      );
    }
    expect(
      findTargetOwner(policy, 'packages/weft/scripts/generate-operation-client.ts', 'weft'),
    ).toBeUndefined();
    expect(
      findTargetOwner(policy, 'packages/weft/scripts/operation-client-schema.ts', 'weft'),
    ).toBeUndefined();
  });

  test('weft’s gate scripts are retired, and the scripts the release and pr-title still call are not', async () => {
    const policy = await loadTargetOwnedPolicy();
    const retired = retiredDirectoriesFor(policy, 'weft');
    for (const file of [
      'check-lint-disables.ts',
      'check-coverage.ts',
      'check-coverage.test.ts',
      'extract-markdown-doctests.ts',
      'markdown-doctest-skip-counts.json',
      'run-gates.ts',
      'verify-jsdoc-doctests.ts',
    ]) {
      expect(retired, file).toContain(`packages/weft/scripts/${file}`);
    }
    for (const file of [
      'build.ts',
      'pr-title.ts',
      'verify-release-version.ts',
      'verify-tree-shaking.ts',
    ]) {
      expect(retired, file).not.toContain(`packages/weft/scripts/${file}`);
    }
  });

  test('.husky/** stays target-owned for cinder alone; packages/weft/scripts/husky/** is no longer a paths entry at all', async () => {
    const policy = await loadTargetOwnedPolicy();
    expect(findTargetOwner(policy, '.husky/pre-commit', 'cinder')?.glob).toBe('.husky/**');
    expect(findTargetOwner(policy, '.husky/pre-commit', 'weft')).toBeUndefined();
    expect(
      findTargetOwner(policy, 'packages/weft/scripts/husky/verify-hooks-installed.ts', 'weft'),
    ).toBeUndefined();
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
    retired: { policy: 'fixture', entries: [] },
    insideFiles: {
      policy: 'fixture',
      manifestKeys: [{ key: 'name', reason: 'fixture' }],
      manifestDefaults: [{ key: 'engines', reason: 'fixture' }],
      dependencies: { policy: 'fixture' },
      typeScriptTargetOwnedPolicy: 'fixture',
      typeScriptTargetOwned: [{ key: 'include', reason: 'fixture' }],
    },
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
      const { written } = await writeTransformOutput({
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

describe('the guard refuses target-owned deletions', () => {
  test('a plan that would delete a target-owned path is refused whole', async () => {
    await withFixtureTarget(async (directory) => {
      const policy = await loadTargetOwnedPolicy();
      let thrown: unknown;
      try {
        await writeTransformOutput({
          policy,
          target: 'weft',
          directory,
          files: { 'packages/weft/src/added.ts': 'export const added = true;\n' },
          deletions: ['packages/weft/src/index.ts', 'packages/weft/CHANGELOG.md'],
        });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(TargetOwnedViolation);
      expect((thrown as TargetOwnedViolation).action).toBe('delete');
      expect((thrown as Error).message).toContain('must not delete');
      expect((thrown as Error).message).toContain('packages/weft/CHANGELOG.md');
      // Whole-plan-before-acting, the same property the write side has: the permitted write in
      // the plan did not happen, the permitted deletion did not happen, and the target is
      // byte-identical to what it was.
      expect(await Bun.file(join(directory, 'packages/weft/src/added.ts')).exists()).toBe(false);
      expect(await Bun.file(join(directory, 'packages/weft/src/index.ts')).exists()).toBe(true);
      expect(await runGit(directory, 'status', '--porcelain')).toBe('');
    });
  });

  test('a deletion the enumeration does not hold is carried out and reported', async () => {
    await withFixtureTarget(
      async (directory) => {
        const policy = await loadTargetOwnedPolicy();
        const { deleted } = await writeTransformOutput({
          policy,
          target: 'weft',
          directory,
          files: transformOwned,
          deletions: ['packages/weft/src/retired.ts'],
        });
        expect(deleted).toEqual(['packages/weft/src/retired.ts']);
        expect(await Bun.file(join(directory, 'packages/weft/src/retired.ts')).exists()).toBe(
          false,
        );
        expect(await runGit(directory, 'status', '--porcelain')).toContain(
          'packages/weft/src/retired.ts',
        );
      },
      { 'packages/weft/src/retired.ts': 'export const retired = true;\n' },
    );
  });

  test('the command line guard writes a base64 plan entry as bytes', async () => {
    // JSON has no byte string, so a binary plan entry names its encoding. The in-process plan
    // type is `string | Uint8Array`; this is that union surviving a round trip through a file,
    // which is what a source tree holding a PNG fixture needs.
    await withFixtureTarget(async (directory) => {
      const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
      const plan = join(directory, '..', `plan-${Bun.randomUUIDv7()}.json`);
      await Bun.write(
        plan,
        JSON.stringify({
          'packages/weft/src/fixtures/baseline.png': {
            base64: Buffer.from(bytes).toString('base64'),
          },
          'packages/weft/src/index.ts': 'export const version = 1;\n',
        }),
      );
      try {
        const process_ = Bun.spawn(
          ['bun', guard, '--target', 'weft', '--directory', directory, '--plan', plan],
          { stdout: 'pipe', stderr: 'pipe' },
        );
        expect(await process_.exited).toBe(0);
        const written = new Uint8Array(
          await Bun.file(join(directory, 'packages/weft/src/fixtures/baseline.png')).arrayBuffer(),
        );
        expect(written).toEqual(bytes);
      } finally {
        await rm(plan, { force: true });
      }
    });
  });

  test('a written file keeps the executable bit the plan records for it', async () => {
    await withFixtureTarget(async (directory) => {
      const policy = await loadTargetOwnedPolicy();
      await writeTransformOutput({
        policy,
        target: 'weft',
        directory,
        files: {
          'packages/weft/src/cli-main.ts': '#!/usr/bin/env bun\nexport const main = true;\n',
          'packages/weft/src/library.ts': 'export const library = true;\n',
        },
        executable: ['packages/weft/src/cli-main.ts'],
      });
      const executable = await stat(join(directory, 'packages/weft/src/cli-main.ts'));
      const plain = await stat(join(directory, 'packages/weft/src/library.ts'));
      expect(executable.mode & 0o111).not.toBe(0);
      expect(plain.mode & 0o111).toBe(0);
    });
  });
});

describe('retiring a directory the target still carries', () => {
  /** A minimal policy whose only ruling is that the root LICENSE belongs to the target. */
  function policyFor(entries: TargetOwnedPolicy['retired']['entries']): TargetOwnedPolicy {
    return {
      documentation: 'fixture',
      targets: ['weft', 'cinder'],
      paths: [
        { glob: 'LICENSE', reason: 'root license is target-owned' },
        { glob: '**/.gitignore', reason: 'ignore rules are decided downstream' },
      ],
      retired: { policy: 'fixture', entries },
      insideFiles: {
        policy: 'fixture',
        manifestKeys: [{ key: 'name', reason: 'fixture' }],
        manifestDefaults: [{ key: 'engines', reason: 'fixture' }],
        dependencies: { policy: 'fixture' },
        typeScriptTargetOwnedPolicy: 'fixture',
        typeScriptTargetOwned: [{ key: 'include', reason: 'fixture' }],
      },
      exceptions: { policy: 'fixture', entries: [] },
      openQuestions: [],
    };
  }

  const retirement = {
    directory: 'packages/retired-ui',
    target: 'weft',
    reason: 'the monorepo is its home and the target copy has drifted',
    issue: 'COR-2001',
  } as const;

  test('a directory nobody enumerated is refused rather than deleted', async () => {
    await withFixtureTarget(
      async (directory) => {
        const policy = policyFor([retirement]);
        // The one property that matters: the refusal turns on the enumeration, not on what the
        // plan happens to emit. `packages/unlisted` is a real directory in the clone, the plan
        // emits nothing for it, and it is still not deletable.
        await expect(
          collectRetiredPaths({
            policy,
            target: 'weft',
            directory,
            directories: ['packages/unlisted'],
          }),
        ).rejects.toThrow(RetirementError);
        await expect(
          collectRetiredPaths({
            policy,
            target: 'weft',
            directory,
            directories: ['packages/unlisted'],
          }),
        ).rejects.toThrow(/no entry in target-owned.json's `retired` section names it/);
        expect(await Bun.file(join(directory, 'packages/unlisted/src/keep.ts')).exists()).toBe(
          true,
        );
      },
      { 'packages/unlisted/src/keep.ts': 'export const keep = true;\n' },
    );
  });

  test('an entry scoped to one target does not retire the same directory from the other', async () => {
    const policy = policyFor([retirement]);
    expect(retiredDirectoriesFor(policy, 'weft')).toEqual(['packages/retired-ui']);
    expect(retiredDirectoriesFor(policy, 'cinder')).toEqual([]);
  });

  test('a retirement holding a target-owned file is refused, naming both rulings', async () => {
    await withFixtureTarget(
      async (directory) => {
        const policy = policyFor([retirement]);
        let thrown: unknown;
        try {
          await collectRetiredPaths({
            policy,
            target: 'weft',
            directory,
            directories: retiredDirectoriesFor(policy, 'weft'),
          });
        } catch (error) {
          thrown = error;
        }

        expect(thrown).toBeInstanceOf(RetirementCollisionError);
        const collision = thrown as RetirementCollisionError;
        expect(collision.entry.issue).toBe('COR-2001');
        expect(collision.matches.map((match) => match.path)).toEqual([
          'packages/retired-ui/.gitignore',
        ]);
        expect(collision.message).toContain('packages/retired-ui/.gitignore matches **/.gitignore');
        expect(collision.message).toContain('Refusing to retire packages/retired-ui from weft');
        // Refused whole, exactly as a deletion plan is: the sibling that is not target-owned is
        // still there, because a retirement is all-or-nothing and picking a subset would be the
        // precedence rule this refuses to have.
        expect(await Bun.file(join(directory, 'packages/retired-ui/src/app.ts')).exists()).toBe(
          true,
        );
        expect(await runGit(directory, 'status', '--porcelain')).toBe('');
      },
      {
        'packages/retired-ui/.gitignore': 'dist\n',
        'packages/retired-ui/src/app.ts': 'export const app = true;\n',
      },
    );
  });

  test('a clean retirement collects every file, including ones the source walk skips', async () => {
    await withFixtureTarget(
      async (directory) => {
        const policy = policyFor([retirement]);
        const paths = await collectRetiredPaths({
          policy,
          target: 'weft',
          directory,
          directories: retiredDirectoriesFor(policy, 'weft'),
        });
        // `README.md`, the PNG and the dotfile are all here. The source walk that feeds the
        // ordinary prune filters to source files and drops repository-operating names; reusing it
        // would have turned the collision above into a silent partial deletion.
        expect(paths).toEqual([
          'packages/retired-ui/.npmrc',
          'packages/retired-ui/README.md',
          'packages/retired-ui/src/app.ts',
          'packages/retired-ui/static/logo.png',
        ]);

        const { deleted } = await writeTransformOutput({
          policy,
          target: 'weft',
          directory,
          files: {},
          deletions: paths,
        });
        expect(deleted).toEqual(paths);
        expect(await Bun.file(join(directory, 'packages/retired-ui/src/app.ts')).exists()).toBe(
          false,
        );
        // Unstaged deletions, which is what `runSync` then stages with `git add --all` — the flag
        // that commit path already documents as load-bearing for removals.
        const porcelain = await runGit(directory, 'status', '--porcelain');
        expect(porcelain.split('\n').filter((line) => line.length > 0)).toEqual(
          paths.map((path) => ` D ${path}`),
        );
        // Every target-owned path in the fixture survives untouched.
        for (const path of Object.keys(targetOwned)) {
          expect(await Bun.file(join(directory, path)).text()).toBe(targetOwned[path] ?? '');
        }
      },
      {
        'packages/retired-ui/README.md': '# retired\n',
        'packages/retired-ui/.npmrc': 'registry=https://registry.npmjs.org\n',
        'packages/retired-ui/src/app.ts': 'export const app = true;\n',
        'packages/retired-ui/static/logo.png': 'not really a png\n',
      },
    );
  });

  test('a retired entry naming a single file removes the named file and leaves its siblings', async () => {
    const fileRetirement = {
      directory: 'packages/retired-ui/scripts/ci-workflows.test.ts',
      target: 'weft',
      reason: 'the workflow this test reads no longer exists in the target',
      issue: 'COR-1286',
    } as const;
    await withFixtureTarget(
      async (directory) => {
        const policy = policyFor([fileRetirement]);
        const paths = await collectRetiredPaths({
          policy,
          target: 'weft',
          directory,
          directories: retiredDirectoriesFor(policy, 'weft'),
        });
        // Exactly the one named file, not a directory's worth: `walkRetiredPath` stops at `lstat`
        // rather than trying to `readdir` a path that is not one, which is D3's whole point.
        expect(paths).toEqual(['packages/retired-ui/scripts/ci-workflows.test.ts']);

        const { deleted } = await writeTransformOutput({
          policy,
          target: 'weft',
          directory,
          files: {},
          deletions: paths,
        });
        expect(deleted).toEqual(paths);
        expect(
          await Bun.file(
            join(directory, 'packages/retired-ui/scripts/ci-workflows.test.ts'),
          ).exists(),
        ).toBe(false);
        // The sibling in the same directory, and the one two levels up, both survive: a retired
        // file is removed alone, never as a stand-in for its containing directory.
        expect(
          await Bun.file(join(directory, 'packages/retired-ui/scripts/run-gates.ts')).exists(),
        ).toBe(true);
        expect(await Bun.file(join(directory, 'packages/retired-ui/README.md')).exists()).toBe(
          true,
        );
        const porcelain = await runGit(directory, 'status', '--porcelain');
        expect(porcelain.split('\n').filter((line) => line.length > 0)).toEqual([
          ' D packages/retired-ui/scripts/ci-workflows.test.ts',
        ]);
      },
      {
        'packages/retired-ui/README.md': '# retired\n',
        'packages/retired-ui/scripts/ci-workflows.test.ts': "it('reads ci.yaml', () => {});\n",
        'packages/retired-ui/scripts/run-gates.ts': 'export const main = true;\n',
      },
    );
  });

  test('a retirement whose directory the target no longer carries is a no-op, not a failure', async () => {
    await withFixtureTarget(async (directory) => {
      const policy = policyFor([retirement]);
      expect(
        await collectRetiredPaths({
          policy,
          target: 'weft',
          directory,
          directories: retiredDirectoriesFor(policy, 'weft'),
        }),
      ).toEqual([]);
    });
  });

  test('a retired directory that a paths glob already claims is refused as configuration', () => {
    expect(() =>
      assertRetirementsCoherent(
        policyFor([{ ...retirement, directory: 'LICENSE', issue: 'COR-2002' }]),
      ),
    ).toThrow(/the directory itself is target-owned by LICENSE/);
  });

  test('a retirement naming a target this file does not mirror is refused', () => {
    expect(() =>
      assertRetirementsCoherent(policyFor([{ ...retirement, target: 'tribunal' }])),
    ).toThrow(/unknown target "tribunal"/);
  });

  test('a plan emitting into a retired directory is refused before anything is written', () => {
    const policy = policyFor([retirement]);
    expect(() =>
      assertNoEmissionsIntoRetired(policy, 'weft', [
        'packages/weft/src/index.ts',
        'packages/retired-ui/src/app.ts',
      ]),
    ).toThrow(/packages\/retired-ui\/src\/app.ts is emitted into retired packages\/retired-ui/);
    expect(() =>
      assertNoEmissionsIntoRetired(policy, 'cinder', ['packages/retired-ui/src/app.ts']),
    ).not.toThrow();
  });

  test('the committed enumeration retires each target only what its own issue ruled on', async () => {
    const policy = await loadTargetOwnedPolicy();
    const retired = retiredDirectoriesFor(policy, 'weft');
    // The CI-owned paths and weft-ui, then the gate scripts the cleanup pull request deletes.
    expect(retired.slice(0, 6)).toEqual([
      'packages/weft-ui',
      '.github/workflows/ci.yaml',
      '.github/workflows/verify-jsdoc.yaml',
      '.husky',
      'packages/weft/scripts/husky',
      'packages/weft/scripts/ci-workflows.test.ts',
    ]);
    expect(retired.slice(6).every((path) => path.startsWith('packages/weft/scripts/'))).toBe(true);
    expect(retired.length).toBe(37);
    // COR-1287. The two CI workflows and the hook configuration are COR-1286's demotion ruling
    // carried to a third target; the five packages are D1's — corvidae never carried them, and a
    // mirror carries only what its source of truth carries.
    expect(retiredDirectoriesFor(policy, 'agent-bureau')).toEqual([
      '.github/workflows/ci.yml',
      '.github/workflows/nightly.yml',
      'lefthook.yml',
      'packages/cloudflare',
      'packages/evaluation',
      'packages/gateway',
      'packages/integration',
      'packages/interoperability',
      // The target's own test trees and the configurations that type-check them: stale forks of
      // corvidae's tests, which run in corvidae alone (COR-1286's ruling). Found by the agent-bureau
      // staging proof of 2026-09-23, where they were every typecheck failure outside `src`.
      'packages/armorer/test',
      'packages/conversationalist/test',
      'packages/lifecycle/test',
      'packages/memory/test',
      'packages/operative/test',
      'packages/skills/test',
      'packages/armorer/tsconfig.test.json',
      'packages/bureau/tsconfig.test.json',
      'packages/conversationalist/tsconfig.test.json',
      'packages/lifecycle/tsconfig.test.json',
      'packages/memory/tsconfig.test.json',
      'packages/operative/tsconfig.test.json',
      'packages/skills/tsconfig.test.json',
    ]);
    expect(retiredDirectoriesFor(policy, 'cinder')).toEqual([]);
    for (const entry of policy.retired.entries) {
      expect(['weft', 'agent-bureau']).toContain(entry.target);
      expect(entry.reason.length).toBeGreaterThan(0);
      expect(['COR-1192', 'COR-1286', 'COR-1287']).toContain(entry.issue);
    }
    // A retirement names exactly one repository, so no target's list may reach another's paths.
    for (const target of mirrorTargets) {
      for (const directory of retiredDirectoriesFor(policy, target)) {
        expect(
          policy.retired.entries.filter((entry) => entry.directory === directory),
        ).toHaveLength(1);
      }
    }
    // The one retired entry that names a file rather than a directory — D3's own evidence that
    // `retiredEntrySchema`'s `directory` key needed no widening to carry it.
    const fileEntry = policy.retired.entries.find(
      (candidate) => candidate.directory === 'packages/weft/scripts/ci-workflows.test.ts',
    );
    expect(fileEntry?.issue).toBe('COR-1286');
  });
});
