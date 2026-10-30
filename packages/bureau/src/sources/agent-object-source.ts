/**
 * `agentObjectSource`: Markdown agent objects in an S3 bucket as an {@link AgentSource}
 * (COR-1762).
 *
 * @module agent-object-source
 */

import type { Tool } from 'armorer';

import { AGENT_FILE_EXTENSION, AGENT_FILE_SIZE_LIMIT } from '../agent-file';
import type { AgentSource } from './definition-source';
import type { ObjectLocation } from './object-operations';
import { createObjectSource, type ObjectSourceOptions } from './object-source';
import { assertReferencePath } from './reference-path';

/** What {@link agentObjectSource} takes beyond the location. */
export interface AgentObjectSourceOptions extends ObjectSourceOptions {
  /**
   * The deployment's tool catalog: the tools an agent object may name in `tools`, by the name it
   * uses. An object naming a tool that is not here is `invalid`. Defaults to none.
   */
  readonly tools?: Readonly<Record<string, Tool>> | undefined;
}

/**
 * The S3 counterpart of `agentFileDirectory`. Every `*.md` object directly under `location.prefix`
 * is an agent whose identifier is the key's name without the extension. Bureau reads, polls, and
 * writes the prefix through the caller's `Bun.S3Client`; a prefix with no objects is an empty one.
 * The documents an agent object's `references` name are other objects under the same prefix, read
 * by path (`<prefix>/<path>`), one listing and one read each.
 * Writes and deletes are conditional on the ETag of the object just read. Bun only. See
 * `documentation/agent-files.md`.
 */
export function agentObjectSource(
  location: ObjectLocation,
  options: AgentObjectSourceOptions,
): AgentSource {
  const source = createObjectSource(
    {
      location,
      label: 'agent object source',
      extension: AGENT_FILE_EXTENSION,
      sizeLimit: AGENT_FILE_SIZE_LIMIT,
      contentType: 'text/markdown; charset=utf-8',
    },
    options,
  );
  return Object.assign(source, {
    kind: 'agent' as const,
    referencePollMilliseconds: source.pollIntervalMilliseconds,
    async readSibling(
      path: string,
      readOptions: { readonly limit: number; readonly unlessStamp?: string | undefined },
    ) {
      assertReferencePath(path);
      return await source.readBeside(path, readOptions);
    },
    ...(options.tools === undefined ? {} : { tools: options.tools }),
  });
}
