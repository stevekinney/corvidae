import { existsSync } from 'node:fs';
import { join } from 'node:path';

import ts from 'typescript';

import {
  flattenExportTarget,
  sourceCandidatesForTarget,
  type SurfaceExportsMap,
} from './package-surface.ts';

/**
 * Whether a published subpath's runtime module exports every value its `types` condition declares.
 *
 * COR-1274. `@lostgradient/weft/storage/sqlite` resolves `types` to `src/storage/sqlite.ts`, a
 * declaration-only module (`export declare const SQLiteStorage`), and its runtime conditions to
 * `src/storage/bun-sql.ts` and `src/storage/node-sqlite.ts`, which have to carry
 * `export { … as SQLiteStorage }`. The consolidation into corvidae dropped both aliases and nothing
 * noticed: a consumer's typecheck reads the declaration, which is complete, and every packaging
 * gate asks whether a file exists rather than what it exports. The subpath compiled and then threw
 * `Export named 'SQLiteStorage' not found` on import.
 *
 * **Which entries qualify.** Only one whose `types` condition and a runtime condition derive from
 * different *source modules*. Emitted paths are the wrong unit: a cinder component subpath names
 * `dist/…/index.d.ts`, `src/…/index.ts` and `dist/server/…/index.js`, three paths built from one
 * module, so its declaration is generated from its runtime and cannot promise a name the runtime
 * lacks. Each target is mapped back to its source with `sourceCandidatesForTarget`, the same
 * mapping `checkTargetCoverage` uses, so there is one definition of "the source this path came
 * from" rather than two that can disagree. A runtime condition is paired with the nearest `types`
 * condition that governs it — `bun.default` with `bun.types` where the entry has one, and with the
 * top-level `types` otherwise.
 *
 * **Why source rather than the tarball.** The qualification is a statement about source modules,
 * so only source can answer it; the defect is an authoring divergence the build faithfully
 * reproduces rather than one it introduces; and checked here the finding refuses a sync in
 * `assertPublishable`, before anything is written, built or packed, for every target. The packed
 * tarball has its own gates — publint, attw and the consumer smoke test — and they remain the ones
 * that speak for the artifact.
 *
 * **Values only.** A declaration is allowed to export types its runtime module has never heard
 * of: `export type SQLiteStorageInstance` has no runtime counterpart by design, and a check that
 * flagged it would be turned off. A name counts as a value when importing it yields something at
 * run time — a variable, function, class, enum or instantiated namespace — and not when every
 * path to it passes through `export type`, `import type` or `export type *`. That last one is why
 * re-exports are resolved here rather than by `getAliasedSymbol`: the checker reports a class
 * reached through `export type * from` as a plain class, with nothing on the symbol to say that a
 * consumer cannot use it as a value.
 */

export interface DeclarationFinding {
  publicName: string;
  subpath: string;
  /** Package-relative source module the `types` condition derives from. */
  declaration: string;
  /** Package-relative source module a runtime condition derives from. */
  runtime: string;
  /** Values the declaration exports and the runtime module does not, sorted. */
  missing: string[];
}

export interface DeclarationAgreement {
  publicName: string;
  /** Subpaths whose `types` and runtime conditions derive from different source modules. */
  examined: string[];
  findings: DeclarationFinding[];
}

export interface DeclarationAgreementOptions {
  publicName: string;
  exports: SurfaceExportsMap;
  /** The package's source root, as `package-surface.json` records it. */
  sourceRoot: string;
  /** The corvidae workspace directory the sources are read from. */
  packageRoot: string;
}

/** Extensions TypeScript can read exports from. Anything else (a stylesheet) exports no values. */
const scriptModule = /\.(?:[cm]?[jt]sx?)$/;

/** The package-relative source module an exports target derives from, if one exists. */
function sourceModuleFor(target: string, sourceRoot: string, packageRoot: string) {
  return sourceCandidatesForTarget(target, sourceRoot).find((candidate) =>
    existsSync(join(packageRoot, candidate)),
  );
}

/** The `types` condition that governs a runtime condition path, from the innermost outwards. */
function governingDeclaration(condition: string, declarations: ReadonlyMap<string, string>) {
  const segments = condition.split('.');
  for (let depth = segments.length - 1; depth >= 0; depth -= 1) {
    const candidate = [...segments.slice(0, depth), 'types'].join('.');
    const declaration = declarations.get(candidate);
    if (declaration !== undefined) return declaration;
  }
  return undefined;
}

function isDeclarationCondition(condition: string): boolean {
  return condition === 'types' || condition.endsWith('.types');
}

/** Every distinct declaration/runtime source pair in one entry whose two modules differ. */
function divergentPairs(
  value: SurfaceExportsMap[string],
  sourceRoot: string,
  packageRoot: string,
): [string, string][] {
  const flattened = flattenExportTarget(value);
  const declarations = new Map<string, string>();
  for (const [condition, target] of flattened) {
    if (!isDeclarationCondition(condition)) continue;
    const source = sourceModuleFor(target, sourceRoot, packageRoot);
    if (source !== undefined) declarations.set(condition, source);
  }
  const everyDeclaration = [...new Set(declarations.values())];
  const pairs = new Map<string, [string, string]>();
  for (const [condition, target] of flattened) {
    if (isDeclarationCondition(condition)) continue;
    const runtime = sourceModuleFor(target, sourceRoot, packageRoot);
    // A target with no source is `checkTargetCoverage`'s `no-source` finding already, and a
    // wildcard names no single module; neither is something this check can compare.
    if (runtime === undefined) continue;
    // A runtime condition with no `types` above it — `{ bun: …, import: { types, default } }` —
    // is still typed by whichever declaration the consumer's compiler happens to pick, which is
    // exactly how a Bun import comes to be checked against a declaration it never loads. With no
    // way to say which one, it has to satisfy all of them.
    const governing = governingDeclaration(condition, declarations);
    for (const declaration of governing === undefined ? everyDeclaration : [governing]) {
      if (declaration !== runtime)
        pairs.set(`${declaration}\u0000${runtime}`, [declaration, runtime]);
    }
  }
  return [...pairs.values()];
}

/**
 * Options that only trim what the program loads. Which names a module exports, and whether each
 * is a value, is settled by the binder from the module graph; the default libraries and ambient
 * `@types` packages contribute nothing to it. Loading them was over 90% of the cost — roughly half
 * a second per package, paid on every `planSurface` — for no change in any answer.
 */
const exportShapeOnly: ts.CompilerOptions = {
  allowJs: true,
  noEmit: true,
  noLib: true,
  types: [],
};

/** TS18003, "No inputs were found in config file". */
const noInputsFound = 18_003;

/** The package's own compiler options, so its path mappings and extension imports resolve. */
function compilerOptionsFor(packageRoot: string): ts.CompilerOptions {
  const fallback: ts.CompilerOptions = {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowImportingTsExtensions: true,
  };
  const path = join(packageRoot, 'tsconfig.json');
  if (!existsSync(path)) return { ...fallback, ...exportShapeOnly };
  const read = ts.readConfigFile(path, (file) => ts.sys.readFile(file));
  if (read.error !== undefined) {
    throw new DeclarationAgreementError(
      `${path} could not be read: ${ts.flattenDiagnosticMessageText(read.error.messageText, '\n')}`,
    );
  }
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, packageRoot, undefined, path);
  // A broken `extends` or an invalid option does not stop TypeScript; it parses what it can and
  // reports the rest here. Carrying on would resolve modules under weaker options than the
  // package's own, and an `export *` that then fails to resolve reads as a missing value. "No
  // inputs were found" is the one error that says nothing about options: this check names its
  // own root files and never reads the configuration's `include`.
  const errors = parsed.errors.filter((error) => error.code !== noInputsFound);
  if (errors.length > 0) {
    throw new DeclarationAgreementError(
      `${path} could not be parsed:\n${errors
        .map((error) => `  ${ts.flattenDiagnosticMessageText(error.messageText, '\n')}`)
        .join('\n')}`,
    );
  }
  return { ...parsed.options, ...exportShapeOnly };
}

export class DeclarationAgreementError extends Error {}

/**
 * The value names each module exports, resolved through its re-exports.
 *
 * Memoized per source file for the life of one program, which is one package's check — but only
 * a result computed without meeting a module already on the walk. Inside an `export *` cycle the
 * module being re-entered answers with nothing, which is right for the module that started the
 * walk (it already holds its own names) and wrong for every other member, which would otherwise be
 * cached missing them. Those are recomputed when asked for directly instead.
 */
class ValueExports {
  readonly #checker: ts.TypeChecker;
  readonly #memo = new Map<ts.SourceFile, Set<string>>();
  readonly #inProgress = new Set<ts.SourceFile>();
  /** Whether the walk in progress has re-entered a module it was already inside. */
  #reenteredCycle = false;

  constructor(program: ts.Program) {
    this.#checker = program.getTypeChecker();
  }

  of(file: ts.SourceFile): Set<string> {
    const memoized = this.#memo.get(file);
    if (memoized !== undefined) return memoized;
    if (this.#inProgress.has(file)) {
      this.#reenteredCycle = true;
      return new Set();
    }
    const enclosingReentered = this.#reenteredCycle;
    this.#reenteredCycle = false;
    this.#inProgress.add(file);
    const values = new Set<string>();
    const moduleSymbol = this.#checker.getSymbolAtLocation(file);
    const local = new Set<string>();
    if (moduleSymbol !== undefined) {
      for (const exported of this.#checker.getExportsOfModule(moduleSymbol)) {
        if (!exported.declarations?.some((node) => node.getSourceFile() === file)) continue;
        local.add(exported.name);
        if (this.#isValue(exported)) values.add(exported.name);
      }
    }
    for (const statement of file.statements) {
      if (!ts.isExportDeclaration(statement)) continue;
      if (statement.exportClause !== undefined || statement.isTypeOnly) continue;
      const target = this.#moduleFile(statement.moduleSpecifier);
      if (target === undefined) continue;
      for (const name of this.of(target)) {
        // A local declaration shadows a star re-export of the same name, and `export *` never
        // carries a default.
        if (name !== 'default' && !local.has(name)) values.add(name);
      }
    }
    this.#inProgress.delete(file);
    if (!this.#reenteredCycle) this.#memo.set(file, values);
    this.#reenteredCycle = enclosingReentered || this.#reenteredCycle;
    return values;
  }

  #moduleFile(specifier: ts.Expression | undefined): ts.SourceFile | undefined {
    if (specifier === undefined) return undefined;
    const declaration = this.#checker.getSymbolAtLocation(specifier)?.valueDeclaration;
    return declaration !== undefined && ts.isSourceFile(declaration) ? declaration : undefined;
  }

  /** Whether a name another module re-exports from `specifier` is a value there. */
  #exportsValue(specifier: ts.Expression, name: string, symbol: ts.Symbol): boolean {
    const target = this.#moduleFile(specifier);
    if (target !== undefined && !this.#inProgress.has(target)) return this.of(target).has(name);
    // An ambient or unresolvable module has no file to walk, and one already on the walk has no
    // complete answer yet. Fall back to what the checker resolves the alias to; an unresolved one
    // is treated as a value, which errs toward asking the runtime module for it rather than
    // toward excusing it.
    const resolved = this.#checker.getAliasedSymbol(symbol);
    return (resolved.flags & ts.SymbolFlags.Value) !== 0;
  }

  #isValue(symbol: ts.Symbol): boolean {
    if ((symbol.flags & ts.SymbolFlags.Alias) === 0) {
      return (symbol.flags & ts.SymbolFlags.Value) !== 0;
    }
    const declaration = symbol.declarations?.[0];
    if (declaration === undefined) return false;
    if (ts.isTypeOnlyImportOrExportDeclaration(declaration)) return false;
    if (ts.isExportSpecifier(declaration)) {
      const specifier = declaration.parent.parent.moduleSpecifier;
      const name = (declaration.propertyName ?? declaration.name).text;
      if (specifier !== undefined) return this.#exportsValue(specifier, name, symbol);
    } else if (ts.isImportSpecifier(declaration)) {
      const name = (declaration.propertyName ?? declaration.name).text;
      return this.#exportsValue(declaration.parent.parent.parent.moduleSpecifier, name, symbol);
    } else if (ts.isImportClause(declaration)) {
      return this.#exportsValue(declaration.parent.moduleSpecifier, 'default', symbol);
    } else if (ts.isNamespaceImport(declaration) || ts.isNamespaceExport(declaration)) {
      // A module namespace object is a value unless the clause was type-only, handled above.
      return true;
    }
    // A local `export { name }`, `export default name` or `import x = …`: follow one step to
    // whatever it names in this program and ask the same question of that.
    const next = this.#checker.getImmediateAliasedSymbol(symbol);
    if (next === undefined || next === symbol) return true;
    return this.#isValue(next);
  }
}

/**
 * Check every qualifying `exports` entry of one published package.
 *
 * Returns findings rather than throwing, so `planSurface` can carry them and `assertPublishable`
 * decides; the plan is also built by callers that report rather than refuse.
 */
export function checkDeclarationAgreement({
  publicName,
  exports,
  sourceRoot,
  packageRoot,
}: DeclarationAgreementOptions): DeclarationAgreement {
  const pairsBySubpath = new Map<string, [string, string][]>();
  for (const [subpath, value] of Object.entries(exports)) {
    const pairs = divergentPairs(value, sourceRoot, packageRoot);
    if (pairs.length > 0) pairsBySubpath.set(subpath, pairs);
  }
  const examined = [...pairsBySubpath.keys()];
  if (examined.length === 0) return { publicName, examined, findings: [] };

  const modules = new Set<string>();
  for (const pairs of pairsBySubpath.values()) {
    for (const [declaration, runtime] of pairs) {
      if (scriptModule.test(declaration)) modules.add(declaration);
      if (scriptModule.test(runtime)) modules.add(runtime);
    }
  }
  const program = ts.createProgram(
    [...modules].map((module) => join(packageRoot, module)),
    compilerOptionsFor(packageRoot),
  );
  const valueExports = new ValueExports(program);
  const valuesOf = (module: string): Set<string> => {
    if (!scriptModule.test(module)) return new Set();
    const file = program.getSourceFile(join(packageRoot, module));
    if (file === undefined) {
      throw new DeclarationAgreementError(`${publicName}: TypeScript could not load ${module}`);
    }
    return valueExports.of(file);
  };

  const findings: DeclarationFinding[] = [];
  for (const [subpath, pairs] of pairsBySubpath) {
    for (const [declaration, runtime] of pairs) {
      const declared = valuesOf(declaration);
      // A declaration with no values promises nothing a runtime module could lack, which is what
      // keeps a stylesheet's `export {}` stub from ever asking a `.css` file for exports.
      if (declared.size === 0) continue;
      const provided = valuesOf(runtime);
      const missing = [...declared].filter((name) => !provided.has(name)).toSorted();
      if (missing.length > 0) findings.push({ publicName, subpath, declaration, runtime, missing });
    }
  }
  return { publicName, examined, findings };
}

/** One line per finding, suitable for a failure message. */
export function describeDeclarationFinding(finding: DeclarationFinding): string {
  return `${finding.publicName} ${finding.subpath}: ${finding.declaration} declares ${finding.missing.join(', ')}, which ${finding.runtime} does not export`;
}
