#!/usr/bin/env bun
// Chef mutation check: proves a test fails without the fix it guards. It applies one textual
// mutation to a file (the fix removed or the guard weakened), runs a command, reports whether the
// command went red, and restores the file in a `finally`. The restore is verified by SHA-256 and a
// mismatch is a loud failure, because a mutation left behind in a worktree is a silent defect.
//
// Usage:
//   bun scripts/chef/mutation-check.ts --file <path> --from <text> --to <text> --command <shell>
//        [--cwd <dir>] [--expect red|green] [--log <file>] [--name <label>] [--json]
//   bun scripts/chef/mutation-check.ts --spec <json> [--log <file>] [--json]
//
// A spec is a JSON array of { name, file, from, to, command, cwd?, expect? }, run in turn. `file`
// resolves against `cwd` when one is given. `from` must occur exactly once in the file; anything
// else is a usage error, raised before any file in the spec is touched. The command's output goes to
// the log (truncated at the start of a run), never to stdout; the report holds one line per
// mutation: its name, red (the command failed) or green, and the parsed bun test counts.
//
// Exit codes: 0 every mutation matched its expectation (default `red`), 1 a mutation survived
// or a restore failed, 2 invalid CLI usage.

import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import {
  defaultRunner,
  emitResult,
  parseOptions,
  type Runner,
  UsageError,
} from './process-runner.ts';

export { UsageError };

export type Expectation = 'red' | 'green';

export interface Mutation {
  name: string;
  file: string;
  from: string;
  to: string;
  command: string;
  cwd?: string;
  expect: Expectation;
}

export interface TestCounts {
  pass: number | undefined;
  fail: number | undefined;
  failing: string[];
}

export interface MutationResult {
  name: string;
  verdict: Expectation;
  expected: Expectation;
  matched: boolean;
  exitCode: number;
  counts: TestCounts;
  /** False when the file's SHA-256 after the restore differs from the one before the mutation. */
  restored: boolean;
  restoreError?: string;
}

export interface MutationDependencies {
  runner?: Runner;
  /** Writes `file`; injectable so a test can corrupt a restore. Defaults to `writeFileSync`. */
  writeFile?: (path: string, data: Buffer) => void;
  /** Checked between mutations; true stops the run after the current restore. */
  shouldStop?: () => boolean;
}

export function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');
}

/** Parse a `bun test` summary: ` N pass`, ` N fail` and the `(fail) ` names. */
export function parseTestCounts(output: string): TestCounts {
  const clean = stripAnsi(output);
  const pass = /^\s*(\d+) pass\b/m.exec(clean)?.[1];
  const fail = /^\s*(\d+) fail\b/m.exec(clean)?.[1];
  const failing = [
    ...new Set(
      [...clean.matchAll(/^\(fail\) (.+?)(?: \[[\d.]+m?s\])?\s*$/gm)].map(
        (match) => match[1] as string,
      ),
    ),
  ];
  return {
    pass: pass === undefined ? undefined : Number(pass),
    fail: fail === undefined ? undefined : Number(fail),
    failing,
  };
}

/** Occurrences of `needle` in `haystack`, not counting overlaps. */
export function countOccurrences(haystack: string, needle: string): number {
  if (needle === '') return 0;
  return haystack.split(needle).length - 1;
}

function pathOf(mutation: Mutation): string {
  return resolve(mutation.cwd ?? process.cwd(), mutation.file);
}

/** Throw a `UsageError` unless every mutation's file exists and holds `from` exactly once. */
export function validateMutations(mutations: Mutation[]): void {
  for (const mutation of mutations) {
    if (mutation.from === '') throw new UsageError(`${mutation.name}: --from cannot be empty.`);
    if (mutation.from === mutation.to)
      throw new UsageError(`${mutation.name}: --from and --to are the same text.`);
    const path = pathOf(mutation);
    if (!existsSync(path)) throw new UsageError(`${mutation.name}: no such file ${path}`);
    const occurrences = countOccurrences(readFileSync(path, 'utf8'), mutation.from);
    if (occurrences !== 1)
      throw new UsageError(
        `${mutation.name}: the text to replace occurs ${occurrences} times in ${path}; it must occur exactly once.`,
      );
  }
}

/** Apply one mutation, run its command, and restore the file with a verified checksum. */
export function runMutation(
  mutation: Mutation,
  log: string | undefined,
  dependencies: MutationDependencies = {},
): MutationResult {
  const runner = dependencies.runner ?? defaultRunner;
  const writeFile =
    dependencies.writeFile ?? ((path: string, data: Buffer) => writeFileSync(path, data));
  const path = pathOf(mutation);
  const original = readFileSync(path);
  const before = sha256(original);
  const text = original.toString('utf8');
  if (countOccurrences(text, mutation.from) !== 1)
    throw new UsageError(
      `${mutation.name}: the text to replace no longer occurs exactly once in ${path}.`,
    );
  const index = text.indexOf(mutation.from);
  const mutated = Buffer.from(
    text.slice(0, index) + mutation.to + text.slice(index + mutation.from.length),
  );
  let outcome: { code: number; stdout: string; stderr: string } | undefined;
  let restoreError: string | undefined;
  try {
    writeFile(path, mutated);
    outcome = runner(
      ['sh', '-c', mutation.command],
      mutation.cwd === undefined ? {} : { cwd: mutation.cwd },
    );
  } finally {
    try {
      writeFile(path, original);
    } catch (error) {
      restoreError = `could not write the original back: ${String(error)}`;
    }
    if (restoreError === undefined) {
      const after = sha256(readFileSync(path));
      if (after !== before) restoreError = `SHA-256 after restore is ${after}, expected ${before}`;
    }
  }
  const combined = `${outcome?.stdout ?? ''}\n${outcome?.stderr ?? ''}`;
  if (log !== undefined)
    appendFileSync(
      log,
      `=== ${mutation.name} (exit ${outcome?.code ?? 'none'}) ===\n$ ${mutation.command}\n${combined}\n${restoreError === undefined ? 'restored: sha256 verified' : `RESTORE FAILED: ${restoreError}`}\n\n`,
    );
  const exitCode = outcome?.code ?? 1;
  const verdict: Expectation = exitCode === 0 ? 'green' : 'red';
  return {
    name: mutation.name,
    verdict,
    expected: mutation.expect,
    matched: verdict === mutation.expect && restoreError === undefined,
    exitCode,
    counts: parseTestCounts(combined),
    restored: restoreError === undefined,
    ...(restoreError === undefined ? {} : { restoreError }),
  };
}

/** Run each mutation in turn. A failed restore stops the run, because the file is no longer trustworthy. */
export function runMutations(
  mutations: Mutation[],
  log: string | undefined,
  dependencies: MutationDependencies = {},
): MutationResult[] {
  validateMutations(mutations);
  if (log !== undefined) writeFileSync(log, '');
  const results: MutationResult[] = [];
  for (const mutation of mutations) {
    if (dependencies.shouldStop?.() === true) break;
    const result = runMutation(mutation, log, dependencies);
    results.push(result);
    if (!result.restored) break;
  }
  return results;
}

function describeCounts(counts: TestCounts): string {
  const parts: string[] = [];
  if (counts.pass !== undefined) parts.push(`${counts.pass} pass`);
  if (counts.fail !== undefined) parts.push(`${counts.fail} fail`);
  if (parts.length === 0) parts.push('no bun test summary');
  return parts.join(', ');
}

export function renderResult(result: MutationResult): string {
  if (!result.restored)
    return `RESTORE FAILED ${result.name}: ${result.restoreError} (the file may still hold the mutation; check git diff)`;
  const status = result.matched ? 'ok      ' : 'SURVIVED';
  const note = result.matched ? '' : ` (expected ${result.expected})`;
  const failing =
    result.counts.failing.length === 0
      ? ''
      : ` [${result.counts.failing.slice(0, 3).join('; ')}${result.counts.failing.length > 3 ? `; +${result.counts.failing.length - 3} more` : ''}]`;
  return `${status} ${result.name}: ${result.verdict}${note}, exit ${result.exitCode}, ${describeCounts(result.counts)}${failing}`;
}

function expectationOf(value: unknown, where: string): Expectation {
  if (value === undefined) return 'red';
  if (value !== 'red' && value !== 'green')
    throw new UsageError(`${where}: expect must be "red" or "green".`);
  return value;
}

/** Read and validate a `--spec` file's shape. */
export function readSpec(path: string): Mutation[] {
  if (!existsSync(path)) throw new UsageError(`No such spec file: ${path}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new UsageError(`Could not read the spec ${path}: ${String(error)}`);
  }
  if (!Array.isArray(parsed) || parsed.length === 0)
    throw new UsageError('A spec is a non-empty JSON array of mutations.');
  return parsed.map((entry: unknown, index: number): Mutation => {
    const where = `spec entry ${index + 1}`;
    const item = (entry ?? {}) as Record<string, unknown>;
    for (const field of ['name', 'file', 'from', 'to', 'command']) {
      if (typeof item[field] !== 'string')
        throw new UsageError(`${where} needs a string "${field}".`);
    }
    if (item['cwd'] !== undefined && typeof item['cwd'] !== 'string')
      throw new UsageError(`${where}: cwd must be a string.`);
    return {
      name: item['name'] as string,
      file: item['file'] as string,
      from: item['from'] as string,
      to: item['to'] as string,
      command: item['command'] as string,
      ...(typeof item['cwd'] === 'string' ? { cwd: item['cwd'] } : {}),
      expect: expectationOf(item['expect'], where),
    };
  });
}

export function run(
  argv: string[],
  dependencies: MutationDependencies = {},
): { code: number; output: string } {
  const parsed = parseOptions(argv, {
    values: ['file', 'from', 'to', 'command', 'cwd', 'expect', 'log', 'spec', 'name'],
    flags: ['json'],
  });
  if (parsed.positionals.length > 0)
    throw new UsageError(`Unexpected argument ${parsed.positionals[0]}.`);
  const values = parsed.values;
  let mutations: Mutation[];
  if (values['spec'] !== undefined) {
    for (const conflicting of ['file', 'from', 'to', 'command', 'cwd', 'expect', 'name']) {
      if (values[conflicting] !== undefined)
        throw new UsageError(`--spec cannot be combined with --${conflicting}.`);
    }
    mutations = readSpec(values['spec']);
  } else {
    for (const name of ['file', 'from', 'to', 'command']) {
      // `--to` may be empty (deleting the guard), so only absence is an error.
      if (values[name] === undefined)
        throw new UsageError(`--${name} is required (or give --spec).`);
    }
    mutations = [
      {
        name: values['name'] ?? basename(values['file'] as string),
        file: values['file'] as string,
        from: values['from'] as string,
        to: values['to'] as string,
        command: values['command'] as string,
        ...(values['cwd'] === undefined ? {} : { cwd: values['cwd'] }),
        expect: expectationOf(values['expect'], '--expect'),
      },
    ];
  }
  const results = runMutations(mutations, values['log'], dependencies);
  const stopped = results.length < mutations.length;
  const ok = !stopped && results.every((result) => result.matched);
  return {
    code: ok ? 0 : 1,
    output: parsed.flags.has('json')
      ? JSON.stringify({ ok, stopped, results })
      : [
          ...results.map(renderResult),
          ...(stopped ? [`stopped after ${results.length} of ${mutations.length} mutations`] : []),
        ].join('\n'),
  };
}

if (import.meta.main) {
  // A signal must not skip the restore. Registering a handler keeps the process alive until the
  // synchronous command returns, so the `finally` in `runMutation` still runs.
  let interrupted = false;
  for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.on(signal, () => (interrupted = true));
  try {
    const { code, output } = run(Bun.argv.slice(2), {
      shouldStop: () => interrupted,
    });
    emitResult(Bun.argv.slice(2), { code, output });
    process.exitCode = code;
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}
