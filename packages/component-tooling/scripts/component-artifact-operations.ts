/**
 * Reusable component artifact operations for schema, variables, and README files.
 *
 * Keep lightweight discovery imports pointed at `discover-component-directories.ts`.
 * This module intentionally imports the heavier schema, variable, README, and
 * formatter dependencies needed to generate or check per-component artifacts,
 * while the CLI entrypoint in `generate-component-artifacts.ts` stays thin.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import * as prettier from 'prettier';

import { assertPrettierResolvesToRoot } from './lib/prettier-resolution.ts';

import {
  CINDER_PACKAGE_ROOT,
  discoverComponentDirectories,
  type DiscoveredComponent,
} from './discover-component-directories.ts';
import { generateSchemaForComponent, type GenerateResult } from './generate-component-schema.ts';
import { generateVariablesForComponent } from './generate-component-variables.ts';
import { readComponentMetadata } from './lib/metadata-files.ts';
import { renderComponentReadme } from './render-component-readme.ts';

const COMPOSE_ONLY_ACCESSIBILITY_DOCUMENTATION_EXEMPTIONS = new Set([
  'accordion-item',
  'dropdown-group',
  'dropdown-item',
  'dropdown-label',
  'dropdown-menu',
  'dropdown-separator',
  'dropdown-trigger',
  'feed-event',
  'grid-list-item',
  'side-navigation-group',
  'side-navigation-item',
  'statistic',
  'tab',
  'tab-list',
  'tab-panel',
  'table-body',
  'table-cell',
  'table-header',
  'table-header-cell',
  'table-row',
  'tree-item',
]);

const prettierConfigurationCache = new Map<string, Promise<prettier.Options | null>>();

/**
 * Run prettier over generated content using the repo's prettier configuration.
 *
 * Failures are NOT swallowed. An earlier version returned `content` unformatted
 * on any error, so a formatter that failed to load -- or a version that could not
 * parse a generated file -- produced artifacts that `components:check` flagged as
 * drifted with no hint of the actual cause. A formatting error now names the file
 * and where prettier was resolved from.
 */
export async function formatGenerated(content: string, filepath: string): Promise<string> {
  assertPrettierResolvesToRoot();
  try {
    let optionsPromise = prettierConfigurationCache.get(filepath);
    if (!optionsPromise) {
      optionsPromise = prettier.resolveConfig(filepath);
      prettierConfigurationCache.set(filepath, optionsPromise);
    }
    const options = await optionsPromise;
    return await prettier.format(content, { ...options, filepath });
  } catch (error) {
    // The underlying message rides in the string as well as in `cause`:
    // `components:check` catches stage-1 failures and logs only `err.message`,
    // so a parser error would otherwise be lost from CI output.
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `formatGenerated: prettier ${prettier.version} (${import.meta.resolve('prettier')}) ` +
        `failed to format ${filepath}: ${reason}`,
      { cause: error },
    );
  }
}

/** What the generators derive for one component: its schema, its variables, and its README. */
export interface ComponentArtifacts {
  component: DiscoveredComponent;
  /** The JSON Schema of its props, as the `metadata` task writes it. */
  schema: GenerateResult['schema'];
  /** The custom properties it declares, as the `metadata` task writes them. */
  variables: readonly string[];
  /** The committed README with its generated regions rewritten, formatted; null without one. */
  readme: string | null;
}

export async function generateArtifactsForComponent(
  component: DiscoveredComponent,
): Promise<ComponentArtifacts> {
  const { directory, name } = component;
  const typesFilePath = join(directory, `${name}.types.ts`);

  const schema = generateSchemaForComponent({ typesFilePath, componentName: name });
  const variables = await generateVariablesForComponent({
    componentDirectory: directory,
    componentName: name,
  });

  return {
    component,
    schema: schema.schema,
    variables: variables.variables,
    readme: await renderReadme(component, schema.schema, variables.variables),
  };
}

/** The component's README with its generated regions rendered from `schema` and `variables`. */
export async function renderReadme(
  component: DiscoveredComponent,
  schema: GenerateResult['schema'],
  variables: readonly string[],
): Promise<string | null> {
  const readmePath = join(component.directory, 'README.md');
  if (!existsSync(readmePath)) return null;
  const existing = await Bun.file(readmePath).text();
  const readme = renderComponentReadme({ existingReadme: existing, schema, variables });
  return formatGenerated(readme, readmePath);
}

/** Write a component's README regions; the schema and variables go to `.metadata/` instead. */
export async function writeReadme(artifacts: ComponentArtifacts): Promise<boolean> {
  if (artifacts.readme === null) return false;
  const path = join(artifacts.component.directory, 'README.md');
  if ((await Bun.file(path).text()) === artifacts.readme) return false;
  await Bun.write(path, artifacts.readme);
  return true;
}

export interface DriftIssue {
  component: string;
  file: string;
  reason: 'missing' | 'stale';
}

/**
 * The committed files a component package must hold, checked against what the `metadata` task
 * derived: each README's generated regions (rendered from `.metadata/<id>/schema.json` and
 * `variables.json`), and the README and accessibility review every component ships.
 */
export async function checkComponentArtifacts(
  packageRoot: string = CINDER_PACKAGE_ROOT,
): Promise<DriftIssue[]> {
  const components = await discoverComponentDirectories(packageRoot);
  const issues: DriftIssue[] = [];
  for (const component of components) {
    if (!existsSync(join(component.directory, 'README.md'))) {
      issues.push({ component: component.name, file: 'README.md', reason: 'missing' });
    }
    if (
      !COMPOSE_ONLY_ACCESSIBILITY_DOCUMENTATION_EXEMPTIONS.has(component.name) &&
      !existsSync(join(component.directory, `${component.name}.a11y.md`))
    ) {
      issues.push({
        component: component.name,
        file: `${component.name}.a11y.md`,
        reason: 'missing',
      });
    }
    const schema = readComponentMetadata<GenerateResult['schema']>(
      packageRoot,
      component.name,
      'schema',
    );
    const variables = readComponentMetadata<string[]>(packageRoot, component.name, 'variables');
    const expected = await renderReadme(component, schema, variables);
    if (expected === null) continue;
    const actual = await Bun.file(join(component.directory, 'README.md')).text();
    if (actual !== expected) {
      issues.push({ component: component.name, file: 'README.md', reason: 'stale' });
    }
  }
  return issues;
}
