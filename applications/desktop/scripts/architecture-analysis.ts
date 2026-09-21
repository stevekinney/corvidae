import path from 'node:path';

import ts from 'typescript';

import type { ArchitectureBoundary } from './architecture-boundaries.ts';

const typescript = ts;

function importedSpecifiers(contents: string): string[] {
  const sourceFile = typescript.createSourceFile(
    'boundary.ts',
    contents,
    typescript.ScriptTarget.Latest,
    true,
  );
  const specifiers: string[] = [];
  const add = (value: ts.Expression | undefined) => {
    if (value !== undefined && typescript.isStringLiteral(value)) specifiers.push(value.text);
  };
  const visit = (node: ts.Node): void => {
    if (typescript.isImportDeclaration(node) || typescript.isExportDeclaration(node))
      add(node.moduleSpecifier);
    if (
      typescript.isImportEqualsDeclaration(node) &&
      typescript.isExternalModuleReference(node.moduleReference)
    )
      add(node.moduleReference.expression);
    if (
      typescript.isCallExpression(node) &&
      node.arguments.length === 1 &&
      (node.expression.kind === typescript.SyntaxKind.ImportKeyword ||
        (typescript.isIdentifier(node.expression) && node.expression.text === 'require'))
    )
      add(node.arguments[0]);
    typescript.forEachChild(node, visit);
  };
  visit(sourceFile);
  return specifiers;
}

function normalizeProjectPath(value: string): string {
  return value.replaceAll(path.sep, '/').replace(/^\.\//u, '');
}

/**
 * Resolves an import specifier to a project-relative path, or `undefined` when
 * it points outside the project (a package rather than a source file).
 */
export function resolveProjectImport(
  projectRoot: string,
  importer: string,
  specifier: string,
): string | undefined {
  if (specifier.startsWith('.')) {
    return normalizeProjectPath(
      path.relative(projectRoot, path.resolve(projectRoot, path.dirname(importer), specifier)),
    );
  }

  const normalizedSpecifier = normalizeProjectPath(specifier);
  if (
    normalizedSpecifier === 'scripts' ||
    normalizedSpecifier.startsWith('scripts/') ||
    normalizedSpecifier === 'src' ||
    normalizedSpecifier.startsWith('src/')
  ) {
    return normalizedSpecifier;
  }

  return undefined;
}

/** Returns whether a specifier reaches into a directory the layer may not use. */
export function importsForbiddenDirectory(
  projectRoot: string,
  importer: string,
  specifier: string,
  boundary: ArchitectureBoundary,
): boolean {
  const target = resolveProjectImport(projectRoot, importer, specifier);
  if (target === undefined) return false;

  return boundary.forbiddenDirectories.some(
    (directory) => target === directory || target.startsWith(`${directory}/`),
  );
}

/** Returns whether a specifier names a package or module the layer may not use. */
export function importsForbiddenPackage(
  specifier: string,
  boundary: ArchitectureBoundary,
): boolean {
  return (
    boundary.forbiddenExactSpecifiers.includes(specifier) ||
    boundary.forbiddenPackages.some(
      (packageName) => specifier === packageName || specifier.startsWith(`${packageName}/`),
    ) ||
    boundary.forbiddenModulePrefixes.some((prefix) => specifier.startsWith(prefix))
  );
}

/**
 * Throws when a source file violates its layer boundary.
 *
 * Uses TypeScript's own preprocessor so static imports, side-effect imports,
 * re-exports, `require`, and dynamic `import()` are all covered — ESLint's
 * `no-restricted-imports` cannot see the dynamic form.
 */
export function assertSourceBoundary(
  projectRoot: string,
  file: string,
  contents: string,
  boundary: ArchitectureBoundary,
): void {
  for (const specifier of importedSpecifiers(contents)) {
    if (
      importsForbiddenDirectory(projectRoot, file, specifier, boundary) ||
      importsForbiddenPackage(specifier, boundary)
    ) {
      throw new Error(`${file} imports ${specifier}, violating the ${boundary.layer} boundary.`);
    }
  }
}

/** Returns the boundary for a layer, throwing when the table is incomplete. */
export function boundaryForLayer(
  boundaries: readonly ArchitectureBoundary[],
  layer: ArchitectureBoundary['layer'],
): ArchitectureBoundary {
  const boundary = boundaries.find((candidate) => candidate.layer === layer);
  if (boundary === undefined) {
    throw new Error(`No architecture boundary defines the ${layer} layer.`);
  }

  return boundary;
}
