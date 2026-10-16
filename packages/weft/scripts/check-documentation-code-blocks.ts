/**
 * Type-checks the TypeScript code blocks in Weft's Markdown documentation against the package's
 * published export surface.
 *
 * Every ```` ```ts ```` or ```` ```typescript ```` fence in `README.md` and `documentation/**` is
 * compiled as its own module in one in-memory TypeScript program. Imports of `@lostgradient/weft`
 * and its subpaths resolve through the published `exports` map recorded in
 * `scripts/published-exports.json` at the repository root — a snapshot of the map the public mirror ships —
 * rather than this workspace's single `"."` export, so a guide cannot import a subpath or symbol a
 * consumer would not be able to import.
 *
 * The fence info string accepts two attributes after the language:
 *
 * - `partial` marks an illustrative fragment that depends on context the block does not declare.
 *   It is skipped.
 * - `file=<name>.ts` names the block's module, so a later block in the same document can import it
 *   with a relative specifier such as `import('./greeting.ts')`.
 *
 * Any other attribute is an error, so a misspelled `partial` cannot silently opt a block out.
 * Unused-binding checks are disabled: a snippet that declares a value to show its type is not a
 * defect. Every other compiler option comes from this package's `tsconfig.json`.
 *
 * Triggered as part of `bun run typecheck`.
 */

import { Glob } from 'bun';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import ts from 'typescript';

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
  partialCount: number;
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
  let partialCount = 0;

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

    let partial = false;
    let fileName = `line-${line}.ts`;
    for (const attribute of attributes) {
      const fileMatch = FILE_ATTRIBUTE_PATTERN.exec(attribute);
      if (attribute === 'partial') partial = true;
      else if (fileMatch?.[1]) fileName = fileMatch[1];
      else problems.push(`${document}:${line}: unknown code-block attribute "${attribute}"`);
    }
    if (partial) {
      partialCount += 1;
      continue;
    }
    if (fileNames.has(fileName)) {
      problems.push(`${document}:${line}: duplicate code-block file name "${fileName}"`);
      continue;
    }
    fileNames.add(fileName);
    blocks.push({ document, line, indent, fileName, source: body.join('\n') });
  }

  return { blocks, partialCount, problems };
}

interface PublishedPackageSurface {
  packages: Record<
    string,
    { exports: Record<string, string | { types?: unknown } | null> } | undefined
  >;
}

/**
 * Maps each published specifier of `publicName` to the source file behind its `types` target:
 * `./dist/storage/sqlite.d.ts` becomes `src/storage/sqlite.ts`, or `src/storage/sqlite/index.ts`.
 */
export function publishedModuleMap(
  surface: PublishedPackageSurface,
  publicName: string,
  packageRoot: string,
): Map<string, string> {
  const entry = surface.packages[publicName];
  if (!entry) throw new Error(`The published package surface has no entry for ${publicName}.`);

  const modules = new Map<string, string>();
  for (const [subpath, target] of Object.entries(entry.exports)) {
    const types = typeof target === 'string' ? target : target?.types;
    if (typeof types !== 'string' || !types.startsWith('./dist/') || !types.endsWith('.d.ts')) {
      throw new Error(`${publicName} export "${subpath}" has no ./dist/*.d.ts types target.`);
    }
    const tail = types.slice('./dist/'.length, -'.d.ts'.length);
    const source = [`src/${tail}.ts`, `src/${tail}/index.ts`]
      .map((candidate) => join(packageRoot, candidate))
      .find((candidate) => existsSync(candidate));
    if (!source) throw new Error(`${publicName} export "${subpath}" has no source for ${types}.`);
    modules.set(subpath === '.' ? publicName : `${publicName}/${subpath.slice(2)}`, source);
  }
  return modules;
}

function loadCompilerOptions(
  packageRoot: string,
  modules: ReadonlyMap<string, string>,
): ts.CompilerOptions {
  const configurationPath = join(packageRoot, 'tsconfig.json');
  const loaded = ts.readConfigFile(configurationPath, (path) => ts.sys.readFile(path));
  if (loaded.error) {
    throw new Error(ts.flattenDiagnosticMessageText(loaded.error.messageText, '\n'));
  }
  const parsed = ts.parseJsonConfigFileContent(loaded.config, ts.sys, packageRoot);
  return {
    ...parsed.options,
    noEmit: true,
    noUnusedLocals: false,
    noUnusedParameters: false,
    moduleDetection: ts.ModuleDetectionKind.Force,
    pathsBasePath: packageRoot,
    paths: Object.fromEntries([...modules].map(([specifier, source]) => [specifier, [source]])),
  };
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

  const options = loadCompilerOptions(packageRoot, modules);
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

  const program = ts.createProgram([...virtualFiles.keys()], options, host);
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

/**
 * Checks `README.md` and every `documentation/**` Markdown file under `packageRoot` against the
 * published surface of `publicName` recorded in `surfacePath`.
 */
export async function runDocumentationCodeBlockCheck(
  packageRoot: string,
  surfacePath: string,
  publicName: string,
): Promise<DocumentationCheckResult> {
  const surface = (await Bun.file(surfacePath).json()) as PublishedPackageSurface;
  const modules = publishedModuleMap(surface, publicName, packageRoot);

  const documents = [
    ...new Glob('documentation/**/*.md').scanSync(packageRoot),
    'README.md',
  ].toSorted();
  const blocks: DocumentationCodeBlock[] = [];
  const problems: string[] = [];
  let partialCount = 0;
  for (const document of documents) {
    const markdown = await Bun.file(join(packageRoot, document)).text();
    const extracted = extractCodeBlocks(document, markdown);
    blocks.push(...extracted.blocks);
    problems.push(...extracted.problems);
    partialCount += extracted.partialCount;
  }
  problems.push(...checkCodeBlocks(packageRoot, blocks, modules));

  const summary =
    `Checked ${blocks.length} documentation code blocks in ${documents.length} documents ` +
    `(${partialCount} partial blocks skipped); ${problems.length} problems.`;
  return { problems, summary };
}

if (import.meta.main) {
  const packageRoot = resolve(import.meta.dir, '..');
  const surfacePath = resolve(packageRoot, '../../scripts/published-exports.json');
  const result = await runDocumentationCodeBlockCheck(
    packageRoot,
    surfacePath,
    '@lostgradient/weft',
  );
  for (const problem of result.problems) process.stderr.write(`${problem}\n`);
  process.stdout.write(`${result.summary}\n`);
  process.exitCode = result.problems.length > 0 ? 1 : 0;
}
