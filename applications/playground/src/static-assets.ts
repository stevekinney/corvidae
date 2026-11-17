import {
  CINDER_COMPONENT_SOURCE,
  cinderComponentStylesheetUrlFor,
  componentRoots,
  componentSourceById,
} from './component-sources.ts';
import {
  buildPlaygroundStylesheet,
  type PlaygroundStylesheetName,
} from './documentation-styles.ts';
import { notFound } from './http-responses.ts';
import {
  packageStylesheetPath,
  rewriteStylesheetPackageImports,
  stylePackages,
} from './package-stylesheets.ts';
import { resolveSafePath } from './traversal-guard.ts';

/** Where the entry stylesheet is served: beside the files its relative `@import`s name. */
const STYLES_ENTRY_PATH = '/styles/index.css';

/**
 * GET /styles.css → 307 to /styles/index.css
 *
 * The entry stylesheet imports `./tokens.css`, `./foundation.css`, and
 * `./components/*.css`, which a browser resolves against the stylesheet's own
 * URL. Served at `/styles.css`, that base is `/`, so every import landed on a
 * path the server does not expose (`/tokens.css`) and 404ed. A redirect makes
 * the final URL `/styles/index.css`, where the imports resolve into the
 * `/styles/*` tree below. Temporary (307), not permanent, so a browser never
 * caches the alias.
 */
export function handleStylesEntryRoute(): Response {
  return new Response(null, { status: 307, headers: { Location: STYLES_ENTRY_PATH } });
}

/**
 * Serve one stylesheet file: 404 when it is absent, and every package-specifier `@import` in it
 * rewritten to the URL of the file the specifier resolves to (`package-stylesheets.ts`), so a
 * browser can follow an import of another package's stylesheet.
 */
async function stylesheetResponse(cssPath: string | null, relative: string): Promise<Response> {
  if (cssPath === null) return notFound();
  const cssFile = Bun.file(cssPath);
  if (!(await cssFile.exists())) return notFound(`${relative} not found`);
  const css = rewriteStylesheetPackageImports(await cssFile.text(), cssPath);
  return new Response(css, { headers: { 'Content-Type': 'text/css' } });
}

/**
 * GET /styles/<path>.css → core's src/styles/<path>.css
 *
 * The component-library's index.css uses `@import './tokens.css'` etc. which
 * the browser resolves relative to the served URL — so we need to serve the
 * full styles/ tree, not just the entry file. `relative` is the path after
 * `/styles/`.
 */
export async function handleStylesRoute(relative: string): Promise<Response> {
  // Require an actual .css filename. Without this, `GET /styles/` resolves
  // to the styles directory itself, and Bun.file(dir).text() throws a 500.
  if (relative === '' || !relative.endsWith('.css')) return notFound();
  return stylesheetResponse(resolveSafePath(stylePackages().stylesRoot, relative), relative);
}

/** GET /playground-styles/:name.css → one bundled, route-scoped stylesheet. */
export async function handlePlaygroundStylesRoute(
  name: PlaygroundStylesheetName,
): Promise<Response> {
  return new Response(await buildPlaygroundStylesheet(name), {
    headers: { 'Content-Type': 'text/css' },
  });
}

/**
 * GET /components/<path>.css → core's own components root, <path>.css
 *
 * After the per-directory layout migration, each component owns its CSS at
 * `<name>/<name>.css` in core's components root. The styles aggregator at
 * `src/styles/components.css` imports those via `@import '../components/<name>/<name>.css'`,
 * which the browser resolves relative to the served URL — landing on
 * `/components/<name>/<name>.css`. Serve them from disk here so the
 * resolved relative paths actually reach the right file. A component in a
 * family package is served at `/package-styles/<family>/…` instead.
 */
export async function handleComponentsStyleRoute(relative: string): Promise<Response> {
  for (const componentRoot of stylePackages().componentRoots) {
    const cssPath = resolveSafePath(componentRoot, relative);
    if (cssPath === null) return notFound();
    if (await Bun.file(cssPath).exists()) return stylesheetResponse(cssPath, relative);
  }
  return notFound(`${relative} not found`);
}

/**
 * GET /package-styles/<package>/<path>.css → a style package's file, <path> inside it
 *
 * A style package is one of core's `workspace:` dependencies whose `exports` name a stylesheet:
 * the tokens, the foundation, and each family. `<package>` is its name without the scope. Only
 * the packages core depends on are reachable, and only inside their own directories.
 */
export async function handlePackageStylesRoute(
  packageName: string,
  relative: string,
): Promise<Response> {
  if (relative === '' || !relative.endsWith('.css')) return notFound();
  return stylesheetResponse(packageStylesheetPath(packageName, relative), relative);
}

const CINDER_COMPONENT_STYLE_IMPORT =
  /(['"])@lostgradient\/cinder\/([a-z0-9][a-z0-9-]*)\/styles\1/gu;

/**
 * Resolve peer-package style imports (`@lostgradient/cinder/<component>/styles`) to the URL of
 * that Cinder component's stylesheet, wherever core's manifest says the component lives.
 */
export function rewritePackageComponentStyleImports(css: string): string {
  return css.replace(
    CINDER_COMPONENT_STYLE_IMPORT,
    (_match, quote: string, componentName: string) => {
      const location = CINDER_COMPONENT_SOURCE.components().get(componentName);
      if (location === undefined) {
        return `${quote}/components/${componentName}/${componentName}.css${quote}`;
      }
      const url = cinderComponentStylesheetUrlFor(
        location,
        `${location.directory}/${componentName}.css`,
      );
      return `${quote}${url}${quote}`;
    },
  );
}

/**
 * GET /package-components/:source/<path>.css → extracted package component CSS.
 *
 * The source id comes from component-sources.ts; preserving the component
 * directory shape keeps relative CSS imports working for future packages.
 */
export async function handlePackageComponentStyleRoute(
  sourceId: string,
  relative: string,
): Promise<Response> {
  const componentSource = componentSourceById(sourceId);
  if (componentSource === undefined) return notFound();

  // A package's components share one components root (chat's and editor's `src/lib/components`).
  for (const componentRoot of componentRoots(componentSource)) {
    const cssPath = resolveSafePath(componentRoot, relative);
    if (cssPath === null) return notFound();
    const cssFile = Bun.file(cssPath);
    if (!(await cssFile.exists())) continue;
    return new Response(rewritePackageComponentStyleImports(await cssFile.text()), {
      headers: { 'Content-Type': 'text/css' },
    });
  }
  return notFound(`${relative} not found`);
}
