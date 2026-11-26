import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SWEEP_CATEGORIES } from './design-coverage.ts';
import {
  designVerdictPath,
  failingVerdictRows,
  run,
  UsageError,
  verdictFileProblems,
} from './design-verdict.ts';

const HEAD = 'a'.repeat(40);

const SWEEP = SWEEP_CATEGORIES.map(
  (category) => `sweep | ${category} | clear | looked at every screen`,
);

/** A capture with one screen, and a complete ledger for it; `screenLine` replaces its verdict. */
function coverage(
  directory: string,
  screenLine = 'screen | screens/runs--1280--light.png | good | The runs list leads with each run and its status, readable at a glance.',
  extra: readonly string[] = [],
): string[] {
  const capture = join(directory, 'capture');
  mkdirSync(join(capture, 'screens'), { recursive: true });
  writeFileSync(join(capture, 'screens', 'runs--1280--light.png'), '');
  const ledger = join(directory, 'coverage-ledger.txt');
  writeFileSync(ledger, [screenLine, ...SWEEP, ...extra].join('\n'));
  return ['--capture', capture, '--ledger', ledger];
}

function withDirectory(body: (directory: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), 'design-verdict-'));
  try {
    body(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe('design-verdict record', () => {
  test('writes a well-formed verdicts file into the state directory, never the worktree', () => {
    withDirectory((directory) => {
      const rows = join(directory, 'rows.txt');
      writeFileSync(rows, '11a | matches |\n11b | deferred | the issue defers it to COR-9\n');
      const state = join(directory, 'state');
      const result = run([
        'record',
        '--head',
        HEAD,
        '--file',
        rows,
        '--state-directory',
        state,
        ...coverage(directory),
      ]);
      expect(result.code).toBe(0);
      const target = designVerdictPath(state, HEAD);
      expect(readFileSync(target, 'utf8')).toContain('11b | deferred');
      expect(target.startsWith(state)).toBe(true);
      expect(failingVerdictRows(readFileSync(target, 'utf8'))).toEqual([]);
    });
  });

  test('refuses an unknown verdict word and writes nothing', () => {
    withDirectory((directory) => {
      const rows = join(directory, 'rows.txt');
      writeFileSync(rows, '11a | looks-fine | ok\n');
      const state = join(directory, 'state');
      const result = run([
        'record',
        '--head',
        HEAD,
        '--file',
        rows,
        '--state-directory',
        state,
        ...coverage(directory),
      ]);
      expect(result.code).toBe(1);
      expect(result.output).toContain('"looks-fine" is not one of');
      expect(existsSync(designVerdictPath(state, HEAD))).toBe(false);
    });
  });

  test('refuses a row that is not three fields, an empty file and a missing reason', () => {
    expect(verdictFileProblems('11a | matches')[0]).toContain(
      'expected "row-id | verdict | evidence"',
    );
    expect(verdictFileProblems('')).toEqual(['the verdicts file has no rows']);
    expect(verdictFileProblems('11a | drifted |')[0]).toContain('drifted needs evidence');
  });

  test('records a failing verdict and says landing will refuse it', () => {
    withDirectory((directory) => {
      const rows = join(directory, 'rows.txt');
      writeFileSync(rows, '11a | drifted | the card is 1950px wide\n');
      const result = run([
        'record',
        '--head',
        HEAD,
        '--file',
        rows,
        '--state-directory',
        join(directory, 'state'),
        ...coverage(directory),
      ]);
      expect(result.code).toBe(0);
      expect(result.output).toContain('landing refuses: 11a: drifted');
    });
  });

  test('needs the record command, a full head and a state directory', () => {
    expect(() => run(['write'])).toThrow(UsageError);
    expect(() => run(['record', '--head', 'abc', '--file', 'x', '--state-directory', 'y'])).toThrow(
      UsageError,
    );
    expect(() => run(['record', '--head', HEAD, '--file', 'x'])).toThrow(UsageError);
    expect(() => run(['record', '--head', HEAD, '--file', 'x', '--state-directory', 'y'])).toThrow(
      '--capture and --ledger are required',
    );
  });

  test('refuses a review whose coverage ledger skipped a capture, and writes nothing', () => {
    withDirectory((directory) => {
      const rows = join(directory, 'rows.txt');
      writeFileSync(rows, '11a | matches |\n');
      const state = join(directory, 'state');
      const flags = coverage(directory);
      writeFileSync(join(directory, 'capture', 'screens', 'runs-filter-open--1280--light.png'), '');
      const result = run([
        'record',
        '--head',
        HEAD,
        '--file',
        rows,
        '--state-directory',
        state,
        ...flags,
      ]);
      expect(result.code).toBe(1);
      expect(result.output).toContain(
        'no cold verdict for screens/runs-filter-open--1280--light.png',
      );
      expect(existsSync(designVerdictPath(state, HEAD))).toBe(false);
    });
  });

  test('a ledger that blocks approval records a failing coverage row, so landing refuses', () => {
    withDirectory((directory) => {
      const rows = join(directory, 'rows.txt');
      writeFileSync(rows, '11a | matches |\n');
      const state = join(directory, 'state');
      const flags = coverage(
        directory,
        'screen | screens/runs--1280--light.png | wrong | The filter form hides behind a disclosure and its last row floats off line.',
        ['state | the run menu opened | not captured'],
      );
      const result = run([
        'record',
        '--head',
        HEAD,
        '--file',
        rows,
        '--state-directory',
        state,
        ...flags,
      ]);
      expect(result.code).toBe(0);
      const recorded = readFileSync(designVerdictPath(state, HEAD), 'utf8');
      expect(failingVerdictRows(recorded)).toEqual(['coverage-ledger: unverified']);
      expect(recorded).toContain(
        'screens/runs--1280--light.png: wrong; state the run menu opened: not captured',
      );
      expect(existsSync(designVerdictPath(state, HEAD).replace(/\.verdicts$/, '.ledger'))).toBe(
        true,
      );
    });
  });
});
