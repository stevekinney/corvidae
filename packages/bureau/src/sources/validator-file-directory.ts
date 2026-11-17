/**
 * `validatorFileDirectory`: a directory of JSON validator files as a {@link ValidatorSource}
 * (COR-2119).
 *
 * @module validator-file-directory
 */

import { VALIDATOR_FILE_EXTENSION, VALIDATOR_FILE_SIZE_LIMIT } from '../validator-file';
import type { ValidatorSource } from './definition-source';
import { createDirectorySource, type DirectorySourceOptions } from './directory-source';

/** What {@link validatorFileDirectory} takes. */
export type ValidatorFileDirectoryOptions = Omit<DirectorySourceOptions, 'plugin'>;

/**
 * A directory of JSON validator files. Every `*.json` file in it is a validator whose name is the
 * filename without the extension. Bureau reads and watches the directory, and a directory that does
 * not exist is an empty one. Owners write these files; Bureau never does.
 */
export function validatorFileDirectory(
  path: string,
  options: ValidatorFileDirectoryOptions = {},
): ValidatorSource {
  const source = createDirectorySource(
    {
      directory: path,
      label: 'validator directory',
      extension: VALIDATOR_FILE_EXTENSION,
      sizeLimit: VALIDATOR_FILE_SIZE_LIMIT,
    },
    options,
  );
  return Object.assign(source, { kind: 'validator' as const });
}
