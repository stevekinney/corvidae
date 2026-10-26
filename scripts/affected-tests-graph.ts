/**
 * The import graph behind `scripts/affected-tests.ts`: which files a source file depends on, as far
 * as the repository's own TypeScript, JavaScript, Svelte, and CSS can say statically.
 *
 * Everything here is a pure function of file text and a path set, so the selector's tests run it
 * against small synthetic trees. Nothing reads the disk or runs Git.
 *
 * What the graph does not see, and how the selector covers it, is listed in
 * `documentation/repository/test-lanes-and-checks.md` ("Affected test selection").
 */

import { dirname, posix } from 'node:path';

/** One workspace as the selector needs to see it. `directory` is repository-relative; the root is `''`. */
export interface WorkspaceDescription {
  name: string;
  directory: string;
  /** Names of the workspaces this one declares in any dependency field. */
  dependencies: readonly string[];
  /** The `exports` map when it is an object of plain string targets, otherwise `null`. */
  exports: Readonly<Record<string, string>> | null;
  /** Repository-relative preload files named by this workspace's `bunfig*.toml` files. */
  preloads: readonly string[];
  /** The text of every `package.json` script whose name starts with `test`. */
  testScripts: readonly string[];
}

/** The files the selector may look at: a path set and a way to read a code file's text. */
export interface SourceTree {
  paths: ReadonlySet<string>;
  read(path: string): string | undefined;
}

export const CODE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.svelte',
]);

/** Files whose text is scanned for imports and references. CSS is included for its `@import`. */
const SCANNED_EXTENSIONS = new Set([...CODE_EXTENSIONS, '.css']);

const TEST_FILE_PATTERN = /(?:\.|_)(?:test|spec)\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

export function extensionOf(path: string): string {
  const name = posix.basename(path);
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot);
}

export function isCodeFile(path: string): boolean {
  return CODE_EXTENSIONS.has(extensionOf(path));
}

/** Whether Bun's default discovery would treat the file as a test file. */
export function isTestFile(path: string): boolean {
  return TEST_FILE_PATTERN.test(path);
}

/** The workspace that owns a path: the one with the longest matching directory, else the root. */
export function owningWorkspace(
  path: string,
  workspaces: readonly WorkspaceDescription[],
): WorkspaceDescription {
  let best: WorkspaceDescription | undefined;
  for (const workspace of workspaces) {
    const { directory } = workspace;
    const inside = directory === '' || path === directory || path.startsWith(`${directory}/`);
    if (inside && (best === undefined || directory.length > best.directory.length)) {
      best = workspace;
    }
  }
  if (best === undefined) throw new Error(`no workspace owns ${path}; the root is missing`);
  return best;
}

// --- Source analysis --------------------------------------------------------------------------

const scriptBlock = /<script\b[^>]*>([\s\S]*?)<\/script>/g;
const cssImport = /@import\s+(?:url\(\s*)?['"]([^'"]+)['"]/g;
const stringLiteral = /(['"`])([^'"`\n\\$]{1,240}?)\1/g;
const nonLiteralDynamicImport = /\bimport\s*\(\s*(?!['"]|`[^`$]*`\s*\))/;
const repositoryScan = /\bworkspace-directories(?:\.ts)?['"]/;
const ownLocation = /import\.meta\.(?:dir|dirname|url|path|filename)\b|__dirname/;
const filesystemScan =
  /(?:\bGlob\s*\(|\breaddir(?:Sync)?\s*\(|\bfs\.glob\s*\(|\bglobSync\s*\(|ls-files|\bopendir(?:Sync)?\s*\()/;
const bundleBuild = /\bBun\.build\s*\(/;
/**
 * Whether a file is test code or tooling rather than shipped library source. Reading the tree or
 * loading a module by a run-time specifier is evidence of an unseen dependency only here: library
 * source does it on behalf of its callers, and the tests that call it name the paths it reads.
 */
export function isTestOrTooling(path: string): boolean {
  return (
    isTestFile(path) ||
    /\.test-(?:support|d)\./.test(path) ||
    /(?:^|\/)(?:scripts|testing|tests|test|__fixtures__)\//.test(path)
  );
}

const typeOnlyImport = /\b(?:import|export)\s+type\b[^;'"`]*?\bfrom\s*['"]([^'"\n]+)['"]/g;
const templateLiteral = /`((?:[^`\\]|\\.)*)`/g;
const anchorInterpolation = /\$\{\s*(?:import\.meta\.(?:dir|dirname)|__dirname)\s*\}/g;
const pathLikeLiteral = /^[\w@$.~/-][\w@$.~/ -]*\.[A-Za-z0-9]{1,8}$/;

/** What the text of one source file says about its dependencies. */
export interface SourceAnalysis {
  /** Module specifiers in import, export-from, dynamic-import, and `require` position. */
  specifiers: string[];
  /** Specifiers imported for types only. They leave no runtime edge, but they do name a user. */
  typeSpecifiers: string[];
  /** Extensions of files read through a path built at run time (`${dir}/${name}.css`). */
  computedPathExtensions: string[];
  /** String literals that look like paths to files, for runtime reads the import graph cannot see. */
  pathLiterals: string[];
  /** Reads the file system in a way an import edge cannot express (a glob or directory listing). */
  scansFileSystem: boolean;
  /**
   * Scans the workspaces themselves: it uses the shared workspace directory list and anchors to
   * its own checkout. A script that takes its root as a parameter leaves that to its callers.
   */
  scansRepository: boolean;
  /** Bundles code the import graph cannot see, through `Bun.build`. */
  bundlesCode: boolean;
  /** Loads a module by a specifier only known at run time: `import(variable)`. */
  importsDynamically: boolean;
}

const emptyAnalysis: SourceAnalysis = {
  specifiers: [],
  typeSpecifiers: [],
  computedPathExtensions: [],
  pathLiterals: [],
  scansFileSystem: false,
  scansRepository: false,
  bundlesCode: false,
  importsDynamically: false,
};

const transpiler = new Bun.Transpiler({ loader: 'ts' });
const transpilerTsx = new Bun.Transpiler({ loader: 'tsx' });

function scanScript(source: string, extension: string): string[] {
  const scanner = extension === '.tsx' || extension === '.jsx' ? transpilerTsx : transpiler;
  try {
    return scanner.scanImports(source).map((entry) => entry.path);
  } catch {
    // A file the transpiler cannot parse still has to attribute: take the specifiers from text.
    const found: string[] = [];
    for (const match of source.matchAll(/(?:from|import|require\()\s*['"]([^'"]+)['"]/g)) {
      if (match[1] !== undefined) found.push(match[1]);
    }
    return found;
  }
}

/** Read what a file's text says about its dependencies. */
export function analyzeSource(path: string, source: string): SourceAnalysis {
  const extension = extensionOf(path);
  if (!SCANNED_EXTENSIONS.has(extension)) return emptyAnalysis;

  const specifiers: string[] = [];
  let code = source;
  if (extension === '.svelte') {
    const blocks: string[] = [];
    for (const match of source.matchAll(scriptBlock)) blocks.push(match[1] ?? '');
    code = blocks.join('\n');
    for (const block of blocks) specifiers.push(...scanScript(block, '.ts'));
    for (const match of source.matchAll(cssImport)) specifiers.push(match[1] ?? '');
  } else if (extension === '.css') {
    for (const match of source.matchAll(cssImport)) specifiers.push(match[1] ?? '');
    code = '';
  } else {
    specifiers.push(...scanScript(source, extension));
  }

  // Comments name files and APIs without using them, so they cannot make an edge or a marker.
  code = code.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"`\\])\/\/[^\n]*/gm, '$1');

  // Module specifiers are edges already, and a type-only import has none, so none is a literal.
  const literalSource = code
    .replace(/\b(?:import|export)\b[^;'"`]*?\bfrom\s*['"][^'"\n]+['"]/g, ' ')
    .replace(/\bimport\s*['"][^'"\n]+['"]/g, ' ');
  const typeSpecifiers: string[] = [];
  for (const match of code.matchAll(typeOnlyImport)) typeSpecifiers.push(match[1] ?? '');

  const pathLiterals: string[] = [];
  for (const match of literalSource.matchAll(stringLiteral)) {
    const text = match[2] ?? '';
    if (
      !text.includes('*') &&
      !text.includes('{') &&
      !/^[a-z][a-z0-9+.-]*:/i.test(text) &&
      pathLikeLiteral.test(text)
    ) {
      pathLiterals.push(text);
    }
  }

  const computedPathExtensions = new Set<string>();
  for (const match of literalSource.matchAll(templateLiteral)) {
    const anchored = (match[1] ?? '').replace(anchorInterpolation, '.');
    if (!anchored.includes('${')) {
      // `${import.meta.dir}/chat.css` is a path relative to the file itself.
      if (pathLikeLiteral.test(anchored) && !anchored.includes('*')) pathLiterals.push(anchored);
      continue;
    }
    const tail = anchored.slice(anchored.lastIndexOf('}') + 1);
    const tailExtension = /\.[A-Za-z0-9]{1,8}$/.exec(tail)?.[0];
    if (tailExtension !== undefined) computedPathExtensions.add(tailExtension);
  }

  return {
    specifiers,
    typeSpecifiers,
    computedPathExtensions: [...computedPathExtensions],
    pathLiterals,
    scansFileSystem: filesystemScan.test(code),
    scansRepository: repositoryScan.test(code) && ownLocation.test(code),
    bundlesCode: bundleBuild.test(code),
    importsDynamically: nonLiteralDynamicImport.test(code),
  };
}

// --- Specifier resolution ----------------------------------------------------------------------

const resolutionExtensions = [
  '.ts',
  '.tsx',
  '.mts',
  '.js',
  '.mjs',
  '.jsx',
  '.svelte',
  '.json',
  '.css',
];
const extensionSubstitutions: Record<string, readonly string[]> = {
  '.js': ['.ts', '.tsx'],
  '.mjs': ['.mts'],
  '.jsx': ['.tsx'],
};

function resolveFile(candidate: string, paths: ReadonlySet<string>): string | null {
  if (paths.has(candidate)) return candidate;
  const extension = extensionOf(candidate);
  for (const replacement of extensionSubstitutions[extension] ?? []) {
    const swapped = candidate.slice(0, -extension.length) + replacement;
    if (paths.has(swapped)) return swapped;
  }
  for (const suffix of resolutionExtensions) {
    if (paths.has(candidate + suffix)) return candidate + suffix;
  }
  for (const suffix of resolutionExtensions) {
    if (paths.has(`${candidate}/index${suffix}`)) return `${candidate}/index${suffix}`;
  }
  return null;
}

/** A specifier that names a workspace, with the subpath after its name (`''` for the entry). */
function matchWorkspace(
  specifier: string,
  workspaces: readonly WorkspaceDescription[],
): { workspace: WorkspaceDescription; subpath: string } | null {
  let best: { workspace: WorkspaceDescription; subpath: string } | null = null;
  for (const workspace of workspaces) {
    const { name } = workspace;
    if (workspace.directory === '') continue;
    if (specifier === name || specifier.startsWith(`${name}/`)) {
      if (best === null || name.length > best.workspace.name.length) {
        best = { workspace, subpath: specifier.slice(name.length) };
      }
    }
  }
  return best;
}

/**
 * Resolve one specifier written in `from` to a repository-relative path, or `null` for anything
 * outside the repository (a registry package, `node:`, `bun:`). A workspace specifier that its
 * `exports` map does not resolve falls back to that workspace's `package.json`, so a change to the
 * manifest still reaches its importer.
 */
export function resolveSpecifier(
  from: string,
  specifier: string,
  paths: ReadonlySet<string>,
  workspaces: readonly WorkspaceDescription[],
): string | null {
  const bare = specifier.replace(/[?#].*$/, '');
  if (bare.startsWith('.')) {
    return resolveFile(posix.normalize(posix.join(dirname(from), bare)), paths);
  }
  const match = matchWorkspace(bare, workspaces);
  if (match === null) return null;
  const { workspace, subpath } = match;
  const root = workspace.directory;
  if (workspace.exports !== null) {
    const target = workspace.exports[subpath === '' ? '.' : `.${subpath}`];
    if (target !== undefined) {
      const resolved = resolveFile(posix.normalize(posix.join(root, target)), paths);
      if (resolved !== null) return resolved;
    }
  } else if (subpath !== '') {
    const resolved = resolveFile(posix.normalize(posix.join(root, subpath)), paths);
    if (resolved !== null) return resolved;
  }
  const manifest = posix.join(root, 'package.json');
  return paths.has(manifest) ? manifest : null;
}

/**
 * Resolve a string literal that may name a file read at run time. Literals are tried against the
 * file's own directory, the owning workspace's root (where its tests run), and the repository root.
 */
export function resolvePathLiteral(
  from: string,
  literal: string,
  workspaceDirectory: string,
  paths: ReadonlySet<string>,
): string | null {
  const bases = literal.startsWith('.')
    ? [dirname(from), workspaceDirectory]
    : [dirname(from), workspaceDirectory, ''];
  for (const base of bases) {
    const candidate = posix.normalize(posix.join(base, literal));
    if (!candidate.startsWith('..') && paths.has(candidate)) return candidate;
  }
  return null;
}
