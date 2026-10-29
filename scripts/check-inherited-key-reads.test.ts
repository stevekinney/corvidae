import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';

import {
  expressionOf,
  findInheritedKeyReads,
  judgeReads,
  type AllowlistEntry,
  type InheritedKeyRead,
} from './check-inherited-key-reads.ts';

const fixture = mkdtempSync(join(tmpdir(), 'inherited-key-reads-'));
afterAll(() => rmSync(fixture, { recursive: true, force: true }));

// `noLib` below keeps the fixture program small, so the few globals the cases name are declared
// here, and the records use index signatures rather than `Record`.
const files: Record<string, string> = {
  'package/src/reads.ts': [
    'interface Table { [key: string]: number }',
    'interface Positions { [index: number]: string }',
    'interface Names { [key: string]: string }',
    'declare const Object: {',
    '  hasOwn(record: object, key: string): boolean;',
    '  keys(record: object): string[];',
    '  entries(record: object): [string, string][];',
    '  create(prototype: null): never;',
    '};',
    'declare function hasOwnProperty(record: object, key: string): boolean;',
    '',
    'export function flaggedRead(table: Table, name: string) { return table[name]; }',
    'export function flaggedMembership(table: Table, name: string) { return name in table; }',
    'export function flaggedThroughCast(value: object, key: string) {',
    '  return (value as Table)[key];',
    '}',
    'export function flaggedOptional(table: Table | undefined, name: string) {',
    '  return table?.[name];',
    '}',
    'export function flaggedBesideOtherTable(table: Table, other: Table, name: string) {',
    '  return Object.hasOwn(other, name) ? table[name] : undefined;',
    '}',
    'export function flaggedInheritedOnlyByIn(table: Table, name: string) {',
    '  return name in table ? table[name] : undefined;',
    '}',
    '',
    'export function guardedByHasOwn(table: Table, name: string) {',
    '  return Object.hasOwn(table, name) ? table[name] : undefined;',
    '}',
    'export function guardedByHelper(table: Table, name: string) {',
    '  return hasOwnProperty(table, name) ? table[name] : undefined;',
    '}',
    'export function guardedPropertyReceiver(holder: { table: Table }, name: string) {',
    '  return Object.hasOwn(holder.table, name) ? holder.table[name] : undefined;',
    '}',
    'export function guardedThroughCast(value: object, key: string) {',
    '  return Object.hasOwn(value, key) ? (value as Table)[key] : undefined;',
    '}',
    'export function guardedMembership(table: Table, name: string) {',
    '  return Object.hasOwn(table, name) && name in table;',
    '}',
    'export function ownKeysInLoop(table: Table) {',
    '  const seen: number[] = [];',
    '  for (const key of Object.keys(table)) seen[0] = table[key]!;',
    '  return seen;',
    '}',
    'export function ownKeysThroughLocal(table: Table) {',
    '  const keys = Object.keys(table);',
    '  return keys.map((key) => table[key]);',
    '}',
    'export function ownKeysThroughCallback(table: Table) {',
    '  return Object.keys(table).map((key) => table[key]);',
    '}',
    'export function nullPrototypeLocal(name: string) {',
    '  const bag: Table = Object.create(null);',
    '  return bag[name];',
    '}',
    'export function literalKey(table: Table) { return table["a"]; }',
    'export function unionKey(table: Table, key: "a" | "b") { return table[key]; }',
    'export function numericKey(positions: Positions, index: number) { return positions[index]; }',
    'export function writes(table: Table, name: string) {',
    '  table[name] = 1;',
    '  delete table[name];',
    '}',
    'export function entriesKeyPosition(names: Names) {',
    '  for (const [label] of Object.entries(names)) names[label];',
    '}',
    'export function entriesKeyAfterValue(names: Names) {',
    '  return Object.entries(names).map(([key, value]) => names[key]);',
    '}',
    'export function entriesValuePosition(names: Names) {',
    '  for (const [label, value] of Object.entries(names)) names[value];',
    '}',
    'export function entriesCallbackValue(names: Names) {',
    '  return Object.entries(names).map(([key, value]) => names[value]);',
    '}',
    'export function entriesWholePair(names: Names) {',
    '  return Object.entries(names).map((entry) => names[entry[0]]);',
    '}',
    'export function keysThroughPreservingChain(names: Names) {',
    '  return Object.keys(names).filter((key) => key !== "").toSorted().map((key) => names[key]);',
    '}',
    'export function keysThroughTransformingChain(names: Names) {',
    '  return Object.keys(names).map((key) => key).map((derived) => names[derived]);',
    '}',
    'export function bypassedByVoid(table: Table, name: string) {',
    '  void Object.hasOwn(table, name);',
    '  return table[name];',
    '}',
    'export function bypassedByIgnoredResult(table: Table, name: string) {',
    '  const owns = Object.hasOwn(table, name);',
    '  return owns ? 1 : table[name];',
    '}',
    'export function bypassedInElseBranch(table: Table, name: string) {',
    '  if (Object.hasOwn(table, name)) return 0;',
    '  return table[name];',
    '}',
    'export function bypassedByNegatedAnd(table: Table, name: string, other: boolean) {',
    '  if (!Object.hasOwn(table, name) && other) return undefined;',
    '  return table[name];',
    '}',
    'export function guardedByIf(table: Table, name: string) {',
    '  if (Object.hasOwn(table, name)) return table[name];',
    '  return undefined;',
    '}',
    'export function guardedByElse(table: Table, name: string) {',
    '  if (!Object.hasOwn(table, name)) return undefined; else return table[name];',
    '}',
    'export function guardedByEarlyReturn(table: Table, name: string) {',
    '  if (!Object.hasOwn(table, name)) return undefined;',
    '  return table[name];',
    '}',
    'export function guardedByEarlyThrow(table: Table, name: string) {',
    '  if (!Object.hasOwn(table, name)) { throw name; }',
    '  return table[name];',
    '}',
    'export function guardedByEarlyReturnOrOther(table: Table, name: string, other: boolean) {',
    '  if (!Object.hasOwn(table, name) || other) return undefined;',
    '  return table[name];',
    '}',
    'export function guardedByAnd(table: Table, name: string) {',
    '  return Object.hasOwn(table, name) && table[name] > 0;',
    '}',
    'export function guardedByOr(table: Table, name: string) {',
    '  return !Object.hasOwn(table, name) || table[name] > 0;',
    '}',
  ].join('\n'),
};
for (const [path, contents] of Object.entries(files)) {
  await Bun.write(join(fixture, path), contents);
}

const options: ts.CompilerOptions = {
  noLib: true,
  types: [],
  allowImportingTsExtensions: true,
  module: ts.ModuleKind.Preserve,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
};
const directory = join(fixture, 'package');
const program = ts.createProgram([join(directory, 'src/reads.ts')], { ...options, noEmit: true });
const reads = findInheritedKeyReads(program, directory);

/** The name of the exported function that holds a read, from the fixture's own source lines. */
function functionOf(read: InheritedKeyRead): string {
  const lines = files['package/src/reads.ts']!.split('\n');
  for (let index = read.line - 1; index >= 0; index -= 1) {
    const match = /^export function (\w+)/.exec(lines[index]!);
    if (match) return match[1]!;
  }
  throw new Error(`no function above line ${read.line}`);
}

describe('findInheritedKeyReads', () => {
  test('flags exactly the reads and membership tests nothing guards', () => {
    expect(reads.map((read) => `${functionOf(read)}: ${expressionOf(read)}`)).toEqual([
      'flaggedRead: table[name]',
      'flaggedMembership: name in table',
      'flaggedThroughCast: (value as Table)[key]',
      'flaggedOptional: table[name]',
      'flaggedBesideOtherTable: table[name]',
      'flaggedInheritedOnlyByIn: name in table',
      'flaggedInheritedOnlyByIn: table[name]',
      'entriesValuePosition: names[value]',
      'entriesCallbackValue: names[value]',
      'entriesWholePair: names[entry[0]]',
      'keysThroughTransformingChain: names[derived]',
      'bypassedByVoid: table[name]',
      'bypassedByIgnoredResult: table[name]',
      'bypassedInElseBranch: table[name]',
      'bypassedByNegatedAnd: table[name]',
    ]);
  });

  test('skips a test file', async () => {
    await Bun.write(
      join(directory, 'src/other.test.ts'),
      'export function x(table: { [key: string]: number }, name: string) { return table[name]; }\n',
    );
    const withTest = ts.createProgram(
      [join(directory, 'src/reads.ts'), join(directory, 'src/other.test.ts')],
      { ...options, noEmit: true },
    );
    expect(findInheritedKeyReads(withTest, directory)).toHaveLength(reads.length);
  });
});

describe('judgeReads', () => {
  const read = (file: string, line: number): InheritedKeyRead => ({
    file,
    line,
    receiver: 'table',
    key: 'name',
    operator: 'read',
  });
  const entry = (overrides: Partial<AllowlistEntry> = {}): AllowlistEntry => ({
    file: 'src/a.ts',
    expression: 'table[name]',
    count: 1,
    reason: 'every caller passes a literal',
    ...overrides,
  });

  test('passes a site the allowlist names with the right count', () => {
    const judgement = judgeReads([read('src/a.ts', 3)], [entry()]);
    expect(judgement).toEqual({ unlisted: [], stale: [], invalid: [] });
  });

  test('fails a site with no entry, and names its line', () => {
    const judgement = judgeReads([read('src/a.ts', 3), read('src/b.ts', 9)], [entry()]);
    expect(judgement.unlisted).toEqual([
      { file: 'src/b.ts', expression: 'table[name]', lines: [9], found: 1, allowed: 0 },
    ]);
  });

  test('fails a new identical read in a file whose entry counts fewer', () => {
    const judgement = judgeReads([read('src/a.ts', 3), read('src/a.ts', 8)], [entry()]);
    expect(judgement.unlisted).toEqual([
      { file: 'src/a.ts', expression: 'table[name]', lines: [3, 8], found: 2, allowed: 1 },
    ]);
  });

  test('fails an entry for a site that is gone, or a count that is too high', () => {
    expect(judgeReads([], [entry()]).stale).toEqual([
      { file: 'src/a.ts', expression: 'table[name]', found: 0, allowed: 1 },
    ]);
    expect(judgeReads([read('src/a.ts', 3)], [entry({ count: 2 })]).stale).toEqual([
      { file: 'src/a.ts', expression: 'table[name]', found: 1, allowed: 2 },
    ]);
  });

  test('fails an entry with no reason or no count', () => {
    const bare = entry({ reason: '  ' });
    expect(judgeReads([read('src/a.ts', 3)], [bare]).invalid).toEqual([bare]);
    const empty = entry({ count: 0 });
    expect(judgeReads([], [empty]).invalid).toEqual([empty]);
  });
});
