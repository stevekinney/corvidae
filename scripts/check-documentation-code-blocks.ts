/**
 * Type-checks the TypeScript code blocks in a workspace's Markdown against the surface its
 * consumers can import.
 *
 * Run from a workspace directory, as each library's and component's `typecheck` does. Every
 * ```` ```ts ```` or ```` ```typescript ```` fence in the workspace's Markdown (outside
 * dependencies and generated output) is compiled as its own module in one in-memory TypeScript
 * program. Fences in other languages, `svelte` included, are not checked. Imports of the
 * workspace's own package name and its subpaths resolve through the published `exports` map
 * recorded in `scripts/published-exports.json` when the workspace has one there — a snapshot of
 * the map the public mirror ships, so a guide cannot import a subpath or symbol a consumer would
 * not be able to import — and through the workspace's own `package.json` `exports` otherwise.
 * Imports of other workspaces resolve as they do for any consumer, through `node_modules`.
 *
 * The fence info string accepts one attribute after the language: `file=<name>.ts` names the
 * block's module, so a later block in the same document can import it with a relative specifier
 * such as `import('./greeting.ts')`. Any other attribute is an error. No attribute opts a block
 * out: every TypeScript example is checked, so one that cannot compile on its own needs the
 * context it depends on, in the block or in an earlier named block.
 * Unused-binding checks are disabled: a snippet that declares a value to show its type is not a
 * defect. Every other compiler option comes from the workspace's `tsconfig.json`, whose ambient
 * declaration files every block also sees.
 */

import { Glob } from 'bun';
import { existsSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import ts from 'typescript';

import { readEntryPoints } from './check-documentation-coverage.ts';

export interface DocumentationCodeBlock {
  /** Package-relative path of the Markdown document that contains the block. */
  document: string;
  /** One-based line of the opening fence. */
  line: number;
  /** Columns of indentation removed from every body line, for list-nested fences. */
  indent: number;
  /** Module file name within the document's virtual directory. */
  fileName: string;
  source: string;
}

export interface ExtractedCodeBlocks {
  blocks: DocumentationCodeBlock[];
  problems: string[];
}

const TYPESCRIPT_LANGUAGES = new Set(['ts', 'typescript']);
const FILE_ATTRIBUTE_PATTERN = /^file=([A-Za-z0-9_-][A-Za-z0-9_.-]*\.ts)$/;
const OPENING_FENCE_PATTERN = /^( *)(`{3,}|~{3,})(.*)$/;

function isClosingFence(line: string, marker: string): boolean {
  const trimmed = line.trim();
  return trimmed.length >= marker.length && /^(`+|~+)$/.test(trimmed) && trimmed[0] === marker[0];
}

/**
 * Collects every TypeScript fence in one Markdown document. Fences in other languages are skipped
 * whole, so a TypeScript example quoted inside a longer Markdown fence is not extracted.
 */
export function extractCodeBlocks(document: string, markdown: string): ExtractedCodeBlocks {
  const lines = markdown.split('\n');
  const blocks: DocumentationCodeBlock[] = [];
  const problems: string[] = [];
  const fileNames = new Set<string>();

  for (let index = 0; index < lines.length; index += 1) {
    const opening = OPENING_FENCE_PATTERN.exec(lines[index] ?? '');
    if (!opening) continue;
    const indent = opening[1]?.length ?? 0;
    const marker = opening[2] ?? '```';
    const [language = '', ...attributes] = (opening[3] ?? '').trim().split(/\s+/);

    const body: string[] = [];
    let closing = index + 1;
    while (closing < lines.length && !isClosingFence(lines[closing] ?? '', marker)) {
      const bodyLine = lines[closing] ?? '';
      body.push(bodyLine.slice(Math.min(indent, bodyLine.length - bodyLine.trimStart().length)));
      closing += 1;
    }
    const line = index + 1;
    index = closing;
    if (!TYPESCRIPT_LANGUAGES.has(language)) continue;

    let fileName = `line-${line}.ts`;
    for (const attribute of attributes) {
      const fileMatch = FILE_ATTRIBUTE_PATTERN.exec(attribute);
      if (fileMatch?.[1]) fileName = fileMatch[1];
      else problems.push(`${document}:${line}: unknown code-block attribute "${attribute}"`);
    }
    if (fileNames.has(fileName)) {
      problems.push(`${document}:${line}: duplicate code-block file name "${fileName}"`);
      continue;
    }
    fileNames.add(fileName);
    blocks.push({ document, line, indent, fileName, source: body.join('\n') });
  }

  return { blocks, problems };
}

type ExportTarget = string | { [condition: string]: unknown } | null;

/** The published `exports` snapshot in `scripts/published-exports.json`. */
export interface PublishedPackageSurface {
  packages: Record<string, { exports: Record<string, ExportTarget> } | undefined>;
}

const SOURCE_CONDITIONS = ['bun', 'svelte', 'browser'];
const SOURCE_TARGET_PATTERN = /^\.\/src\/.+\.ts$/;

/**
 * Finds the source file behind one published export, or returns `undefined` for an export that is
 * not a TypeScript module, such as `./package.json`, a JSON manifest, or a stylesheet. A source
 * condition (`bun`, `svelte`, `browser`) that names a `./src/**.ts` file wins; otherwise the
 * `types` target `./dist/<tail>.d.ts` maps to `src/<tail>.ts` or `src/<tail>/index.ts`, or the same
 * under `src/lib/` for a Svelte package.
 */
function publishedSource(packageRoot: string, target: ExportTarget): string | false | undefined {
  if (target !== null && typeof target === 'object') {
    for (const condition of SOURCE_CONDITIONS) {
      const source = target[condition];
      if (typeof source === 'string' && SOURCE_TARGET_PATTERN.test(source)) {
        return join(packageRoot, source);
      }
    }
  }
  const types = typeof target === 'string' ? target : target?.['types'];
  if (typeof types !== 'string') return false;
  if (!types.endsWith('.d.ts')) return types.endsWith('.json') ? undefined : false;
  if (types.endsWith('.css.d.ts')) return undefined;
  if (!types.startsWith('./dist/')) return false;
  const tail = types.slice('./dist/'.length, -'.d.ts'.length);
  const source = [
    `src/${tail}.ts`,
    `src/${tail}/index.ts`,
    `src/lib/${tail}.ts`,
    `src/lib/${tail}/index.ts`,
  ]
    .map((candidate) => join(packageRoot, candidate))
    .find((candidate) => existsSync(candidate));
  return source ?? false;
}

/**
 * Maps each published specifier of `publicName` to the source file behind it, or returns
 * `undefined` when the snapshot has no exports map for the package. Cinder's entry, for one, names
 * the generator that derives its map rather than the map itself.
 */
export function publishedModuleMap(
  surface: PublishedPackageSurface,
  publicName: string,
  packageRoot: string,
): Map<string, string> | undefined {
  const exports = surface.packages[publicName]?.exports;
  if (!exports || !Object.keys(exports).every((subpath) => subpath.startsWith('.'))) {
    return undefined;
  }

  const modules = new Map<string, string>();
  for (const [subpath, target] of Object.entries(exports)) {
    const source = publishedSource(packageRoot, target);
    if (source === undefined) continue;
    if (source === false) {
      throw new Error(`${publicName} export "${subpath}" has no TypeScript source.`);
    }
    modules.set(subpath === '.' ? publicName : `${publicName}/${subpath.slice(2)}`, source);
  }
  return modules;
}

/** Maps each specifier of the workspace's own `exports` map to its source file. */
export function manifestModuleMap(
  packageRoot: string,
  manifest: { name: string; exports?: unknown },
): Map<string, string> {
  return new Map(
    readEntryPoints(packageRoot, manifest.exports).map(({ subpath, file }) => [
      subpath === '.' ? manifest.name : `${manifest.name}/${subpath.slice(2)}`,
      file,
    ]),
  );
}

function loadConfiguration(
  packageRoot: string,
  modules: ReadonlyMap<string, string>,
): { options: ts.CompilerOptions; declarationFiles: string[] } {
  const configurationPath = join(packageRoot, 'tsconfig.json');
  const loaded = ts.readConfigFile(configurationPath, (path) => ts.sys.readFile(path));
  if (loaded.error) {
    throw new Error(ts.flattenDiagnosticMessageText(loaded.error.messageText, '\n'));
  }
  const parsed = ts.parseJsonConfigFileContent(loaded.config, ts.sys, packageRoot);
  const options: ts.CompilerOptions = {
    ...parsed.options,
    noEmit: true,
    noUnusedLocals: false,
    noUnusedParameters: false,
    moduleDetection: ts.ModuleDetectionKind.Force,
    pathsBasePath: packageRoot,
    paths: Object.fromEntries([...modules].map(([specifier, source]) => [specifier, [source]])),
  };
  // A composite project would require every block to be listed in its own file list.
  for (const option of ['composite', 'incremental', 'declaration', 'emitDeclarationOnly']) {
    delete options[option];
  }
  // Ambient declarations, such as a Svelte workspace's `*.svelte` module, apply to every block.
  const declarationFiles = parsed.fileNames.filter((fileName) => fileName.endsWith('.d.ts'));
  return { options, declarationFiles };
}

/**
 * Compiles every block in one program and returns formatted diagnostics located at the Markdown
 * line that produced them. Diagnostics from real source files are not reported: a block is
 * checked against the package, not the package against its own configuration.
 */
export function checkCodeBlocks(
  packageRoot: string,
  blocks: readonly DocumentationCodeBlock[],
  modules: ReadonlyMap<string, string>,
): string[] {
  const virtualRoot = join(packageRoot, '.documentation-code-blocks');
  const virtualFiles = new Map<string, DocumentationCodeBlock>();
  for (const block of blocks) {
    virtualFiles.set(join(virtualRoot, block.document, block.fileName), block);
  }
  const isVirtualDirectory = (path: string): boolean =>
    [...virtualFiles.keys()].some((file) => file.startsWith(`${resolve(path)}/`));

  const { options, declarationFiles } = loadConfiguration(packageRoot, modules);
  const base = ts.createCompilerHost(options, true);
  const host: ts.CompilerHost = {
    ...base,
    fileExists: (path) => virtualFiles.has(resolve(path)) || base.fileExists(path),
    readFile: (path) => virtualFiles.get(resolve(path))?.source ?? base.readFile(path),
    // Module resolution skips a directory it believes absent, so the virtual ones must exist.
    directoryExists: (path) => isVirtualDirectory(path) || ts.sys.directoryExists(path),
    getSourceFile: (path, languageVersion, onError, shouldCreate) => {
      const block = virtualFiles.get(resolve(path));
      return block
        ? ts.createSourceFile(path, block.source, languageVersion, true)
        : base.getSourceFile(path, languageVersion, onError, shouldCreate);
    },
  };

  const program = ts.createProgram([...virtualFiles.keys(), ...declarationFiles], options, host);
  const messages = [...program.getOptionsDiagnostics(), ...program.getGlobalDiagnostics()].map(
    (diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
  );
  for (const [path, block] of virtualFiles) {
    const sourceFile = program.getSourceFile(path);
    if (!sourceFile) continue;
    const diagnostics = [
      ...program.getSyntacticDiagnostics(sourceFile),
      ...program.getSemanticDiagnostics(sourceFile),
    ];
    for (const diagnostic of diagnostics) {
      const position = sourceFile.getLineAndCharacterOfPosition(diagnostic.start ?? 0);
      const line = block.line + 1 + position.line;
      const column = block.indent + position.character + 1;
      const text = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
      messages.push(`${block.document}:${line}:${column} - error TS${diagnostic.code}: ${text}`);
    }
  }
  return messages;
}

export interface DocumentationCheckResult {
  problems: string[];
  summary: string;
}

const IGNORED_DIRECTORIES = [
  'node_modules',
  'dist',
  'build',
  'coverage',
  'test-output',
  '.types',
  '.svelte-kit',
];

/** Lists the workspace's Markdown documents, skipping dependencies and generated output. */
export function findDocuments(packageRoot: string): string[] {
  return [...new Glob('**/*.md').scanSync({ cwd: packageRoot, dot: true })]
    .filter((document) => !document.split('/').some((part) => IGNORED_DIRECTORIES.includes(part)))
    .toSorted();
}

/**
 * Checks every Markdown document under `packageRoot`. The workspace's own imports resolve through
 * its entry in the published surface at `surfacePath` when that entry is an exports map, and
 * through its `package.json` `exports` otherwise.
 */
export async function runDocumentationCodeBlockCheck(
  packageRoot: string,
  surfacePath: string,
): Promise<DocumentationCheckResult> {
  const manifest: { name: string; exports?: unknown } = await Bun.file(
    join(packageRoot, 'package.json'),
  ).json();
  const surface = (await Bun.file(surfacePath).json()) as PublishedPackageSurface;
  const modules =
    publishedModuleMap(surface, manifest.name, packageRoot) ??
    manifestModuleMap(packageRoot, manifest);

  const documents = findDocuments(packageRoot);
  const blocks: DocumentationCodeBlock[] = [];
  const problems: string[] = [];
  for (const document of documents) {
    const markdown = await Bun.file(join(packageRoot, document)).text();
    const extracted = extractCodeBlocks(document, markdown);
    blocks.push(...extracted.blocks);
    problems.push(...extracted.problems);
  }
  if (blocks.length > 0) problems.push(...checkCodeBlocks(packageRoot, blocks, modules));

  const summary =
    `Checked ${blocks.length} documentation code blocks in ${documents.length} documents; ` +
    `${problems.length} problems.`;
  return { problems, summary };
}

if (import.meta.main) {
  const packageRoot = process.cwd();
  const name = relative(join(import.meta.dir, '..'), packageRoot);
  const result = await runDocumentationCodeBlockCheck(
    packageRoot,
    join(import.meta.dir, 'published-exports.json'),
  );
  for (const problem of result.problems) process.stderr.write(`${problem}\n`);
  process.stdout.write(`check-documentation-code-blocks — ${name}: ${result.summary}\n`);
  process.exitCode = result.problems.length > 0 ? 1 : 0;
}
