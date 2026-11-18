import { readFileSync } from 'node:fs';

/**
 * The files every component package's `browser/` suite is made of (COR-2080, COR-2092), written by
 * `move-browser-specs.ts` and checked by `place-browser-specs.ts --check`. They are the same in
 * every package: the harness and the Playwright configuration find the package's own directory, and
 * every package serves the same fixture page with Cinder core's `browser/host.ts`.
 */

/** `browser/harness.ts`: `prepare`, `build` and `serve --port <port>`. */
export const HARNESS_SOURCE = `/**
 * This package's browser suite (COR-2080, COR-2092): \`bun browser/harness.ts prepare\` writes the
 * fixture manifest and the slugs the package owns, \`build\` bundles the fixture page every package
 * serves, and \`serve --port <port>\`, which \`playwright.config.ts\` starts, builds and serves it.
 */
import { repositoryPackageSuite } from '@lostgradient/testing/browser/package-suite';

export const suite = await repositoryPackageSuite(import.meta.dirname);

if (import.meta.main) await suite.main(Bun.argv.slice(2));
`;

/** A browser project besides Chromium, run only by the package's `test:browser:engines`. */
export type EngineProject = {
  name: string;
  device: 'Desktop Firefox' | 'Desktop Safari';
  testMatch: string;
  testIgnore?: string;
};

/** `browser/playwright.config.ts`, with the package's opt-in Firefox and WebKit projects. */
export function playwrightConfigSource(projects: readonly EngineProject[] = []): string {
  const lines = [
    "import { packageSuiteConfiguration } from '@lostgradient/testing/browser/playwright-configuration';",
  ];
  if (projects.length === 0) {
    lines.push('', 'export default packageSuiteConfiguration({ root: import.meta.dirname });', '');
    return lines.join('\n');
  }
  lines.push("import { devices } from '@playwright/test';", '');
  lines.push(
    '// Chromium is the gate; the other engines run only through `test:browser:engines`.',
    'export default packageSuiteConfiguration({',
    '  root: import.meta.dirname,',
    '  projects: [',
  );
  for (const project of projects) {
    lines.push('    {');
    lines.push(`      name: ${JSON.stringify(project.name)},`);
    lines.push(`      testMatch: ${JSON.stringify(project.testMatch)},`);
    if (project.testIgnore !== undefined) {
      lines.push(`      testIgnore: ${JSON.stringify(project.testIgnore)},`);
    }
    lines.push(`      use: { ...devices[${JSON.stringify(project.device)}] },`);
    lines.push('    },');
  }
  lines.push('  ],', '});', '');
  return lines.join('\n');
}

/** `browser/tests/components.playwright.ts` for a package whose sweep is all it holds there. */
export const SWEEP_SOURCE = `/**
 * The component sweep of every fixture this package owns (COR-2092): both themes, every viewport,
 * a screenshot against the package's own browser snapshots and the accessibility gate.
 */
import { defineComponentSweep } from '@lostgradient/testing/playwright/component-sweep-suite';

defineComponentSweep();
`;

/** The package scripts a browser suite adds (`createPackage` and the move write them). */
export const BROWSER_SCRIPTS = {
  'test:browser':
    'bun browser/harness.ts prepare && bun ../../scripts/host-slots.ts --slots=4 -- bun --bun playwright test --config browser/playwright.config.ts --project=chromium --workers=4',
} as const;

/** The script that runs a package's Firefox and WebKit projects, outside every gate. */
export const ENGINES_SCRIPT =
  'bun browser/harness.ts prepare && bun ../../scripts/host-slots.ts --slots=4 -- bun --bun playwright test --config browser/playwright.config.ts --workers=4';

/** The root manifest's dependency catalog (`catalog`, or `workspaces.catalog`). */
export function rootCatalog(repositoryRoot: string): Record<string, string> {
  const manifest = JSON.parse(readFileSync(`${repositoryRoot}/package.json`, 'utf8')) as {
    catalog?: Record<string, string>;
    workspaces?: { catalog?: Record<string, string> } | string[];
  };
  const workspaces = Array.isArray(manifest.workspaces) ? undefined : manifest.workspaces;
  return manifest.catalog ?? workspaces?.catalog ?? {};
}

type Manifest = {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

const SPECIFIER = /(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)(['"])([^'"\n]+)\1/g;

/** The package a module specifier names, or undefined for a relative or built-in one. */
function packageOf(specifier: string): string | undefined {
  if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.includes(':')) {
    return undefined;
  }
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

/** The packages the files under a package's `browser/` directory import, `@playwright/test` too. */
export function browserImports(packageDirectory: string): Set<string> {
  const imports = new Set(['@playwright/test']);
  const directory = `${packageDirectory}/browser`;
  for (const file of new Bun.Glob('**/*.{ts,svelte}').scanSync({ cwd: directory, dot: false })) {
    if (file.startsWith('.playwright/')) continue;
    const text = readFileSync(`${directory}/${file}`, 'utf8');
    for (const match of text.matchAll(SPECIFIER)) {
      const name = packageOf(match[2] ?? '');
      if (name !== undefined) imports.add(name);
    }
  }
  return imports;
}

/**
 * A package manifest with its browser suite: the `test:browser` script (and `test:browser:engines`
 * when its configuration has another engine), `browser` among the directories its lint reads, and
 * a development dependency on every package its browser files import that it does not already
 * depend on. `catalog` is the root catalog; a workspace package is `workspace:*`.
 */
export function withBrowserSuite<M extends Manifest>(
  manifest: M,
  options: {
    packageName: string;
    imports: ReadonlySet<string>;
    catalog: Readonly<Record<string, string>>;
    engines: boolean;
  },
): M {
  const scripts = { ...manifest.scripts };
  scripts['test:browser'] = BROWSER_SCRIPTS['test:browser'];
  if (options.engines && scripts['test:browser:engines'] === undefined) {
    scripts['test:browser:engines'] = ENGINES_SCRIPT;
  }
  for (const name of ['lint', 'lint:fix']) {
    const command = scripts[name];
    if (command === undefined) continue;
    scripts[name] = command.replace(
      /^(oxlint (?:--[\w-]+(?: \.\/[\w.]+)? )+)([^&]*?)(\s*(?:&&|$))/,
      (whole, head: string, directories: string, tail: string) =>
        directories.split(/\s+/).includes('browser')
          ? whole
          : `${head}${directories.trimEnd()} browser${tail}`,
    );
  }
  const devDependencies = { ...manifest.devDependencies };
  for (const name of options.imports) {
    if (name === options.packageName || manifest.dependencies?.[name] !== undefined) continue;
    if (devDependencies[name] !== undefined) continue;
    if (Object.hasOwn(options.catalog, name)) devDependencies[name] = 'catalog:';
    else if (name.startsWith('@lostgradient/')) devDependencies[name] = 'workspace:*';
    else if (!['bun', 'svelte'].includes(name)) {
      throw new Error(
        `${options.packageName}'s browser files import ${name}, which the catalog lacks.`,
      );
    }
  }
  const sorted = Object.fromEntries(
    Object.entries(devDependencies).toSorted(([left], [right]) => left.localeCompare(right)),
  );
  return { ...manifest, scripts, devDependencies: sorted };
}
