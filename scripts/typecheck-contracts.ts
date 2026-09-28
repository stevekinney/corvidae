import { dirname, resolve } from 'node:path';
import ts from 'typescript';

// A contract needs its own TypeScript program when what it declares would
// otherwise leak into every other contract checked alongside it: a module or
// global augmentation (registry augmentation fixtures rely on this), or a
// script-mode file, whose top-level declarations are global. Every other
// contract is an ordinary module and can share one program, which loads the
// package's dependency graph once instead of once per contract. A contract
// that imports an isolated contract is isolated too, because the import would
// carry that augmentation into the shared program.
export function requiresIsolatedProgram(sourceFile: ts.SourceFile): boolean {
  if (!ts.isExternalModule(sourceFile)) return true;
  return sourceFile.statements.some(
    (statement) =>
      ts.isModuleDeclaration(statement) &&
      (ts.isStringLiteral(statement.name) ||
        (statement.flags & ts.NodeFlags.GlobalAugmentation) !== 0),
  );
}

function importedContracts(sourceFile: ts.SourceFile): string[] {
  const directory = dirname(sourceFile.fileName);
  return ts
    .preProcessFile(sourceFile.text, true, true)
    .importedFiles.map((imported) => imported.fileName)
    .filter((specifier) => specifier.startsWith('.') && specifier.endsWith('.test-d.ts'))
    .map((specifier) => resolve(directory, specifier));
}

export type ContractPartition = { shared: string[]; isolated: string[] };

export function partitionContracts(paths: readonly string[]): ContractPartition {
  const isolated = new Set<string>();
  const imports = new Map<string, string[]>();
  for (const path of paths) {
    const source = ts.sys.readFile(path);
    if (source === undefined) throw new Error(`Cannot read type contract ${path}`);
    const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
    if (requiresIsolatedProgram(sourceFile)) isolated.add(path);
    imports.set(path, importedContracts(sourceFile));
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const [path, imported] of imports) {
      if (isolated.has(path) || !imported.some((dependency) => isolated.has(dependency))) continue;
      isolated.add(path);
      changed = true;
    }
  }
  return {
    shared: paths.filter((path) => !isolated.has(path)),
    isolated: paths.filter((path) => isolated.has(path)),
  };
}

export type ContractCheck = {
  partition: ContractPartition;
  diagnostics: readonly ts.Diagnostic[];
};

export function checkContracts(
  paths: readonly string[],
  options: ts.CompilerOptions,
): ContractCheck {
  const partition = partitionContracts(paths);
  const diagnostics: ts.Diagnostic[] = [];
  const programs =
    partition.shared.length > 0
      ? [partition.shared, ...partition.isolated.map((path) => [path])]
      : partition.isolated.map((path) => [path]);
  const seen = new Set<string>();
  for (const rootNames of programs) {
    const program = ts.createProgram(rootNames, options);
    for (const diagnostic of ts.getPreEmitDiagnostics(program)) {
      const key = `${diagnostic.file?.fileName ?? ''}:${diagnostic.start ?? ''}:${diagnostic.code}`;
      if (seen.has(key)) continue;
      seen.add(key);
      diagnostics.push(diagnostic);
    }
  }
  return { partition, diagnostics };
}

function main(): void {
  const directory = process.cwd();
  const configurationPath = resolve(directory, 'tsconfig.json');
  const loaded = ts.readConfigFile(configurationPath, (path) => ts.sys.readFile(path));
  if (loaded.error)
    throw new Error(ts.flattenDiagnosticMessageText(loaded.error.messageText, '\n'));
  const configuration = ts.parseJsonConfigFileContent(loaded.config, ts.sys, directory);
  const formatHost: ts.FormatDiagnosticsHost = {
    getCanonicalFileName: (fileName) => fileName,
    getCurrentDirectory: () => directory,
    getNewLine: () => '\n',
  };

  const contracts = [...new Bun.Glob('{src,tests}/**/*.test-d.ts').scanSync(directory)]
    .toSorted()
    .map((contract) => resolve(directory, contract));
  const { partition, diagnostics } = checkContracts(contracts, configuration.options);
  let failureCount = diagnostics.length;
  if (diagnostics.length > 0) {
    process.stderr.write(ts.formatDiagnostics(diagnostics, formatHost));
  }

  for (const path of new Bun.Glob('src/**/__fixtures__/**/tsconfig.json').scanSync(directory)) {
    const result = Bun.spawnSync(['bun', 'x', 'tsc', '--noEmit', '--project', path], {
      cwd: directory,
      stdout: 'inherit',
      stderr: 'inherit',
    });
    if (result.exitCode !== 0) failureCount += 1;
  }

  process.stdout.write(
    `Checked ${contracts.length} type contracts (${partition.shared.length} in one shared program, ${partition.isolated.length} isolated); ${failureCount} errors.\n`,
  );
  process.exitCode = failureCount > 0 ? 1 : 0;
}

if (import.meta.main) main();
