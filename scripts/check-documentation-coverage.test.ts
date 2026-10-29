import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';

import {
  expandEntries,
  findUndocumented,
  findUndocumentedExports,
  judgeCoverage,
  MEMBER_ALLOWLIST_FILE,
  parseArguments,
  readAllowlist,
  readEntryPoints,
} from './check-documentation-coverage.ts';

const fixture = mkdtempSync(join(tmpdir(), 'documentation-coverage-'));
afterAll(() => rmSync(fixture, { recursive: true, force: true }));

const files: Record<string, string> = {
  'neighbor/src/index.ts': 'export const borrowed = 1;\n',
  'package/src/ambient.d.ts':
    "declare module '*.svelte' {\n  const component: unknown;\n  export default component;\n}\n",
  'package/src/button.svelte': '',
  'package/src/declared.ts': [
    '/** Documented where it is declared. */',
    'export const reexported = 1;',
    'export function bare(): void {}',
    '/** Shared by both entry points. */',
    'export interface Shared {}',
    'export type SharedUndocumented = string;',
  ].join('\n'),
  'package/src/index.ts': [
    "export { reexported, bare } from './declared.ts';",
    "export type { Shared, SharedUndocumented } from './declared.ts';",
    "export { borrowed } from '../../neighbor/src/index.ts';",
    "export { default as Button } from './button.svelte';",
    '/** Documented in place. */',
    'export class Documented {}',
    'export class Undocumented {}',
    '/** @deprecated A tag alone is not documentation. */',
    'export const tagged = 1;',
  ].join('\n'),
  'package/src/extra.ts':
    "export type { Shared, SharedUndocumented } from './declared.ts';\nexport const onlyHere = 1;\n",
};
files['members/src/index.ts'] = [
  '/** Documented interface. */',
  'export interface Shape {',
  '  /** Documented property. */',
  '  documented: string;',
  '  bare: string;',
  '  /** @deprecated A tag alone is not documentation. */',
  '  tagged: string;',
  '  /** Documented method. */',
  '  run(): void;',
  '  stop(): void;',
  '  (call: string): void;',
  '  [key: string]: unknown;',
  '}',
  '/** Documented base. */',
  'export interface Base {',
  '  inheritedBare: string;',
  '}',
  '/** Derived adds one member and inherits another undocumented one. */',
  'export interface Derived extends Base {',
  '  own: string;',
  '}',
  '/** Documented class. */',
  'export class Widget {',
  '  /** Documented field. */',
  '  documented = 1;',
  '  bare = 2;',
  '  private hidden = 3;',
  '  #secret = 4;',
  '  constructor() {}',
  '  method(): void {}',
  '  /** Documented accessor. */',
  '  get value(): number { return 1; }',
  '  set value(next: number) {}',
  '  get other(): number { return 1; }',
  '  static create(): Widget { return new Widget(); }',
  '  /** First overload is documented. */',
  '  pick(input: string): string;',
  '  pick(input: number): number;',
  '  /** Third overload is documented. */',
  '  pick(input: boolean): boolean;',
  '  pick(input: unknown): unknown { return input; }',
  '}',
  '/** Class that overrides a member without redocumenting it. */',
  'export class Child extends Widget {',
  '  childOnly = 1;',
  '}',
  '/** Documented static, undocumented instance of the same name. */',
  'export class Twin {',
  '  /** Documented static. */',
  '  static same = 1;',
  '  same = 2;',
  '  /** Documented instance, undocumented static of the same name. */',
  '  other = 1;',
  '  static other = 2;',
  '}',
  '/** Parameter properties declare members. */',
  'export class Parameters {',
  '  constructor(',
  '    /** Documented parameter property. */',
  '    public readonly documented: string,',
  '    public readonly bare: string,',
  '    protected guarded: string,',
  '    readonly frozen: string,',
  '    private hidden: string,',
  '    plain: string,',
  '  ) {}',
  '}',
  '/** Documented object alias. */',
  'export type Options = {',
  '  /** Documented option. */',
  '  documented?: string;',
  '  bare?: string;',
  '};',
  '/** Not an object literal type, so nothing is judged. */',
  'export type Mapped = { [Key in "a" | "b"]: string };',
  '/** Conditional. */',
  'export type Conditional<T> = T extends string ? { member: string } : never;',
  '/** Reference alias. */',
  'export type Reference = Options;',
  '/** Enum members are not judged. */',
  'export enum Mode { On, Off }',
  '/** Namespace members are not judged. */',
  'export namespace Space { export const inside = 1; }',
  '/** Documented overloaded function. */',
  'export function convert(input: string): string;',
  'export function convert(input: number): number;',
  '/** Third documented. */',
  'export function convert(input: boolean): boolean;',
  'export function convert(input: unknown): unknown { return input; }',
  '/** Single signature with an implementation. */',
  'export function single(input: string): string { return input; }',
].join('\n');
files['application/src/host/server.ts'] = [
  '/** Documented export. */',
  'export interface Settings {',
  '  /** Documented member. */',
  '  port: number;',
  '  host: string;',
  '}',
  'export function start(): void {}',
].join('\n');
files['application/src/host/server.test.ts'] = 'export const testOnly = 1;\n';
files['application/src/lib/helper.ts'] =
  '/** Helps. */\nexport const help = 1;\nexport const bare = 2;\n';
files['application/src/lib/helper.test-support.ts'] = 'export const supportOnly = 1;\n';
files['application/src/lib/script.ts'] = 'const local = 1;\nlocal;\n';
files['application/src/lib/nested/deep.ts'] = 'export class Deep {}\n';
files['application/src/routes/page.ts'] = 'export const outsideTheGlobs = 1;\n';
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

describe('findUndocumentedExports', () => {
  test('judges each export at its declaration, once, and only where this workspace owns it', () => {
    const entryPoints = readEntryPoints(directory, {
      '.': './src/index.ts',
      './extra': './src/extra.ts',
    });
    const declarationFiles = [join(directory, 'src/ambient.d.ts')];
    expect(findUndocumentedExports(directory, entryPoints, options, declarationFiles)).toEqual([
      '. SharedUndocumented',
      '. Undocumented',
      '. bare',
      '. tagged',
      './extra onlyHere',
    ]);
  });
});

describe('findUndocumented members', () => {
  const memberDirectory = join(fixture, 'members');
  const found = findUndocumented(
    memberDirectory,
    readEntryPoints(memberDirectory, './src/index.ts'),
    options,
  );

  test('judges own members of interfaces, classes, and object type aliases', () => {
    expect(
      found.members.filter(
        (key) => /Shape|Options|Widget\./.test(key) && !key.includes('overload'),
      ),
    ).toEqual([
      '. Options.bare',
      '. Shape.bare',
      '. Shape.stop',
      '. Shape.tagged',
      '. Widget.bare',
      '. Widget.method',
      '. Widget.other',
      '. Widget.static.create',
    ]);
  });

  test('judges a static member apart from an instance member of the same name', () => {
    expect(found.members.filter((key) => key.startsWith('. Twin.'))).toEqual([
      '. Twin.same',
      '. Twin.static.other',
    ]);
  });

  test('judges constructor parameter properties that are not private', () => {
    expect(found.members.filter((key) => key.startsWith('. Parameters.'))).toEqual([
      '. Parameters.bare',
      '. Parameters.frozen',
      '. Parameters.guarded',
    ]);
  });

  test('requires a comment on each overload signature of a method and a function', () => {
    expect(found.members.filter((key) => /overload/.test(key))).toEqual([
      '. Widget.pick(overload 2)',
      '. convert(overload 2)',
    ]);
  });

  test('judges own members only, not inherited ones, enums, namespaces, or other aliases', () => {
    expect(
      found.members.filter((key) => /Base|Derived|Child|Mapped|Conditional|Reference/.test(key)),
    ).toEqual(['. Base.inheritedBare', '. Child.childOnly', '. Derived.own']);
    expect(found.members.some((key) => /Mode|Space|single/.test(key))).toBe(false);
    expect(found.members.some((key) => /hidden|secret|constructor|\[/.test(key))).toBe(false);
  });

  test('leaves the export judgement unchanged', () => {
    expect(found.exports).toEqual([]);
  });
});

describe('readEntryPoints', () => {
  test('accepts a bare string export as the root entry point', () => {
    expect(readEntryPoints(directory, './src/index.ts')).toEqual([
      { subpath: '.', file: join(directory, 'src/index.ts') },
    ]);
  });

  test('rejects a conditional or non-TypeScript export rather than skipping it', () => {
    expect(() => readEntryPoints(directory, { '.': { default: './src/index.ts' } })).toThrow(
      'must map to a TypeScript source file',
    );
    expect(() => readEntryPoints(directory, { './styles': './src/styles.css' })).toThrow(
      'must map to a TypeScript source file',
    );
  });
});

describe('judgeCoverage', () => {
  test('fails new undocumented exports and allowlist entries that no longer apply', () => {
    expect(judgeCoverage(['. kept', '. added'], ['. kept', '. documentedSince'])).toEqual({
      missing: ['. added'],
      stale: ['. documentedSince'],
    });
  });

  test('passes when the allowlist names exactly the undocumented exports', () => {
    expect(judgeCoverage(['. kept'], ['. kept'])).toEqual({ missing: [], stale: [] });
  });
});

describe('judgeCoverage for members', () => {
  test('fails a new undocumented member and a stale entry for a documented or removed one', () => {
    expect(
      judgeCoverage(['. Shape.kept', '. Shape.added'], ['. Shape.kept', '. Shape.documentedSince']),
    ).toEqual({ missing: ['. Shape.added'], stale: ['. Shape.documentedSince'] });
  });

  test('treats a missing member allowlist file as empty', async () => {
    expect(await readAllowlist(join(fixture, 'members', MEMBER_ALLOWLIST_FILE))).toEqual([]);
  });

  test('treats a missing member allowlist as empty', () => {
    expect(judgeCoverage(['. Shape.bare'], [])).toEqual({
      missing: ['. Shape.bare'],
      stale: [],
    });
  });
});

describe('--entries mode', () => {
  const applicationDirectory = join(fixture, 'application');
  const patterns = [
    'src/host/**/*.ts',
    'src/lib/**/*.ts',
    '!**/*.test.ts',
    '!**/*.test-support.ts',
  ];

  test('matches the globs relative to the workspace and removes test files', () => {
    expect(expandEntries(applicationDirectory, patterns).map((entry) => entry.subpath)).toEqual([
      'src/host/server.ts',
      'src/lib/helper.ts',
      'src/lib/nested/deep.ts',
      'src/lib/script.ts',
    ]);
  });

  test('fails a positive glob that matches nothing and a list with no positive glob', () => {
    expect(() => expandEntries(applicationDirectory, ['src/missing/**/*.ts'])).toThrow(
      'matches no file',
    );
    expect(() => expandEntries(applicationDirectory, ['!**/*.test.ts'])).toThrow(
      'needs at least one glob',
    );
  });

  test('judges every export and member of the matching files under path keys', () => {
    const found = findUndocumented(
      applicationDirectory,
      expandEntries(applicationDirectory, patterns),
      options,
    );
    expect(found.exports).toEqual([
      'src/host/server.ts start',
      'src/lib/helper.ts bare',
      'src/lib/nested/deep.ts Deep',
    ]);
    expect(found.members).toEqual(['src/host/server.ts Settings.host']);
    expect(found.exports.concat(found.members).join('\n')).not.toMatch(/testOnly|supportOnly/);
  });

  test('a glob that also matches test-support and other files judges them too', () => {
    const everything = findUndocumented(
      applicationDirectory,
      expandEntries(applicationDirectory, ['src/**/*.ts']),
      options,
    );
    expect(everything.exports).toContain('src/lib/helper.test-support.ts supportOnly');
    expect(everything.exports).toContain('src/routes/page.ts outsideTheGlobs');
  });
});

describe('parseArguments', () => {
  test('reads a mode, the entries globs, or both in either order', () => {
    expect(parseArguments([])).toEqual({ mode: undefined, entries: undefined });
    expect(parseArguments(['--entries', 'a/**/*.ts', '!b.ts', '--seed-members'])).toEqual({
      mode: '--seed-members',
      entries: ['a/**/*.ts', '!b.ts'],
    });
    expect(parseArguments(['--shrink', '--entries', 'a.ts'])).toEqual({
      mode: '--shrink',
      entries: ['a.ts'],
    });
  });

  test('rejects an unknown flag, a stray word, an empty --entries, and two modes', () => {
    expect(parseArguments(['--bogus'])).toContain('unknown argument');
    expect(parseArguments(['stray.ts'])).toContain('unknown argument');
    expect(parseArguments(['--entries'])).toContain('at least one glob');
    expect(parseArguments(['--entries', '--seed'])).toContain('at least one glob');
    expect(parseArguments(['--seed', '--shrink'])).toContain('unknown argument');
  });
});
