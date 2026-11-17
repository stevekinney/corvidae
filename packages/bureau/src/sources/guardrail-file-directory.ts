/**
 * `guardrailFileDirectory`: a directory of JSON guardrail files as a {@link GuardrailSource}
 * (COR-2120).
 *
 * @module guardrail-file-directory
 */

import { GUARDRAIL_FILE_EXTENSION, GUARDRAIL_FILE_SIZE_LIMIT } from '../guardrail-file';
import type { GuardrailSource } from './definition-source';
import { createDirectorySource, type DirectorySourceOptions } from './directory-source';

/** What {@link guardrailFileDirectory} takes. */
export type GuardrailFileDirectoryOptions = Omit<DirectorySourceOptions, 'plugin'>;

/**
 * A directory of JSON guardrail files. Every `*.json` file in it is a guardrail whose name is the
 * filename without the extension, which an agent file lists in `guardrails`. Bureau reads and
 * watches the directory, and a directory that does not exist is an empty one. Owners write these
 * files; Bureau never does.
 */
export function guardrailFileDirectory(
  path: string,
  options: GuardrailFileDirectoryOptions = {},
): GuardrailSource {
  const source = createDirectorySource(
    {
      directory: path,
      label: 'guardrail directory',
      extension: GUARDRAIL_FILE_EXTENSION,
      sizeLimit: GUARDRAIL_FILE_SIZE_LIMIT,
    },
    options,
  );
  return Object.assign(source, { kind: 'guardrail' as const });
}
