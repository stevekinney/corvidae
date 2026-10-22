#!/usr/bin/env bun
// Chef work-history note: edits a run's bounded state note and its sibling append-only log without
// rereading either into the coordinator's context. The note holds a bounded state section per
// heading; the sibling log (`<note without .md>-log.md`) holds timestamped entries. Every write goes
// to a temporary file and is renamed over the target, so a failure never truncates a note.
//
// Usage:
//   bun scripts/chef/note.ts state <note> --section "<heading>" --file <content> [--json]
//   bun scripts/chef/note.ts log <note> --file <entry> [--json]
//   bun scripts/chef/note.ts row <note> --key <first-cell value> --column <header> --value <text> [--json]
//   bun scripts/chef/note.ts stats <note> [--json]
//
// `state` replaces the body under `## <heading>` (up to the next `## `), creating the section when
// it is absent, and warns above 300 lines. `log` appends `- <local ISO timestamp> <entry>` to the
// sibling log, creating it with a title line. `row` updates one cell of the first Markdown table
// whose first column contains the key. `stats` prints line counts and byte sizes.
//
// Exit codes: 0 success, 1 the key, column or note was not found, 2 invalid CLI usage.

import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { parseOptions, UsageError } from './process-runner.ts';

export const LINE_WARNING_THRESHOLD = 300;

export interface NoteDependencies {
  /** The clock; tests pin it. */
  now?: () => Date;
}

/** Lines in `text`, not counting the empty string after a trailing newline. */
export function countLines(text: string): number {
  if (text === '') return 0;
  const lines = text.split('\n').length;
  return text.endsWith('\n') ? lines - 1 : lines;
}

/** The sibling log's path: `<note without .md>-log.md`. */
export function logPathFor(notePath: string): string {
  return `${notePath.replace(/\.md$/, '')}-log.md`;
}

/** A local ISO timestamp with the UTC offset, for example `2026-10-22T12:41:05-04:00`. */
export function localTimestamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const absolute = Math.abs(offset);
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`
  );
}

/** Write through a temporary sibling and rename, so a failed write leaves the target intact. */
export function writeAtomically(path: string, content: string): void {
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(temporary, content);
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

/** Indexes of lines that open or close a fenced code block, so headings inside one are ignored. */
function outsideFences(lines: string[]): boolean[] {
  const outside: boolean[] = [];
  let fence: string | undefined;
  for (const line of lines) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence === undefined) {
      outside.push(true);
      if (marker !== undefined) fence = marker;
    } else {
      outside.push(false);
      if (marker !== undefined && marker[0] === fence[0] && marker.length >= fence.length)
        fence = undefined;
    }
  }
  return outside;
}

/**
 * Replace the body under `## <heading>` (up to the next `## ` heading) with `body`, or append the
 * section when it is absent. Returns the new note text and whether the section was created.
 */
export function replaceSection(
  note: string,
  heading: string,
  body: string,
): { text: string; created: boolean } {
  const lines = note === '' ? [] : note.replace(/\n$/, '').split('\n');
  const outside = outsideFences(lines);
  const wanted = `## ${heading.trim()}`;
  const start = lines.findIndex(
    (line, index) => outside[index] === true && line.trimEnd() === wanted,
  );
  const bodyLines = body.replace(/\s+$/, '').split('\n');
  const section = [wanted, '', ...bodyLines];
  if (start === -1) {
    const prefix = lines.length === 0 ? [] : [...lines, ''];
    return { text: `${[...prefix, ...section].join('\n')}\n`, created: true };
  }
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (outside[index] === true && (lines[index] ?? '').startsWith('## ')) {
      end = index;
      break;
    }
  }
  const after = lines.slice(end);
  const rebuilt = [
    ...lines.slice(0, start),
    ...section,
    ...(after.length > 0 ? ['', ...after] : []),
  ];
  return { text: `${rebuilt.join('\n')}\n`, created: false };
}

/** Split a Markdown table row into its raw cells, honoring `\|`. Null when it is not a row. */
function splitRow(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|')) return null;
  let body = trimmed.slice(1);
  if (body.endsWith('|') && !body.endsWith('\\|')) body = body.slice(0, -1);
  const cells: string[] = [];
  let current = '';
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index] ?? '';
    if (character === '\\' && body[index + 1] === '|') {
      current += '\\|';
      index += 1;
    } else if (character === '|') {
      cells.push(current);
      current = '';
    } else current += character;
  }
  cells.push(current);
  return cells;
}

function isSeparator(cells: string[]): boolean {
  return cells.length > 0 && cells.every((cell) => /^\s*:?-{1,}:?\s*$/.test(cell));
}

export type RowResult =
  { found: true; text: string; line: number } | { found: false; reason: 'key' | 'column' };

/**
 * Update one cell of the first table whose first column contains `key`. A key found in a table
 * that lacks `column` is a `column` miss, not a reason to look in a later table.
 */
export function updateRow(note: string, key: string, column: string, value: string): RowResult {
  const lines = note.split('\n');
  const outside = outsideFences(lines);
  let index = 0;
  while (index < lines.length) {
    const header = outside[index] === true ? splitRow(lines[index] ?? '') : null;
    const separator = index + 1 < lines.length ? splitRow(lines[index + 1] ?? '') : null;
    if (header === null || separator === null || !isSeparator(separator)) {
      index += 1;
      continue;
    }
    let end = index + 2;
    while (end < lines.length && splitRow(lines[end] ?? '') !== null) end += 1;
    for (let rowIndex = index + 2; rowIndex < end; rowIndex += 1) {
      const cells = splitRow(lines[rowIndex] ?? '');
      if (cells === null || !(cells[0] ?? '').includes(key)) continue;
      const columnIndex = header.findIndex(
        (cell) => cell.trim().toLowerCase() === column.trim().toLowerCase(),
      );
      if (columnIndex === -1) return { found: false, reason: 'column' };
      while (cells.length <= columnIndex) cells.push('');
      cells[columnIndex] = ` ${value
        .replace(/\|/g, '\\|')
        .replace(/\s*\n\s*/g, ' ')
        .trim()} `;
      lines[rowIndex] = `|${cells.join('|')}|`;
      return { found: true, text: lines.join('\n'), line: rowIndex + 1 };
    }
    index = end;
  }
  return { found: false, reason: 'key' };
}

function readText(path: string, what: string): string {
  if (!existsSync(path)) throw new UsageError(`No such ${what}: ${path}`);
  return readFileSync(path, 'utf8');
}

interface Parsed {
  positionals: string[];
  options: Map<string, string>;
  json: boolean;
}

function parse(argv: string[], names: string[]): Parsed {
  const parsed = parseOptions(argv, { values: names, flags: ['json'] });
  return {
    positionals: parsed.positionals,
    options: new Map(Object.entries(parsed.values)),
    json: parsed.flags.has('json'),
  };
}

function required(parsed: Parsed, name: string): string {
  const value = parsed.options.get(name);
  if (value === undefined) throw new UsageError(`--${name} is required.`);
  return value;
}

function notePathOf(parsed: Parsed): string {
  const [path, extra] = parsed.positionals.slice(1);
  if (path === undefined) throw new UsageError('Name the note file.');
  if (extra !== undefined) throw new UsageError(`Unexpected argument ${extra}.`);
  return path;
}

function emit(
  parsed: Parsed,
  code: number,
  data: Record<string, unknown>,
  text: string,
): { code: number; output: string } {
  return { code, output: parsed.json ? JSON.stringify(data) : text };
}

export function run(
  argv: string[],
  dependencies: NoteDependencies = {},
): { code: number; output: string } {
  const now = dependencies.now ?? (() => new Date());
  const command = argv[0];
  if (command === undefined) throw new UsageError('Name a command: state, log, row or stats.');
  if (command === 'state') {
    const parsed = parse(argv, ['section', 'file']);
    const notePath = notePathOf(parsed);
    const section = required(parsed, 'section');
    if (section.trim() === '') throw new UsageError('--section cannot be empty.');
    const content = readText(required(parsed, 'file'), 'content file');
    const existing = existsSync(notePath) ? readFileSync(notePath, 'utf8') : '';
    const { text, created } = replaceSection(existing, section, content);
    writeAtomically(notePath, text);
    const lines = countLines(text);
    const warning = lines > LINE_WARNING_THRESHOLD;
    return emit(
      parsed,
      0,
      { note: notePath, section, created, lines, warning },
      `${created ? 'Created' : 'Replaced'} section "${section}"; ${basename(notePath)} is ${lines} lines.` +
        (warning ? `\nwarning: the note is over ${LINE_WARNING_THRESHOLD} lines; trim it.` : ''),
    );
  }
  if (command === 'log') {
    const parsed = parse(argv, ['file']);
    const notePath = notePathOf(parsed);
    const entry = readText(required(parsed, 'file'), 'entry file')
      .replace(/\s+$/, '')
      .replace(/\n/g, '\n  ');
    if (entry === '') throw new UsageError('The entry file is empty.');
    const logPath = logPathFor(notePath);
    const existing = existsSync(logPath)
      ? readFileSync(logPath, 'utf8')
      : `# ${basename(notePath).replace(/\.md$/, '')} log\n\n`;
    const line = `- ${localTimestamp(now())} ${entry}`;
    writeAtomically(logPath, `${existing}${existing.endsWith('\n') ? '' : '\n'}${line}\n`);
    return emit(
      parsed,
      0,
      { log: logPath, lines: countLines(existing) + 1 },
      `Appended to ${basename(logPath)}.`,
    );
  }
  if (command === 'row') {
    const parsed = parse(argv, ['key', 'column', 'value']);
    const notePath = notePathOf(parsed);
    const key = required(parsed, 'key');
    const column = required(parsed, 'column');
    const value = required(parsed, 'value');
    if (key === '') throw new UsageError('--key cannot be empty.');
    const result = updateRow(readText(notePath, 'note'), key, column, value);
    if (!result.found) {
      return emit(
        parsed,
        1,
        { note: notePath, key, column, updated: false, reason: result.reason },
        result.reason === 'key'
          ? `No table row has "${key}" in its first column.`
          : `The table holding "${key}" has no column "${column}".`,
      );
    }
    writeAtomically(notePath, result.text);
    return emit(
      parsed,
      0,
      { note: notePath, key, column, updated: true, line: result.line },
      `Updated "${column}" of "${key}" on line ${result.line}.`,
    );
  }
  if (command === 'stats') {
    const parsed = parse(argv, []);
    const notePath = notePathOf(parsed);
    const note = readText(notePath, 'note');
    const logPath = logPathFor(notePath);
    const log = existsSync(logPath) ? readFileSync(logPath, 'utf8') : undefined;
    const data = {
      note: {
        path: notePath,
        lines: countLines(note),
        bytes: Buffer.byteLength(note),
      },
      log:
        log === undefined
          ? null
          : {
              path: logPath,
              lines: countLines(log),
              bytes: Buffer.byteLength(log),
            },
    };
    return emit(
      parsed,
      0,
      data,
      `note: ${data.note.lines} lines, ${data.note.bytes} bytes\n` +
        (data.log === null
          ? 'log: absent'
          : `log: ${data.log.lines} lines, ${data.log.bytes} bytes`),
    );
  }
  throw new UsageError(`Unknown command ${command}.`);
}

if (import.meta.main) {
  try {
    const { code, output } = run(Bun.argv.slice(2));
    (code === 0 ? process.stdout : process.stderr).write(`${output}\n`);
    process.exitCode = code;
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}
