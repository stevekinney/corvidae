import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import ts from 'typescript';
import { checkContracts, partitionContracts, requiresIsolatedProgram } from './typecheck-contracts';

function classify(source: string): boolean {
  const parsed = ts.createSourceFile('contract.test-d.ts', source, ts.ScriptTarget.Latest, true);
  return requiresIsolatedProgram(parsed);
}

describe('requiresIsolatedProgram', () => {
  test.each([
    [
      'a module augmentation',
      "import { x } from './x.ts';\ndeclare module './x.ts' { interface Registry { a: 1 } }\nvoid x;",
    ],
    ['a global augmentation', 'export {};\ndeclare global { interface Window { a: 1 } }'],
    ['a script-mode file with no import or export', 'const value: number = 1;\nvoid value;'],
  ])('isolates %s', (_label, source) => {
    expect(classify(source)).toBe(true);
  });

  test.each([
    ['a plain module', "import { x } from './x.ts';\nconst y: number = x;\nvoid y;"],
    ['an empty export', 'export {};\nconst y: number = 1;\nvoid y;'],
    [
      'a namespace declaration',
      'export {};\ndeclare namespace Local { const a: number; }\nvoid Local.a;',
    ],
  ])('shares %s', (_label, source) => {
    expect(classify(source)).toBe(false);
  });
});

describe('checkContracts', () => {
  const directory = mkdtempSync(join(tmpdir(), 'typecheck-contracts-'));
  afterAll(() => rmSync(directory, { recursive: true, force: true }));

  const options: ts.CompilerOptions = {
    strict: true,
    noEmit: true,
    lib: ['lib.es5.d.ts'],
    types: [],
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ESNext,
    allowImportingTsExtensions: true,
  };

  function write(name: string, source: string): string {
    const path = join(directory, name);
    writeFileSync(path, source);
    return path;
  }

  const shared = write(
    'shared.test-d.ts',
    'export {};\ndeclare const value: number;\nconst text: string = value;\nvoid text;\n',
  );
  const sharedClean = write(
    'shared-clean.test-d.ts',
    'export {};\ndeclare const fine: number;\nvoid fine;\n',
  );
  const isolated = write(
    'isolated.test-d.ts',
    'export interface Registry { name: string }\ndeclare global { interface Window { registry: Registry } }\ndeclare const registry: Registry;\nconst wrong: number = registry.name;\nvoid wrong;\n',
  );
  const isolatedSibling = write(
    'isolated-sibling.test-d.ts',
    'export {};\ndeclare global { interface Registry { name: number } }\ndeclare const registry: Registry;\nconst right: number = registry.name;\nvoid right;\n',
  );

  const importer = write(
    'importer.test-d.ts',
    "import type { Registry } from './isolated.test-d.ts';\ndeclare const registry: Registry;\nvoid registry;\n",
  );
  const importerOfImporter = write(
    'importer-of-importer.test-d.ts',
    "import './importer.test-d.ts';\nexport {};\n",
  );

  test('partitions augmenting contracts away from the shared program', () => {
    const partition = partitionContracts([shared, sharedClean, isolated, isolatedSibling]);
    expect(partition.shared).toEqual([shared, sharedClean]);
    expect(partition.isolated).toEqual([isolated, isolatedSibling]);
  });

  test('isolates a contract that imports an isolated contract, transitively', () => {
    const partition = partitionContracts([importerOfImporter, importer, shared, isolated]);
    expect(partition.shared).toEqual([shared]);
    expect(partition.isolated).toEqual([importerOfImporter, importer, isolated]);
  });

  test('reports a diagnostic once when the same contract is loaded by several programs', () => {
    const { diagnostics } = checkContracts([importer, isolated], options);
    expect(diagnostics.map((diagnostic) => basename(diagnostic.file?.fileName ?? ''))).toEqual([
      'isolated.test-d.ts',
    ]);
  });

  test('reports an error in a shared contract and in an isolated contract at their own locations', () => {
    const { diagnostics } = checkContracts(
      [shared, sharedClean, isolated, isolatedSibling],
      options,
    );
    const located = diagnostics.map((diagnostic) => ({
      file: basename(diagnostic.file?.fileName ?? ''),
      line:
        diagnostic.file && diagnostic.start !== undefined
          ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start).line + 1
          : undefined,
      code: diagnostic.code,
    }));
    expect(located).toEqual([
      { file: 'shared.test-d.ts', line: 3, code: 2322 },
      { file: 'isolated.test-d.ts', line: 4, code: 2322 },
    ]);
  });

  test('keeps conflicting global augmentations from seeing each other', () => {
    // Sharing one program would merge the two Registry augmentations and
    // report a TS2717 conflict in both files instead of the single intended error.
    const { diagnostics } = checkContracts([isolated, isolatedSibling], options);
    expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual([2322]);
  });

  test('a clean set yields no diagnostics', () => {
    expect(checkContracts([sharedClean, isolatedSibling], options).diagnostics).toHaveLength(0);
  });
});
