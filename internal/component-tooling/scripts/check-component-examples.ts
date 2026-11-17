/** Validate committed component example metadata and its manifest relationship. */

import { readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';

import Ajv, { type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';

import { cinderComponentRoots, CORE_PACKAGE } from './discover-component-directories.ts';
import type { Manifest } from './generate-manifest.ts';
import {
  componentPackage,
  packageRelative,
  type ComponentPackage,
} from './lib/component-package.ts';
import { componentMetadataPath, manifestMetadataPath } from './lib/metadata-files.ts';
import { readJsonFile } from './lib/read-json-file.ts';

/** Every package's examples validate against Cinder's examples schema. */
const SCHEMA_PATH = join(import.meta.dir, '..', 'src', 'schemas', 'examples.schema.json');

/**
 * The package `checkCommittedExamples` is checking (cinder unless it was given another root). The
 * check runs one package at a time, so the helpers below read it instead of threading it through.
 */
let active: ComponentPackage = componentPackage();
let PACKAGE_ROOT = active.root;
let COMPONENTS_ROOT = active.componentsRoot;
let MANIFEST_PATH = manifestMetadataPath(PACKAGE_ROOT);
let PUBLIC_ROOT_IMPORT = active.name;

function activate(pkg: ComponentPackage): void {
  active = pkg;
  PACKAGE_ROOT = pkg.root;
  COMPONENTS_ROOT = pkg.componentsRoot;
  MANIFEST_PATH = manifestMetadataPath(PACKAGE_ROOT);
  PUBLIC_ROOT_IMPORT = pkg.name;
}

export type ExampleArtifact = {
  component: string;
  import: string;
  examples: Array<{ code: string }>;
};
type ExampleValidator = ValidateFunction<ExampleArtifact>;

export type ComponentLocation = {
  directory: string;
  id: string;
};

function formatSchemaErrors(errors: ErrorObject[] | null | undefined): string {
  return (errors ?? [])
    .map((error) => `${error.instancePath || '/'} ${error.message ?? 'is invalid'}`)
    .join('; ');
}

/** Every component directory the active package lists; core's are its own and its packages'. */
export async function componentLocations(): Promise<ComponentLocation[]> {
  const locations: ComponentLocation[] = [];
  const roots =
    active.name === CORE_PACKAGE ? cinderComponentRoots(PACKAGE_ROOT) : [COMPONENTS_ROOT];
  for (const root of roots) {
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('_') || entry.name === 'icons') continue;
      locations.push({ directory: join(root, entry.name), id: entry.name });
    }
  }
  return locations.toSorted((a, b) => a.id.localeCompare(b.id));
}

/** The component directories `checkCommittedExamples` reads for a package (core by default). */
export async function exampleComponentLocations(
  packageRoot?: string,
): Promise<ComponentLocation[]> {
  activate(componentPackage(packageRoot));
  return componentLocations();
}

/** Where the manifest says the examples are: the `metadata` task's copy in `.metadata/`. */
function artifactPath(location: ComponentLocation): string {
  return packageRelative(active, componentMetadataPath(PACKAGE_ROOT, location.id, 'examples'));
}

function readManifest(): Promise<Manifest> {
  return readJsonFile<Manifest>(MANIFEST_PATH);
}

async function validateArtifact(
  location: ComponentLocation,
  entryName: string,
  validator: ExampleValidator,
  manifestById: ReadonlyMap<string, Manifest['components'][number]>,
): Promise<string[]> {
  const path = join(location.directory, entryName);
  const packagePath = relative(PACKAGE_ROOT, path);
  const artifactId = entryName.slice(0, -'.examples.json'.length);
  let artifact: unknown;

  try {
    artifact = await Bun.file(path).json();
  } catch (error) {
    return [
      `${packagePath}: invalid JSON (${error instanceof Error ? error.message : String(error)})`,
    ];
  }

  return validateExampleArtifactValue(
    artifact,
    location,
    artifactId,
    packagePath,
    validator,
    manifestById.get(artifactId),
  );
}

export function validateExampleArtifactValue(
  artifact: unknown,
  location: ComponentLocation,
  artifactId: string,
  packagePath: string,
  validator: ExampleValidator,
  manifestComponent: Manifest['components'][number] | undefined,
): string[] {
  if (!validator(artifact)) {
    return [`${packagePath}: schema validation failed (${formatSchemaErrors(validator.errors)})`];
  }

  const metadataIssues = validateArtifactMetadata(artifact, location, artifactId, packagePath);
  if (manifestComponent === undefined) {
    return [...metadataIssues, `${packagePath}: no matching component in components.json`];
  }
  return [
    ...metadataIssues,
    ...validateManifestRelation(manifestComponent, location, artifactId, packagePath),
  ];
}

function validateArtifactMetadata(
  value: ExampleArtifact,
  location: ComponentLocation,
  artifactId: string,
  packagePath: string,
): string[] {
  const issues: string[] = [];
  if (artifactId !== location.id) {
    issues.push(`${packagePath}: filename does not match owning directory "${location.id}"`);
  }
  if (value.component !== location.id) {
    issues.push(
      `${packagePath}: component "${value.component}" does not match owning directory "${location.id}"`,
    );
  }
  if (value.import !== PUBLIC_ROOT_IMPORT) {
    issues.push(`${packagePath}: import must use public root "${PUBLIC_ROOT_IMPORT}"`);
  }
  if (
    value.examples.some((example) =>
      new RegExp(`(?:from|import)\\s+['"]${PUBLIC_ROOT_IMPORT.replaceAll('/', '\\/')}\\/`).test(
        example.code,
      ),
    )
  ) {
    issues.push(
      `${packagePath}: example code must use the public root import "${PUBLIC_ROOT_IMPORT}"`,
    );
  }
  return issues;
}

function validateManifestRelation(
  manifestComponent: Manifest['components'][number],
  location: ComponentLocation,
  artifactId: string,
  packagePath: string,
): string[] {
  const issues: string[] = [];
  if (!manifestComponent.hasExamples) {
    issues.push(`${packagePath}: components.json does not advertise this examples artifact`);
  }
  if (manifestComponent.import !== PUBLIC_ROOT_IMPORT) {
    issues.push(
      `components.json ${artifactId}: import is not the public root "${PUBLIC_ROOT_IMPORT}"`,
    );
  }
  if (manifestComponent.artifacts.examples !== artifactPath(location)) {
    issues.push(
      `${packagePath}: manifest artifact path is "${manifestComponent.artifacts.examples ?? 'absent'}"`,
    );
  }
  return issues;
}

async function validateLocation(
  location: ComponentLocation,
  validator: ExampleValidator,
  manifestById: ReadonlyMap<string, Manifest['components'][number]>,
): Promise<{ issues: string[]; paths: string[] }> {
  const issues: string[] = [];
  const paths: string[] = [];
  for (const entry of await readdir(location.directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.examples.json')) continue;
    if (entry.name === `${location.id}.examples.json`) paths.push(artifactPath(location));
    issues.push(...(await validateArtifact(location, entry.name, validator, manifestById)));
  }
  return { issues, paths };
}

/** Return every committed example-sidecar issue; an empty array means valid. */
export async function checkCommittedExamples(packageRoot?: string): Promise<string[]> {
  activate(componentPackage(packageRoot));
  const [locations, manifest, schema] = await Promise.all([
    componentLocations(),
    readManifest(),
    Bun.file(SCHEMA_PATH).json(),
  ]);
  const validator = new Ajv({ allErrors: true, strict: false }).compile<ExampleArtifact>(schema);
  const manifestById = new Map(manifest.components.map((component) => [component.id, component]));
  const issues: string[] = [];
  const discoveredArtifacts = new Set<string>();

  for (const location of locations) {
    const result = await validateLocation(location, validator, manifestById);
    issues.push(...result.issues);
    for (const path of result.paths) discoveredArtifacts.add(path);
  }

  for (const component of manifest.components) {
    const expected = component.artifacts.examples;
    if (component.hasExamples && expected !== undefined && !discoveredArtifacts.has(expected)) {
      issues.push(
        `components.json ${component.id}: advertised examples artifact "${expected}" is missing`,
      );
    }
  }

  return issues;
}

async function main(): Promise<void> {
  const issues = await checkCommittedExamples();
  if (issues.length > 0) {
    for (const issue of issues) process.stderr.write(`component examples: ${issue}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write('component examples: OK\n');
}

if (import.meta.main) await main();
