/**
 * `agentFileDirectory`: a directory of Markdown agent files as an {@link AgentSource}
 * (COR-1524, COR-1702).
 *
 * @module agent-file-directory
 */

import type { Tool } from 'armorer';

import { AGENT_FILE_EXTENSION, AGENT_FILE_SIZE_LIMIT } from '../agent-file';
import type { AgentSource } from './definition-source';
import { createDirectorySource, type DirectorySourceOptions } from './directory-source';

/** What {@link agentFileDirectory} takes beyond the directory itself. */
export interface AgentFileDirectoryOptions extends DirectorySourceOptions {
  /**
   * The deployment's tool catalog: the tools an agent file may name in `tools`, by the name it
   * uses. A file naming a tool that is not here is `invalid`. Defaults to none.
   */
  readonly tools?: Readonly<Record<string, Tool>> | undefined;
}

/**
 * A directory of Markdown agent files. Every `*.md` file in it is an agent whose identifier is the
 * filename without the extension. Bureau reads, watches, and writes the directory; a directory
 * that does not exist is an empty one. See `documentation/agent-files.md`.
 */
export function agentFileDirectory(
  path: string,
  options: AgentFileDirectoryOptions = {},
): AgentSource {
  const source = createDirectorySource(
    {
      directory: path,
      label: 'agent directory',
      extension: AGENT_FILE_EXTENSION,
      sizeLimit: AGENT_FILE_SIZE_LIMIT,
    },
    options,
  );
  return Object.assign(source, {
    kind: 'agent' as const,
    ...(options.tools === undefined ? {} : { tools: options.tools }),
  });
}
