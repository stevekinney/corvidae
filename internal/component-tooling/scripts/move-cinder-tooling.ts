/**
 * Moves Cinder's tooling into `internal/component-tooling` (COR-2079), re-runnably.
 *
 * ```sh
 * bun internal/component-tooling/scripts/move-cinder-tooling.ts            # move and rewrite
 * bun internal/component-tooling/scripts/move-cinder-tooling.ts --dry-run  # print the plan
 * ```
 *
 * What moves: every tracked file under `components/core/scripts` except the token pipeline
 * (`tokens/`), the design-system bundle (`design-system/`), the baselines and the A2UI catalog
 * allowlist, which stay beside Cinder; and every Cinder module `families.json`'s rules give the
 * tooling (the schemas, `manifest.meta.ts`, `schema-types.ts`, the component-free test helpers and
 * the tests that read sibling packages). A moved file keeps its path below `scripts/` or `src/`.
 * A module listed in `REEXPORTED` leaves a re-export at its old path; since the `metadata` task
 * (COR-2078) stopped committing generated schema modules, none needs one.
 *
 * Then it rewrites what pointed at the old places:
 *   - every relative import, export and dynamic import, resolved where the file was before the move
 *     and re-emitted from where it is now; an import from outside the tooling into it becomes an
 *     `@lostgradient/component-tooling/...` specifier, and the importing package gains the
 *     development dependency;
 *   - every path a moved file or an importer builds from `import.meta.dir`, `import.meta.dirname`,
 *     `dirname(fileURLToPath(import.meta.url))` or a constant bound to one, through `join(...)` or
 *     `resolve(...)` with literal segments, or `new URL('<literal>', import.meta.url)`;
 *   - every file path in a `package.json` script or a `bunfig.toml`;
 *   - every repository-relative mention (`components/core/scripts/x.ts`) in tracked text files.
 *
 * A run with nothing left to move still repairs a relative import that no longer resolves when the
 * old path's counterpart exists in the tooling, so it can run again after a merge brings in files
 * written against the old layout. A file that exists at both its old and its new path stops the run.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';

import { deriveFamilies, readPackageTree, readRules } from './derive-families.ts';

const TOOLING = 'internal/component-tooling';
const TOOLING_PACKAGE = '@lostgradient/component-tooling';
const CINDER = 'components/core';
const KEPT_SCRIPTS = [
  /^scripts\/tokens\//,
  /^scripts\/design-system\//,
  /^scripts\/[a-z-]+-baseline\.json$/,
  /^scripts\/a2ui-catalog-allowlist\.json$/,
];
/** Moved, but a re-export stays at the old path for everything outside the tooling: path -> text. */
const REEXPORTED = new Map<string, string>();
/** Specifiers for paths inside the tooling, longest prefix first: [tooling path, specifier]. */
const EXPORTS: [string, string][] = [
  ['src/test/', 'test/'],
  ['src/schemas/', 'schemas/'],
  ['src/schema-types.ts', 'schema-types'],
  ['src/manifest.meta.ts', 'manifest.meta'],
  ['scripts/', 'scripts/'],
];
const CODE = /\.(?:ts|svelte|js|mjs)$/;
const SPECIFIER =
  /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\bexport\s*\*\s*from\s*)(['"])(\.{1,2}\/[^'"\n]*)\2/g;

export interface Plan {
  moves: Map<string, string>;
}

function git(root: string, ...args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr.toString()}`);
  }
  return result.stdout.toString();
}

function trackedFiles(root: string): string[] {
  return git(root, 'ls-files', '-z')
    .split('\0')
    .filter((path) => path !== '' && existsSync(join(root, path)));
}

/** Which tracked files move, and where. */
export function planMoves(root: string, tracked: readonly string[]): Plan {
  const moves = new Map<string, string>();
  for (const path of tracked) {
    if (!path.startsWith(`${CINDER}/scripts/`)) continue;
    const local = path.slice(CINDER.length + 1);
    if (KEPT_SCRIPTS.some((pattern) => pattern.test(local))) continue;
    moves.set(path, `${TOOLING}/${local}`);
  }
  const rules = readRules(join(root, TOOLING, 'family-rules.json'));
  const derived = deriveFamilies(readPackageTree(join(root, rules.packageRoot)), rules);
  for (const local of derived.packages['tooling']?.modules ?? []) {
    const from = `${CINDER}/${local}`;
    // A re-export left at a moved module's old path is expected, not a second copy.
    if (REEXPORTED.has(from) && existsSync(join(root, TOOLING, local))) continue;
    if (existsSync(join(root, from))) moves.set(from, `${TOOLING}/${local}`);
  }
  const collisions = [...moves].filter(([, to]) => existsSync(join(root, to)));
  if (collisions.length > 0) {
    throw new Error(
      `These files exist at both their old and their new path; reconcile them by hand first:\n${collisions.map(([from, to]) => `  ${from} -> ${to}`).join('\n')}`,
    );
  }
  return { moves };
}

/**
 * Where a pre-move path is now. A moved file maps to its new path; a directory every tracked file
 * of which moved maps to its new directory; anything else stays, so a path into a directory that
 * only partly moved (Cinder's `src`) still points at Cinder. A Cinder path that an earlier run
 * moved (it is gone, and the tooling holds its counterpart) maps to that counterpart.
 */
function mapPath(path: string, moves: ReadonlyMap<string, string>, before: ReadonlySet<string>) {
  const moved = moves.get(path);
  if (moved !== undefined) return moved;
  if (before.has(path)) return path;
  const prefix = `${path}/`;
  let any = false;
  for (const file of before) {
    if (!file.startsWith(prefix)) continue;
    if (!moves.has(file)) return path;
    any = true;
  }
  if (!any) return movedEarlier(path) ?? path;
  const first = [...moves].find(([from]) => from.startsWith(prefix));
  if (first === undefined) return path;
  const [from, to] = first;
  return to.slice(0, to.length - (from.length - path.length));
}

/** The repository root of the current run; {@link movedEarlier} reads the tree under it. */
let repositoryRoot = '';

/** The tooling counterpart of a Cinder path an earlier run moved, when only the counterpart exists. */
function movedEarlier(path: string): string | undefined {
  if (repositoryRoot === '' || !path.startsWith(`${CINDER}/`)) return undefined;
  if (existsSync(join(repositoryRoot, path))) return undefined;
  const counterpart = `${TOOLING}/${path.slice(CINDER.length + 1)}`;
  return existsSync(join(repositoryRoot, counterpart)) ? counterpart : undefined;
}

const insideTooling = (path: string) => path === TOOLING || path.startsWith(`${TOOLING}/`);

function relativeSpecifier(fromFile: string, target: string): string {
  const relative = posix.relative(posix.dirname(fromFile), target);
  return relative.startsWith('.') ? relative : `./${relative}`;
}

function packageSpecifier(target: string): string | undefined {
  const local = target.slice(TOOLING.length + 1);
  for (const [prefix, exported] of EXPORTS) {
    if (local === prefix) return `${TOOLING_PACKAGE}/${exported}`;
    if (prefix.endsWith('/') && local.startsWith(prefix)) {
      return `${TOOLING_PACKAGE}/${exported}${local.slice(prefix.length)}`;
    }
  }
  return undefined;
}

/** The file a relative specifier names, from a directory, among `exists`; and the suffix added. */
function resolveFile(
  directory: string,
  specifier: string,
  exists: (path: string) => boolean,
): { path: string; added: string } | undefined {
  const base = posix.normalize(posix.join(directory, specifier.split('?')[0] ?? ''));
  for (const added of ['', '.ts', '.svelte', '.svelte.ts', '/index.ts', '.js']) {
    if (exists(`${base}${added}`)) return { path: `${base}${added}`, added };
  }
  return undefined;
}

interface Context {
  root: string;
  moves: ReadonlyMap<string, string>;
  /** New path -> old path for files this run moves. */
  origins: ReadonlyMap<string, string>;
  before: ReadonlySet<string>;
  /** Packages (by manifest path) whose files now import the tooling by specifier. */
  dependents: Set<string>;
}

function owningManifest(root: string, file: string): string | undefined {
  for (
    let directory = posix.dirname(file);
    directory !== '.';
    directory = posix.dirname(directory)
  ) {
    if (existsSync(join(root, directory, 'package.json'))) return `${directory}/package.json`;
  }
  return undefined;
}

/** The new specifier for one relative import of `file` (at its new path), or undefined. */
function rewriteSpecifier(context: Context, file: string, specifier: string): string | undefined {
  const { root, moves, origins, before } = context;
  const query = specifier.includes('?') ? specifier.slice(specifier.indexOf('?')) : '';
  const origin = origins.get(file);
  let target: string | undefined;
  let added = '';
  if (origin !== undefined || moves.size > 0) {
    const resolved = resolveFile(posix.dirname(origin ?? file), specifier, (path) =>
      before.has(path),
    );
    if (resolved !== undefined) {
      target = mapPath(resolved.path, moves, before);
      added = resolved.added;
      if (REEXPORTED.has(resolved.path) && !insideTooling(file)) target = resolved.path;
      // Neither end moved: the specifier stays as written.
      if (origin === undefined && target === resolved.path) return undefined;
    }
  }
  if (target === undefined) {
    // A later run: repair an import that no longer resolves when the tooling holds its counterpart.
    if (resolveFile(posix.dirname(file), specifier, (path) => existsSync(join(root, path)))) {
      return undefined;
    }
    const stale = posix.normalize(posix.join(posix.dirname(file), specifier.split('?')[0] ?? ''));
    if (!stale.startsWith(`${CINDER}/`)) return undefined;
    const counterpart = `${TOOLING}/${stale.slice(CINDER.length + 1)}`;
    const resolved = resolveFile(
      posix.dirname(counterpart),
      `./${posix.basename(counterpart)}`,
      (path) => existsSync(join(root, path)),
    );
    if (resolved === undefined) return undefined;
    target = resolved.path;
    added = resolved.added;
  }
  if (!insideTooling(file) && insideTooling(target)) {
    const exported = packageSpecifier(target);
    if (exported !== undefined) {
      const manifest = owningManifest(root, file);
      if (manifest !== undefined) context.dependents.add(manifest);
      return `${exported}${query}`;
    }
  }
  let next = relativeSpecifier(file, target);
  if (added !== '' && next.endsWith(added)) next = next.slice(0, next.length - added.length);
  next = `${next}${query}`;
  return next === specifier ? undefined : next;
}

const ANCHOR_EXPRESSIONS = [
  'import.meta.dirname',
  'import.meta.dir',
  'dirname(fileURLToPath(import.meta.url))',
  "resolve(fileURLToPath(new URL('.', import.meta.url)))",
];
const escape = (text: string) => text.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');
const LITERAL_LIST = String.raw`((?:\s*,\s*'[^'\n]*')+)`;

/**
 * Rewrites the paths `file` builds from its own location: each `join(anchor, '...')` or
 * `resolve(anchor, '...')` whose literal segments name a place that moved, or that `file` moved
 * away from. Constants bound to such a call are anchors too, at the place they named.
 */
function rewriteAnchors(context: Context, file: string, source: string): string {
  const { moves, before, origins } = context;
  const oldDirectory = posix.dirname(origins.get(file) ?? file);
  const newDirectory = posix.dirname(file);
  // anchor text -> [old absolute, new absolute]
  const anchors = new Map<string, [string, string]>(
    ANCHOR_EXPRESSIONS.map((expression) => [expression, [oldDirectory, newDirectory]]),
  );
  const binding = /\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*([^;\n]+);/g;
  for (const match of source.matchAll(binding)) {
    const [, name = '', expression = ''] = match;
    if (ANCHOR_EXPRESSIONS.includes(expression.trim())) {
      anchors.set(name, [oldDirectory, newDirectory]);
    }
  }
  let output = source;
  for (const [anchor] of [...anchors].toSorted((a, b) => b[0].length - a[0].length)) {
    const call = new RegExp(String.raw`\b(join|resolve)\(\s*${escape(anchor)}${LITERAL_LIST}`, 'g');
    output = output.replace(call, (whole, _callee: string, literals: string) => {
      const [oldBase, newBase] = anchors.get(anchor) as [string, string];
      const segments = [...literals.matchAll(/'([^'\n]*)'/g)].map((part) => part[1] ?? '');
      const oldTarget = posix.normalize(posix.join(oldBase, ...segments));
      const newTarget = mapPath(oldTarget, moves, before);
      const relative = posix.relative(newBase, newTarget) || '.';
      if (posix.normalize(posix.join(newBase, ...segments)) === newTarget) return whole;
      return whole.replace(literals, `, '${relative}'`);
    });
  }
  // Constants bound to a rewritten call are anchors at the place they name, for the next pass.
  for (const match of output.matchAll(binding)) {
    const [, name = '', expression = ''] = match;
    const call = new RegExp(
      String.raw`^(?:join|resolve)\(\s*(${[...anchors.keys()].map(escape).join('|')})${LITERAL_LIST}\s*\)$`,
    );
    const parts = call.exec(expression.trim());
    if (parts === null || anchors.has(name)) continue;
    const [, base = '', literals = ''] = parts;
    const segments = [...literals.matchAll(/'([^'\n]*)'/g)].map((part) => part[1] ?? '');
    const [, newBase] = anchors.get(base) as [string, string];
    const newAbsolute = posix.normalize(posix.join(newBase, ...segments));
    // The old absolute is where the source said before this rewrite.
    const original = source.match(
      new RegExp(
        String.raw`\bconst\s+${escape(name)}\s*=\s*(?:join|resolve)\(\s*${escape(base)}${LITERAL_LIST}`,
      ),
    );
    const oldSegments = original
      ? [...(original[1] ?? '').matchAll(/'([^'\n]*)'/g)].map((part) => part[1] ?? '')
      : segments;
    const [oldBase] = anchors.get(base) as [string, string];
    anchors.set(name, [posix.normalize(posix.join(oldBase, ...oldSegments)), newAbsolute]);
    const use = new RegExp(String.raw`\b(join|resolve)\(\s*${escape(name)}${LITERAL_LIST}`, 'g');
    output = output.replace(use, (whole, _callee: string, useLiterals: string) => {
      const [oldAt, newAt] = anchors.get(name) as [string, string];
      const useSegments = [...useLiterals.matchAll(/'([^'\n]*)'/g)].map((part) => part[1] ?? '');
      const newTarget = mapPath(posix.normalize(posix.join(oldAt, ...useSegments)), moves, before);
      if (posix.normalize(posix.join(newAt, ...useSegments)) === newTarget) return whole;
      return whole.replace(useLiterals, `, '${posix.relative(newAt, newTarget) || '.'}'`);
    });
  }
  // new URL('<relative>', import.meta.url)
  return output.replace(
    /new URL\('(\.{1,2}\/[^'\n]*)', import\.meta\.url\)/g,
    (whole, path: string) => {
      const oldTarget = posix.normalize(posix.join(oldDirectory, path));
      const newTarget = mapPath(oldTarget.replace(/\/$/, ''), moves, before);
      let relative = posix.relative(newDirectory, newTarget);
      if (!relative.startsWith('.')) relative = `./${relative}`;
      if (path.endsWith('/')) relative = `${relative}/`;
      return posix.normalize(posix.join(newDirectory, path)).replace(/\/$/, '') ===
        newTarget.replace(/\/$/, '')
        ? whole
        : `new URL('${relative}', import.meta.url)`;
    },
  );
}

/** Rewrites path tokens in package.json scripts and bunfig.toml preloads of one package. */
function rewriteManifestPaths(context: Context, file: string, source: string): string {
  const directory = posix.dirname(file);
  const mapToken = (token: string): string => {
    if (!/^\.{0,2}\/?[\w.-]+(?:\/[\w.-]+)+$/.test(token) || !/\.(?:ts|json)$/.test(token)) {
      return token;
    }
    const old = posix.normalize(posix.join(directory, token));
    let target = context.before.has(old) ? mapPath(old, context.moves, context.before) : undefined;
    if (
      target === undefined &&
      !existsSync(join(context.root, old)) &&
      old.startsWith(`${CINDER}/`)
    ) {
      const counterpart = `${TOOLING}/${old.slice(CINDER.length + 1)}`;
      if (existsSync(join(context.root, counterpart))) target = counterpart;
    }
    if (target === undefined || target === old) return token;
    const relative = posix.relative(directory, target);
    return token.startsWith('./') && !relative.startsWith('.') ? `./${relative}` : relative;
  };
  if (file.endsWith('package.json')) {
    const manifest = JSON.parse(source) as { scripts?: Record<string, string> };
    if (manifest.scripts === undefined) return source;
    let changed = false;
    for (const [name, script] of Object.entries(manifest.scripts)) {
      const next = script.replace(/[^\s'"&|;]+/g, (token) => mapToken(token));
      if (next !== script) {
        manifest.scripts[name] = next;
        changed = true;
      }
    }
    return changed ? `${JSON.stringify(manifest, null, 2)}\n` : source;
  }
  return source.replace(/"([^"\n]+)"/g, (whole, token: string) => {
    const next = mapToken(token);
    return next === token ? whole : `"${next}"`;
  });
}

/** Rewrites repository-relative mentions of moved files and directories. */
function rewriteMentions(context: Context, source: string): string {
  if (context.moves.size === 0) return source;
  return source.replace(
    new RegExp(String.raw`${escape(CINDER)}/(?:scripts|src)/[\w./-]*[\w-]`, 'g'),
    (mention) => {
      const path = mention.replace(/\/$/, '');
      if (
        !context.before.has(path) &&
        ![...context.before].some((file) => file.startsWith(`${path}/`))
      ) {
        return mention;
      }
      const target = mapPath(path, context.moves, context.before);
      return REEXPORTED.has(path) ? mention : target;
    },
  );
}

function addDevelopmentDependency(root: string, manifestPath: string): boolean {
  const path = join(root, manifestPath);
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as {
    name?: string;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  if (manifest.name === TOOLING_PACKAGE) return false;
  if (manifest.dependencies?.[TOOLING_PACKAGE] !== undefined) return false;
  if (manifest.devDependencies?.[TOOLING_PACKAGE] !== undefined) return false;
  manifest.devDependencies = { ...manifest.devDependencies, [TOOLING_PACKAGE]: 'workspace:*' };
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
  return true;
}

/**
 * Repoints a JSON file's relative `"$schema"` at the schema's new place when the schema moved in
 * this run, or when it no longer exists and the tooling holds its counterpart.
 */
function rewriteSchemaReferences(context: Context, file: string, source: string): string {
  const directory = posix.dirname(context.origins.get(file) ?? file);
  return source.replace(
    /("\$schema"\s*:\s*")(\.{1,2}\/[^"\n]+)(")/g,
    (whole, lead: string, reference: string, tail: string) => {
      const old = posix.normalize(posix.join(directory, reference));
      let target: string | undefined = context.moves.get(old);
      if (
        target === undefined &&
        !existsSync(join(context.root, old)) &&
        old.startsWith(`${CINDER}/`)
      ) {
        const counterpart = `${TOOLING}/${old.slice(CINDER.length + 1)}`;
        if (existsSync(join(context.root, counterpart))) target = counterpart;
      }
      if (target === undefined) return whole;
      return `${lead}${posix.relative(posix.dirname(file), target)}${tail}`;
    },
  );
}

/** The tooling file a `@lostgradient/component-tooling/<subpath>` specifier names. */
function toolingPathOf(subpath: string): string | undefined {
  for (const [prefix, exported] of EXPORTS) {
    if (subpath === exported) return `./${prefix}`;
    if (exported.endsWith('/') && subpath.startsWith(exported)) {
      return `./${prefix}${subpath.slice(exported.length)}`;
    }
  }
  return undefined;
}

/**
 * Declares, as an exact entry in the tooling's `exports`, every tooling subpath a file outside the
 * tooling imports: `scripts/workspace-imports.test.ts` accepts only declared entry points.
 */
function declareUsedEntryPoints(root: string, files: readonly string[]): boolean {
  const used = new Map<string, string>();
  const specifier = new RegExp(String.raw`['"]${escape(TOOLING_PACKAGE)}/([\w./-]+)['"]`, 'g');
  for (const file of files) {
    if (!CODE.test(file) || insideTooling(file) || !existsSync(join(root, file))) continue;
    for (const match of readFileSync(join(root, file), 'utf8').matchAll(specifier)) {
      const subpath = match[1] ?? '';
      const target = toolingPathOf(subpath);
      if (target !== undefined && existsSync(join(root, TOOLING, target))) {
        used.set(`./${subpath}`, target);
      }
    }
  }
  const path = join(root, TOOLING, 'package.json');
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as { exports?: Record<string, string> };
  const exports = { ...manifest.exports };
  let changed = false;
  for (const [key, target] of used) {
    if (exports[key] === target) continue;
    exports[key] = target;
    changed = true;
  }
  if (!changed) return false;
  manifest.exports = Object.fromEntries(
    Object.entries(exports).toSorted(([a], [b]) => a.localeCompare(b)),
  );
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
  return true;
}

const TEXT = /\.(?:ts|svelte|js|mjs|json|md|toml|ya?ml|css)$|(?:^|\/)\.prettierignore$/;
const SKIP_MENTIONS = [
  `${TOOLING}/families.json`,
  `${TOOLING}/family-rules.json`,
  `${TOOLING}/family-rules.fixture.json`,
  `${TOOLING}/scripts/move-cinder-tooling.ts`,
];

export function run(root: string, dryRun: boolean): string[] {
  repositoryRoot = root;
  const tracked = trackedFiles(root);
  const before = new Set(tracked);
  const { moves } = planMoves(root, tracked);
  const log = [...moves].map(([from, to]) => `move ${from} -> ${to}`);
  if (dryRun) return log;

  for (const [from, to] of moves) {
    mkdirSync(dirname(join(root, to)), { recursive: true });
    git(root, 'mv', from, to);
  }
  for (const [path, content] of REEXPORTED) {
    if (moves.has(path)) {
      writeFileSync(join(root, path), content);
      git(root, 'add', path);
    }
  }
  const origins = new Map([...moves].map(([from, to]) => [to, from]));
  const context: Context = { root, moves, origins, before, dependents: new Set() };
  const current = trackedFiles(root);
  for (const file of current) {
    if (!TEXT.test(file) || file.includes('/fixtures/schema-fallback/')) continue;
    const absolute = join(root, file);
    const source = readFileSync(absolute, 'utf8');
    let next = source;
    if (CODE.test(file) && !REEXPORTED.has(file)) {
      next = next.replace(SPECIFIER, (whole, lead: string, quote: string, specifier: string) => {
        const rewritten = rewriteSpecifier(context, file, specifier);
        return rewritten === undefined ? whole : `${lead}${quote}${rewritten}${quote}`;
      });
      if (moves.size > 0 && file !== `${TOOLING}/scripts/move-cinder-tooling.ts`) {
        next = rewriteAnchors(context, file, next);
      }
    }
    if (posix.basename(file) === 'package.json' || posix.basename(file) === 'bunfig.toml') {
      next = rewriteManifestPaths(context, file, next);
    }
    if (file.endsWith('.json')) next = rewriteSchemaReferences(context, file, next);
    if (!SKIP_MENTIONS.includes(file)) next = rewriteMentions(context, next);
    if (next !== source) {
      writeFileSync(absolute, next);
      log.push(`rewrite ${file}`);
    }
  }
  for (const manifest of context.dependents) {
    if (addDevelopmentDependency(root, manifest))
      log.push(`depend ${manifest} -> ${TOOLING_PACKAGE}`);
  }
  if (declareUsedEntryPoints(root, current)) log.push(`rewrite ${TOOLING}/package.json`);
  // A rewritten specifier or path changes line lengths; leave every touched file as Prettier would.
  const touched = log
    .filter((line) => line.startsWith('rewrite ') || line.startsWith('depend '))
    .map((line) => line.split(' ')[1] ?? '')
    .filter((path) => /\.(?:ts|svelte|js|mjs|json|md)$/.test(path));
  if (touched.length > 0) {
    const prettier = Bun.spawnSync(
      [join(root, 'node_modules/.bin/prettier'), '--write', '--log-level=warn', ...touched],
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
  const log = run(root, process.argv.includes('--dry-run'));
  process.stdout.write(log.length === 0 ? 'Nothing to move or rewrite.\n' : `${log.join('\n')}\n`);
  if (log.some((line) => line.startsWith('depend '))) {
    process.stdout.write(
      'A manifest gained a dependency: run `bun install` and commit bun.lock.\n',
    );
  }
}
