import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  countLines,
  escapeCell,
  localTimestamp,
  logPathFor,
  replaceSection,
  run,
  splitRow,
  updateRow,
  writeAtomically,
} from './note.ts';
import { UsageError } from './process-runner.ts';

let sandbox: string;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'note-'));
});

afterEach(() => {
  chmodSync(sandbox, 0o755);
  rmSync(sandbox, { recursive: true, force: true });
});

function file(name: string, content: string): string {
  const path = join(sandbox, name);
  writeFileSync(path, content);
  return path;
}

const note = [
  '# Run',
  '',
  '## State',
  '',
  'old state',
  '',
  '## Batches',
  '',
  '| Batch | Status | Notes |',
  '| ----- | ------ | ----- |',
  '| B35 quote-reply | running | a |',
  '| B60 sidebar | queued | b |',
  '',
  '## Later',
  '',
  'kept',
  '',
].join('\n');

describe('replaceSection', () => {
  test('replaces only the body under the heading, up to the next ## heading', () => {
    const { text, created } = replaceSection(note, 'State', 'new line one\nnew line two\n');
    expect(created).toBe(false);
    expect(text).toContain('## State\n\nnew line one\nnew line two\n\n## Batches');
    expect(text).not.toContain('old state');
    expect(text).toContain('## Later\n\nkept\n');
  });

  test("keeps ### subheadings inside the replaced body's boundary", () => {
    const withSub = '## A\n\n### sub\n\ntext\n\n## B\n\nb\n';
    const { text } = replaceSection(withSub, 'A', 'fresh');
    expect(text).toBe('## A\n\nfresh\n\n## B\n\nb\n');
  });

  test('creates an absent section at the end', () => {
    const { text, created } = replaceSection('# Run\n\n## A\n\na\n', 'New', 'body');
    expect(created).toBe(true);
    expect(text).toBe('# Run\n\n## A\n\na\n\n## New\n\nbody\n');
  });

  test('replaces the last section without adding a trailing blank line', () => {
    expect(replaceSection('## A\n\nold\n', 'A', 'new').text).toBe('## A\n\nnew\n');
  });

  test('ignores a heading inside a fenced code block', () => {
    const fenced = '## A\n\n```\n## B\n```\n\n## B\n\nreal\n';
    const { text } = replaceSection(fenced, 'B', 'changed');
    expect(text).toBe('## A\n\n```\n## B\n```\n\n## B\n\nchanged\n');
  });
});

describe('updateRow', () => {
  test('updates one cell of the row whose first column contains the key', () => {
    const result = updateRow(note, 'B60', 'status', 'merged');
    expect(result.found).toBe(true);
    if (!result.found) return;
    expect(result.text).toContain('| B60 sidebar | merged | b |');
    expect(result.text).toContain('| B35 quote-reply | running | a |');
  });

  test('reports a missing key and a missing column distinctly', () => {
    expect(updateRow(note, 'B99', 'Status', 'x')).toEqual({
      found: false,
      reason: 'key',
    });
    expect(updateRow(note, 'B35', 'Owner', 'x')).toEqual({
      found: false,
      reason: 'column',
    });
  });

  test('escapes a pipe and flattens a newline in the value', () => {
    const result = updateRow(note, 'B35', 'Notes', 'a|b\nc');
    expect(result.found && result.text).toContain('| B35 quote-reply | running | a\\|b c |');
  });

  test('keeps an empty trailing cell', () => {
    const table = '| K | V | W |\n| - | - | - |\n| row | 1 |  |\n';
    const result = updateRow(table, 'row', 'W', 'set');
    expect(result.found && result.text).toContain('| row | 1 | set |');
  });
});

/** What a CommonMark renderer shows for a cell: `\\` plus ASCII punctuation is that punctuation. */
function renderedCell(cell: string): string {
  return cell.trim().replace(/\\([!-/:-@[-`{-~])/g, '$1');
}

describe('row cells survive any value', () => {
  const awkward = [
    'a|b',
    '#12 @bob',
    '# heading-like',
    '@everyone',
    'C:\\dir\\',
    'ends with backslash\\',
    'x\\|y',
    'x\\\\|y',
    '\\#12',
    'two \\\\ slashes',
    'a\rb',
    'a\r\nb\n\nc',
    'a\u2028b',
    '$& $1 `code | span`',
    '| leading and trailing |',
    '',
  ];
  const wide = '| K | V | W |\n| - | - | - |\n| row | 1 |  |\n| other | 2 | 3 |\n';

  for (const value of awkward) {
    test(`keeps the table intact and the cell faithful for ${JSON.stringify(value)}`, () => {
      const result = updateRow(wide, 'row', 'W', value);
      expect(result.found).toBe(true);
      if (!result.found) return;
      const lines = result.text.split('\n');
      expect(lines).toHaveLength(wide.split('\n').length);
      expect(lines[3]).toBe('| other | 2 | 3 |');
      const cells = splitRow(lines[2]!);
      expect(cells).toHaveLength(3);
      expect(cells![0]!.trim()).toBe('row');
      expect(cells![1]!.trim()).toBe('1');
      expect(renderedCell(cells![2]!)).toBe(value.replace(/\s*[\r\n\u2028\u2029]\s*/g, ' ').trim());
      expect(escapeCell(value)).not.toMatch(/[\r\n\u2028\u2029]/);
    });
  }

  test('the CLI writes such a value through the file without disturbing neighbours', () => {
    const path = file('awkward.md', note);
    const value = 'PR #12 by @bob | C:\\temp\\ \\#3\nsecond line';
    const result = run(['row', path, '--key', 'B35', '--column', 'Notes', '--value', value]);
    expect(result.code).toBe(0);
    const lines = readFileSync(path, 'utf8').split('\n');
    const row = lines.find((line) => line.startsWith('| B35'))!;
    expect(splitRow(row)).toHaveLength(3);
    expect(lines).toContain('| B60 sidebar | queued | b |');
    expect(lines).toContain('## Later');
  });
});

describe('helpers', () => {
  test('counts lines without the phantom one after a trailing newline', () => {
    expect(countLines('')).toBe(0);
    expect(countLines('a\n')).toBe(1);
    expect(countLines('a\nb')).toBe(2);
  });

  test('derives the sibling log path', () => {
    expect(logPathFor('/x/run.md')).toBe('/x/run-log.md');
    expect(logPathFor('/x/run')).toBe('/x/run-log.md');
  });

  test('formats a local ISO timestamp with an offset', () => {
    expect(localTimestamp(new Date(2026, 9, 22, 12, 41, 5))).toMatch(
      /^2026-10-22T12:41:05[+-]\d\d:\d\d$/,
    );
  });

  test('leaves the target untouched and no temporary file when a write fails', () => {
    const target = file('keep.md', 'original\n');
    chmodSync(sandbox, 0o555);
    expect(() => writeAtomically(target, 'new\n')).toThrow();
    chmodSync(sandbox, 0o755);
    expect(readFileSync(target, 'utf8')).toBe('original\n');
    expect(readdirSync(sandbox)).toEqual(['keep.md']);
  });
});

describe('run', () => {
  test('state replaces a section, reports the line count and warns above 300 lines', () => {
    const path = file('run.md', note);
    const content = file('content.md', 'fresh\n');
    const ok = run(['state', path, '--section', 'State', '--file', content]);
    expect(ok.code).toBe(0);
    expect(ok.output).toContain('Replaced section');
    expect(ok.output).not.toContain('warning');
    expect(readFileSync(path, 'utf8')).toContain('## State\n\nfresh\n\n## Batches');

    const big = file('big.md', 'line\n'.repeat(400));
    const warned = run(['state', path, '--section', 'Big', '--file', big]);
    expect(warned.code).toBe(0);
    expect(warned.output).toContain('warning');
    expect(
      JSON.parse(run(['state', path, '--section', 'Big', '--file', content, '--json']).output)
        .created,
    ).toBe(false);
  });

  test('state creates the note when absent', () => {
    const path = join(sandbox, 'fresh.md');
    run(['state', path, '--section', 'State', '--file', file('c.md', 'x')]);
    expect(readFileSync(path, 'utf8')).toBe('## State\n\nx\n');
  });

  test('log appends timestamped entries to a log it creates with a title', () => {
    const path = file('run.md', note);
    const entry = file('entry.md', 'first entry\nsecond line\n');
    const now = () => new Date(2026, 9, 22, 9, 0, 0);
    expect(run(['log', path, '--file', entry], { now }).code).toBe(0);
    run(['log', path, '--file', file('e2.md', 'second')], { now });
    const log = readFileSync(join(sandbox, 'run-log.md'), 'utf8');
    expect(log.startsWith('# run log\n\n')).toBe(true);
    expect(log).toMatch(/- 2026-10-22T09:00:00[+-]\d\d:\d\d first entry\n {2}second line\n/);
    expect(log.match(/^- /gm)).toHaveLength(2);
    expect(readFileSync(path, 'utf8')).toBe(note);
  });

  test('row exits 1 and changes nothing when the key or column is missing', () => {
    const path = file('run.md', note);
    expect(run(['row', path, '--key', 'B99', '--column', 'Status', '--value', 'x']).code).toBe(1);
    expect(run(['row', path, '--key', 'B35', '--column', 'Owner', '--value', 'x']).code).toBe(1);
    expect(readFileSync(path, 'utf8')).toBe(note);
    const ok = run(['row', path, '--key', 'B35', '--column', 'Status', '--value', 'done']);
    expect(ok.code).toBe(0);
    expect(readFileSync(path, 'utf8')).toContain('| B35 quote-reply | done | a |');
  });

  test('stats reports the note and its log', () => {
    const path = file('run.md', 'a\nb\n');
    expect(run(['stats', path]).output).toBe('note: 2 lines, 4 bytes\nlog: absent');
    file('run-log.md', '# t\n');
    const parsed = JSON.parse(run(['stats', path, '--json']).output);
    expect(parsed.note).toMatchObject({ lines: 2, bytes: 4 });
    expect(parsed.log).toMatchObject({ lines: 1, bytes: 4 });
  });

  test('rejects bad usage', () => {
    const path = file('run.md', note);
    expect(() => run([])).toThrow(UsageError);
    expect(() => run(['nope'])).toThrow(UsageError);
    expect(() => run(['state', path, '--section', 'A'])).toThrow(UsageError);
    expect(() => run(['state', path, '--file', path])).toThrow(UsageError);
    expect(() => run(['state', path, '--bogus', 'x'])).toThrow(UsageError);
    expect(() => run(['stats', join(sandbox, 'missing.md')])).toThrow(UsageError);
    expect(() => run(['log', path, '--file', file('empty.md', '\n')])).toThrow(UsageError);
  });
});
