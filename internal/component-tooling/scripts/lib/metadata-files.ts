/**
 * Where a component package's derived metadata lives, and how to read it.
 *
 * The `metadata` Turborepo task of cinder, chat, editor and terminal
 * (`scripts/generate-component-artifacts.ts`) writes an ignored `.metadata/` directory in the
 * package:
 *
 * ```text
 * .metadata/components.json        the package manifest
 * .metadata/a2ui-catalog.json      Cinder's A2UI catalog (cinder only)
 * .metadata/<id>/schema.json       each component's props schema
 * .metadata/<id>/variables.json    the custom properties it declares
 * .metadata/<id>/examples.json     a copy of its authored <id>.examples.json, when it has one
 * ```
 *
 * The package exports them as `./manifest`, `./<id>/schema`, `./<id>/variables` and
 * `./<id>/examples`. Read them through this module rather than importing the JSON statically, so
 * a type-check never depends on a generated file and a missing one names the command that makes
 * it.
 */

import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

import type { ComponentSchema } from '../../src/schema-types.ts';

/**
 * The text of a JSON document copied from `fromPath` to `toPath`, with a relative `$schema`
 * re-pointed so it names the same file from the copy. An examples document's `$schema` is relative
 * to the authored file beside the component; copied unchanged into `.metadata/<id>/`, it would
 * climb out of the repository. A document with no `$schema`, or a URL or absolute one, is
 * returned as it was.
 */
export function relocatedJsonDocument(text: string, fromPath: string, toPath: string): string {
  const document = JSON.parse(text) as Record<string, unknown>;
  const schema = document['$schema'];
  if (typeof schema !== 'string' || isAbsolute(schema) || /^[a-z][a-z0-9+.-]*:/i.test(schema)) {
    return text;
  }
  const target = resolve(dirname(fromPath), schema);
  const moved = relative(dirname(toPath), target).split('\\').join('/');
  return `${JSON.stringify({ ...document, $schema: moved }, null, 2)}\n`;
}

/** The directory, inside a component package, that the `metadata` task writes. */
export const METADATA_DIRECTORY = '.metadata';

/** The derived files of one component. */
export type ComponentMetadataKind = 'schema' | 'variables' | 'examples';

export function metadataRoot(packageRoot: string): string {
  return join(packageRoot, METADATA_DIRECTORY);
}

export function componentMetadataPath(
  packageRoot: string,
  id: string,
  kind: ComponentMetadataKind,
): string {
  return join(metadataRoot(packageRoot), id, `${kind}.json`);
}

export function manifestMetadataPath(packageRoot: string): string {
  return join(metadataRoot(packageRoot), 'components.json');
}

/** The command that writes a package's `.metadata/`, for error messages. */
export function metadataCommand(packageRoot: string): string {
  return `bunx turbo run metadata --filter=@lostgradient/${basename(packageRoot)}`;
}

/** Parse one generated metadata file, or throw naming the command that generates it. */
export function readMetadataFile<T>(path: string, packageRoot: string): T {
  if (!existsSync(path)) {
    throw new Error(`${path} does not exist: run \`${metadataCommand(packageRoot)}\` first.`);
  }
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

export function readComponentMetadata<T>(
  packageRoot: string,
  id: string,
  kind: ComponentMetadataKind,
): T {
  return readMetadataFile<T>(componentMetadataPath(packageRoot, id, kind), packageRoot);
}

const CINDER_PACKAGE_ROOT = join(import.meta.dir, '../../../../components/cinder');

/** A component's generated props schema (cinder's unless `packageRoot` names another package). */
export function readComponentSchema(
  id: string,
  packageRoot: string = CINDER_PACKAGE_ROOT,
): ComponentSchema {
  return readComponentMetadata<ComponentSchema>(packageRoot, id, 'schema');
}

/** The custom properties a component declares (cinder's unless `packageRoot` says otherwise). */
export function readComponentVariables(
  id: string,
  packageRoot: string = CINDER_PACKAGE_ROOT,
): readonly string[] {
  return readComponentMetadata<string[]>(packageRoot, id, 'variables');
}
