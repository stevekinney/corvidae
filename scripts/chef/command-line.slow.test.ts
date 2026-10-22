import { describe, expect } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

async function invoke(
  script: string,
  args: string[] = [],
  cwd = sandbox,
  env?: Record<string, string>,
) {
  const child = await runWithHangGuard(
    [env === undefined ? 'bun' : process.execPath, join(import.meta.dir, script), ...args],
    { cwd, ...(env === undefined ? {} : { env }) },
  );
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

/**
 * With `--json` the result object goes to standard output whatever the exit code, so a caller that
 * parses it reads a failure the same way as a success; diagnostics stay on standard error. One
 * non-zero run per script that accepts `--json`, each arranged so it needs no credential, network
 * or real repository: an empty `PATH` hides `git`, `gh` and `security`, an unreachable proxy stops
 * a request that a fake key would otherwise send, and the rest fail on their own inputs.
 */
describe('a non-zero result with --json goes to standard output', () => {
  const hermetic = () => ({ PATH: '', HOME: sandbox, TMPDIR: sandbox });

  async function expectJsonFailure(
    run: Promise<{ exitCode: number | null; stdout: string; stderr: string }>,
    expectedCode: number,
  ): Promise<Record<string, unknown>> {
    const result = await run;
    expect(result.exitCode).toBe(expectedCode);
    expect(result.stderr).toBe('');
    return JSON.parse(result.stdout) as Record<string, unknown>;
  }

  scenarios.scenario('credentials.ts resolve', async () => {
    const result = await expectJsonFailure(
      invoke(
        'credentials.ts',
        ['resolve', 'CHEF_NO_SUCH_CREDENTIAL', '--json'],
        sandbox,
        hermetic(),
      ),
      1,
    );
    expect(result).toEqual({
      name: 'CHEF_NO_SUCH_CREDENTIAL',
      source: 'unavailable',
      found: false,
    });
  });

  scenarios.scenario('gate-run.ts read', async () => {
    const log = join(sandbox, 'cut-off.log');
    writeFileSync(log, 'HEAD abc LOAD 1\nstill going\n');
    const result = await expectJsonFailure(invoke('gate-run.ts', ['read', log, '--json']), 1);
    expect(result['head']).toBe('abc');
    expect(result['exitCode']).toBeUndefined();
  });

  scenarios.scenario('gate-run.ts control', async () => {
    const candidate = join(sandbox, 'candidate');
    const base = join(sandbox, 'base');
    for (const directory of [candidate, base]) mkdirSync(directory);
    writeFileSync(join(base, 'marker'), '');
    const result = await expectJsonFailure(
      invoke('gate-run.ts', [
        'control',
        '--candidate',
        candidate,
        '--base',
        base,
        '--command',
        'test -f marker',
        '--iterations',
        '1',
        '--log',
        join(sandbox, 'control.tsv'),
        '--json',
      ]),
      1,
    );
    expect(result).toMatchObject({ candidateFailures: 1, baseFailures: 0, shared: false });
  });

  scenarios.scenario('leftovers.ts', async () => {
    // This test process is alive, so it is a leftover by definition.
    const result = await expectJsonFailure(
      invoke('leftovers.ts', ['--pids', String(process.pid), '--json']),
      1,
    );
    expect(result['found']).toBe(true);
  });

  scenarios.scenario('jev.ts decide', async () => {
    const result = await expectJsonFailure(
      invoke(
        'jev.ts',
        [
          'decide',
          '--question',
          'Is this shared?',
          '--state',
          'A state.',
          '--yes-no',
          '--record',
          join(sandbox, 'jev.jsonl'),
          '--json',
        ],
        sandbox,
        hermetic(),
      ),
      3,
    );
    expect(result['outcome']).toBe('unavailable');
    expect(result['cleared']).toBe(false);
  });

  scenarios.scenario('linear.ts read', async () => {
    const result = await expectJsonFailure(
      invoke('linear.ts', ['read', 'COR-1', '--json'], sandbox, {
        ...hermetic(),
        LINEAR_API_KEY: 'lin_api_fake_key_for_the_command_line_test',
        HTTPS_PROXY: 'http://127.0.0.1:1',
        HTTP_PROXY: 'http://127.0.0.1:1',
      }),
      1,
    );
    expect(result['ok']).toBe(false);
    expect(String(result['error'])).toContain('Linear request failed');
    expect(String(result['error'])).not.toContain('lin_api_fake_key');
  });

  scenarios.scenario('merge-gate.ts', async () => {
    writeFileSync(join(sandbox, 'gate.log'), 'HEAD abc LOAD 1\nGATE_RC=0\n');
    writeFileSync(join(sandbox, 'comment.md'), 'comment\n');
    const result = await expectJsonFailure(
      invoke('merge-gate.ts', [
        '--pr',
        '1',
        '--worktree',
        sandbox,
        '--gate-log',
        join(sandbox, 'gate.log'),
        '--comment-file',
        join(sandbox, 'comment.md'),
        '--dry-run',
        '--json',
      ]),
      1,
    );
    // The sandbox is not a Git repository, so the first step fails before any network call.
    expect(result['failedStep']).toBe('fetch');
  });

  scenarios.scenario('mutation-check.ts', async () => {
    writeFileSync(join(sandbox, 'target.ts'), 'export const x = 1;\n');
    const result = await expectJsonFailure(
      invoke('mutation-check.ts', [
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
        '--json',
      ]),
      1,
    );
    expect(result['ok']).toBe(false);
  });

  scenarios.scenario('note.ts row', async () => {
    const note = join(sandbox, 'run.md');
    writeFileSync(note, '# Run\n\n| Batch | State |\n| --- | --- |\n| A | open |\n');
    const result = await expectJsonFailure(
      invoke('note.ts', [
        'row',
        note,
        '--key',
        'Z',
        '--column',
        'State',
        '--value',
        'done',
        '--json',
      ]),
      1,
    );
    expect(result).toMatchObject({ updated: false, reason: 'key' });
  });

  scenarios.scenario('review-threads.ts list', async () => {
    const result = await expectJsonFailure(
      invoke('review-threads.ts', ['list', 'o/n', '1', '--json'], sandbox, hermetic()),
      1,
    );
    expect(result['ok']).toBe(false);
  });

  scenarios.scenario('worktree.ts remove', async () => {
    const repository = join(sandbox, 'repository');
    mkdirSync(repository);
    await runWithHangGuard(['git', 'init', '-q', '-b', 'main'], { cwd: repository });
    const result = await expectJsonFailure(
      invoke(
        'worktree.ts',
        ['remove', '--provider', 'claude', '--name', 'chef-no-such-worktree', '--json'],
        repository,
      ),
      1,
    );
    expect(result['ok']).toBe(false);
    expect(String(result['error'])).toContain('is not a worktree under the claude root');
  });
});

describe('review-boundary.ts and worktree-scope.ts reject bad usage with exit 2', () => {
  for (const script of ['review-boundary.ts', 'worktree-scope.ts']) {
    scenarios.scenario(
      `${script}: an unknown option, a boolean-looking flag and a missing option`,
      async () => {
        const output = join(sandbox, 'evidence.json');
        const configuration = join(sandbox, 'configuration.json');
        writeFileSync(
          configuration,
          JSON.stringify({ root: sandbox, directories: ['.'], exclusions: [], paths: ['.'] }),
        );
        const attempts = [
          ['capture', '--configuration', configuration, '--output', output, '--bogus', 'x'],
          ['capture', '--configuration', configuration, '--output', output, '--json'],
          ['capture', '--configuration', configuration],
          ['verify', '--configuration', configuration],
          ['bogus'],
        ];
        for (const attempt of attempts) {
          const result = await invoke(script, attempt);
          expect(result.exitCode, `${script} ${attempt.join(' ')}`).toBe(2);
          expect(result.stderr).toContain('usage error');
        }
        // None of them got far enough to write the evidence file.
        expect(existsSync(output)).toBe(false);
      },
    );
  }
});

await scenarios.settled();
