/**
 * Which `scripts/check-*.ts` commands the package's gates run.
 *
 * A check nothing runs is worse than no check: it reads as enforcement while the tree drifts
 * past it. COR-2075 found twenty of them, five already failing. This module answers the two
 * questions that keep it from recurring, as pure functions over a scripts directory and a
 * `package.json` `scripts` map, so `gate-wiring.test.ts` can ask them of a fixture tree:
 *
 *   - Which commands does a gate script run, following `bun run <name>` into the scripts it
 *     names? ({@link findGateInvocations})
 *   - Which `check-*.ts` files are commands (they guard an entry point with `import.meta.main`),
 *     and which run on import without that guard? ({@link classifyCheckScripts})
 *
 * A `check-*.ts` with neither is a library module other scripts import, and is not a command.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import ts from 'typescript';

/** The package scripts Turborepo runs as gates; a check counts as wired only through these. */
export const GATE_SCRIPTS: readonly string[] = ['lint', 'test', 'test:coverage', 'typecheck'];

/** A leading `NAME=value` word sets the command's environment and is not the command. */
const ENVIRONMENT_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * Every TypeScript file the named scripts run with `bun <file> [arguments]`, each as the command
 * line that follows `bun` (`scripts/check-platform-features.ts --strict`), in the order they run.
 * `bun run <name>` is followed into the script it names; other tools (`oxlint`, `svelte-check`)
 * are not files this package owns and are skipped.
 */
export function findGateInvocations(
  scripts: Readonly<Record<string, string>>,
  roots: readonly string[] = GATE_SCRIPTS,
): string[] {
  const invocations: string[] = [];
  const visited = new Set<string>();

  const visit = (name: string): void => {
    if (visited.has(name) || !Object.hasOwn(scripts, name)) return;
    visited.add(name);
    for (const command of (scripts[name] ?? '').split('&&')) {
      const words = command.trim().split(/\s+/);
      while (ENVIRONMENT_ASSIGNMENT.test(words[0] ?? '')) words.shift();
      const [program, target, ...rest] = words;
      if (program !== 'bun' || target === undefined) continue;
      if (target === 'run' && rest[0] !== undefined) visit(rest[0]);
      else if (target.endsWith('.ts')) invocations.push([target, ...rest].join(' '));
    }
  };

  for (const root of roots) visit(root);
  return invocations;
}

/** Whether a statement does work when the module is imported, rather than declaring something. */
function runsOnImport(statement: ts.Statement): boolean {
  return ts.isExpressionStatement(statement);
}

/** The `check-*.ts` files of a scripts directory, by how they run. */
export type CheckScripts = {
  /** Commands: files that guard an entry point with `import.meta.main`. */
  entryPoints: string[];
  /** Files that run on import with no guard, so nothing can tell them from a library module. */
  unguarded: string[];
};

/** Sorts a scripts directory's `check-*.ts` files (tests excluded) into commands and unguarded scripts. */
export function classifyCheckScripts(scriptsDirectory: string): CheckScripts {
  const entryPoints: string[] = [];
  const unguarded: string[] = [];
  const files = readdirSync(scriptsDirectory)
    .filter((name) => /^check-.+\.ts$/.test(name) && !name.endsWith('.test.ts'))
    .toSorted();

  for (const name of files) {
    const source = readFileSync(join(scriptsDirectory, name), 'utf8');
    if (source.includes('import.meta.main')) {
      entryPoints.push(name);
      continue;
    }
    const sourceFile = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, false);
    if (sourceFile.statements.some(runsOnImport)) unguarded.push(name);
  }
  return { entryPoints, unguarded };
}

/**
 * The check commands under `scriptsDirectory` that no gate script runs. `scriptsDirectory` is the
 * package's `scripts` directory, so a gate names a check as `scripts/<file>`.
 */
export function findUninvokedChecks(
  scriptsDirectory: string,
  scripts: Readonly<Record<string, string>>,
): string[] {
  const invoked = new Set(
    findGateInvocations(scripts).map((invocation) => invocation.split(' ')[0]),
  );
  return classifyCheckScripts(scriptsDirectory).entryPoints.filter(
    (name) => !invoked.has(`scripts/${name}`),
  );
}
