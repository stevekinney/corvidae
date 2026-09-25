import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createWorkflowVerifyEnvironment,
  readLockedVersion,
  renderMirrorVerifyWorkflow,
  shellWord,
} from './mirror-verify-workflow.ts';
import type { PrivateWorkspace, PublishedPackage } from './surface.ts';
import { buildVerifySteps } from './verify-steps.ts';

const published: PublishedPackage[] = [
  {
    workspace: '@lostgradient/cryptography',
    directory: 'packages/cryptography',
    publicName: '@lostgradient/cryptography',
    entry: {} as PublishedPackage['entry'],
    exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' } },
    files: ['dist'],
    version: '1.2.3',
    dependsOn: [],
  },
];

const privateWorkspaces: PrivateWorkspace[] = [
  {
    workspace: '@lostgradient/testing',
    directory: 'packages/testing',
    publicName: '@lostgradient/testing',
    typechecks: true,
    emitsTypeScript: true,
  },
];

const fixtureReleaseWorkflow = [
  'name: release',
  'on:',
  '  push:',
  "    tags: ['v*.*.*']",
  'jobs:',
  '  publish:',
  '    runs-on: ubuntu-latest',
  '    steps:',
  '      - uses: actions/checkout@v4',
  '      - uses: oven-sh/setup-bun@v1',
  '        with:',
  '          bun-version: 1.4.2',
  '      - run: bun install --frozen-lockfile --linker=isolated',
  '',
].join('\n');

const fixtureBunLock = [
  '{',
  '  "packages": {',
  '    "publint": ["publint@0.3.24", "", {}, "sha512-x"],',
  '    "@arethetypeswrong/cli": ["@arethetypeswrong/cli@0.18.5", "", {}, "sha512-y"]',
  '  }',
  '}',
  '',
].join('\n');

async function withFixture(
  body: (options: { targetDirectory: string; bunLockPath: string }) => Promise<void>,
  releaseWorkflowNames: readonly string[] = ['release.yaml'],
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'mirror-verify-workflow-'));
  try {
    const targetDirectory = join(root, 'clone');
    for (const name of releaseWorkflowNames) {
      await Bun.write(join(targetDirectory, '.github/workflows', name), fixtureReleaseWorkflow);
    }
    const bunLockPath = join(root, 'bun.lock');
    await Bun.write(bunLockPath, fixtureBunLock);
    await body({ targetDirectory, bunLockPath });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('shellWord', () => {
  /** What bash hands the command for each word, which is the only oracle that matters. */
  function throughBash(words: readonly string[]): string[] {
    const line = `printf '%s\\n' ${words.map(shellWord).join(' ')}`;
    const result = Bun.spawnSync(['bash', '-c', line]);
    expect(result.exitCode).toBe(0);
    return result.stdout.toString().replace(/\n$/, '').split('\n');
  }

  test('a plain word is left exactly as it is', () => {
    expect(shellWord('--ignore-scripts')).toBe('--ignore-scripts');
    expect(shellWord('@arethetypeswrong/cli@0.18.5')).toBe('@arethetypeswrong/cli@0.18.5');
  });

  test('a GitHub expression stays unquoted, since GitHub replaces it before the shell runs', () => {
    expect(shellWord('${{ runner.temp }}/mirror-verify/tarballs')).toBe(
      '${{ runner.temp }}/mirror-verify/tarballs',
    );
  });

  test('spaces, quotes, operators and the empty string reach the command intact', () => {
    const words = ["it's", 'a b', 'x; rm -rf y', '$HOME', '"quoted"', ''];
    expect(throughBash(words)).toEqual(words);
  });
});

describe('readLockedVersion', () => {
  test('reads a package’s locked version out of a bun.lock text lockfile', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bun-lock-'));
    try {
      const path = join(root, 'bun.lock');
      await Bun.write(path, fixtureBunLock);
      expect(await readLockedVersion(path, 'publint')).toBe('0.3.24');
      expect(await readLockedVersion(path, '@arethetypeswrong/cli')).toBe('0.18.5');
      await expect(readLockedVersion(path, 'not-a-real-package')).rejects.toThrow(
        /no locked entry/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('renderMirrorVerifyWorkflow', () => {
  /**
   * COR-1287: `release.yaml` was a default parameter here, which made the renderer silently
   * target-specific. stevekinney/agent-bureau spells it `release.yml`, and the failure would not
   * have been a missing file — `readWorkflowInstalls` reads both extensions, so the pin read would
   * have thrown while the *install line* lookup would merely have missed, rendering a workflow
   * that installs without the target's own arguments. Both halves are asserted together.
   */
  test('a target whose release workflow is spelled .yml is read the same way', async () => {
    await withFixture(
      async ({ targetDirectory, bunLockPath }) => {
        const workflow = await renderMirrorVerifyWorkflow({
          targetDirectory,
          bunLockPath,
          published,
          privateWorkspaces,
        });
        expect(workflow).toContain('bun-version: 1.4.2');
        expect(workflow).toContain('bun install --frozen-lockfile --linker=isolated');
      },
      ['release.yml'],
    );
  });

  test('a clone carrying both spellings is refused rather than resolved by probe order', async () => {
    await withFixture(
      async ({ targetDirectory, bunLockPath }) => {
        await expect(
          renderMirrorVerifyWorkflow({
            targetDirectory,
            bunLockPath,
            published,
            privateWorkspaces,
          }),
        ).rejects.toThrow(/carries both release\.yaml and release\.yml/);
      },
      ['release.yaml', 'release.yml'],
    );
  });

  test('a clone carrying neither spelling names both in its refusal', async () => {
    await withFixture(async ({ targetDirectory, bunLockPath }) => {
      await expect(
        renderMirrorVerifyWorkflow({
          targetDirectory,
          bunLockPath,
          published,
          privateWorkspaces,
        }),
      ).rejects.toThrow(/carries neither release\.yaml nor release\.yml/);
    }, []);
  });

  test('pins the release workflow’s own Bun version and carries pull_request + merge_group triggers', async () => {
    await withFixture(async ({ targetDirectory, bunLockPath }) => {
      const workflow = await renderMirrorVerifyWorkflow({
        targetDirectory,
        bunLockPath,
        published,
        privateWorkspaces,
      });
      expect(workflow).toContain('name: mirror-verify');
      expect(workflow).toContain('pull_request:');
      expect(workflow).toContain('merge_group:');
      // The release workflow's gate job `uses:` this file; without the trigger the call is refused.
      expect(workflow).toContain('workflow_call:');
      expect(workflow).toContain('bun-version: 1.4.2');
      // Read off the release workflow's own install line, not hardcoded to weft's flag.
      expect(workflow).toContain('bun install --frozen-lockfile --linker=isolated');
    });
  });

  test('a multi-line heredoc body has every one of its own lines indented, not just its first, inside its "run: |" block scalar', async () => {
    // A structural indentation scan can't reliably tell "the block legitimately ended" apart from
    // "this line should have been indented and was not" — a dedented line is exactly what both
    // look like. So this checks against ground truth instead: `write-consumer-project`'s two
    // heredoc bodies (`package.json`, `smoke.mjs`) are known multi-line strings, split the same way
    // `renderStep` is documented to split them, and every one of those lines, reconstructed with
    // the renderer's own indent, must appear verbatim and contiguously in the rendered output.
    // This is the exact shape the bug had: a multi-line string pushed as one array element only
    // had its first line indented by a later `.map()`, so every line after the first embedded
    // `\n` stayed at column zero.
    await withFixture(async ({ targetDirectory, bunLockPath }) => {
      const workflow = await renderMirrorVerifyWorkflow({
        targetDirectory,
        bunLockPath,
        published,
        privateWorkspaces,
      });
      const environment = createWorkflowVerifyEnvironment({
        lockedVersions: {
          publint: await readLockedVersion(bunLockPath, 'publint'),
          attw: await readLockedVersion(bunLockPath, '@arethetypeswrong/cli'),
        },
      });
      const steps = buildVerifySteps(
        {
          installCommand: ['bun', 'install', '--frozen-lockfile', '--linker=isolated'],
          published,
          privateWorkspaces,
          installArguments: ['--linker=isolated'],
        },
        environment,
      );
      const writeStep = steps.find((step) => step.kind === 'write-consumer-project');
      expect(writeStep?.files).toBeDefined();

      // `renderStep`'s own indentation constant, kept in sync by this test failing loudly if the
      // renderer's indent ever changes without this assertion changing with it.
      const indent = '          ';
      for (const contents of Object.values(writeStep?.files ?? {})) {
        const bodyLines = contents.replace(/\n$/, '').split('\n');
        expect(bodyLines.length).toBeGreaterThan(1); // a single-line body would not have caught the bug
        const expectedBlock = bodyLines
          .map((line) => (line.length === 0 ? '' : `${indent}${line}`))
          .join('\n');
        expect(workflow).toContain(expectedBlock);
      }
    });
  });

  test('every command buildVerifySteps produces for the workflow environment appears as a run: line, proving the renderer never hand-writes a divergent list', async () => {
    await withFixture(async ({ targetDirectory, bunLockPath }) => {
      const workflow = await renderMirrorVerifyWorkflow({
        targetDirectory,
        bunLockPath,
        published,
        privateWorkspaces,
      });

      // Independently reconstruct the exact inputs `renderMirrorVerifyWorkflow` used internally —
      // the same release-workflow install line and the same locked tool versions — and call
      // `buildVerifySteps` a second time, directly. If the renderer had its own hand-written step
      // list instead of calling `buildVerifySteps`, this would not (in general) match.
      const environment = createWorkflowVerifyEnvironment({
        lockedVersions: {
          publint: await readLockedVersion(bunLockPath, 'publint'),
          attw: await readLockedVersion(bunLockPath, '@arethetypeswrong/cli'),
        },
      });
      const expectedSteps = buildVerifySteps(
        {
          installCommand: ['bun', 'install', '--frozen-lockfile', '--linker=isolated'],
          published,
          privateWorkspaces,
          installArguments: ['--linker=isolated'],
        },
        environment,
      );

      for (const step of expectedSteps) {
        if (step.command.length === 0) continue;
        expect(workflow).toContain(step.command.map(shellWord).join(' '));
      }
      // And every command appears in the same order it was built in — searched with an advancing
      // cursor, since two steps (the published package's `typecheck` and the private workspace's)
      // legitimately render the identical command text and a plain `indexOf` per step would find
      // the first one twice.
      const commandSteps = expectedSteps.filter((step) => step.command.length > 0);
      let cursor = 0;
      for (const step of commandSteps) {
        const line = step.command.map(shellWord).join(' ');
        const index = workflow.indexOf(line, cursor);
        expect(index, `${step.description}: "${line}"`).toBeGreaterThan(-1);
        cursor = index + line.length;
      }
    });
  });

  test('publint and attw are pinned to bun.lock’s locked versions via bunx, never a range', async () => {
    await withFixture(async ({ targetDirectory, bunLockPath }) => {
      const workflow = await renderMirrorVerifyWorkflow({
        targetDirectory,
        bunLockPath,
        published,
        privateWorkspaces,
      });
      // The package spec alone, then the tool's own flags: `bunx` runs the package's single bin,
      // and a repeated binary name becomes a positional argument the tool tries to read.
      expect(workflow).toContain('bunx --bun publint@0.3.24 --strict ');
      expect(workflow).toContain('bunx --bun @arethetypeswrong/cli@0.18.5 ${{ runner.temp }}/');
      expect(workflow).not.toContain('publint@0.3.24 publint');
      expect(workflow).not.toContain('cli@0.18.5 attw');
      expect(workflow).not.toContain('publint@^');
      expect(workflow).not.toContain('arethetypeswrong/cli@^');
    });
  });

  test('the consumer smoke-test project is written with a heredoc before it is installed and run', async () => {
    await withFixture(async ({ targetDirectory, bunLockPath }) => {
      const workflow = await renderMirrorVerifyWorkflow({
        targetDirectory,
        bunLockPath,
        published,
        privateWorkspaces,
      });
      expect(workflow).toContain("cat > package.json <<'MIRROR_VERIFY_EOF'");
      expect(workflow).toContain("cat > smoke.mjs <<'MIRROR_VERIFY_EOF'");
      expect(workflow).toContain("cat > smoke-node.mjs <<'MIRROR_VERIFY_EOF'");
      expect(workflow).toContain("import * as module0 from '@lostgradient/cryptography';");
      const writeIndex = workflow.indexOf('write the consumer smoke-test project');
      const installIndex = workflow.indexOf(
        'install the packed tarballs into the consumer project',
      );
      const runIndex = workflow.indexOf('import 1 specifier(s) from the packed tarballs');
      expect(writeIndex).toBeGreaterThan(-1);
      expect(writeIndex).toBeLessThan(installIndex);
      expect(installIndex).toBeLessThan(runIndex);
    });
  });

  test('a release workflow with no bun-version pin fails loudly rather than emitting an unpinned workflow', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mirror-verify-workflow-'));
    try {
      const targetDirectory = join(root, 'clone');
      await Bun.write(
        join(targetDirectory, '.github/workflows/release.yaml'),
        'name: release\non:\n  push:\n    tags: ["v*"]\n',
      );
      const bunLockPath = join(root, 'bun.lock');
      await Bun.write(bunLockPath, fixtureBunLock);
      await expect(
        renderMirrorVerifyWorkflow({ targetDirectory, bunLockPath, published, privateWorkspaces }),
      ).rejects.toThrow(/bun-version/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  /**
   * COR-1198. The workflow is rendered at sync time, but it runs on every later pull request too,
   * including a changesets Version Packages pull request that bumps each manifest's `version`.
   * agent-bureau#636 failed `verify` because publint was pointed at `…-0.0.0.tgz` after the bump
   * had packed `…-0.0.1.tgz`. Every step after the pack has to find the tarball whatever version the
   * manifest carries when the workflow runs, so this bumps the version after rendering and runs the
   * rendered pack-relocate lines through a real shell.
   */
  test('the rendered steps find each tarball after a later commit bumps the version', async () => {
    await withFixture(async ({ targetDirectory, bunLockPath }) => {
      const workflow = await renderMirrorVerifyWorkflow({
        targetDirectory,
        bunLockPath,
        published,
        privateWorkspaces,
      });
      const parsed = Bun.YAML.parse(workflow) as {
        jobs: {
          verify: { steps: { name?: string; run?: string; 'working-directory'?: string }[] };
        };
      };
      const steps = parsed.jobs.verify.steps;
      expect(workflow).not.toContain('lostgradient-cryptography-1.2.3.tgz');

      const runner = await mkdtemp(join(tmpdir(), 'mirror-verify-runner-'));
      try {
        const packageDirectory = join(runner, 'clone/packages/cryptography');
        const tarballs = join(runner, 'mirror-verify/tarballs');
        await Bun.write(
          join(packageDirectory, 'package.json'),
          `${JSON.stringify({ name: '@lostgradient/cryptography', version: '1.2.4' })}\n`,
        );
        // What `bun pm pack --destination` writes for the bumped manifest.
        await Bun.write(join(tarballs, 'lostgradient-cryptography-1.2.4.tgz'), 'tarball');

        const relocations = steps.filter((step) => step.name?.startsWith('move ') && step.run);
        expect(relocations.length).toBe(published.length);
        for (const step of relocations) {
          const script = (step.run ?? '').replaceAll('${{ runner.temp }}', runner);
          const shell = Bun.spawnSync(['bash', '-euc', script], {
            cwd: join(runner, 'clone', step['working-directory'] ?? '.'),
          });
          expect({
            step: step.name,
            exitCode: shell.exitCode,
            stderr: shell.stderr.toString(),
          }).toEqual({ step: step.name, exitCode: 0, stderr: '' });
        }

        const publint = steps.find((step) => step.name === 'publint @lostgradient/cryptography');
        const publintLine = (publint?.run ?? '').replaceAll('${{ runner.temp }}', runner);
        const tarball = /(\S+\.tgz)/.exec(publintLine)?.[1] ?? '';
        expect(tarball.startsWith(runner)).toBe(true);
        expect(await Bun.file(tarball).exists()).toBe(true);
      } finally {
        await rm(runner, { recursive: true, force: true });
      }
    });
  });
});
