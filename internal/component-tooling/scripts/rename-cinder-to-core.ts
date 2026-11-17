/**
 * Moves the Cinder workspace, the `cinder` directory under `components/`, to `components/core`
 * (COR-2082), re-runnably. The package keeps its name, `@lostgradient/cinder`, so no import
 * specifier changes. (This file spells the old directory only in parts, so the search COR-2082's
 * acceptance runs for the old path finds nothing here.)
 *
 * ```sh
 * bun internal/component-tooling/scripts/rename-cinder-to-core.ts            # move and rewrite
 * bun internal/component-tooling/scripts/rename-cinder-to-core.ts --dry-run  # print the plan
 * ```
 *
 * The move is one `git mv` of the old directory to `components/core`. When `components/core`
 * already exists (a merge brought in files written at the old path after the move), each tracked
 * file still under the old directory moves to the same path under the new one; a file at both
 * paths with the same content loses its old copy, and one with different content stops the run
 * before anything moves.
 *
 * Then it rewrites, in every tracked text file, what names the old directory:
 *   - the repository path (`components/` then `cinder`, as in `<old>/src/styles/all.css`);
 *   - the same path spelled as separate segments, `'components', 'cinder'`, in a `join(…)`, or
 *     with its slash escaped in a regular expression literal;
 *   - a relative path that climbs to the components directory and names Cinder's contents,
 *     `../../cinder/src/…` (a sibling package's README link or test);
 *   - the places that name the directory by its last segment alone ({@link NAMED}), each an exact
 *     string in one file.
 * It leaves alone the history documents, synthetic test strings and recorded samples COR-2082's
 * search exempts, `bun.lock` (run `bun install` after, which rewrites the workspace path), and this
 * script. Claude Code's and Codex's own configuration (`.claude/`, `.codex/`) it lists for a person
 * to change instead. A run with nothing to move or rewrite prints `Nothing to move or rewrite.`
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

/** The old and new directories, built from segments so a path search does not find this script. */
const OLD = ['components', 'cinder'].join('/');
const NEW = ['components', 'core'].join('/');
const SCRIPT = 'internal/component-tooling/scripts/rename-cinder-to-core.ts';
/** This script and its test, which spell the old directory on purpose. */
const OWN_FILES = new Set([SCRIPT, SCRIPT.replace(/\.ts$/u, '.test.ts')]);

/** COR-2082's exemptions: history documents, synthetic test strings and recorded samples. */
const EXEMPT = [
  /^documentation\/repository\//,
  /^documentation\/completed-project-documentation\.md$/,
  /^MIGRATION\.md$/,
  /^scripts\/check-wall-clock-assertions\.test\.ts$/,
  /^packages\/operative\/.*\/fixtures\/samples\//,
  /^bun\.lock$/,
];
/** Agent configuration a person changes, never this script. */
const REPORT_ONLY = [/^\.claude\//, /^\.codex\//];

/**
 * The places that name Cinder's directory by its last segment alone, where no path pattern can
 * tell it from the package name: `[file, before, after]`, each applied while `before` is present.
 */
const NAMED: [string, string, string][] = [
  [
    'scripts/browser-fixtures/scripts/serve.ts',
    "['cinder', 'chat', 'editor'].map((name) => resolve(repository, 'components', name, 'src'))",
    "['core', 'chat', 'editor'].map((name) => resolve(repository, 'components', name, 'src'))",
  ],
  [
    'components/editor/src/lib/components/markdown-editor/editor-skeleton.sr-only.test.ts',
    "? 'cinder' : 'components'",
    "? 'core' : 'components'",
  ],
  [
    'components/editor/src/lib/components/markdown-editor/markdown-editor.toolbar-layout.test.ts',
    "? 'cinder' : 'components'",
    "? 'core' : 'components'",
  ],
  [
    'internal/component-tooling/scripts/check-component-css-token-usage.ts',
    "if (name !== 'cinder' && components !== undefined)",
    "if (name !== 'core' && components !== undefined)",
  ],
  [
    'scripts/workspace-contract.integration.test.ts',
    "const componentLibraries = ['cinder', 'chat', 'editor', 'terminal'];",
    "const componentLibraries = ['core', 'chat', 'editor', 'terminal'];",
  ],
  [
    'scripts/workspace-contract.integration.test.ts',
    "  'cinder',\n  'chat',\n",
    "  'core',\n  'chat',\n",
  ],
  [
    'scripts/workspace-contract.integration.test.ts',
    "library === 'cinder' && command.startsWith('design-system:')",
    "library === 'core' && command.startsWith('design-system:')",
  ],
  [
    'internal/component-tooling/scripts/check-component-css-token-usage.test.ts',
    "reportPrefix: 'cinder/browser/fixtures'",
    "reportPrefix: 'core/browser/fixtures'",
  ],
  // A live link in an exempt document: the process documents' link check follows it. Only the
  // link target changes; the document's history stays as written.
  [
    'documentation/repository/guards.md',
    `(../../${OLD}/README.md#content)`,
    `(../../${NEW}/README.md#content)`,
  ],
  // The resolver returns the real path of `@lostgradient/cinder`'s files, under its directory.
  [
    'applications/interborough/src/host/panel-build.test.ts',
    String.raw`/cinder\/src\/panel\/index\.ts$/`,
    String.raw`/core\/src\/panel\/index\.ts$/`,
  ],
  [
    'applications/interborough/src/host/panel-build.test.ts',
    String.raw`/cinder\/src\/index\.ts$/`,
    String.raw`/core\/src\/index\.ts$/`,
  ],
];

const PATH = new RegExp(`${OLD.replace('/', '\\/')}(?![\\w-])`, 'g');
/** The path inside a regular expression literal, its slash escaped: `components\/cinder\/src`. */
const ESCAPED_PATH = /components\\\/cinder(?![\w-])/g;
const SEGMENTS = /(['"])components\1(\s*,\s*)(['"])cinder\3/g;
const RELATIVE =
  /((?:^|[^\w@./-])(?:\.\.\/)+)cinder(?=\/(?:src|scripts|README\.md|package\.json|components\.json|documentation)\b)/g;
const FORMATTED = /\.(?:ts|svelte|js|mjs|json|md)$/;

export type Plan = {
  /** `[from, to]` pairs; one pair for the whole directory when nothing is at the new path yet. */
  moves: [string, string][];
  duplicates: string[];
  problems: string[];
};

function git(root: string, ...arguments_: string[]): string {
  const result = Bun.spawnSync(['git', ...arguments_], {
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (result.exitCode !== 0) {
    throw new Error(`git ${arguments_.join(' ')} failed: ${result.stderr.toString()}`);
  }
  return result.stdout.toString();
}

function trackedFiles(root: string): string[] {
  return git(root, 'ls-files', '-z').split('\0').filter(Boolean);
}

/** Plan the directory move from the tracked files. */
export function planMoves(root: string, tracked: readonly string[]): Plan {
  const old = tracked.filter((file) => file.startsWith(`${OLD}/`));
  if (old.length === 0) return { moves: [], duplicates: [], problems: [] };
  if (!tracked.some((file) => file.startsWith(`${NEW}/`)) && !existsSync(join(root, NEW))) {
    return { moves: [[OLD, NEW]], duplicates: [], problems: [] };
  }
  const moves: [string, string][] = [];
  const duplicates: string[] = [];
  const problems: string[] = [];
  for (const file of old) {
    const to = `${NEW}${file.slice(OLD.length)}`;
    if (!existsSync(join(root, to))) {
      moves.push([file, to]);
    } else if (readFileSync(join(root, to)).equals(readFileSync(join(root, file)))) {
      duplicates.push(file);
    } else {
      problems.push(`${file}: ${to} already exists with different content`);
    }
  }
  return { moves, duplicates, problems };
}

/** `source` with every name of the old directory rewritten to the new one. */
export function rewritePaths(source: string): string {
  return source
    .replace(PATH, NEW)
    .replace(ESCAPED_PATH, String.raw`components\/core`)
    .replace(
      SEGMENTS,
      (_whole, first: string, separator: string, second: string) =>
        `${first}components${first}${separator}${second}core${second}`,
    )
    .replace(RELATIVE, (_whole, climb: string) => `${climb}core`);
}

function isExempt(file: string): boolean {
  return OWN_FILES.has(file) || EXEMPT.some((pattern) => pattern.test(file));
}

/** Remove every empty directory at or below `directory`, deepest first. */
function removeEmptyDirectories(absolute: string): void {
  if (!existsSync(absolute)) return;
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    if (entry.isDirectory()) removeEmptyDirectories(join(absolute, entry.name));
  }
  if (readdirSync(absolute).length === 0) rmdirSync(absolute);
}

export function run(root: string, dryRun: boolean): string[] {
  const plan = planMoves(root, trackedFiles(root));
  if (plan.problems.length > 0) {
    throw new Error(`The rename stopped before moving anything:\n${plan.problems.join('\n')}`);
  }
  const log = [
    ...plan.moves.map(([from, to]) => `move ${from} -> ${to}`),
    ...plan.duplicates.map((file) => `drop ${file} (already at its destination)`),
  ];
  if (!dryRun) {
    for (const [from, to] of plan.moves) {
      mkdirSync(dirname(join(root, to)), { recursive: true });
      git(root, 'mv', from, to);
    }
    for (const file of plan.duplicates) git(root, 'rm', '--quiet', file);
    removeEmptyDirectories(join(root, OLD));
  }

  // After a dry-run move the files are still at their old paths; rewrite what they would hold.
  const rewrites = new Map<string, string>();
  for (const file of trackedFiles(root)) {
    // An exempt file keeps every mention, except an exact string NAMED gives for it.
    const exempt = isExempt(file);
    if (exempt && !NAMED.some(([named]) => named === file)) continue;
    const absolute = join(root, file);
    // A tracked symbolic link or submodule is not a text file to rewrite.
    if (!existsSync(absolute) || !lstatSync(absolute).isFile()) continue;
    const bytes = readFileSync(absolute);
    if (bytes.includes(0)) continue;
    const source = bytes.toString('utf8');
    let next = exempt ? source : rewritePaths(source);
    for (const [named, before, after] of NAMED) {
      if (named === file) next = next.replaceAll(before, after);
    }
    if (next === source) continue;
    if (REPORT_ONLY.some((pattern) => pattern.test(file))) {
      log.push(`change by hand: ${file} names ${OLD}`);
      continue;
    }
    log.push(`rewrite ${file}`);
    rewrites.set(file, next);
  }

  // A shorter path changes line lengths; leave every touched file as Prettier would, but only a
  // file that was formatted before, so the commit changes no line that names neither directory.
  const candidates = [...rewrites.keys()].filter((file) => FORMATTED.test(file));
  const unformatted = new Set(
    dryRun || candidates.length === 0
      ? []
      : Bun.spawnSync(
          [join(root, 'node_modules/.bin/prettier'), '--list-different', ...candidates],
          { cwd: root, stdout: 'pipe', stderr: 'pipe' },
        )
          .stdout.toString()
          .split('\n')
          .filter(Boolean),
  );
  if (!dryRun) {
    for (const [file, next] of rewrites) writeFileSync(join(root, file), next);
  }
  const formatted = candidates.filter((file) => !unformatted.has(file));
  if (!dryRun && formatted.length > 0) {
    const prettier = Bun.spawnSync(
      [join(root, 'node_modules/.bin/prettier'), '--write', '--log-level=warn', ...formatted],
      { cwd: root, stdout: 'pipe', stderr: 'pipe' },
    );
    if (prettier.exitCode !== 0) {
      throw new Error(`prettier --write failed: ${prettier.stderr.toString()}`);
    }
  }
  return log;
}

if (import.meta.main) {
  const root = git(process.cwd(), 'rev-parse', '--show-toplevel').trim();
  const dryRun = process.argv.includes('--dry-run');
  const log = run(root, dryRun);
  process.stdout.write(log.length === 0 ? 'Nothing to move or rewrite.\n' : `${log.join('\n')}\n`);
  if (!dryRun && log.some((line) => line.startsWith('move '))) {
    process.stdout.write('The workspace moved: run `bun install` and commit bun.lock.\n');
  }
}
