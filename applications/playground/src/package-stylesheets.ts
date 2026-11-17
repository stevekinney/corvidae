/**
 * Which packages' stylesheets the playground serves, and the URL each file is served at
 * (COR-2083's playground half).
 *
 * Cinder's stylesheets live in core and, as families are extracted, in the packages core depends
 * on: the tokens, the foundation, and every family. A stylesheet names one in another package
 * through a package specifier (`@import '@lostgradient/tokens/tokens.css'`), which a browser
 * cannot resolve, so the server resolves each one with the package's `exports`, from the directory
 * of the stylesheet that names it, and rewrites it to the URL of the file:
 *
 * - `/styles/<path>`: core's `src/styles/` (the URLs the playground always served);
 * - `/components/<path>`: core's own components root, where the aggregator's relative imports land;
 * - `/package-styles/<package>/<path>`: any other style package, `<package>` being its name
 *   without the scope and `<path>` the file's path inside it. A family's own `src/styles/index.css`
 *   is `/package-styles/<family>/src/styles/index.css`, so it can never shadow core's.
 *
 * A style package is core, and every `workspace:` dependency of core whose `exports` name a
 * stylesheet. Each root is the package's real directory (`realpath`), never a path through
 * `node_modules`, so the lexical traversal guard holds for every root it is given.
 */

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

import { CINDER_COMPONENT_SOURCE } from './component-sources.ts';
import { resolveSafePath } from './traversal-guard.ts';

/** One package whose stylesheets the playground serves. */
export type StylePackage = {
  name: string;
  /** The package's real directory. */
  root: string;
  /** The URL segment after `/package-styles/`: the name without its scope. */
  urlSegment: string;
};

/** Every style package of a core, and core's own two served roots. */
export type StylePackages = {
  core: StylePackage;
  /** Core's `src/styles/`, served at `/styles/`. */
  stylesRoot: string;
  /** Core's own components roots, served at `/components/` (one today, none once all are extracted). */
  componentRoots: readonly string[];
  /** Every other style package: tokens, foundation, and each family core depends on. */
  dependencies: readonly StylePackage[];
};

type PackageManifest = { name?: unknown; exports?: unknown; dependencies?: unknown };

function readManifest(directory: string): PackageManifest {
  return JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as PackageManifest;
}

/** Whether a package's `exports` map names a stylesheet, as a subpath key or a target. */
export function exportsStylesheets(exports: unknown): boolean {
  if (typeof exports === 'string') return exports.endsWith('.css');
  if (exports === null || typeof exports !== 'object') return false;
  return Object.entries(exports).some(
    ([key, target]) => key.endsWith('.css') || exportsStylesheets(target),
  );
}

function urlSegmentOf(name: string): string {
  return name.replace(/^@[^/]+\//u, '');
}

/**
 * The style packages of the core at `coreRoot`. Its dependencies resolve through core's own
 * `node_modules`, which is where the isolated linker places them, so the playground needs no
 * dependency of its own on any of them. `coreComponentRoots` are core's own components roots, from
 * core's manifest.
 */
export function readStylePackages(
  coreRoot: string,
  coreComponentRoots: readonly string[],
): StylePackages {
  const root = realpathSync(coreRoot);
  const manifest = readManifest(root);
  const name = typeof manifest.name === 'string' ? manifest.name : '@lostgradient/cinder';
  const dependencies: StylePackage[] = [];
  const declared = manifest.dependencies;
  if (declared !== null && typeof declared === 'object') {
    for (const [dependency, specification] of Object.entries(declared)) {
      if (typeof specification !== 'string' || !specification.startsWith('workspace:')) continue;
      const linked = join(root, 'node_modules', dependency);
      if (!existsSync(linked)) continue;
      const dependencyRoot = realpathSync(linked);
      if (!exportsStylesheets(readManifest(dependencyRoot).exports)) continue;
      dependencies.push({
        name: dependency,
        root: dependencyRoot,
        urlSegment: urlSegmentOf(dependency),
      });
    }
  }
  return {
    core: { name, root, urlSegment: urlSegmentOf(name) },
    stylesRoot: join(root, 'src', 'styles'),
    componentRoots: coreComponentRoots.map((componentRoot) => realpathSync(componentRoot)),
    dependencies: dependencies.toSorted((left, right) => left.name.localeCompare(right.name)),
  };
}

let stylePackagesCache: StylePackages | undefined;

/** The playground's style packages: Cinder's core and its style dependencies. */
export function stylePackages(): StylePackages {
  stylePackagesCache ??= readStylePackages(
    CINDER_COMPONENT_SOURCE.packageRoot,
    [...CINDER_COMPONENT_SOURCE.components().values()]
      .filter((location) => location.packageRoot === CINDER_COMPONENT_SOURCE.packageRoot)
      .map((location) => dirname(location.directory))
      .filter((componentRoot, index, roots) => roots.indexOf(componentRoot) === index),
  );
  return stylePackagesCache;
}

/** Forget the style packages, so a dependency core gained or lost is read again. */
export function resetStylePackages(): void {
  stylePackagesCache = undefined;
}

function within(root: string, path: string): string | undefined {
  const pathWithinRoot = relative(root, path);
  if (pathWithinRoot === '' || pathWithinRoot.startsWith('..') || pathWithinRoot.startsWith(sep)) {
    return undefined;
  }
  return pathWithinRoot.split(sep).join('/');
}

/** The URL the playground serves the stylesheet at `path` from, or null outside every root. */
export function stylesheetUrlFor(
  path: string,
  packages: StylePackages = stylePackages(),
): string | null {
  const real = existsSync(path) ? realpathSync(path) : path;
  const underStyles = within(packages.stylesRoot, real);
  if (underStyles !== undefined) return `/styles/${underStyles}`;
  for (const componentRoot of packages.componentRoots) {
    const underComponents = within(componentRoot, real);
    if (underComponents !== undefined) return `/components/${underComponents}`;
  }
  for (const stylePackage of packages.dependencies) {
    const underPackage = within(stylePackage.root, real);
    if (underPackage !== undefined) {
      return `/package-styles/${stylePackage.urlSegment}/${underPackage}`;
    }
  }
  return null;
}

/** The file `/package-styles/<urlSegment>/<path>` names, or null for an unknown package or path. */
export function packageStylesheetPath(
  urlSegment: string,
  path: string,
  packages: StylePackages = stylePackages(),
): string | null {
  const stylePackage = packages.dependencies.find(
    (candidate) => candidate.urlSegment === urlSegment,
  );
  return stylePackage === undefined ? null : resolveSafePath(stylePackage.root, path);
}

/** `@import '<specifier>'`, `@import "<specifier>"`, and `@import url('<specifier>')`. */
const IMPORT_RULE = /(@import\s+(?:url\(\s*)?)(['"])([^'"]+)\2/gu;

function isPackageSpecifier(specifier: string): boolean {
  return (
    !specifier.startsWith('.') &&
    !specifier.startsWith('/') &&
    !/^[a-z][a-z0-9+.-]*:/iu.test(specifier)
  );
}

/**
 * Rewrite every package-specifier `@import` in the stylesheet at `stylesheetPath` to the URL of
 * the file it resolves to, through the named package's `exports`, from the stylesheet's own
 * directory. Relative and absolute imports are left alone: they already resolve against the URL
 * the stylesheet is served at. A specifier that does not resolve, or resolves outside every style
 * package, is left as written.
 */
export function rewriteStylesheetPackageImports(
  css: string,
  stylesheetPath: string,
  packages: StylePackages = stylePackages(),
): string {
  return css.replace(IMPORT_RULE, (whole, lead: string, quote: string, specifier: string) => {
    if (!isPackageSpecifier(specifier)) return whole;
    let resolved: string;
    try {
      resolved = Bun.resolveSync(specifier, dirname(stylesheetPath));
    } catch {
      return whole;
    }
    const url = stylesheetUrlFor(resolved, packages);
    return url === null ? whole : `${lead}${quote}${url}${quote}`;
  });
}

/**
 * Every directory a served stylesheet may come from: core's styles and components roots, and each
 * style dependency's root. The traversal guard checks each request against the one root its route
 * names; this is the complete list, for the tests that prove a path outside every one is refused.
 */
export function allowedStylesheetRoots(packages: StylePackages = stylePackages()): string[] {
  return [
    packages.stylesRoot,
    ...packages.componentRoots,
    ...packages.dependencies.map((stylePackage) => stylePackage.root),
  ];
}
