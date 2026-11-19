/**
 * Writes only the standalone DTCG schema validators (`src/tokens/runtime/*-validator.generated.*`).
 *
 * `tokens:generate` loads and validates the token corpus, and that validation imports these
 * validators, so a checkout with no generated files cannot run it until they exist. This script is
 * the seed: it depends on the vendored schemas and Ajv alone, never on the corpus. The workspace's
 * `prepare` step and `metadata` task run it first, then `tokens:generate` writes everything else.
 */

import { mkdir } from 'node:fs/promises';

import { runtimeDirectory } from './generator-configuration.ts';
import { buildSchemaValidatorOutputs } from './schema-validators.ts';

export async function writeSchemaValidators(): Promise<string[]> {
  await mkdir(runtimeDirectory, { recursive: true });
  const outputs = buildSchemaValidatorOutputs();
  for (const [path, content] of outputs) await Bun.write(path, content);
  return [...outputs.keys()];
}

if (import.meta.main) await writeSchemaValidators();
