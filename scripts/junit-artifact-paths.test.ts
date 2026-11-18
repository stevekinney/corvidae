import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import { workspaceParentDirectories } from './workspace-directories.ts';

const root = join(import.meta.dir, '..');
const workflow = Bun.file(join(root, '.github/workflows/main.yml'));
// The single-directory workspaces the root manifest lists beside the parent directories (the
// groom script's): each writes its report under its own directory.
const singleWorkspaces = (
  JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { workspaces: string[] }
).workspaces.filter((pattern) => !pattern.endsWith('/*'));
const reportPathPatterns = [
  'test-output/junit/*.xml',
  ...workspaceParentDirectories.map((directory) => `${directory}/*/test-output/junit/*.xml`),
  ...singleWorkspaces.map((directory) => `${directory}/test-output/junit/*.xml`),
];

function writeReport(directory: string, path: string): string {
  const report = join(directory, path);
  mkdirSync(join(report, '..'), { recursive: true });
  writeFileSync(report, '<testsuites />');
  return relative(directory, report);
}

function configuredReportPathBlocks(source: string): string[] {
  return [
    ...source.matchAll(
      /name: junit-(?:root|tests-\$\{\{ strategy\.job-index \}\})\n          path: \|\n((?:            .+\n)+)/g,
    ),
  ].map(([, paths = '']) =>
    paths
      .split('\n')
      .filter(Boolean)
      .map((path) => path.trim())
      .join('\n'),
  );
}

function selectedReports(directory: string): string[] {
  return reportPathPatterns
    .flatMap((pattern) => [...new Bun.Glob(pattern).scanSync({ cwd: directory, onlyFiles: true })])
    .toSorted();
}

describe('JUnit artifact paths', () => {
  test('bound discovery to root and workspaces without descending dependencies', async () => {
    const fixture = mkdtempSync(join(tmpdir(), 'junit-artifact-paths-'));
    try {
      const expected = [
        writeReport(fixture, 'test-output/junit/root.xml'),
        ...singleWorkspaces.map((directory) =>
          writeReport(fixture, `${directory}/test-output/junit/single.xml`),
        ),
        ...workspaceParentDirectories.map((parent) =>
          writeReport(fixture, `${parent}/existing/test-output/junit/existing.xml`),
        ),
        writeReport(fixture, 'packages/newly-added/test-output/junit/new.xml'),
      ].toSorted();
      writeReport(fixture, 'packages/newly-added/node_modules/noise/test-output/junit/noise.xml');
      writeReport(fixture, 'nested/dependency/test-output/junit/noise.xml');
      mkdirSync(join(fixture, 'linked-dependency'), { recursive: true });
      writeReport(fixture, 'linked-dependency/test-output/junit/noise.xml');
      symlinkSync(
        join(fixture, 'linked-dependency'),
        join(fixture, 'packages/newly-added/node_modules/linked-dependency'),
      );

      expect(selectedReports(fixture)).toEqual(expected);
    } finally {
      rmSync(fixture, { force: true, recursive: true });
    }
  });

  test('keeps both JUnit uploads aligned with the workspace directory contract', async () => {
    const expected = reportPathPatterns.join('\n');
    expect(configuredReportPathBlocks(await workflow.text())).toEqual([expected, expected]);
  });
});
