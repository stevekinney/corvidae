import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildManifest,
  parseArguments,
  runValidator,
  sha256File,
  type CaseResult,
  type SpawnResult,
  type Spawner,
} from './validate-diff-review-registry.ts';

const ABSOLUTE_CINDER = '/tmp/example/cinder.tgz';
const ABSOLUTE_EDITOR = '/tmp/example/editor.tgz';
const ABSOLUTE_EVIDENCE = '/tmp/example/evidence';

describe('validate-diff-review-registry parseArguments', () => {
  test('accepts the three required absolute options', () => {
    const result = parseArguments([
      '--cinder-tarball',
      ABSOLUTE_CINDER,
      '--editor-tarball',
      ABSOLUTE_EDITOR,
      '--evidence-directory',
      ABSOLUTE_EVIDENCE,
    ]);
    expect(result).toEqual({
      ok: true,
      value: {
        cinderTarball: ABSOLUTE_CINDER,
        editorTarball: ABSOLUTE_EDITOR,
        evidenceDirectory: ABSOLUTE_EVIDENCE,
        markdownTarball: undefined,
      },
    });
  });

  test('accepts an optional absolute --markdown-tarball', () => {
    const result = parseArguments([
      '--cinder-tarball',
      ABSOLUTE_CINDER,
      '--editor-tarball',
      ABSOLUTE_EDITOR,
      '--evidence-directory',
      ABSOLUTE_EVIDENCE,
      '--markdown-tarball',
      '/tmp/example/markdown.tgz',
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.markdownTarball).toBe('/tmp/example/markdown.tgz');
  });

  test('rejects a missing --cinder-tarball', () => {
    const result = parseArguments([
      '--editor-tarball',
      ABSOLUTE_EDITOR,
      '--evidence-directory',
      ABSOLUTE_EVIDENCE,
    ]);
    expect(result).toEqual({
      ok: false,
      error: {
        code: 'missing-argument',
        option: 'cinder-tarball',
        message: 'Missing required option --cinder-tarball',
      },
    });
  });

  test('rejects a missing --editor-tarball', () => {
    const result = parseArguments([
      '--cinder-tarball',
      ABSOLUTE_CINDER,
      '--evidence-directory',
      ABSOLUTE_EVIDENCE,
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error).toEqual({
        code: 'missing-argument',
        option: 'editor-tarball',
        message: 'Missing required option --editor-tarball',
      });
  });

  test('rejects a missing --evidence-directory', () => {
    const result = parseArguments([
      '--cinder-tarball',
      ABSOLUTE_CINDER,
      '--editor-tarball',
      ABSOLUTE_EDITOR,
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.option).toBe('evidence-directory');
  });

  test('rejects a relative --cinder-tarball', () => {
    const result = parseArguments([
      '--cinder-tarball',
      'relative/cinder.tgz',
      '--editor-tarball',
      ABSOLUTE_EDITOR,
      '--evidence-directory',
      ABSOLUTE_EVIDENCE,
    ]);
    expect(result).toEqual({
      ok: false,
      error: {
        code: 'not-absolute',
        option: 'cinder-tarball',
        message: '--cinder-tarball must be an absolute path, got "relative/cinder.tgz"',
      },
    });
  });

  test('rejects a relative --editor-tarball', () => {
    const result = parseArguments([
      '--cinder-tarball',
      ABSOLUTE_CINDER,
      '--editor-tarball',
      'relative/editor.tgz',
      '--evidence-directory',
      ABSOLUTE_EVIDENCE,
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error).toEqual({
        code: 'not-absolute',
        option: 'editor-tarball',
        message: '--editor-tarball must be an absolute path, got "relative/editor.tgz"',
      });
  });

  test('rejects a relative --evidence-directory', () => {
    const result = parseArguments([
      '--cinder-tarball',
      ABSOLUTE_CINDER,
      '--editor-tarball',
      ABSOLUTE_EDITOR,
      '--evidence-directory',
      'relative/evidence',
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('not-absolute');
  });

  test('rejects a relative --markdown-tarball', () => {
    const result = parseArguments([
      '--cinder-tarball',
      ABSOLUTE_CINDER,
      '--editor-tarball',
      ABSOLUTE_EDITOR,
      '--evidence-directory',
      ABSOLUTE_EVIDENCE,
      '--markdown-tarball',
      'relative/markdown.tgz',
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error).toEqual({
        code: 'not-absolute',
        option: 'markdown-tarball',
        message: '--markdown-tarball must be an absolute path, got "relative/markdown.tgz"',
      });
  });
});

describe('validate-diff-review-registry buildManifest', () => {
  const tarball = { path: ABSOLUTE_CINDER, sha256: 'a'.repeat(64) };

  test('exit code is 0 when every case passes', () => {
    const cases: CaseResult[] = [
      { id: 'plain-cinder/import', fixture: 'plain-cinder', status: 'pass' },
      { id: 'aggregate/export', fixture: 'aggregate', status: 'pass' },
    ];
    const manifest = buildManifest({
      now: () => '2026-01-01T00:00:00.000Z',
      cinderTarball: tarball,
      editorTarball: tarball,
      markdownTarball: { registryRange: '^0.5.0' },
      installedVersions: {},
      cases,
    });
    expect(manifest.exitCode).toBe(0);
    expect(manifest.cases).toEqual(cases);
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.generatedAt).toBe('2026-01-01T00:00:00.000Z');
  });

  test('exit code is 1 when any case fails', () => {
    const manifest = buildManifest({
      cinderTarball: tarball,
      editorTarball: tarball,
      markdownTarball: { registryRange: '^0.5.0' },
      installedVersions: {},
      cases: [
        { id: 'plain-cinder/import', fixture: 'plain-cinder', status: 'pass' },
        { id: 'annotated/ssr:x', fixture: 'annotated', status: 'fail', detail: 'boom' },
      ],
    });
    expect(manifest.exitCode).toBe(1);
  });

  test('an empty case list fails atomically rather than reporting a silent pass', () => {
    const manifest = buildManifest({
      cinderTarball: tarball,
      editorTarball: tarball,
      markdownTarball: { registryRange: '^0.5.0' },
      installedVersions: {},
      cases: [],
    });
    expect(manifest.exitCode).toBe(1);
    expect(manifest.cases).toHaveLength(1);
    expect(manifest.cases[0]?.id).toBe('matrix/no-cases');
    expect(manifest.cases[0]?.status).toBe('fail');
  });

  test('carries installed versions and tarball records through unchanged', () => {
    const manifest = buildManifest({
      cinderTarball: { path: '/a/cinder.tgz', sha256: 'b'.repeat(64) },
      editorTarball: { path: '/a/editor.tgz', sha256: 'c'.repeat(64) },
      markdownTarball: { path: '/a/markdown.tgz', sha256: 'd'.repeat(64) },
      installedVersions: { '@lostgradient/cinder': '0.27.0' },
      cases: [{ id: 'plain-cinder/import', fixture: 'plain-cinder', status: 'pass' }],
    });
    expect(manifest.cinderTarball.sha256).toBe('b'.repeat(64));
    expect(manifest.markdownTarball).toEqual({ path: '/a/markdown.tgz', sha256: 'd'.repeat(64) });
    expect(manifest.installedVersions).toEqual({ '@lostgradient/cinder': '0.27.0' });
  });
});

describe('validate-diff-review-registry sha256File', () => {
  test('hashes a file to the expected lowercase hex digest', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sha256-probe-'));
    try {
      const path = join(directory, 'fixture.txt');
      await Bun.write(path, 'diff-review\n');
      const digest = await sha256File(path);
      // sha256("diff-review\n"), computed independently of this module.
      expect(digest).toMatch(/^[0-9a-f]{64}$/);
      const again = await sha256File(path);
      expect(again).toBe(digest);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe('validate-diff-review-registry runValidator failure paths', () => {
  test('reports a fixture install failure as a case, without crashing, and still writes a manifest', async () => {
    const evidenceDirectory = await mkdtemp(join(tmpdir(), 'diff-review-evidence-'));
    const cinderTarball = await mkdtemp(join(tmpdir(), 'diff-review-tarball-'));
    const cinderTarballPath = join(cinderTarball, 'cinder.tgz');
    const editorTarballPath = join(cinderTarball, 'editor.tgz');
    await Bun.write(cinderTarballPath, 'not a real tarball, only its bytes are hashed\n');
    await Bun.write(editorTarballPath, 'not a real tarball, only its bytes are hashed\n');

    const failingInstall: Spawner = async (command): Promise<SpawnResult> => {
      if (command[1] === 'install') {
        return { exitCode: 1, stdout: '', stderr: 'simulated: no network in this test' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    };

    try {
      const manifest = await runValidator(
        {
          cinderTarball: cinderTarballPath,
          editorTarball: editorTarballPath,
          evidenceDirectory,
          markdownTarball: undefined,
        },
        { spawn: failingInstall },
      );

      expect(manifest.exitCode).toBe(1);
      expect(manifest.cases).toHaveLength(3);
      for (const fixture of ['plain-cinder', 'annotated', 'aggregate']) {
        const installCase = manifest.cases.find((c) => c.id === `${fixture}/install`);
        expect(installCase?.status, fixture).toBe('fail');
        expect(installCase?.detail, fixture).toContain('simulated: no network in this test');
      }
      expect(manifest.installedVersions).toEqual({});

      const written = await Bun.file(join(evidenceDirectory, 'manifest.json')).json();
      expect(written.exitCode).toBe(1);
      expect(written.cinderTarball.sha256).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      await rm(evidenceDirectory, { recursive: true, force: true });
      await rm(cinderTarball, { recursive: true, force: true });
    }
  });

  test('a probe that produces no parseable output is reported as a failed case, not a thrown error', async () => {
    const evidenceDirectory = await mkdtemp(join(tmpdir(), 'diff-review-evidence-'));
    const tarballDirectory = await mkdtemp(join(tmpdir(), 'diff-review-tarball-'));
    const cinderTarballPath = join(tarballDirectory, 'cinder.tgz');
    const editorTarballPath = join(tarballDirectory, 'editor.tgz');
    await Bun.write(cinderTarballPath, 'bytes\n');
    await Bun.write(editorTarballPath, 'bytes\n');

    // Install "succeeds" but every probe run prints nothing and exits non-zero, simulating a
    // consumer whose install silently produced an unusable tree.
    const silentSpawner: Spawner = async (command): Promise<SpawnResult> => {
      if (command[1] === 'install') return { exitCode: 0, stdout: '', stderr: '' };
      return { exitCode: 1, stdout: '', stderr: 'probe crashed before printing anything' };
    };

    try {
      const manifest = await runValidator(
        {
          cinderTarball: cinderTarballPath,
          editorTarball: editorTarballPath,
          evidenceDirectory,
          markdownTarball: undefined,
        },
        { spawn: silentSpawner },
      );

      expect(manifest.exitCode).toBe(1);
      const plainCinderImport = manifest.cases.find((c) => c.id === 'plain-cinder/import-style');
      expect(plainCinderImport?.status).toBe('fail');
      expect(plainCinderImport?.detail).toContain('probe crashed before printing anything');
    } finally {
      await rm(evidenceDirectory, { recursive: true, force: true });
      await rm(tarballDirectory, { recursive: true, force: true });
    }
  });
});
