import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  countOccurrences,
  parseTestCounts,
  readSpec,
  renderResult,
  run,
  runMutation,
  runMutations,
  sha256,
  UsageError,
  type Mutation,
} from './mutation-check.ts';
import type { Runner } from './process-runner.ts';

let sandbox: string;
let target: string;

const SOURCE =
  "export function guard(x) {\r\n  if (!x) throw new Error('bad ünïcode');\r\n  return x;\r\n}\r\n";

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'mutation-check-'));
  target = join(sandbox, 'target.ts');
  writeFileSync(target, SOURCE);
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

/** A command that is red exactly when the guard text is missing, printing a bun-style summary. */
const guardCommand = `if grep -q "throw new Error" target.ts; then printf ' 4 pass\\n 0 fail\\n'; else printf '(fail) guard > throws on bad input [0.40ms]\\n 3 pass\\n 1 fail\\n' >&2; exit 1; fi`;

function mutation(overrides: Partial<Mutation> = {}): Mutation {
  return {
    name: 'remove the guard',
    file: 'target.ts',
    from: "throw new Error('bad ünïcode');",
    to: '',
    command: guardCommand,
    cwd: sandbox,
    expect: 'red',
    ...overrides,
  };
}

describe('parsing', () => {
  test('reads pass and fail counts and failing names from a bun summary, ignoring ANSI codes', () => {
    const output =
      '\u001b[31m(fail) suite > a test [1.20ms]\u001b[0m\n(fail) suite > a test [1.20ms]\n(fail) other > second\n 12 pass\n 2 fail\nRan 14 tests';
    expect(parseTestCounts(output)).toEqual({
      pass: 12,
      fail: 2,
      failing: ['suite > a test', 'other > second'],
    });
    expect(parseTestCounts('nothing useful')).toEqual({
      pass: undefined,
      fail: undefined,
      failing: [],
    });
  });

  test('counts non-overlapping occurrences and none for an empty needle', () => {
    expect(countOccurrences('aXbXc', 'X')).toBe(2);
    expect(countOccurrences('aaa', 'aa')).toBe(1);
    expect(countOccurrences('abc', '')).toBe(0);
  });

  test('hashes bytes', () => {
    expect(sha256('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });
});

describe('runMutation', () => {
  test('goes red when the guard is removed, and restores the file byte for byte', () => {
    const log = join(sandbox, 'run.log');
    const result = runMutation(mutation(), log);
    expect(result).toMatchObject({
      verdict: 'red',
      matched: true,
      restored: true,
      exitCode: 1,
    });
    expect(result.counts).toEqual({
      pass: 3,
      fail: 1,
      failing: ['guard > throws on bad input'],
    });
    expect(readFileSync(target)).toEqual(Buffer.from(SOURCE));
    const logText = readFileSync(log, 'utf8');
    expect(logText).toContain('=== remove the guard (exit 1) ===');
    expect(logText).toContain('restored: sha256 verified');
  });

  test('a mutation that survives is green, unmatched and still restored', () => {
    const result = runMutation(mutation({ from: 'return x;', to: 'return x ;' }), undefined);
    expect(result).toMatchObject({
      verdict: 'green',
      matched: false,
      restored: true,
    });
    expect(renderResult(result)).toContain('SURVIVED');
    expect(renderResult(result)).toContain('expected red');
    expect(readFileSync(target, 'utf8')).toBe(SOURCE);
  });

  test('--expect green matches a command that stays green', () => {
    const result = runMutation(
      mutation({ from: 'return x;', to: 'return x ;', expect: 'green' }),
      undefined,
    );
    expect(result.matched).toBe(true);
  });

  test('restores the original when the runner throws', () => {
    const exploding: Runner = () => {
      throw new Error('runner blew up');
    };
    expect(() => runMutation(mutation(), undefined, { runner: exploding })).toThrow(
      'runner blew up',
    );
    expect(readFileSync(target, 'utf8')).toBe(SOURCE);
  });

  test('sees the mutated text while the command runs', () => {
    let seen = '';
    const spy: Runner = () => {
      seen = readFileSync(target, 'utf8');
      return { code: 1, stdout: '', stderr: '' };
    };
    runMutation(mutation(), undefined, { runner: spy });
    expect(seen).not.toContain('throw new Error');
    expect(seen.endsWith('\r\n')).toBe(true);
  });

  test("fails loudly when the restored file's SHA-256 differs", () => {
    let writes = 0;
    const corrupting = (path: string, data: Buffer) => {
      writes += 1;
      // The first write is the mutation; the second is the restore, which is corrupted.
      writeFileSync(path, writes === 2 ? Buffer.concat([data, Buffer.from('// stray')]) : data);
    };
    const result = runMutation(mutation(), undefined, {
      writeFile: corrupting,
    });
    expect(result.restored).toBe(false);
    expect(result.matched).toBe(false);
    expect(result.restoreError).toContain('SHA-256 after restore');
    expect(renderResult(result)).toContain('RESTORE FAILED');
  });

  test('reports a restore write that throws', () => {
    let writes = 0;
    const failing = (path: string, data: Buffer) => {
      writes += 1;
      if (writes === 2) throw new Error('EACCES');
      writeFileSync(path, data);
    };
    const result = runMutation(mutation(), undefined, { writeFile: failing });
    expect(result.restored).toBe(false);
    expect(result.restoreError).toContain('EACCES');
  });
});

describe('runMutations', () => {
  test('refuses a text that occurs zero or several times, before touching any file', () => {
    const marker = join(sandbox, 'ran');
    const first = mutation({
      name: 'first',
      command: `touch ${marker}; exit 1`,
    });
    expect(() =>
      runMutations([first, mutation({ name: 'none', from: 'no such text' })], undefined),
    ).toThrow(UsageError);
    expect(existsSync(marker)).toBe(false);
    writeFileSync(target, 'a a');
    expect(() => runMutations([mutation({ from: 'a' })], undefined)).toThrow('occurs 2 times');
    expect(readFileSync(target, 'utf8')).toBe('a a');
    expect(() => runMutations([mutation({ file: 'missing.ts' })], undefined)).toThrow(
      'no such file',
    );
    expect(() => runMutations([mutation({ from: '' })], undefined)).toThrow(UsageError);
    expect(() => runMutations([mutation({ from: 'x', to: 'x' })], undefined)).toThrow(UsageError);
  });

  test('stops after a failed restore and reports the skipped mutations', () => {
    let writes = 0;
    const corrupting = (path: string, data: Buffer) => {
      writes += 1;
      writeFileSync(path, writes === 2 ? Buffer.from('garbage') : data);
    };
    const results = runMutations(
      [mutation({ name: 'one' }), mutation({ name: 'two', from: 'return x;' })],
      undefined,
      {
        writeFile: corrupting,
      },
    );
    expect(results.map((result) => result.name)).toEqual(['one']);
  });

  test('stops between mutations when asked to', () => {
    let stop = false;
    const runner: Runner = () => {
      stop = true;
      return { code: 1, stdout: '', stderr: '' };
    };
    const results = runMutations(
      [mutation({ name: 'one' }), mutation({ name: 'two', from: 'return x;' })],
      undefined,
      {
        runner,
        shouldStop: () => stop,
      },
    );
    expect(results).toHaveLength(1);
    expect(readFileSync(target, 'utf8')).toBe(SOURCE);
  });
});

describe('run', () => {
  const base = () => [
    '--file',
    'target.ts',
    '--from',
    "throw new Error('bad ünïcode');",
    '--to',
    '',
    '--command',
    guardCommand,
    '--cwd',
    sandbox,
  ];

  test('reports one line per mutation, exits 0 on red and keeps the command output out of stdout', () => {
    const log = join(sandbox, 'out.log');
    const result = run([...base(), '--name', 'no guard', '--log', log]);
    expect(result.code).toBe(0);
    expect(result.output).toBe(
      'ok       no guard: red, exit 1, 3 pass, 1 fail [guard > throws on bad input]',
    );
    expect(readFileSync(log, 'utf8')).toContain('(fail) guard > throws on bad input');
  });

  test('exits 1 when a mutation survives and 0 when it is expected green', () => {
    const survivor = [
      '--file',
      'target.ts',
      '--from',
      'return x;',
      '--to',
      'return x ;',
      '--command',
      guardCommand,
      '--cwd',
      sandbox,
    ];
    expect(run(survivor).code).toBe(1);
    expect(run([...survivor, '--expect', 'green']).code).toBe(0);
  });

  test('runs a spec in order and reports each mutation as JSON', () => {
    const spec = join(sandbox, 'spec.json');
    writeFileSync(
      spec,
      JSON.stringify([
        {
          name: 'guard',
          file: 'target.ts',
          from: "throw new Error('bad ünïcode');",
          to: '',
          command: guardCommand,
          cwd: sandbox,
        },
        {
          name: 'return',
          file: 'target.ts',
          from: 'return x;',
          to: 'return x ;',
          command: guardCommand,
          cwd: sandbox,
          expect: 'green',
        },
      ]),
    );
    const result = run(['--spec', spec, '--json']);
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.output);
    expect(
      parsed.results.map((entry: { name: string; verdict: string }) => [entry.name, entry.verdict]),
    ).toEqual([
      ['guard', 'red'],
      ['return', 'green'],
    ]);
    expect(readFileSync(target, 'utf8')).toBe(SOURCE);
  });

  test('rejects bad usage', () => {
    expect(() => run([])).toThrow(UsageError);
    expect(() => run(['--file', 'x'])).toThrow(UsageError);
    expect(() => run([...base(), '--expect', 'maybe'])).toThrow(UsageError);
    expect(() => run([...base(), 'extra'])).toThrow(UsageError);
    expect(() => run([...base(), '--spec', 's.json'])).toThrow(UsageError);
    expect(() => run(['--spec', join(sandbox, 'missing.json')])).toThrow(UsageError);
    const bad = join(sandbox, 'bad.json');
    writeFileSync(bad, JSON.stringify([{ name: 'x' }]));
    expect(() => readSpec(bad)).toThrow(UsageError);
    writeFileSync(bad, '[]');
    expect(() => readSpec(bad)).toThrow(UsageError);
    writeFileSync(bad, '{');
    expect(() => readSpec(bad)).toThrow(UsageError);
  });
});
