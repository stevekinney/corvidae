/**
 * `workflowObjectSource`: JSON workflow objects in an S3 bucket as a {@link WorkflowSource}
 * (COR-1762).
 *
 * @module workflow-object-source
 */

import { WORKFLOW_FILE_EXTENSION, WORKFLOW_FILE_SIZE_LIMIT } from '../workflow-file';
import type { WorkflowSource } from './definition-source';
import type { ObjectLocation } from './object-operations';
import { createObjectSource, type ObjectSourceOptions } from './object-source';

/** What {@link workflowObjectSource} takes beyond the location. */
export type WorkflowObjectSourceOptions = ObjectSourceOptions;

/**
 * The S3 counterpart of `workflowFileDirectory`. Every `*.json` object directly under
 * `location.prefix` is a workflow whose identifier is the key's name without the extension. Bureau
 * reads, polls, and writes the prefix through the caller's `Bun.S3Client`; a prefix with no
 * objects is an empty one. Writes and deletes are conditional on the ETag of the object just read.
 * Bun only. See `documentation/workflow-files.md`.
 */
export function workflowObjectSource(
  location: ObjectLocation,
  options: WorkflowObjectSourceOptions,
): WorkflowSource {
  const source = createObjectSource(
    {
      location,
      label: 'workflow object source',
      extension: WORKFLOW_FILE_EXTENSION,
      sizeLimit: WORKFLOW_FILE_SIZE_LIMIT,
      contentType: 'application/json',
    },
    options,
  );
  return Object.assign(source, { kind: 'workflow' as const });
}
