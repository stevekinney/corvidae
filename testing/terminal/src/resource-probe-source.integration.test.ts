import { rejectionOf } from '@lostgradient/testing';
import { runWithHangGuard } from '@lostgradient/testing/hang-guard';
import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { sourceSha } from './resource-probe.ts';

async function git(directory: string, ...command: string[]): Promise<void> {
  const result = await runWithHangGuard(
    ['git', '-c', 'user.name=probe', '-c', 'user.email=probe@example.test', ...command],
    { cwd: directory },
  );
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
}

/** A committed repository holding the files the resource probe reads or loads by path. */
async function repository(): Promise<string> {
  const directory = mkdtempSync(join(tmpdir(), 'resource-probe-source-'));
  for (const path of [
    'testing/terminal/src/resource-probe.ts',
    'components/terminal/scripts/engine-probe.ts',
    'documentation/terminal/contract.md',
  ]) {
    mkdirSync(dirname(join(directory, path)), { recursive: true });
    writeFileSync(join(directory, path), 'committed\n');
  }
  await git(directory, 'init', '--quiet');
  await git(directory, 'add', '.');
  await git(directory, 'commit', '--quiet', '-m', 'probe source');
  return directory;
}

const changed = [
  'testing/terminal/src/resource-probe.ts',
  'components/terminal/scripts/engine-probe.ts',
  'documentation/terminal/contract.md',
];

// The processes run here, at module scope, so no test pays a child's boot on its own clock.
const clean = await repository();
const committed = await sourceSha(clean);
const refusals = new Map<string, unknown>();
for (const path of changed) {
  const directory = await repository();
  writeFileSync(join(directory, path), 'edited\n');
  refusals.set(path, await rejectionOf(sourceSha(directory)));
  rmSync(directory, { recursive: true, force: true });
}
rmSync(clean, { recursive: true, force: true });

test('a committed probe source gives the commit it is at', () => {
  expect(committed).toMatch(/^[0-9a-f]{40}$/);
});

test.each(changed)('an uncommitted change to %s makes the resource probe refuse', (path) => {
  const refusal = refusals.get(path);
  expect(refusal).toBeInstanceOf(Error);
  expect((refusal as Error).message).toContain('resource probe source is dirty');
});
