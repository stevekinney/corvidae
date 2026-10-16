/**
 * The published surface of `@lostgradient/weft/ui`, held to the owner's decision in
 * `documentation/weft-ui-public-surface.md` (COR-1447, implemented by COR-1449).
 *
 * - The entry's export names equal the document's one fenced `text` block, as a set. Type-only
 *   exports count, so the names come from the TypeScript checker rather than `Object.keys` of the
 *   evaluated module, which cannot see them.
 * - The entry delivers the UI's stylesheet with a side-effect import, as the document's CSS
 *   decision requires, so importing any name from it brings the styles.
 * - The entry imports without a DOM, because `router` reads `window` on first use rather than at
 *   module evaluation (the document's open question 4). The import runs in a separate `bun`
 *   process: this one has happy-dom's `window` from the UI preload.
 *
 * Building the checker program and running the subprocess are seconds of work on a loaded host, so
 * both run at module scope, off the per-test clock.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

const packageRoot = join(import.meta.dir, '..', '..');
const entryPath = join(import.meta.dir, 'index.ts');
const surfaceDocumentPath = join(
  packageRoot,
  '..',
  '..',
  'documentation',
  'weft-ui-public-surface.md',
);
const sveltePluginPath = join(packageRoot, 'scripts', 'lib', 'svelte-plugin.ts');

/** The names in the document's only fenced `text` block, one per line. */
function documentedExportNames(markdown: string): string[] {
  const blocks = [...markdown.matchAll(/^```text\n([\s\S]*?)^```$/gm)];
  if (blocks.length !== 1) {
    throw new Error(`Expected exactly one fenced text block, found ${blocks.length}.`);
  }
  return (blocks[0]?.[1] ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** Every name `path` exports, values and types alike, as the TypeScript checker sees them. */
function exportNamesOf(path: string): string[] {
  const program = ts.createProgram([path], {
    allowImportingTsExtensions: true,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    noEmit: true,
    target: ts.ScriptTarget.ESNext,
    types: [],
  });
  const sourceFile = program.getSourceFile(path);
  if (sourceFile === undefined) throw new Error(`The program does not contain ${path}.`);
  const checker = program.getTypeChecker();
  const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
  if (moduleSymbol === undefined) throw new Error(`${path} is not a module.`);
  return checker.getExportsOfModule(moduleSymbol).map((symbol) => symbol.name);
}

function sorted(names: Iterable<string>): string[] {
  return [...names].sort((left, right) => left.localeCompare(right, 'en', { sensitivity: 'base' }));
}

interface NoDomImport {
  readonly windowType: string;
  readonly documentType: string;
  readonly exportNames: string[];
  readonly firstRouterUse: string;
}

/**
 * Imports the entry in a fresh `bun` process with the Svelte compile plugin and no DOM, and
 * reports what it saw. `--conditions svelte` without `browser` is the server path the published
 * entry's consumers take; the `browser` condition selects DOM builds of third-party modules.
 */
async function importWithoutDom(): Promise<NoDomImport> {
  const script = `
    import { plugin } from 'bun';
    const { sveltePlugin } = await import(${JSON.stringify(sveltePluginPath)});
    await plugin(sveltePlugin());
    const entry = await import(${JSON.stringify(entryPath)});
    let firstRouterUse = 'no error';
    try {
      void entry.router.pathname;
    } catch (error) {
      firstRouterUse = error instanceof Error ? error.name + ': ' + error.message : String(error);
    }
    console.log(JSON.stringify({
      windowType: typeof globalThis.window,
      documentType: typeof globalThis.document,
      exportNames: Object.keys(entry),
      firstRouterUse,
    }));
  `;
  const child = Bun.spawn([process.execPath, '--conditions', 'svelte', '--eval', script], {
    cwd: packageRoot,
    stdout: 'pipe',
    stderr: 'pipe',
    // A hang guard, not a budget: compiling the entry's Svelte graph takes seconds on a loaded
    // host, and this runs at module scope, off the per-test clock.
    timeout: 120_000,
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`Importing the ./ui entry without a DOM exited ${exitCode}:\n${stderr}`);
  }
  const lastLine = stdout.trim().split('\n').at(-1) ?? '';
  return JSON.parse(lastLine) as NoDomImport;
}

const documentedNames = documentedExportNames(readFileSync(surfaceDocumentPath, 'utf8'));
const entryExportNames = exportNamesOf(entryPath);
const entrySource = readFileSync(entryPath, 'utf8');
const noDomImport = await importWithoutDom();

describe('the ./ui entry', () => {
  test('exports exactly the names documentation/weft-ui-public-surface.md lists', () => {
    expect(documentedNames).toHaveLength(36);
    expect(new Set(documentedNames).size).toBe(documentedNames.length);
    expect(sorted(entryExportNames)).toEqual(sorted(documentedNames));
  });

  test('reads only the one fenced text block from the decision document', () => {
    expect(
      documentedExportNames('# Title\n\n```text\nalpha\nBeta\n```\n\n```ts\nnope\n```\n'),
    ).toEqual(['alpha', 'Beta']);
    expect(() => documentedExportNames('```text\na\n```\n```text\nb\n```\n')).toThrow(
      'Expected exactly one fenced text block, found 2.',
    );
  });

  test('imports the UI stylesheet for its side effect before anything else', () => {
    const imports = ts
      .preProcessFile(entrySource, true, false)
      .importedFiles.map((imported) => imported.fileName);
    expect(imports[0]).toBe('./styles/index.css');
    expect(entrySource).toMatch(/^import '\.\/styles\/index\.css';$/m);
  });

  test('imports with no DOM, reading window only when router is first used', () => {
    expect(noDomImport.windowType).toBe('undefined');
    expect(noDomImport.documentType).toBe('undefined');
    // Values only: type-only exports do not exist at runtime.
    expect(noDomImport.exportNames).toContain('router');
    expect(noDomImport.exportNames).toContain('WeftDashboard');
    expect(noDomImport.exportNames).toHaveLength(24);
    expect(noDomImport.firstRouterUse).toBe('ReferenceError: window is not defined');
  });
});
