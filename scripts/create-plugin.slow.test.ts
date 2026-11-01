/**
 * COR-1896 — the authoring guide's walkthrough, run as written. The test reads the two commands
 * from the sh block under "Scaffold your first plugin" in `packages/interborough-plugin/README.md`,
 * points their `~/plugins` directory at a temporary one, and runs them: the scaffold must write the
 * folder and `check-plugin` must pass on it, so the guide cannot drift from the scaffold. The runs
 * type-check and start a Bureau, so they sit in the slow lane and run at module scope, as the
 * process-spawn guard requires.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, test } from 'bun:test';

import { runWithHangGuard } from '../testing/testing/src/hang-guard.ts';

const guidePath = join(import.meta.dir, '../packages/interborough-plugin/README.md');
const guide = await readFile(guidePath, 'utf8');
const section = guide.slice(guide.indexOf('## Scaffold your first plugin'));
const commandBlock = /```sh\n([\s\S]*?)```/.exec(section)?.[1] ?? '';
const commands = commandBlock
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line.startsWith('bun scripts/'));

const root = await mkdtemp(join(tmpdir(), 'plugin-guide-'));
afterAll(() => rm(root, { recursive: true, force: true }));

const runCommand = async (command: string) => {
  const [, script, ...rest] = command.replaceAll('~/plugins', root).split(' ');
  const completed = await runWithHangGuard([
    process.execPath,
    join(import.meta.dir, '..', script ?? ''),
    ...rest,
  ]);
  return {
    exitCode: completed.exitCode,
    output: `${completed.stdout.toString()}${completed.stderr.toString()}`,
  };
};

const results = [];
for (const command of commands) results.push(await runCommand(command));

describe('the authoring guide walkthrough', () => {
  test('the guide holds the scaffold command and the check command', () => {
    expect(commands).toHaveLength(2);
    expect(commands[0]).toContain('scripts/create-plugin.ts example --to');
    expect(commands[1]).toContain('scripts/check-plugin.ts');
  });

  test('the scaffold command writes the plugin and check-plugin passes on it', async () => {
    expect(results[0]?.exitCode).toBe(0);
    expect(await Bun.file(join(root, 'example/plugin.ts')).exists()).toBe(true);
    expect(results[1]).toEqual({ exitCode: 0, output: '' });
  });
});
