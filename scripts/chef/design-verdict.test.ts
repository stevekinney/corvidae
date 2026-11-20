import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  designVerdictPath,
  failingVerdictRows,
  run,
  UsageError,
  verdictFileProblems,
} from './design-verdict.ts';

const HEAD = 'a'.repeat(40);

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
      const result = run(['record', '--head', HEAD, '--file', rows, '--state-directory', state]);
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
      const result = run(['record', '--head', HEAD, '--file', rows, '--state-directory', state]);
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
  });
});
