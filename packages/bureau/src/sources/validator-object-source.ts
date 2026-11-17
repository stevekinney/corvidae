/**
 * `validatorObjectSource`: JSON validator objects in an S3 bucket as a {@link ValidatorSource}
 * (COR-2119).
 *
 * @module validator-object-source
 */

import { VALIDATOR_FILE_EXTENSION, VALIDATOR_FILE_SIZE_LIMIT } from '../validator-file';
import type { ValidatorSource } from './definition-source';
import type { ObjectLocation } from './object-operations';
import { createObjectSource, type ObjectSourceOptions } from './object-source';

/** What {@link validatorObjectSource} takes beyond the location. */
export type ValidatorObjectSourceOptions = ObjectSourceOptions;

/**
 * The S3 counterpart of `validatorFileDirectory`. Every `*.json` object directly under
 * `location.prefix` is a validator whose name is the key's name without the extension. Bureau reads
 * and polls the prefix through the caller's `Bun.S3Client`; a prefix with no objects is an empty
 * one. Bun only.
 */
export function validatorObjectSource(
  location: ObjectLocation,
  options: ValidatorObjectSourceOptions,
): ValidatorSource {
  const source = createObjectSource(
    {
      location,
      label: 'validator object source',
      extension: VALIDATOR_FILE_EXTENSION,
      sizeLimit: VALIDATOR_FILE_SIZE_LIMIT,
      contentType: 'application/json',
    },
    options,
  );
  return Object.assign(source, { kind: 'validator' as const });
}
