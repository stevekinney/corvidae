import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';

import {
  findTestProcessSpawnViolations,
  findUnboundedSpawns,
  resolveSpecifier,
} from './check-test-process-spawns';

function inspectAt(fileName: string, source: string): string[] {
  const parsed = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  return findTestProcessSpawnViolations(parsed).map((violation) => violation.text);
}

const inspect = (source: string): string[] => inspectAt(join(tmpdir(), 'fixture.test.ts'), source);

describe('spawns inside a test body or hook', () => {
  test.each([
    ['Bun.spawn in an it body', "it('x', async () => { await Bun.spawn(['bun']).exited; });"],
    ['Bun.spawnSync in a test body', "test('x', () => { Bun.spawnSync(['git', 'init']); });"],
    ['Bun.$ in a beforeAll hook', 'beforeAll(async () => { await Bun.$`git init`; });'],
    [
      'a $ tag imported from bun in afterEach',
      "import { $ } from 'bun';\nafterEach(async () => { await $`rm -rf x`; });",
    ],
    [
      'a named child_process import',
      "import { execFileSync } from 'node:child_process';\nit('x', () => { execFileSync('mkfifo', ['f']); });",
    ],
    [
      'a renamed child_process import',
      "import { spawn as start } from 'child_process';\nit('x', () => { start('git'); });",
    ],
    [
      'a child_process namespace',
      "import * as processes from 'node:child_process';\nit('x', () => { processes.execSync('ls'); });",
    ],
    ['a test modifier', "it.only('x', () => { Bun.spawnSync(['ls']); });"],
    ['a parameterized test', "test.each([1])('x %i', () => { Bun.spawnSync(['ls']); });"],
    ['a conditional test', "it.skipIf(false)('x', () => { Bun.spawnSync(['ls']); });"],
    [
      'a nested callback inside a test',
      "it('x', async () => { await Promise.all([1].map(async () => Bun.spawn(['ls']).exited)); });",
    ],
    [
      'a test inside a describe',
      "describe('d', () => { it('x', () => { Bun.spawnSync(['ls']); }); });",
    ],
  ])('reports %s', (_name, source) => {
    expect(inspect(source)).toHaveLength(1);
  });
});

describe('spawns outside any test clock', () => {
  test.each([
    ['module scope', "const result = Bun.spawnSync(['git', 'init']);\nit('x', () => {});"],
    [
      'a module-scope scenario',
      "const outcome = await outcomeOf(async () => { await Bun.spawn(['bun']).exited; });\nit('x', () => rethrow(outcome));",
    ],
    ['a describe callback', "describe('d', () => { Bun.spawnSync(['ls']); it('x', () => {}); });"],
    [
      'a helper only called at module scope',
      "function run() { return Bun.spawnSync(['ls']); }\nconst result = run();\nit('x', () => expect(result).toBeDefined());",
    ],
    ['an unrelated spawn method', "it('x', () => { worker.spawn(); });"],
    ['a string mentioning Bun.spawn', "it('x', () => { expect('Bun.spawn').toBe('Bun.spawn'); });"],
  ])('accepts %s', (_name, source) => {
    expect(inspect(source)).toEqual([]);
  });
});

describe('spawning functions', () => {
  test('reports a call to a local function that spawns', () => {
    expect(
      inspect("function run() { return Bun.spawnSync(['ls']); }\nit('x', () => { run(); });"),
    ).toEqual(['run()']);
  });

  test('reports a call through a chain of local functions', () => {
    expect(
      inspect(
        "const inner = () => Bun.spawnSync(['ls']);\nasync function outer() { return inner(); }\nit('x', async () => { await outer(); });",
      ),
    ).toEqual(['outer()']);
  });

  test('reports a spawning function passed to a test or hook by name', () => {
    expect(
      inspect("function body() { Bun.spawnSync(['ls']); }\ntest('x', body);\nbeforeEach(body);"),
    ).toEqual(['body', 'body']);
  });

  test('accepts a spawn-free function passed to a test by name', () => {
    expect(inspect("function body() { return 1; }\ntest('x', body);")).toEqual([]);
  });

  test('reports constructing a local class that spawns', () => {
    expect(
      inspect(
        "class Realm { constructor() { Bun.spawn(['bun']); } }\nit('x', () => { new Realm(); });",
      ),
    ).toEqual(['new Realm()']);
  });

  test('follows a relative import and its re-export into the spawning module', () => {
    const directory = mkdtempSync(join(tmpdir(), 'check-test-process-spawns-'));
    try {
      writeFileSync(
        join(directory, 'spawner.ts'),
        "export function runGit() { return Bun.spawnSync(['git']); }\nexport function pure() { return 1; }\n",
      );
      writeFileSync(join(directory, 'index.ts'), "export { runGit, pure } from './spawner.ts';\n");
      const violations = inspectAt(
        join(directory, 'consumer.test.ts'),
        "import { pure, runGit } from './index.ts';\nit('x', () => { pure(); runGit(); });",
      );
      expect(violations).toEqual(['runGit()']);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('follows default and namespace imports into the spawning module', () => {
    const directory = mkdtempSync(join(tmpdir(), 'check-test-process-spawns-'));
    try {
      writeFileSync(
        join(directory, 'spawner.ts'),
        "export default function runGit() { return Bun.spawnSync(['git']); }\nexport function pure() { return 1; }\n",
      );
      writeFileSync(
        join(directory, 'named-default.ts'),
        "function inner() { return Bun.spawnSync(['git']); }\nexport default inner;\n",
      );
      const violations = inspectAt(
        join(directory, 'consumer.test.ts'),
        "import run from './spawner.ts';\nimport other from './named-default.ts';\nimport * as tools from './spawner.ts';\nit('x', () => { tools.pure(); run(); other(); tools.default(); });",
      );
      expect(violations).toEqual(['run()', 'other()', 'tools.default()']);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('resolves a workspace package through its exports map', () => {
    const resolved = resolveSpecifier(
      join(import.meta.dir, 'fixture.test.ts'),
      '@lostgradient/testing',
    );
    expect(resolved?.endsWith(join('packages', 'testing', 'src', 'index.ts'))).toBe(true);
  });
});

describe('spawn-free exemptions', () => {
  test('accepts a test marked spawn-free with a reason', () => {
    expect(
      inspect(
        "function run(spawner = Bun.spawnSync) { return spawner(['ls']); }\n// spawn-free: an injected stub replaces the real spawner here.\nit('x', () => { run(); });",
      ),
    ).toEqual([]);
  });

  test('reports a spawn-free marker whose reason is too short', () => {
    expect(
      inspect(
        "function run() { return Bun.spawnSync(['ls']); }\n// spawn-free: stubbed\nit('x', () => { run(); });",
      ),
    ).toEqual(['spawn-free reason shorter than 20 characters']);
  });

  test('does not exempt a process API written in the marked test body', () => {
    expect(
      inspect(
        "function run(spawner = Bun.spawnSync) { return spawner(['ls']); }\n// spawn-free: an injected stub replaces the real spawner here.\nit('x', () => { run(); Bun.spawnSync(['git']); });",
      ),
    ).toEqual(["Bun.spawnSync(['git'])"]);
  });

  test('does not exempt a different test', () => {
    expect(
      inspect(
        "// spawn-free: an injected stub replaces the real spawner here.\nit('a', () => {});\nit('b', () => { Bun.spawnSync(['ls']); });",
      ),
    ).toHaveLength(1);
  });
});

test('skips scripts/benchmarks directories when collecting test files', async () => {
  const { collectTestFiles } = await import('./check-test-process-spawns');
  const directory = mkdtempSync(join(tmpdir(), 'check-test-process-spawns-collect-'));
  try {
    mkdirSync(join(directory, 'scripts', 'benchmarks'), { recursive: true });
    writeFileSync(join(directory, 'scripts', 'benchmarks', 'load.test.ts'), '');
    writeFileSync(join(directory, 'scripts', 'unit.test.ts'), '');
    writeFileSync(join(directory, 'scripts', 'view.test.tsx'), '');
    const paths: string[] = [];
    collectTestFiles(directory, paths);
    expect(paths.map((path) => path.slice(directory.length + 1)).toSorted()).toEqual([
      join('scripts', 'unit.test.ts'),
      join('scripts', 'view.test.tsx'),
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('spawn hang guards', () => {
  const unbounded = (source: string): string[] =>
    findUnboundedSpawns(
      ts.createSourceFile('fixture.test.ts', source, ts.ScriptTarget.Latest, true),
    ).map((violation) => violation.text);

  test.each([
    ['an array-and-options spawn without timeout', "Bun.spawn(['bun'], { cwd: '/' });"],
    ['a single-object spawn without timeout', "Bun.spawnSync({ cmd: ['git'] });"],
    ['a spawn with no options at all', "Bun.spawnSync(['git', 'status']);"],
    ['a spawn whose options are a variable', "Bun.spawn(['bun'], options);"],
    [
      'a child_process call without timeout',
      "import { execFileSync } from 'node:child_process';\nexecFileSync('mkfifo', ['f']);",
    ],
    [
      'a child_process namespace call without timeout',
      "import * as processes from 'node:child_process';\nprocesses.spawn('sleep', ['30'], { detached: true });",
    ],
    ['a Bun shell template, which takes no timeout', 'await Bun.$`git init`;'],
    ['a $ shell template imported from bun', "import { $ } from 'bun';\nawait $`git init`;"],
  ])('reports %s', (_name, source) => {
    expect(unbounded(source)).toHaveLength(1);
  });

  test.each([
    ['a timeout in the options', "Bun.spawn(['bun'], { cwd: '/', timeout: 120_000 });"],
    ['a timeout in a single-object spawn', "Bun.spawnSync({ cmd: ['git'], timeout: LIMIT });"],
    [
      'a child_process call with a timeout',
      "import { execFile } from 'node:child_process';\nexecFile('git', ['init'], { timeout: LIMIT }, () => {});",
    ],
    ['an unrelated spawn function', "spawn('x');"],
  ])('accepts %s', (_name, source) => {
    expect(unbounded(source)).toEqual([]);
  });
});
