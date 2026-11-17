/**
 * `bun scripts/move-browser-pilot.ts [--dry-run]`
 *
 * Moves the browser-pilot specs of the Cinder package split (COR-2080) out of
 * `scripts/browser-fixtures` into the chat, editor and terminal packages, moves the fixtures,
 * helpers, scripts and baselines they own beside them, moves the shared browser helpers and the
 * reusable harness modules into `@lostgradient/testing` (`src/browser/`), and rewrites every import
 * in the tree that names one of those files. There is no re-export left behind: every importer is
 * pointed at the new path.
 *
 * It is idempotent and safe to run again after a branch that still uses the old paths lands. A file
 * still at its old path is moved with `git mv`; Git's rename detection carries a merged edit of a
 * moved file to its new path, and a new or edited file that imports an old path is rewritten. The
 * rewrite touches import specifiers only, so the moved files keep their history and merge cleanly.
 *
 * A relative specifier is resolved against the importer's directory; when that names no file and
 * the importer was moved, it is resolved against the importer's old directory, as it was written.
 * A target under `testing/testing/src` is imported through the package
 * (`@lostgradient/testing/<path>`) from outside it and relatively from inside it.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

const repositoryRoot = resolve(import.meta.dirname, '..');
const dryRun = Bun.argv.includes('--dry-run');

const fixtures = 'scripts/browser-fixtures';
const tests = `${fixtures}/tests`;
const appFixtures = `${fixtures}/src/fixtures`;
const testingBrowser = 'testing/testing/src/browser';
const testingSource = 'testing/testing/src';

/** A file or a whole directory, repository-relative, and where it goes. */
type Move = { from: string; to: string };

function into(directory: string, files: string[]): Move[] {
  return files.map((file) => {
    const name = file.split('/').at(-1)!;
    return { from: file, to: `${directory}/${name}` };
  });
}

function specs(names: string[]): string[] {
  return names.map((name) => `${tests}/${name}.playwright.ts`);
}

const chatSpecs = specs([
  'chat-artifact-network',
  'chat-claim-sources',
  'chat-harness',
  'chat-mcp-app',
  'chat-virtual-row-measurement',
  'conversation-markdown',
]);

const editorSpecs = specs([
  'comment-anchor-a11y',
  'diff-review',
  'diff-review-drafts-inventory',
  'diff-review-error-states',
  'diff-review-isolation',
  'diff-review-keyboard-matrix',
  'diff-review-navigation',
  'diff-review-theme-and-narrow-layout',
  'diff-viewer-annotation',
  'editors-markdown',
  'editors-review',
  'markdown-editor-keyboard',
  'markdown-editor-placeholder',
  'markdown-editor-template-placeholders',
  'markdown-editor-toolbar',
  'review-editor-diff-comments',
  'review-editor-diff-theme-and-narrow-layout',
  'review-editor-malformed-front-matter',
  'review-editor-readiness-and-modality',
  'review-editor-scroll-and-sidebar',
  'review-editor-selection-dismissal',
]);

const terminalSpecs = specs([
  'terminal-failure',
  'terminal-input',
  'terminal-inspection',
  'terminal-layout',
  'terminal-mouse',
  'terminal-recovery',
  'terminal-visual',
  'terminal-vt',
]);

function svelte(names: string[]): string[] {
  return names.map((name) => `${appFixtures}/${name}.svelte`);
}

/** Every move, in the order it is applied. */
export const MOVES: Move[] = [
  // The reusable harness: manifest checks, the route contract, the fixture server, the client
  // loader and snapshot mode, and the run-local port selection.
  ...into(testingBrowser, [
    `${fixtures}/src/manifest.ts`,
    `${fixtures}/src/route-contract.ts`,
    `${fixtures}/scripts/route-contract.test.ts`,
    `${fixtures}/src/server.ts`,
    `${fixtures}/src/fixture-loader.ts`,
    `${fixtures}/src/snapshot-mode.ts`,
    `${fixtures}/scripts/browser-ports.ts`,
    `${fixtures}/scripts/browser-ports.integration.test.ts`,
    `${fixtures}/scripts/fixture-port.ts`,
  ]),
  // Shared browser helpers: specs in more than one package, or a package and the root suite, import
  // them, and no component package may import another for test code.
  ...into(testingBrowser, [
    `${tests}/overlay-fixture.ts`,
    `${tests}/editors-complex-support.ts`,
    `${tests}/review-editor-browser-errors.ts`,
    `${tests}/editor-fixture.ts`,
    `${tests}/component-page-fixture.ts`,
    `${tests}/component-sweep.ts`,
  ]),
  ...into('components/chat/browser/tests', chatSpecs),
  ...into(
    'components/chat/browser/fixtures',
    svelte(['chat', 'chat-mcp-app', 'conversation-markdown', 'chat-conversation-list']),
  ),
  ...into('components/editor/browser/tests', [
    ...editorSpecs,
    `${tests}/review-editor-accessibility-route.ts`,
    `${tests}/link-popover-close-support.ts`,
  ]),
  ...into(
    'components/editor/browser/fixtures',
    svelte([
      'diff-review',
      'diff-viewer',
      'markdown-editor',
      'markdown-editor-template-placeholders',
      'review-editor',
      'review-editor-accessibility',
      'review-editor-basic',
      'review-editor-comments',
      'review-editor-diff-comments',
      'review-editor-malformed-front-matter',
      'review-editor-readonly',
      'review-editor-scroll',
      'scroll-and-sidebar',
      'with-comments',
      'with-comments-readonly',
    ]),
  ),
  ...into('components/terminal/browser/tests', [
    ...terminalSpecs,
    `${tests}/terminal-support.ts`,
    `${tests}/terminal-probe-font.ts`,
  ]),
  ...into('components/terminal/browser/fixtures', svelte(['terminal'])),
  { from: `${appFixtures}/terminal`, to: 'components/terminal/browser/fixtures/terminal' },
  ...into('components/terminal/browser/scripts', [
    `${fixtures}/scripts/run-terminal-browser.ts`,
    `${fixtures}/scripts/terminal-browser-titles.json`,
    `${fixtures}/scripts/terminal-browser-selection.ts`,
    `${fixtures}/scripts/terminal-browser-selection.test.ts`,
  ]),
  // The terminal's Chromium baselines belong to `terminal-visual.playwright.ts` alone.
  {
    from: `${fixtures}/snapshots/chromium/linux/terminal`,
    to: 'components/terminal/browser/snapshots/chromium/linux/terminal',
  },
];

/**
 * Root-suite modules that stay where they are but that a moved file, now outside the root suite,
 * reaches through the testing package instead.
 */
const REDIRECTS: Record<string, string> = {
  [`${fixtures}/environment-configuration.ts`]: `${testingSource}/environment-configuration.ts`,
};

function git(args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], { cwd: repositoryRoot, stderr: 'pipe' });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr.toString()}`);
  }
  return result.stdout.toString();
}

function trackedFiles(...pathspecs: string[]): string[] {
  return git(['ls-files', '-z', '--', ...pathspecs])
    .split('\0')
    .filter((file) => file.length > 0);
}

function isFile(path: string): boolean {
  const absolute = join(repositoryRoot, path);
  return existsSync(absolute) && statSync(absolute).isFile();
}

/** Expands directory moves into file moves, from both ends, so a second run sees the same map. */
function fileMoves(): Map<string, string> {
  const map = new Map<string, string>();
  for (const move of MOVES) {
    const fromFiles = trackedFiles(move.from);
    const toFiles = trackedFiles(move.to);
    const isDirectory =
      fromFiles.some((file) => file !== move.from) || toFiles.some((file) => file !== move.to);
    if (!isDirectory) {
      map.set(move.from, move.to);
      continue;
    }
    for (const file of fromFiles) map.set(file, `${move.to}${file.slice(move.from.length)}`);
    for (const file of toFiles) map.set(`${move.from}${file.slice(move.to.length)}`, file);
  }
  return map;
}

function applyMoves(map: Map<string, string>): number {
  let moved = 0;
  const tracked = new Set(trackedFiles(...map.keys()));
  for (const [from, to] of map) {
    if (!tracked.has(from)) continue;
    if (existsSync(join(repositoryRoot, to))) {
      throw new Error(`Both ${from} and ${to} exist; resolve the duplicate by hand.`);
    }
    console.log(`move ${from} -> ${to}`);
    moved += 1;
    if (dryRun) continue;
    mkdirSync(dirname(join(repositoryRoot, to)), { recursive: true });
    git(['mv', from, to]);
  }
  return moved;
}

function posix(path: string): string {
  return path.split(sep).join('/');
}

function resolveRelative(directory: string, specifier: string): string {
  return posix(relative(repositoryRoot, resolve(repositoryRoot, directory, specifier)));
}

/** The exported subpath of `@lostgradient/testing` that a file under its `src` is imported by. */
function testingSpecifier(target: string): string {
  const path = target.slice(testingSource.length + 1).replace(/\.ts$/, '');
  return `@lostgradient/testing/${path}`;
}

type PackageExports = Record<string, string>;

function testingExports(): PackageExports {
  const manifest = JSON.parse(
    readFileSync(join(repositoryRoot, 'testing/testing/package.json'), 'utf8'),
  ) as { exports: PackageExports };
  return manifest.exports;
}

/** The file a `@lostgradient/testing[/subpath]` specifier names, or undefined. */
function testingTarget(specifier: string, exportsMap: PackageExports): string | undefined {
  const subpath = `.${specifier.slice('@lostgradient/testing'.length)}`;
  const exact = exportsMap[subpath];
  if (exact !== undefined) return posix(join('testing/testing', exact));
  for (const [pattern, target] of Object.entries(exportsMap)) {
    if (!pattern.endsWith('/*') || !subpath.startsWith(pattern.slice(0, -1))) continue;
    const rest = subpath.slice(pattern.length - 1);
    return posix(join('testing/testing', target.replace('*', rest)));
  }
  return undefined;
}

function relativeSpecifier(importer: string, target: string): string {
  const path = posix(relative(dirname(importer), target));
  return path.startsWith('.') ? path : `./${path}`;
}

function desiredSpecifier(importer: string, target: string): string {
  const redirected =
    REDIRECTS[target] !== undefined && !importer.startsWith(`${fixtures}/`)
      ? REDIRECTS[target]
      : target;
  const insideTesting = importer.startsWith('testing/testing/');
  if (redirected.startsWith(`${testingSource}/`) && !insideTesting) {
    return testingSpecifier(redirected);
  }
  return relativeSpecifier(importer, redirected);
}

type Context = {
  map: Map<string, string>;
  previous: Map<string, string>;
  exportsMap: PackageExports;
  unresolved: string[];
};

/** The repository path a relative specifier means, following moves, or undefined. */
function relativeTarget(importer: string, specifier: string, context: Context): string | undefined {
  const here = resolveRelative(dirname(importer), specifier);
  if (isFile(here)) return here;
  const moved = context.map.get(here);
  if (moved !== undefined) return moved;
  const before = context.previous.get(importer);
  if (before === undefined) return undefined;
  const there = resolveRelative(dirname(before), specifier);
  const target = context.map.get(there) ?? there;
  return isFile(target) ? target : undefined;
}

function rewriteSpecifier(importer: string, specifier: string, context: Context): string {
  if (specifier.startsWith('@lostgradient/testing')) {
    // Only a file moved into the testing package changes how it names the package.
    if (!importer.startsWith('testing/testing/') || !context.previous.has(importer)) {
      return specifier;
    }
    const target = testingTarget(specifier, context.exportsMap);
    return target === undefined ? specifier : relativeSpecifier(importer, target);
  }
  if (!specifier.startsWith('.')) return specifier;
  const target = relativeTarget(importer, specifier, context);
  if (target === undefined) {
    context.unresolved.push(`${importer}: ${specifier}`);
    return specifier;
  }
  const wasMoved = context.previous.has(importer) || [...context.map.values()].includes(target);
  const redirected = REDIRECTS[target] !== undefined && !importer.startsWith(`${fixtures}/`);
  if (!wasMoved && !redirected) return specifier;
  return desiredSpecifier(importer, target);
}

const SPECIFIER = /(\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)(['"])([^'"\n]+)\2/g;

function rewriteImports(context: Context): number {
  let rewritten = 0;
  for (const file of trackedFiles('*.ts', '*.svelte')) {
    const path = join(repositoryRoot, file);
    if (!existsSync(path)) continue;
    const source = readFileSync(path, 'utf8');
    const next = source.replace(
      SPECIFIER,
      (whole, lead: string, quote: string, specifier: string) => {
        const replacement = rewriteSpecifier(file, specifier, context);
        return replacement === specifier ? whole : `${lead}${quote}${replacement}${quote}`;
      },
    );
    if (next === source) continue;
    rewritten += 1;
    console.log(`rewrite ${file}`);
    if (!dryRun) writeFileSync(path, next);
  }
  return rewritten;
}

function main(): number {
  const map = fileMoves();
  const moved = applyMoves(map);
  const previous = new Map([...map].map(([from, to]) => [to, from]));
  const context: Context = { map, previous, exportsMap: testingExports(), unresolved: [] };
  const rewritten = rewriteImports(context);
  // Only a moved file's unresolved import is this script's to answer; others predate it.
  const stale = context.unresolved.filter((entry) => previous.has(entry.split(': ')[0]!));
  for (const entry of stale) console.error(`unresolved import ${entry}`);
  console.log(`${moved} files moved, ${rewritten} files rewritten${dryRun ? ' (dry run)' : ''}.`);
  return stale.length === 0 ? 0 : 1;
}

if (import.meta.main) process.exit(main());
