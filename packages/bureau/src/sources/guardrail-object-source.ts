/**
 * `guardrailObjectSource`: JSON guardrail objects in an S3 bucket as a {@link GuardrailSource}
 * (COR-2120).
 *
 * @module guardrail-object-source
 */

import { GUARDRAIL_FILE_EXTENSION, GUARDRAIL_FILE_SIZE_LIMIT } from '../guardrail-file';
import type { GuardrailSource } from './definition-source';
import type { ObjectLocation } from './object-operations';
import { createObjectSource, type ObjectSourceOptions } from './object-source';

/** What {@link guardrailObjectSource} takes beyond the location. */
export type GuardrailObjectSourceOptions = ObjectSourceOptions;

/**
 * The S3 counterpart of `guardrailFileDirectory`. Every `*.json` object directly under
 * `location.prefix` is a guardrail whose name is the key's name without the extension. Bureau reads
 * and polls the prefix through the caller's S3 object-store operations.
 */
export function guardrailObjectSource(
  location: ObjectLocation,
  options: GuardrailObjectSourceOptions,
): GuardrailSource {
  const source = createObjectSource(
    {
      location,
      label: 'guardrail object source',
      extension: GUARDRAIL_FILE_EXTENSION,
      sizeLimit: GUARDRAIL_FILE_SIZE_LIMIT,
      contentType: 'application/json',
    },
    options,
  );
  return Object.assign(source, { kind: 'guardrail' as const });
}
