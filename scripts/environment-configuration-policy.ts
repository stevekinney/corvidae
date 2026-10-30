import { readFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import ts from 'typescript';
import { directoryGlob, workspaceParentDirectories } from './workspace-directories.ts';

export type EnvironmentBoundaryKind = 'runtime' | 'script';

export type EnvironmentViolation = {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly message: string;
};

/** Registered locations where process environment values may be read. */
export const environmentBoundaries = [
  {
    kind: 'runtime',
    paths: new Set([
      'applications/interborough/src/host/environment-configuration.ts',
      'applications/playground/src/environment-configuration.ts',
      'applications/terminal-example/src/server/environment-configuration.ts',
      'packages/bungalow/src/environment-configuration.ts',
      'packages/operative/src/environment-configuration.ts',
      'packages/operative-gemini/src/environment-configuration.ts',
      'packages/bureau/src/skills/environment-configuration.ts',
      'testing/testing/src/environment-configuration.ts',
      'packages/weft/src/runtime/environment-configuration.ts',
      'packages/storage/src/environment-configuration.ts',
    ]),
  },
  {
    kind: 'script',
    paths: new Set([
      'applications/interborough/scripts/environment-configuration.ts',
      'applications/playground/scripts/environment-configuration.ts',
      'applications/terminal-example/tests/environment-configuration.ts',
      'components/cinder/scripts/environment-configuration.ts',
      'scripts/browser-fixtures/environment-configuration.ts',
      'scripts/environment-configuration.ts',
      'packages/armorer/test/fixtures/environment-configuration.ts',
      'packages/bureau/src/test/signal-shutdown/environment-configuration.ts',
      'packages/storage-node-sqlite/src/test/environment-configuration.ts',
      'packages/operative-typesafe/scripts/record-decision-fixtures.ts',
      'packages/weft/examples/environment-configuration.ts',
      'packages/weft/src/cli/__fixtures__/environment-configuration.ts',
      'packages/weft/scripts/benchmarks/environment-configuration.ts',
    ]),
  },
] satisfies readonly {
  readonly kind: EnvironmentBoundaryKind;
  readonly paths: ReadonlySet<string>;
}[];

const environmentGlobals = new Set(['process', 'Bun']);
const sourceExtensions = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.svelte']);
const ignoredPathSegment =
  /^(?:node_modules|dist|build|coverage|\.turbo|\.svelte-kit|\.playwright|\.bun)$/;

type EnvironmentReference = { readonly node: ts.Node; readonly key: string | undefined };

function isPropertyAccess(node: ts.Node): node is ts.PropertyAccessExpression {
  return ts.isPropertyAccessExpression(node);
}

function isElementAccess(node: ts.Node): node is ts.ElementAccessExpression {
  return ts.isElementAccessExpression(node);
}

type EnvironmentAliases = {
  readonly environment: ReadonlySet<string>;
  readonly runtime: ReadonlySet<string>;
  readonly dollarEnv: ReadonlySet<string>;
};

function isEnvironmentObject(
  node: ts.Node,
  runtimeAliases: ReadonlySet<string> = new Set(),
): boolean {
  if (ts.isPropertyAccessExpression(node) && node.name.text === 'env')
    return isRuntimeObject(node.expression, runtimeAliases);
  return (
    ts.isElementAccessExpression(node) &&
    literalKey(node.argumentExpression) === 'env' &&
    isRuntimeObject(node.expression, runtimeAliases)
  );
}

function isRuntimeObject(node: ts.Node, aliases: ReadonlySet<string> = new Set()): boolean {
  if (ts.isIdentifier(node)) return environmentGlobals.has(node.text) || aliases.has(node.text);
  if (ts.isElementAccessExpression(node))
    return (
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'globalThis' &&
      literalKey(node.argumentExpression) !== undefined &&
      environmentGlobals.has(literalKey(node.argumentExpression) ?? '')
    );
  return (
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'globalThis' &&
    environmentGlobals.has(node.name.text)
  );
}

function literalKey(node: ts.Expression | undefined): string | undefined {
  if (!node) return undefined;
  return ts.isStringLiteralLike(node) || ts.isNumericLiteral(node) ? node.text : undefined;
}

function referenceFor(
  node: ts.Node,
  sourceFile?: ts.SourceFile,
  aliases?: EnvironmentAliases,
): EnvironmentReference | undefined {
  if (isEnvironmentObject(node, aliases?.runtime)) {
    const parent = node.parent;
    if ((isPropertyAccess(parent) || isElementAccess(parent)) && parent.expression === node)
      return undefined;
    if (ts.isCallExpression(parent) && parent.expression.getText() === 'Reflect.get')
      return undefined;
    if (
      ts.isVariableDeclaration(parent) &&
      parent.initializer === node &&
      ts.isIdentifier(parent.name)
    )
      return undefined;
    if (isEnvironmentSpreadForwarding(node, sourceFile) || isEnvironmentForwarding(node))
      return undefined;
    return { node, key: undefined };
  }
  if (isPropertyAccess(node) && isEnvironmentObject(node.expression, aliases?.runtime)) {
    return { node, key: node.name.text };
  }
  if (isElementAccess(node) && isEnvironmentObject(node.expression, aliases?.runtime)) {
    if (sourceFile !== undefined && isNamedEnvironmentSnapshot(node, sourceFile)) return undefined;
    return { node, key: literalKey(node.argumentExpression) };
  }
  return undefined;
}

function isWrite(reference: ts.Node): boolean {
  const parent = reference.parent;
  return (
    ts.isBinaryExpression(parent) &&
    parent.left === reference &&
    parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
    parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment
  );
}

function isDeleted(reference: ts.Node): boolean {
  return ts.isDeleteExpression(reference.parent);
}

function isEnvironmentSpreadForwarding(node: ts.Node, sourceFile?: ts.SourceFile): boolean {
  const spread = node.parent;
  if (!ts.isSpreadAssignment(spread) && !ts.isSpreadElement(spread)) return false;
  const object = spread.parent;
  if (!ts.isObjectLiteralExpression(object)) return false;
  const owner = object.parent;
  if (
    ts.isPropertyAssignment(owner) &&
    owner.initializer === object &&
    ts.isIdentifier(owner.name) &&
    owner.name.text === 'env'
  )
    return true;
  if (ts.isCallExpression(owner) && owner.arguments.includes(object)) return true;
  return (
    ts.isVariableDeclaration(owner) &&
    owner.initializer === object &&
    ts.isIdentifier(owner.name) &&
    /(?:environment|constrained|unconstrained|_env)$/i.test(owner.name.text) &&
    (object.properties.some((property) => ts.isPropertyAssignment(property)) ||
      (sourceFile !== undefined &&
        new RegExp(`env\\s*:\\s*${owner.name.text}\\b`).test(sourceFile.getFullText())))
  );
}

function isEnvironmentForwarding(node: ts.Node): boolean {
  const parent = node.parent;
  if (
    ts.isPropertyAssignment(parent) &&
    parent.initializer === node &&
    ts.isIdentifier(parent.name) &&
    parent.name.text === 'env'
  )
    return true;
  if (
    ts.isParameter(parent) &&
    parent.initializer === node &&
    ts.isIdentifier(parent.name) &&
    /^(?:env|environment)$/i.test(parent.name.text)
  )
    return true;
  return (
    ts.isBinaryExpression(parent) &&
    parent.right === node &&
    parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    ts.isIdentifier(parent.left) &&
    /^(?:env|environment)$/i.test(parent.left.text)
  );
}

function isNamedEnvironmentSnapshot(
  node: ts.ElementAccessExpression,
  sourceFile: ts.SourceFile,
): boolean {
  const text = sourceFile.getFullText();
  if (
    !/function\s+(?:snapshotEnv|setEnvironment)\b/.test(text) &&
    !/const\s+saved\s*=\s*Object\.fromEntries\b/.test(text)
  )
    return false;
  return node.argumentExpression !== undefined && !literalKey(node.argumentExpression);
}

function isReflectProcess(node: ts.Node): boolean {
  return (
    ts.isCallExpression(node) &&
    node.expression.getText() === 'Reflect.get' &&
    node.arguments.length >= 2 &&
    node.arguments[0] !== undefined &&
    node.arguments[0].getText() === 'globalThis' &&
    environmentGlobals.has(literalKey(node.arguments[1]) ?? '')
  );
}

function isLiteralDefineKey(reference: ts.Node): boolean {
  return (
    ts.isPropertyAssignment(reference.parent) &&
    reference.parent.name === reference &&
    ts.isStringLiteral(reference) &&
    reference.text.startsWith('process.env.')
  );
}

function importedEnvironmentAliases(sourceFile: ts.SourceFile): Set<string> {
  const aliases = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
      continue;
    if (!statement.moduleSpecifier.text.startsWith('$env/')) continue;
    const clause = statement.importClause;
    if (clause?.name) aliases.add(clause.name.text);
    for (const element of clause?.namedBindings && ts.isNamedImports(clause.namedBindings)
      ? clause.namedBindings.elements
      : [])
      aliases.add(element.name.text);
    if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
      aliases.add(clause.namedBindings.name.text);
    }
  }
  return aliases;
}

function aliasesOfEnvironment(sourceFile: ts.SourceFile): EnvironmentAliases {
  const environment = new Set<string>();
  const runtime = new Set<string>();
  const dollarEnv = importedEnvironmentAliases(sourceFile);
  function visit(node: ts.Node): void {
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const name = ts.isIdentifier(node.name) ? node.name.text : undefined;
      if (
        name &&
        (isRuntimeObject(node.initializer, runtime) || isReflectProcess(node.initializer))
      )
        runtime.add(name);
      if (isEnvironmentObject(node.initializer, runtime))
        environment.add(node.name.getText(sourceFile));
      if (
        name &&
        ts.isObjectLiteralExpression(node.initializer) &&
        node.initializer.properties.some(
          (property) =>
            ts.isPropertyAssignment(property) &&
            ts.isIdentifier(property.name) &&
            property.name.text === 'env' &&
            isEnvironmentObject(property.initializer, runtime),
        )
      )
        environment.add(name);
      if (
        ts.isCallExpression(node.initializer) &&
        node.initializer.expression.getText() === 'Reflect.get' &&
        literalKey(node.initializer.arguments[1]) === 'env' &&
        node.initializer.arguments[0] !== undefined &&
        ts.isIdentifier(node.initializer.arguments[0]) &&
        runtime.has(node.initializer.arguments[0].text) &&
        ts.isIdentifier(node.name)
      )
        environment.add(node.name.text);
      if (ts.isIdentifier(node.initializer) && environment.has(node.initializer.text))
        environment.add(node.name.getText(sourceFile));
      if (name && ts.isIdentifier(node.initializer) && dollarEnv.has(node.initializer.text))
        dollarEnv.add(name);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return { environment, runtime, dollarEnv };
}

function testRestorationKeys(sourceFile: ts.SourceFile, aliases: EnvironmentAliases): Set<string> {
  const saved = new Set<string>();
  const restored = new Set<string>();
  function visit(node: ts.Node): void {
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const reference = referenceFor(node.initializer, sourceFile, aliases);
      if (reference && /^(saved|previous|original|prior)/i.test(node.name.getText(sourceFile)))
        saved.add(reference.key ?? '*');
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const reference = referenceFor(node.right, sourceFile, aliases);
      if (
        reference &&
        ts.isIdentifier(node.left) &&
        /^(saved|previous|original|prior)/i.test(node.left.text)
      ) {
        saved.add(reference.key ?? '*');
      }
    }
    const reference = referenceFor(node, sourceFile, aliases);
    const assignment = reference !== undefined && isWrite(node) ? node.parent : undefined;
    const restoresSavedValue =
      assignment !== undefined &&
      ts.isBinaryExpression(assignment) &&
      ts.isIdentifier(assignment.right) &&
      /^(saved|previous|original|prior)/i.test(assignment.right.text);
    if (reference && (isDeleted(node) || restoresSavedValue)) restored.add(reference.key ?? '*');
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return new Set([...saved].filter((key) => restored.has(key)));
}

function isSavedInitializer(
  node: ts.Node,
  restoredKeys: ReadonlySet<string>,
  sourceFile: ts.SourceFile,
  aliases: EnvironmentAliases,
): boolean {
  const parent = node.parent;
  const variableInitializer =
    ts.isVariableDeclaration(parent) &&
    parent.initializer === node &&
    /^(saved|previous|original|prior)/i.test(parent.name.getText(sourceFile));
  const assignmentInitializer =
    ts.isBinaryExpression(parent) &&
    parent.right === node &&
    ts.isIdentifier(parent.left) &&
    /^(saved|previous|original|prior)/i.test(parent.left.text);
  if (!variableInitializer && !assignmentInitializer) return false;
  const reference = referenceFor(node, sourceFile, aliases);
  return reference !== undefined && restoredKeys.has(reference.key ?? '*');
}

function sourceTextForSvelte(source: string): string {
  return source.replace(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g, '$1');
}

/** Classify forbidden environment reads in one source file. */
export function findEnvironmentViolations(
  source: string,
  file = 'source.ts',
): readonly EnvironmentViolation[] {
  const sourceFile = ts.createSourceFile(
    file,
    sourceTextForSvelte(source),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const environmentAliases = aliasesOfEnvironment(sourceFile);
  const restoredKeys = /(?:\.test\.|\.spec\.|\/test\/|\/tests\/|__tests__)/.test(file)
    ? testRestorationKeys(sourceFile, environmentAliases)
    : new Set<string>();
  const violations: EnvironmentViolation[] = [];
  function report(node: ts.Node, message: string): void {
    const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    violations.push({ file, line: position.line + 1, column: position.character + 1, message });
  }
  function visit(node: ts.Node): void {
    const reference = referenceFor(node, sourceFile, environmentAliases);
    if (reference) {
      if (isWrite(node) || isDeleted(node)) return ts.forEachChild(node, visit);
      if (isEnvironmentSpreadForwarding(node, sourceFile)) return ts.forEachChild(node, visit);
      if (isLiteralDefineKey(node)) return ts.forEachChild(node, visit);
      if (isSavedInitializer(node, restoredKeys, sourceFile, environmentAliases))
        return ts.forEachChild(node, visit);
      report(
        node,
        `environment read must go through a registered environment-configuration.ts module (${reference.key ?? 'environment object'})`,
      );
    }
    if (
      (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
      ts.isIdentifier(node.expression) &&
      environmentAliases.environment.has(node.expression.text)
    ) {
      report(
        node,
        'environment alias reads must go through a registered environment-configuration.ts module',
      );
    }
    if (
      ts.isIdentifier(node) &&
      environmentAliases.environment.has(node.text) &&
      !ts.isVariableDeclaration(node.parent) &&
      !ts.isPropertyAccessExpression(node.parent) &&
      !ts.isElementAccessExpression(node.parent) &&
      !isEnvironmentSpreadForwarding(node) &&
      !(ts.isCallExpression(node.parent) && node.parent.expression.getText() === 'Reflect.get') &&
      !isWrite(node) &&
      !isDeleted(node)
    ) {
      report(
        node,
        'environment alias reads must go through a registered environment-configuration.ts module',
      );
    }
    if (ts.isCallExpression(node) && node.expression.getText(sourceFile) === 'Reflect.get') {
      const target = node.arguments[0];
      if (
        target &&
        (isEnvironmentObject(target, environmentAliases.runtime) ||
          (isReflectProcess(target) && literalKey(node.arguments[1]) === 'env') ||
          (ts.isIdentifier(target) && environmentAliases.environment.has(target.text)))
      ) {
        report(
          node,
          'Reflect.get environment reads must go through a registered environment-configuration.ts module',
        );
      }
    }
    if (ts.isIdentifier(node) && environmentAliases.dollarEnv.has(node.text)) {
      const parent = node.parent;
      if (
        !ts.isImportSpecifier(parent) &&
        !ts.isImportClause(parent) &&
        !ts.isNamedImports(parent) &&
        !ts.isVariableDeclaration(parent) &&
        !(ts.isPropertyAccessExpression(parent) && parent.expression === node) &&
        !(ts.isElementAccessExpression(parent) && parent.expression === node)
      ) {
        report(
          node,
          '$env or environment alias read must go through a registered environment-configuration.ts module',
        );
      }
      if (
        (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) &&
        parent.expression === node
      ) {
        report(
          parent,
          '$env or environment alias reads must go through a registered environment-configuration.ts module',
        );
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return violations;
}

export function boundaryKind(file: string): EnvironmentBoundaryKind | undefined {
  const normalized = file.replaceAll('\\', '/');
  return environmentBoundaries.find((boundary) => boundary.paths.has(normalized))?.kind;
}

export async function scanEnvironmentConfigurationPolicy(
  root: string,
): Promise<readonly EnvironmentViolation[]> {
  const files = await collectSourceFiles(resolve(root));
  const violations = await Promise.all(
    files.map(async (file) =>
      boundaryKind(relative(root, file)) === undefined
        ? findEnvironmentViolations(await readFile(file, 'utf8'), relative(root, file))
        : [],
    ),
  );
  return violations.flat();
}

async function collectSourceFiles(directory: string): Promise<string[]> {
  const entries = await Array.fromAsync(
    new Bun.Glob(`${directoryGlob([...workspaceParentDirectories, 'scripts'])}/**/*`).scan({
      cwd: directory,
      absolute: true,
      onlyFiles: true,
    }),
  );
  return entries.filter(
    (file) =>
      sourceExtensions.has(file.slice(file.lastIndexOf('.'))) &&
      !file.split('/').some((segment) => ignoredPathSegment.test(segment)) &&
      !file.includes('/scripts/environment-configuration-policy'),
  );
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, '..');
  const violations = await scanEnvironmentConfigurationPolicy(root);
  if (violations.length > 0) {
    for (const violation of violations)
      console.error(`${violation.file}:${violation.line}:${violation.column} ${violation.message}`);
    process.exitCode = 1;
  }
}
