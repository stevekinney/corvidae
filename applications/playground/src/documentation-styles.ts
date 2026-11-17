import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';

import { coordinatedBuild } from './build-artifacts-shared.ts';
import {
  CINDER_COMPONENT_SOURCE,
  componentDirectory,
  DOCUMENTATION_CINDER_COMPONENTS,
  LANDING_CINDER_COMPONENTS,
} from './component-sources.ts';
import { stylePackages } from './package-stylesheets.ts';

export { DOCUMENTATION_CINDER_COMPONENTS, LANDING_CINDER_COMPONENTS } from './component-sources.ts';

/**
 * Cinder primitives rendered by the documentation chrome and its colour-token
 * panel. Their styles are bundled once for every documentation route; the
 * documented component and its example dependencies are added separately.
 */
export type PlaygroundStylesheetName = 'documentation' | 'landing';

const componentsByStylesheet: Readonly<Record<PlaygroundStylesheetName, readonly string[]>> = {
  documentation: DOCUMENTATION_CINDER_COMPONENTS,
  landing: LANDING_CINDER_COMPONENTS,
};
const stylesheetPromiseByName = new Map<PlaygroundStylesheetName, Promise<string>>();

function formatBuildLogs(logs: readonly { message: string }[]): string {
  return logs.map(({ message }) => message).join('\n');
}

/** Drop cached styles after a source invalidation so live reload serves fresh CSS. */
export function resetPlaygroundStylesheetBuilds(): void {
  stylesheetPromiseByName.clear();
}

/**
 * The virtual entrypoint lives in core's directory (COR-2083): every stylesheet it names resolves
 * from there, a component's own from wherever core's manifest says the component lives (core or a
 * family package), and a package specifier any of them imports through the package that names it.
 */
function stylesheetImportPath(path: string): string {
  const importPath = relative(CINDER_COMPONENT_SOURCE.packageRoot, path).replaceAll('\\', '/');
  return importPath.startsWith('.') ? importPath : `./${importPath}`;
}

/**
 * A stylesheet of Cinder's `src/styles/`: core's own, or the one a package core depends on holds
 * since the split moved it there (P-COR-101).
 */
function cinderStylesheet(name: string): string {
  const { core, dependencies } = stylePackages();
  const candidates = [core, ...dependencies].map(({ root }) => join(root, 'src', 'styles', name));
  return candidates.find((path) => existsSync(path)) ?? (candidates[0] as string);
}

function stylesheetEntry(components: readonly string[]): string {
  const cinderStylesRoot = join(CINDER_COMPONENT_SOURCE.packageRoot, 'src', 'styles');
  const imports = components
    .map(
      (componentName) =>
        `@import '${stylesheetImportPath(
          join(componentDirectory(CINDER_COMPONENT_SOURCE, componentName), `${componentName}.css`),
        )}';`,
    )
    .join('\n');
  return `@import '${stylesheetImportPath(join(cinderStylesRoot, 'index.css'))}';
@import '${stylesheetImportPath(cinderStylesheet('json-highlight.css'))}';
${imports}
`;
}

/** Bundle the documentation CSS graph so each page needs one shared stylesheet. */
export function buildPlaygroundStylesheet(name: PlaygroundStylesheetName): Promise<string> {
  const existing = stylesheetPromiseByName.get(name);
  if (existing !== undefined) return existing;

  const stylesheetPromise = (async () => {
    // Bun caches a virtual build by its entrypoint path. Keep that path unique
    // per stylesheet or a landing request can receive the documentation graph.
    // It sits in core's directory; nothing is written there.
    const virtualEntrypoint = join(
      CINDER_COMPONENT_SOURCE.packageRoot,
      `.playground-${name}-styles.css`,
    );
    const result = await coordinatedBuild(() =>
      Bun.build({
        entrypoints: [virtualEntrypoint],
        files: { [virtualEntrypoint]: stylesheetEntry(componentsByStylesheet[name]) },
        minify: true,
        target: 'browser',
      }),
    );
    if (!result.success) {
      throw new Error(
        `[playground] ${name} stylesheet build failed:\n${formatBuildLogs(result.logs)}`,
      );
    }
    const stylesheet = result.outputs.find((output) => output.path.endsWith('.css'));
    if (stylesheet === undefined) {
      throw new Error('[playground] documentation stylesheet build produced no CSS output');
    }
    return await stylesheet.text();
  })().catch((error: unknown) => {
    stylesheetPromiseByName.delete(name);
    throw error;
  });
  stylesheetPromiseByName.set(name, stylesheetPromise);
  return stylesheetPromise;
}

/** Bundle the shared documentation CSS graph. */
export function buildDocumentationStylesheet(): Promise<string> {
  return buildPlaygroundStylesheet('documentation');
}

/** Bundle the landing CSS graph without unrelated documentation primitives. */
export function buildLandingStylesheet(): Promise<string> {
  return buildPlaygroundStylesheet('landing');
}
