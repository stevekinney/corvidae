import { expect } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runWithHangGuard } from '../hang-guard.ts';
import { createScenarios } from './scenario.test-support.ts';

/**
 * The `import.meta.main` block of each script: a usage error exits 2 and a real invocation exits
 * with the documented code. Every script's logic is covered in process by its own test file; these
 * start a `bun` child per case, so they run at module scope in the slow lane.
 */

let sandbox = '';
const scenarios = createScenarios({
  setUp() {
    sandbox = mkdtempSync(join(tmpdir(), 'chef-command-line-'));
  },
  tearDown() {
    rmSync(sandbox, { recursive: true, force: true });
  },
});

async function invoke(script: string, args: string[] = [], cwd = sandbox) {
  const child = await runWithHangGuard(['bun', join(import.meta.dir, script), ...args], { cwd });
  return {
    exitCode: child.exitCode,
    stdout: child.stdout.toString(),
    stderr: child.stderr.toString(),
  };
}

for (const script of [
  'note.ts',
  'linear.ts',
  'mutation-check.ts',
  'review-threads.ts',
  'transcript-usage.ts',
  'credentials.ts',
  'jev.ts',
  'merge-gate.ts',
  'repository-config.ts',
  'worktree.ts',
  'gate-run.ts',
]) {
  const expected = script === 'repository-config.ts' ? 0 : 2;
  scenarios.scenario(`${script} with no arguments exits ${expected}`, async () => {
    const result = await invoke(script);
    expect(result.exitCode).toBe(expected);
  });
}

scenarios.scenario('note.ts stats exits 0 for a note', async () => {
  const path = join(sandbox, 'run.md');
  writeFileSync(path, '# Run\n\n## State\n\nbody\n');
  const result = await invoke('note.ts', ['stats', path]);
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain('note:');
  expect(existsSync(path)).toBe(true);
});

scenarios.scenario('review-threads.ts rejects a repository that is not owner/name', async () => {
  const result = await invoke('review-threads.ts', ['list', 'nonsense', '1']);
  expect(result.exitCode).toBe(2);
});

scenarios.scenario('transcript-usage.ts exits 0 on a transcript directory', async () => {
  writeFileSync(
    join(sandbox, 'coordinator.jsonl'),
    `${JSON.stringify({
      type: 'assistant',
      sessionId: 's',
      timestamp: '2026-01-01T00:00:00Z',
      message: {
        id: 'm1',
        model: 'claude-opus-4',
        role: 'assistant',
        content: [{ type: 'text', text: 'x' }],
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0 },
      },
    })}\n`,
  );
  const result = await invoke('transcript-usage.ts', [sandbox]);
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain('Totals by provider and model:');
});

scenarios.scenario('mutation-check.ts exits 1 on a survivor and restores the file', async () => {
  const source = 'export const x = 1;\n';
  const target = join(sandbox, 'target.ts');
  writeFileSync(target, source);
  const result = await invoke('mutation-check.ts', [
    '--file',
    'target.ts',
    '--from',
    'x = 1',
    '--to',
    'x = 2',
    '--command',
    'true',
    '--cwd',
    sandbox,
  ]);
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain('SURVIVED');
  expect(readFileSync(target, 'utf8')).toBe(source);
});

await scenarios.settled();
