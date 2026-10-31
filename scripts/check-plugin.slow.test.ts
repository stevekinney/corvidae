/**
 * COR-1883 — `create-plugin.ts` then `check-plugin.ts`, end to end: the scaffold passes, and a type
 * error or an agent file naming a contribution nothing holds fails it. The runs type-check and
 * start a Bureau, so they sit in the slow lane and run at module scope, as the process-spawn guard
 * requires.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, test } from 'bun:test';

import { runWithHangGuard } from '../testing/testing/src/hang-guard.ts';

const root = await mkdtemp(join(tmpdir(), 'check-plugin-'));
afterAll(() => rm(root, { recursive: true, force: true }));

const run = async (script: string, ...args: string[]) => {
  const completed = await runWithHangGuard([
    process.execPath,
    join(import.meta.dir, script),
    ...args,
  ]);
  return {
    exitCode: completed.exitCode,
    output: `${completed.stdout.toString()}${completed.stderr.toString()}`,
  };
};

const created = await run('create-plugin.ts', 'example', '--to', root);
const folder = join(root, 'example');
const passing = await run('check-plugin.ts', folder);

const pluginPath = join(folder, 'plugin.ts');
const original = await readFile(pluginPath, 'utf8');
await writeFile(pluginPath, `${original}\nexport const broken: number = 'text';\n`);
const typeError = await run('check-plugin.ts', folder);
await writeFile(pluginPath, original);

const agentPath = join(folder, 'content/agents/assistant.md');
const agent = await readFile(agentPath, 'utf8');
await writeFile(agentPath, agent.replace('[example:greet]', '[example:greet, example:absent]'));
const unresolved = await run('check-plugin.ts', folder);

await writeFile(agentPath, agent.replace('anthropic/claude-opus-5-5', 'anthropic/no-such-model'));
const unknownModel = await run('check-plugin.ts', folder);
await writeFile(agentPath, agent);

const missing = await run('check-plugin.ts', join(root, 'nothing-here'));

describe('create-plugin then check-plugin', () => {
  test('the scaffold is written and passes the check', () => {
    expect(created.exitCode).toBe(0);
    expect(passing).toEqual({ exitCode: 0, output: '' });
  });

  test('a type error fails the check and names the file', () => {
    expect(typeError.exitCode).toBe(1);
    expect(typeError.output).toContain(`${folder}/plugin.ts(`);
    expect(typeError.output).toContain('TS2322');
  });

  test('an agent file naming a contribution nothing holds fails the check', () => {
    expect(unresolved.exitCode).toBe(1);
    expect(unresolved.output).toContain('reference-unresolved');
    expect(unresolved.output).toContain('example:absent');
  });

  test('an agent file naming a model nothing holds fails the check', () => {
    expect(unknownModel.exitCode).toBe(1);
    expect(unknownModel.output).toContain('example:assistant');
    expect(unknownModel.output).toContain('unknown-model');
  });

  test('a folder with no plugin.ts fails the check', () => {
    expect(missing.exitCode).toBe(1);
    expect(missing.output).toContain('has no plugin.ts');
  });
});
