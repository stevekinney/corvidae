/**
 * `workflowFileDirectory`: a directory of JSON workflow files as a {@link WorkflowSource}
 * (COR-1527, COR-1702).
 *
 * @module workflow-file-directory
 */

import { WORKFLOW_FILE_EXTENSION, WORKFLOW_FILE_SIZE_LIMIT } from '../workflow-file';
import type { WorkflowSource } from './definition-source';
import { createDirectorySource, type DirectorySourceOptions } from './directory-source';
import { pluginLayer } from './plugin-layer';

/** What {@link workflowFileDirectory} takes. */
export type WorkflowFileDirectoryOptions = DirectorySourceOptions;

/**
 * A directory of JSON workflow files. Every `*.json` file in it is a workflow whose identifier is
 * the filename without the extension. Bureau reads, watches, and writes the directory; a directory
 * that does not exist is an empty one. With `options.plugin` the directory is that plugin's
 * read-only layer (COR-1873). See `documentation/workflow-files.md`.
 */
export function workflowFileDirectory(
  path: string,
  options: WorkflowFileDirectoryOptions = {},
): WorkflowSource {
  const source = createDirectorySource(
    {
      directory: path,
      label: 'workflow directory',
      extension: WORKFLOW_FILE_EXTENSION,
      sizeLimit: WORKFLOW_FILE_SIZE_LIMIT,
    },
    options,
  );
  const workflowSource: WorkflowSource = Object.assign(source, { kind: 'workflow' as const });
  return options.plugin === undefined
    ? workflowSource
    : pluginLayer(workflowSource, options.plugin);
}
