import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCommand, type CommandRunner } from './packaging.ts';
import {
  preparedSyncBundleFile,
  preparedSyncManifestFile,
  readPreparedSyncManifest,
  verifyPreparedSyncArtifact,
  writePreparedSyncArtifact,
} from './prepared-sync.ts';
import { git, provenanceTrailer, type SyncResult } from './sync.ts';

const corvidaeCommit = 'a'.repeat(40);

const verification = {
  reports: [],
  smokeTest: { directory: '', specifiers: [] },
  privateTypechecks: [],
  installParity: { command: 'bun install --frozen-lockfile', checkedAgainst: ['release.yaml'] },
};

async function fixtureRepository(options: { message?: string; trailer?: string } = {}): Promise<{
  root: string;
  directory: string;
  baseCommit: string;
  preparedCommit: string;
}> {
  const root = await mkdtemp(join(tmpdir(), 'mirror-prepared-sync-test-'));
  const directory = join(root, 'repository');
  await mkdir(join(directory, '.github', 'workflows'), { recursive: true });
  await git(directory, 'init', '--quiet', '--initial-branch=main');
  await Bun.write(join(directory, '.github', 'workflows', 'release.yaml'), 'name: release\n');
  await Bun.write(join(directory, 'README.md'), '# target\n');
  await git(directory, 'add', '--all');
  await git(directory, 'commit', '--quiet', '--message', 'base');
  const baseCommitResult = await git(directory, 'rev-parse', 'HEAD');
  const baseCommit = baseCommitResult.trim();
  await Bun.write(join(directory, 'README.md'), '# changed target\n');
  await git(directory, 'add', '--all');
  await git(
    directory,
    'commit',
    '--quiet',
    '--message',
    options.message ??
      `Sync weft from corvidae\n\n${options.trailer ?? `${provenanceTrailer}: ${corvidaeCommit}`}`,
  );
  const preparedCommitResult = await git(directory, 'rev-parse', 'HEAD');
  const preparedCommit = preparedCommitResult.trim();
  return { root, directory, baseCommit, preparedCommit };
}

function preparedResult(options: {
  directory: string;
  baseCommit: string;
  preparedCommit: string;
}): SyncResult {
  return {
    decision: 'prepared',
    target: 'weft',
    directory: options.directory,
    changed: ['M README.md'],
    commit: options.preparedCommit,
    firstPublish: [],
    seededFromPackageMap: [],
    verification,
    baseBranch: 'main',
    baseCommit: options.baseCommit,
  };
}

function skipResult(options: { directory: string; baseCommit: string }): SyncResult {
  return {
    decision: 'skip',
    target: 'weft',
    directory: options.directory,
    changed: [],
    firstPublish: [],
    seededFromPackageMap: [],
    verification,
    baseBranch: 'main',
    baseCommit: options.baseCommit,
  };
}

async function readManifest(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await Bun.file(path).text()) as Record<string, unknown>;
}

async function writeManifest(path: string, manifest: Record<string, unknown>): Promise<void> {
  await Bun.write(path, `${JSON.stringify(manifest)}\n`);
}

function commandRecorder(): { commands: string[][]; run: CommandRunner } {
  const commands: string[][] = [];
  return {
    commands,
    run: async (command, options) => {
      commands.push([...command]);
      return runCommand(command, options);
    },
  };
}

function fixtureVerificationOptions(fixture: { directory: string }): {
  corvidaeRoot: string;
  remote: string;
} {
  return { corvidaeRoot: fixture.directory, remote: fixture.directory };
}

describe('prepared sync artifacts', () => {
  test('verify a prepared bundle without trusting artifact remote or branch data', async () => {
    const fixture = await fixtureRepository();
    try {
      const artifactDirectory = join(fixture.root, 'artifact');
      await writePreparedSyncArtifact({
        artifactDirectory,
        result: preparedResult(fixture),
        corvidaeCommit,
        snapshot: true,
        workflowFile: 'release.yaml',
      });
      const manifestText = await Bun.file(join(artifactDirectory, preparedSyncManifestFile)).text();
      expect(manifestText).not.toContain('remote');
      expect(manifestText).not.toContain('branch');

      const manifest = await readPreparedSyncManifest(
        join(artifactDirectory, preparedSyncManifestFile),
      );
      expect(manifest.decision).toBe('prepared');
      expect(manifest.commit).toBe(fixture.preparedCommit);
      expect(manifest.bundle.file).toBe(preparedSyncBundleFile);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test('reject unknown manifest fields before importing the bundle', async () => {
    const fixture = await fixtureRepository();
    try {
      const artifactDirectory = join(fixture.root, 'artifact');
      await writePreparedSyncArtifact({
        artifactDirectory,
        result: preparedResult(fixture),
        corvidaeCommit,
        snapshot: false,
      });
      const manifestPath = join(artifactDirectory, preparedSyncManifestFile);
      const manifest = await readManifest(manifestPath);
      manifest['remote'] = 'https://github.com/attacker/repository.git';
      manifest['branch'] = 'main';
      await writeManifest(manifestPath, manifest);

      await expect(readPreparedSyncManifest(manifestPath)).rejects.toThrow(/unknown field/);
      let imported = false;
      await expect(
        verifyPreparedSyncArtifact({
          artifactDirectory,
          ...fixtureVerificationOptions(fixture),
          expectedTarget: 'weft',
          expectedCorvidaeCommit: corvidaeCommit,
          expectedSnapshot: false,
          run: async () => {
            imported = true;
            throw new Error('should not import');
          },
        }),
      ).rejects.toThrow(/unknown field/);
      expect(imported).toBe(false);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test('rejects workflow input mismatches before importing the bundle', async () => {
    const fixture = await fixtureRepository();
    try {
      const artifactDirectory = join(fixture.root, 'artifact');
      await writePreparedSyncArtifact({
        artifactDirectory,
        result: preparedResult(fixture),
        corvidaeCommit,
        snapshot: true,
        workflowFile: 'release.yaml',
      });
      let imported = false;
      const run: CommandRunner = async () => {
        imported = true;
        throw new Error('should not import for workflow input mismatches');
      };
      await expect(
        verifyPreparedSyncArtifact({
          artifactDirectory,
          ...fixtureVerificationOptions(fixture),
          expectedTarget: 'cinder',
          expectedCorvidaeCommit: corvidaeCommit,
          expectedSnapshot: true,
          run,
        }),
      ).rejects.toThrow(/target/);
      await expect(
        verifyPreparedSyncArtifact({
          artifactDirectory,
          ...fixtureVerificationOptions(fixture),
          expectedTarget: 'weft',
          expectedCorvidaeCommit: 'b'.repeat(40),
          expectedSnapshot: true,
          run,
        }),
      ).rejects.toThrow(/source commit/);
      await expect(
        verifyPreparedSyncArtifact({
          artifactDirectory,
          ...fixtureVerificationOptions(fixture),
          expectedTarget: 'weft',
          expectedCorvidaeCommit: corvidaeCommit,
          expectedSnapshot: false,
          run,
        }),
      ).rejects.toThrow(/snapshot flag/);
      expect(imported).toBe(false);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test('verify skip artifacts from the bundled base commit and release workflow tree', async () => {
    const fixture = await fixtureRepository();
    try {
      await git(fixture.directory, 'reset', '--hard', fixture.baseCommit);
      const artifactDirectory = join(fixture.root, 'artifact');
      await writePreparedSyncArtifact({
        artifactDirectory,
        result: skipResult({ directory: fixture.directory, baseCommit: fixture.baseCommit }),
        corvidaeCommit,
        snapshot: true,
        workflowFile: 'release.yaml',
      });
      await expect(
        readPreparedSyncManifest(join(artifactDirectory, preparedSyncManifestFile)),
      ).resolves.toMatchObject({ decision: 'skip', baseCommit: fixture.baseCommit });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test('reject tampered bundles, non-parent bases, and mismatched workflow filenames', async () => {
    const fixture = await fixtureRepository();
    try {
      const artifactDirectory = join(fixture.root, 'artifact');
      await writePreparedSyncArtifact({
        artifactDirectory,
        result: preparedResult(fixture),
        corvidaeCommit,
        snapshot: true,
        workflowFile: 'release.yaml',
      });
      await Bun.write(join(artifactDirectory, preparedSyncBundleFile), 'tampered');
      await expect(
        verifyPreparedSyncArtifact({
          artifactDirectory,
          ...fixtureVerificationOptions(fixture),
          expectedTarget: 'weft',
          expectedCorvidaeCommit: corvidaeCommit,
          expectedSnapshot: true,
        }),
      ).rejects.toThrow(/digest/);

      await writePreparedSyncArtifact({
        artifactDirectory,
        result: preparedResult(fixture),
        corvidaeCommit,
        snapshot: true,
        workflowFile: 'release.yaml',
      });
      const manifestPath = join(artifactDirectory, preparedSyncManifestFile);
      const manifest = await readManifest(manifestPath);
      manifest['baseCommit'] = 'b'.repeat(40);
      await writeManifest(manifestPath, manifest);
      await expect(
        verifyPreparedSyncArtifact({
          artifactDirectory,
          ...fixtureVerificationOptions(fixture),
          expectedTarget: 'weft',
          expectedCorvidaeCommit: corvidaeCommit,
          expectedSnapshot: true,
        }),
      ).rejects.toThrow(/base commit as its only parent/);

      manifest['baseCommit'] = fixture.baseCommit;
      manifest['workflowFile'] = 'release.yml';
      await writeManifest(manifestPath, manifest);
      await expect(
        verifyPreparedSyncArtifact({
          artifactDirectory,
          ...fixtureVerificationOptions(fixture),
          expectedTarget: 'weft',
          expectedCorvidaeCommit: corvidaeCommit,
          expectedSnapshot: true,
        }),
      ).rejects.toThrow(/release workflow/);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test('rejects manifest commit and tree mismatches without any push command', async () => {
    const fixture = await fixtureRepository();
    try {
      const artifactDirectory = join(fixture.root, 'artifact');
      await writePreparedSyncArtifact({
        artifactDirectory,
        result: preparedResult(fixture),
        corvidaeCommit,
        snapshot: false,
      });
      const manifestPath = join(artifactDirectory, preparedSyncManifestFile);
      const original = await readManifest(manifestPath);
      const commitMismatch = { ...original, commit: 'b'.repeat(40) };
      await writeManifest(manifestPath, commitMismatch);
      const commitRecorder = commandRecorder();
      await expect(
        verifyPreparedSyncArtifact({
          artifactDirectory,
          ...fixtureVerificationOptions(fixture),
          expectedTarget: 'weft',
          expectedCorvidaeCommit: corvidaeCommit,
          expectedSnapshot: false,
          run: commitRecorder.run,
        }),
      ).rejects.toThrow(/commit/);
      expect(commitRecorder.commands.some((command) => command.includes('push'))).toBe(false);

      const treeMismatch = { ...original, tree: 'b'.repeat(40) };
      await writeManifest(manifestPath, treeMismatch);
      const treeRecorder = commandRecorder();
      await expect(
        verifyPreparedSyncArtifact({
          artifactDirectory,
          ...fixtureVerificationOptions(fixture),
          expectedTarget: 'weft',
          expectedCorvidaeCommit: corvidaeCommit,
          expectedSnapshot: false,
          run: treeRecorder.run,
        }),
      ).rejects.toThrow(/tree/);
      expect(treeRecorder.commands.some((command) => command.includes('push'))).toBe(false);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test('rejects a prepared bundle whose sync commit is not a direct child of the base', async () => {
    const fixture = await fixtureRepository();
    try {
      await git(fixture.directory, 'reset', '--hard', fixture.baseCommit);
      await Bun.write(join(fixture.directory, 'README.md'), '# intermediate target\n');
      await git(fixture.directory, 'add', '--all');
      await git(fixture.directory, 'commit', '--quiet', '--message', 'Intermediate target commit');
      await Bun.write(join(fixture.directory, 'README.md'), '# changed target\n');
      await git(fixture.directory, 'add', '--all');
      await git(
        fixture.directory,
        'commit',
        '--quiet',
        '--message',
        `Sync weft from corvidae\n\n${provenanceTrailer}: ${corvidaeCommit}`,
      );
      const preparedCommitOutput = await git(fixture.directory, 'rev-parse', 'HEAD');
      const preparedCommit = preparedCommitOutput.trim();
      const artifactDirectory = join(fixture.root, 'artifact');
      await writePreparedSyncArtifact({
        artifactDirectory,
        result: preparedResult({
          directory: fixture.directory,
          baseCommit: fixture.baseCommit,
          preparedCommit,
        }),
        corvidaeCommit,
        snapshot: false,
      });
      await expect(
        verifyPreparedSyncArtifact({
          artifactDirectory,
          ...fixtureVerificationOptions(fixture),
          expectedTarget: 'weft',
          expectedCorvidaeCommit: corvidaeCommit,
          expectedSnapshot: false,
        }),
      ).rejects.toThrow(/base commit as its only parent/);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test('requires an exact corvidae trailer in prepared commits', async () => {
    const fixture = await fixtureRepository({
      trailer: `${provenanceTrailer}: ${corvidaeCommit}-extra`,
    });
    try {
      const artifactDirectory = join(fixture.root, 'artifact');
      await writePreparedSyncArtifact({
        artifactDirectory,
        result: preparedResult(fixture),
        corvidaeCommit,
        snapshot: false,
      });
      await expect(
        verifyPreparedSyncArtifact({
          artifactDirectory,
          ...fixtureVerificationOptions(fixture),
          expectedTarget: 'weft',
          expectedCorvidaeCommit: corvidaeCommit,
          expectedSnapshot: false,
        }),
      ).rejects.toThrow(/expected corvidae trailer/);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test('rejects a matching-looking body line that is not a Git trailer', async () => {
    const fixture = await fixtureRepository({
      message: `Sync weft from corvidae\n\n${provenanceTrailer}: ${corvidaeCommit}\nnot a trailer footer`,
    });
    try {
      const artifactDirectory = join(fixture.root, 'artifact');
      await writePreparedSyncArtifact({
        artifactDirectory,
        result: preparedResult(fixture),
        corvidaeCommit,
        snapshot: false,
      });
      await expect(
        verifyPreparedSyncArtifact({
          artifactDirectory,
          ...fixtureVerificationOptions(fixture),
          expectedTarget: 'weft',
          expectedCorvidaeCommit: corvidaeCommit,
          expectedSnapshot: false,
        }),
      ).rejects.toThrow(/expected corvidae trailer/);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
});
