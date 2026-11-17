/**
 * Builds a component package's `components.json`, the machine-readable index of its public
 * components, which the `metadata` task writes to `.metadata/components.json` and the package
 * exports as `./manifest`.
 *
 * The generator fails loudly when any component's `<name>.meta.json` is missing or invalid — a
 * partial manifest is never written to disk. `hasExamples` and `hasConstraints` follow the
 * authored `<name>.examples.json` and `<name>.constraints.json` on disk.
 */

import { existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

import Ajv from 'ajv/dist/2020.js';

import type { CategoryId, StatusLevel } from '../src/manifest.meta.ts';
import { categories, overlapFamilies, statusLevels } from '../src/manifest.meta.ts';
import { discoverComponentEnhancements } from './lib/component-enhancements.ts';
import type { A11yMetadata, AvoidWhenEntry, ComponentMetadata } from './lib/component-meta.ts';
import { extractAllComponentMetadata } from './lib/component-meta.ts';
import {
  componentPackage,
  packageRelative,
  type ComponentPackage,
} from './lib/component-package.ts';
import { componentMetadataPath, manifestMetadataPath } from './lib/metadata-files.ts';
import { parseJsonFile, readJsonFile } from './lib/read-json-file.ts';
import { readTokenNamespaces } from './token-namespaces.ts';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A single entry in `components.json#components`. */
export type ManifestComponent = {
  /** PascalCase name for use in prose and documentation. Equals `exportName`. */
  name: string;
  /** Kebab-case canonical identifier, matching the component directory name. */
  id: string;
  /**
   * Import specifier consumers use. E.g. `"@lostgradient/cinder"`.
   */
  import: string;
  /** PascalCase named export the component ships under. */
  exportName: string;
  /** Category identifier from the closed set in `manifest.meta.ts`. */
  category: CategoryId;
  /** Status identifier from the closed set in `manifest.meta.ts`. */
  status: StatusLevel;
  /** One-sentence description of what this component is for. */
  purpose: string;
  /** Free-form classification tags. */
  tags: string[];
  /** When to prefer this component over similar alternatives. */
  useWhen: string[];
  /** When NOT to use this component, each with an optional alternative component id. */
  avoidWhen: AvoidWhenEntry[];
  /** Kebab-case ids of related components. */
  related: string[];
  /** Accessibility metadata, present only when a11y tags were authored. */
  a11y?: A11yMetadata;
  /**
   * True when the component directory contains a `{id}.constraints.json` file.
   * The constraints sidecar is read by local component tooling.
   */
  hasConstraints: boolean;
  /**
   * True when the component has a committed examples sidecar. The sidecar is
   * read by local component tooling.
   */
  hasExamples: boolean;
  /** Package-relative paths for local machine-readable artifacts. */
  artifacts: {
    schema: string;
    variables: string;
    examples?: string;
    constraints?: string;
    enhancement?: string;
  };
};

/** The full shape of `components.json`. */
export type Manifest = {
  $schema: string;
  manifestVersion: 1;
  package: {
    name: string;
    framework: 'svelte';
    frameworkVersionRange: string;
    classPrefix: string;
    cssVarPrefix: string;
    tokenNamespaces: string[];
    stylesEntry: string;
    schemaDialect: string;
  };
  categories: Record<CategoryId, { label: string; description: string }>;
  statusLevels: Record<StatusLevel, string>;
  overlapFamilies: Record<string, readonly string[]>;
  components: ManifestComponent[];
};

// ---------------------------------------------------------------------------
// Filesystem roots (resolved relative to this script)
// ---------------------------------------------------------------------------

const PACKAGE_ROOT = join(import.meta.dir, '..');
const COMPONENTS_ROOT = join(PACKAGE_ROOT, 'src', 'components');

/** Every package's manifest validates against Cinder's manifest schema. */
const SCHEMA_PATH = join(PACKAGE_ROOT, 'src', 'schemas', 'manifest.schema.json');

/** Where the `metadata` task writes a package's `components.json`. */
export function manifestPathOf(pkg: ComponentPackage): string {
  return manifestMetadataPath(pkg.root);
}

/**
 * The `$schema` a package's manifest names, relative to the manifest in `.metadata/`: the
 * package's own copy of the manifest schema, or Cinder's.
 */
function manifestSchemaReference(pkg: ComponentPackage): string {
  const from = dirname(manifestPathOf(pkg));
  for (const candidate of [
    join(pkg.root, 'src', 'schemas', 'manifest.schema.json'),
    join(pkg.root, 'src', 'lib', 'schemas', 'manifest.schema.json'),
    SCHEMA_PATH,
  ]) {
    if (existsSync(candidate)) return relative(from, candidate).split('\\').join('/');
  }
  return relative(from, SCHEMA_PATH);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert a kebab-case component id to PascalCase.
 * "button-group" → "ButtonGroup"
 */
function kebabToPascal(id: string): string {
  return id
    .split('-')
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join('');
}

/**
 * Check whether the committed examples artifact exists on disk for a
 * component. We base the manifest flag on the artifact's presence so the
 * manifest cannot advertise an artifact that is absent from the package.
 */
function hasExamplesArtifact(pkg: ComponentPackage, id: string): boolean {
  return existsSync(join(pkg.componentsRoot, id, `${id}.examples.json`));
}

/**
 * Check whether the generated constraints artifact exists on disk. We base
 * the manifest flag on the artifact, not the source sidecar, for the same
 * reason as `hasExamplesArtifact`.
 */
function hasConstraintsArtifact(pkg: ComponentPackage, id: string): boolean {
  return existsSync(join(pkg.componentsRoot, id, `${id}.constraints.json`));
}

/**
 * Package-relative paths of a component's machine-readable files: the derived schema, variables
 * and examples copy in `.metadata/<id>/`, the authored constraints and enhancement beside the
 * component.
 */
function artifactPath(
  id: string,
  suffix: string,
  pkg: ComponentPackage = componentPackage(),
): string {
  if (suffix === 'schema' || suffix === 'variables' || suffix === 'examples') {
    return packageRelative(pkg, componentMetadataPath(pkg.root, id, suffix));
  }
  const filename = suffix === 'enhancement' ? `${id}-enhancement.ts` : `${id}.${suffix}.json`;
  return packageRelative(pkg, join(pkg.componentsRoot, id, filename));
}

/** Return the manifest subpath when this component owns a runtime enhancement. */
export function enhancementArtifactPath(
  id: string,
  componentsRoot: string = COMPONENTS_ROOT,
): string | undefined {
  const enhancement = discoverComponentEnhancements([{ name: id }], componentsRoot)[0];
  // Only Cinder ships enhancements, and its manifest names them by their package path.
  return enhancement === undefined ? undefined : `src/components/${id}/${id}-enhancement.ts`;
}

// ---------------------------------------------------------------------------
// Core builder
// ---------------------------------------------------------------------------

/**
 * Build the manifest from all discovered component metadata.
 *
 * Throws when:
 * - any component's `<name>.meta.json` is missing or invalid (a partial manifest is never
 *   emitted — callers must fix the metadata first).
 * - The produced manifest fails validation against `manifest.schema.json`.
 */
/**
 * Format an extraction-errors list into the human-readable message that
 * `buildManifest()` throws when annotations are incomplete.
 *
 * Exported separately from `buildManifest()` so tests can exercise the
 * "fail loudly" path without mocking the extractor — mocking entire modules
 * with `mock.module()` leaks across files in a single `bun test` run and
 * breaks unrelated suites.
 */
export function formatExtractionErrorMessage(
  errors: ReadonlyArray<{ componentId: string; reason: string }>,
): string {
  const shown = errors.slice(0, 10);
  const lines = shown.map((e) => `  [${e.componentId}] ${e.reason}`);
  const tail =
    errors.length > 10
      ? `  … and ${errors.length - 10} more errors (${errors.length} total)`
      : `  (${errors.length} error${errors.length === 1 ? '' : 's'} total)`;
  return `Cannot build manifest — ${errors.length} component${errors.length === 1 ? '' : 's'} have extraction errors:\n${lines.join('\n')}\n${tail}\n\nFix every component's <name>.meta.json before generating the manifest.`;
}

/** One dangling `avoidWhen.alternative`: the owning component and the bad id. */
export type DanglingAlternative = { componentId: string; alternative: string };

/**
 * Find every `avoidWhen.alternative` that does not resolve to a real component
 * id in the set. The page renders an alternative as a `/c/<id>` link, so a
 * dangling id would ship a dead link — the generator fails on any hit.
 *
 * Exported (like {@link formatExtractionErrorMessage}) so the referential-
 * integrity check is unit-testable without reading the filesystem.
 */
export function findDanglingAlternatives(
  components: ReadonlyArray<Pick<ManifestComponent, 'id' | 'avoidWhen'>>,
): DanglingAlternative[] {
  const componentIds = new Set(components.map((entry) => entry.id));
  const dangling: DanglingAlternative[] = [];
  for (const entry of components) {
    for (const guidance of entry.avoidWhen) {
      if (guidance.alternative !== undefined && !componentIds.has(guidance.alternative)) {
        dangling.push({ componentId: entry.id, alternative: guidance.alternative });
      }
    }
  }
  return dangling;
}

/** Format the dangling-alternative failure message thrown by `buildManifest`. */
export function formatDanglingAlternativeMessage(dangling: DanglingAlternative[]): string {
  const lines = dangling.map(
    (d) => `  [${d.componentId}] avoidWhen alternative '${d.alternative}'`,
  );
  return `Cannot build manifest — ${dangling.length} @avoidWhen alternative(s) do not match any component id:\n${lines.join('\n')}\n\nUse the kebab-case id of an existing component, or drop the ' | <id>' suffix.`;
}

export async function buildManifest(packageRoot: string = PACKAGE_ROOT): Promise<Manifest> {
  const pkg = componentPackage(packageRoot);
  // 1. Read every component's `<name>.meta.json`, in the manifest's id order.
  const { metadata, errors } = await extractAllComponentMetadata(pkg.root);

  if (errors.length > 0) {
    throw new Error(formatExtractionErrorMessage(errors));
  }

  // The internal library uses the same framework version as the root catalog.
  const rootPackage = await readJsonFile<{ catalog: { svelte: string } }>(
    join(PACKAGE_ROOT, '..', '..', 'package.json'),
  );
  const frameworkVersionRange = rootPackage.catalog.svelte;

  // 3. Build per-component entries in parallel.
  const componentEntries = await Promise.all(
    metadata.map(async (meta: ComponentMetadata): Promise<ManifestComponent> => {
      const exportName = kebabToPascal(meta.id);
      const hasExamplesFlag = hasExamplesArtifact(pkg, meta.id);
      const hasConstraintsFlag = hasConstraintsArtifact(pkg, meta.id);

      const artifacts: ManifestComponent['artifacts'] = {
        schema: artifactPath(meta.id, 'schema', pkg),
        variables: artifactPath(meta.id, 'variables', pkg),
      };

      if (hasExamplesFlag) {
        artifacts.examples = artifactPath(meta.id, 'examples', pkg);
      }
      if (hasConstraintsFlag) {
        artifacts.constraints = artifactPath(meta.id, 'constraints', pkg);
      }
      const enhancementArtifact = pkg.isCinder ? enhancementArtifactPath(meta.id) : undefined;
      if (enhancementArtifact !== undefined) {
        artifacts.enhancement = enhancementArtifact;
      }

      return {
        name: exportName,
        id: meta.id,
        import: pkg.name,
        exportName,
        category: meta.category,
        status: meta.status,
        purpose: meta.purpose,
        tags: meta.tags,
        useWhen: meta.useWhen,
        avoidWhen: meta.avoidWhen,
        related: meta.related,
        hasConstraints: hasConstraintsFlag,
        hasExamples: hasExamplesFlag,
        artifacts,
        ...(meta.a11y !== undefined ? { a11y: meta.a11y } : {}),
      };
    }),
  );

  // 4. The metadata is already sorted alphabetically (matching
  //    discoverComponents). No re-sorting needed here.

  // 4a. Cross-check every `avoidWhen.alternative` resolves to a real component
  //     id. The page renders the alternative as a `/c/<id>` link, so a dangling
  //     id would ship a dead link — fail generation instead.
  const danglingAlternatives = findDanglingAlternatives(componentEntries);
  if (danglingAlternatives.length > 0) {
    throw new Error(formatDanglingAlternativeMessage(danglingAlternatives));
  }

  // 5. Assemble the manifest.
  const manifest: Manifest = {
    $schema: manifestSchemaReference(pkg),
    manifestVersion: 1,
    package: {
      name: pkg.name,
      framework: 'svelte',
      frameworkVersionRange,
      classPrefix: 'cinder-',
      cssVarPrefix: '--cinder-',
      // Derived from the generated registry rather than hand-listed: this array
      // ships in components.json, and the hand-written version advertised
      // `color` -- a namespace CIN-33 deleted -- alongside names that had
      // drifted from the corpus.
      tokenNamespaces: readTokenNamespaces(),
      stylesEntry: '@lostgradient/cinder',
      schemaDialect: 'https://json-schema.org/draft/2020-12/schema',
    },
    categories,
    statusLevels,
    // The overlap families name Cinder's own components.
    overlapFamilies: pkg.isCinder ? overlapFamilies : {},
    components: componentEntries,
  };

  // 6. Validate the manifest against manifest.schema.json before returning.
  const schemaText = await Bun.file(SCHEMA_PATH).text();
  const schema = parseJsonFile<object>(schemaText);

  const ajv = new Ajv({ strict: false });
  const validate = ajv.compile(schema);
  const valid = validate(manifest);

  if (!valid) {
    const validationErrors = (validate.errors ?? [])
      .map((e) => `  ${e.instancePath || '(root)'}: ${e.message ?? 'unknown error'}`)
      .join('\n');
    throw new Error(`Generated manifest failed schema validation:\n${validationErrors}`);
  }

  return manifest;
}

/**
 * The `components.json` of a package (cinder by default), as the `metadata` task writes it into
 * `.metadata/`: plain `JSON.stringify` output, with no Prettier pass, since nothing commits it.
 */
export async function renderManifest(packageRoot: string = PACKAGE_ROOT): Promise<string> {
  const manifest = await buildManifest(packageRoot);
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/**
 * Build the manifest and write it to the package's `.metadata/components.json`.
 * Throws if extraction errors exist (never writes a partial manifest).
 */
export async function writeManifest(packageRoot: string = PACKAGE_ROOT): Promise<void> {
  const content = await renderManifest(packageRoot);
  await Bun.write(manifestPathOf(componentPackage(packageRoot)), content);
}

if (import.meta.main) {
  try {
    await writeManifest();
    process.stdout.write('manifest:generate — wrote .metadata/components.json\n');
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`manifest:generate — failed:\n${message}\n`);
    process.exit(1);
  }
}
