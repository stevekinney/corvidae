import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import ts from 'typescript';
import {
  collectScannedFiles,
  findProcessIdentifierPathViolations,
} from './check-process-identifier-test-paths';

/**
 * The fixtures spell the process id `PID`, and `inspect` writes it out. A literal `join(…, process.pid)`
 * in this file would be reported by the guard's own scan of string literals, which has no allowlist.
 */
function inspect(source: string): number[] {
  const parsed = ts.createSourceFile(
    'fixture.test.ts',
    source.replaceAll('PID', 'process.pid'),
    ts.ScriptTarget.Latest,
    true,
  );
  return findProcessIdentifierPathViolations(parsed).map((violation) => violation.line);
}

const IMPORT = "import { join, resolve } from 'node:path';\nimport { tmpdir } from 'node:os';\n";

describe('a path named after the process id', () => {
  test.each([
    ['a template literal', 'const path = join(tmpdir(), `bureau-${PID}.sqlite`);'],
    [
      'a template literal with a counter, as the Bureau tests wrote it',
      'let counter = 0;\nconst path = join(\n  tmpdir(),\n  `bureau-${PID}-${counter++}.sqlite`,\n);',
    ],
    ['resolve', 'const path = resolve(tmpdir(), `bureau-${PID}`);'],
    ['a + expression', "const path = join(tmpdir(), 'bureau-' + PID + '.sqlite');"],
    [
      'a String() conversion in a template literal',
      'const path = join(tmpdir(), `bureau-${String(PID)}-${crypto.randomUUID()}`);',
    ],
    ['a String() conversion alone', 'const path = join(tmpdir(), String(PID));'],
    ['a toString() conversion', 'const path = join(tmpdir(), PID.toString());'],
    ['a globalThis-qualified process', 'const path = join(tmpdir(), `bureau-${globalThis.PID}`);'],
    ['a ternary branch', 'const path = join(tmpdir(), flag ? `bureau-${PID}` : "bureau");'],
    [
      'a file-local const',
      'const name = `bureau-${PID}.sqlite`;\nconst path = join(tmpdir(), name);',
    ],
    [
      'a file-local const of a const',
      'const identifier = String(PID);\nconst name = `bureau-${identifier}`;\nconst path = join(tmpdir(), name);',
    ],
    [
      'a file-local const read inside a function',
      'const suffix = `-${PID}`;\nfunction pathFor(label: string) {\n  return join(tmpdir(), label + suffix);\n}',
    ],
    [
      'a method called on a value that carries the process id',
      'const path = join(tmpdir(), `bureau-${String(PID).padStart(8, "0")}`);',
    ],
    [
      'a method called on a file-local const that carries the process id',
      'const identifier = String(PID);\nconst path = join(tmpdir(), identifier.padStart(8, "0"));',
    ],
    [
      'a chain of methods on the process id',
      'const path = join(tmpdir(), PID.toString(36).toUpperCase());',
    ],
    [
      "a bracket access, process['pid']",
      "const path = join(tmpdir(), `bureau-${process['pid']}`);",
    ],
    [
      'a globalThis-qualified bracket access',
      "const path = join(tmpdir(), `bureau-${globalThis.process['pid']}`);",
    ],
    ['a nested join', 'const path = join(root, join(tmpdir(), `x-${PID}`));'],
  ])('reports %s', (_name, source) => {
    expect(inspect(`${IMPORT}${source}`).length).toBeGreaterThan(0);
  });

  test('names the line of the argument', () => {
    expect(
      inspect(`${IMPORT}\nconst path = join(\n  tmpdir(),\n  \`bureau-\${PID}\`,\n);`),
    ).toEqual([6]);
  });

  test.each([
    [
      'an aliased named import',
      "import { join as joinPath } from 'node:path';\njoinPath(a, `x-${PID}`);",
    ],
    ['the plain path module', "import { join } from 'path';\njoin(a, `x-${PID}`);"],
    ['a default import', "import path from 'node:path';\npath.join(a, `x-${PID}`);"],
    ['a namespace import', "import * as path from 'node:path';\npath.resolve(a, `x-${PID}`);"],
    ['the posix variant', "import { posix } from 'node:path';\nposix.join(a, `x-${PID}`);"],
    ['a dynamic import', "const { join } = await import('node:path');\njoin(a, `x-${PID}`);"],
    [
      'a dynamic import with a renamed binding',
      "const { join: joinPath } = await import('node:path');\njoinPath(a, `x-${PID}`);",
    ],
    ['a require call', "const path = require('node:path');\npath.join(a, `x-${PID}`);"],
  ])('follows %s', (_name, source) => {
    expect(inspect(source).length).toBe(1);
  });

  test.each([
    [
      'a child-process script held in a template literal',
      'const script = `\n  const file = join(dirname(sourcePath), \\`.ssr-\\${PID}.mjs\\`);\n`;',
    ],
    [
      'a child-process script held in a string literal',
      "const script = 'const file = join(directory, `.ssr-${PID}`);';",
    ],
    [
      'a child-process script whose template has a substitution between the call and the process id',
      'const script = `const file = join(${JSON.stringify(directory)}, \\`.ssr-\\${PID}.mjs\\`);`;',
    ],
    [
      'a child-process script whose template has several substitutions before the process id',
      'const script = `const a = ${one};\nconst file = join(${two}, ${three}, \\`-\\${PID}\\`);`;',
    ],
  ])('reports %s, which cannot be parsed', (_name, source) => {
    expect(inspect(source).length).toBe(1);
  });
});

describe('a process id that never names a path', () => {
  test.each([
    [
      'a lock file written with the owner',
      "writeFileSync(join(root, 'lock'), `${PID}\\n`);\nexpect(readFileSync(join(root, 'lock'), 'utf8')).toBe(`${PID}\\n`);",
    ],
    ['a comparison', 'expect(error.holderProcessIdentifier).toBe(PID);'],
    ['a kill', "process.kill(PID, 'SIGKILL');"],
    [
      'a process-table row',
      'const ownGroup = table.find((row) => row.pid === PID)?.pgid;\nconst path = join(root, String(ownGroup));',
    ],
    ['a process name that is not a path', 'const token = `7919.${PID}`;\nrun(token);'],
    [
      'a record written under a fixed name',
      "await Bun.write(join(record, 'server.pid'), `${PID}\\n`);",
    ],
    [
      'a path built from a UUID',
      'const path = join(tmpdir(), `bureau-${crypto.randomUUID()}.sqlite`);',
    ],
    [
      'a name that carries the process id but never reaches a path call',
      'const label = `worker-${PID}`;\nconsole.log(label);\nconst path = join(tmpdir(), "fixed");',
    ],
    [
      'a process id in a call that is not the path module',
      'const path = other.join(tmpdir(), `x-${PID}`);',
    ],
    [
      'a process id read from a call inside the argument',
      'const path = join(tmpdir(), name(PID));',
    ],
    [
      'a template whose substitution is followed by a statement end before the process id',
      'const script = `const file = join(${directory}, name);\nconsole.log(\\`-\\${PID}\\`);`;',
    ],
    [
      'a method called on a value that is not the process id',
      'const path = join(tmpdir(), String(counter).padStart(8, "0"));',
    ],
    ['a bracket access on another object', "const path = join(tmpdir(), String(row['pid']));"],
    [
      'a duration or a counter in a path',
      'const path = join(tmpdir(), `bureau-${counter++}-${Date.now()}.sqlite`);',
    ],
  ])('accepts %s', (_name, source) => {
    expect(inspect(`${IMPORT}${source}`)).toEqual([]);
  });

  test('accepts a file that does not import the path module', () => {
    expect(inspect('const path = join(tmpdir(), `x-${PID}`);')).toEqual([]);
  });
});

describe('test file discovery', () => {
  test('scans test files, test-support files and every .ts under src/test and src/testing', () => {
    const directory = mkdtempSync(join(tmpdir(), 'process-identifier-scan-'));
    try {
      for (const path of [
        'packages/bureau/src/create-bureau.test.ts',
        'packages/bureau/src/schedule-fire.slow.test.ts',
        'packages/bureau/src/fixtures.test-support.ts',
        'packages/bureau/src/test/storage-fixtures.ts',
        'packages/bureau/src/test/nested/deep.ts',
        'packages/bureau/src/testing/goal-fixtures.ts',
        'packages/bureau/src/create-bureau.ts',
        'packages/bureau/src/tester/not-a-test-directory.ts',
        'packages/bureau/test/not-under-src.ts',
        'packages/bureau/src/test/readme.md',
        'scripts/root-check.test.ts',
        'components/chat/node_modules/dependency/index.test.ts',
        'components/chat/.svelte-kit/generated.test.ts',
        'applications/playground/build/bundled.test.ts',
        'packages/weft/coverage/report.test.ts',
      ]) {
        mkdirSync(dirname(join(directory, path)), { recursive: true });
        writeFileSync(join(directory, path), '');
      }
      const paths: string[] = [];
      collectScannedFiles(directory, paths);
      expect(paths.map((path) => relative(directory, path)).toSorted()).toEqual([
        'packages/bureau/src/create-bureau.test.ts',
        'packages/bureau/src/fixtures.test-support.ts',
        'packages/bureau/src/schedule-fire.slow.test.ts',
        'packages/bureau/src/test/nested/deep.ts',
        'packages/bureau/src/test/storage-fixtures.ts',
        'packages/bureau/src/testing/goal-fixtures.ts',
        'scripts/root-check.test.ts',
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
