/**
 * Generates `base-corpus.generated.ts`: the package version and the source
 * digest of the bundled Cinder token base.
 *
 * The digest is computed over the validated corpus the generator loaded, with
 * the runtime's own canonical-JSON and SHA-256 code, so what is committed is
 * exactly what the runtime recomputes in the browser.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { format } from 'prettier';
import babelPlugin from 'prettier/plugins/babel';
import estreePlugin from 'prettier/plugins/estree';
import typescriptPlugin from 'prettier/plugins/typescript';

import { computeSourceDigest } from '../../src/tokens/runtime/source-digest.ts';
import type { ResolverDocument, TokenDocument } from '../../src/tokens/runtime/types.ts';
import { assertPrettierResolvesToRoot } from '../lib/prettier-resolution.ts';
import {
  PRETTIER_OPTIONS,
  REGENERATE_COMMAND,
  packageRoot,
  runtimeDirectory,
} from './generator-configuration.ts';

export const baseCorpusMetadataPath = join(runtimeDirectory, 'base-corpus.generated.ts');

function packageVersion(): string {
  const manifest: unknown = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
  const version =
    typeof manifest === 'object' && manifest !== null && 'version' in manifest
      ? manifest.version
      : undefined;
  if (typeof version !== 'string' || version === '') {
    throw new Error('components/cinder/package.json must declare a version.');
  }
  return version;
}

/** Absolute output path -> generated content for the base-corpus metadata module. */
export async function buildBaseCorpusMetadata(
  resolver: ResolverDocument,
  documentsByPath: Map<string, TokenDocument>,
): Promise<Map<string, string>> {
  const digest = await computeSourceDigest({
    resolver,
    documents: Object.fromEntries(documentsByPath),
  });
  const source = `/**
 * GENERATED FILE. Do not edit by hand.
 *
 * The version and source digest of the bundled Cinder token base.
 * Regenerate: ${REGENERATE_COMMAND}
 */

export const BASE_PACKAGE_VERSION = ${JSON.stringify(packageVersion())};

export const BASE_SOURCE_DIGEST = ${JSON.stringify(digest)};
`;
  assertPrettierResolvesToRoot();
  const formatted = await format(source, {
    ...PRETTIER_OPTIONS,
    parser: 'typescript',
    plugins: [typescriptPlugin, estreePlugin, babelPlugin],
  });
  return new Map([[baseCorpusMetadataPath, formatted]]);
}
