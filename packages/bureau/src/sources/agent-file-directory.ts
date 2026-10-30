/**
 * `agentFileDirectory`: a directory of Markdown agent files as an {@link AgentSource}
 * (COR-1524, COR-1702).
 *
 * @module agent-file-directory
 */

import { isAbsolute, relative, resolve } from 'node:path';

import type { Tool } from 'armorer';

import { AGENT_FILE_EXTENSION, AGENT_FILE_SIZE_LIMIT } from '../agent-file';
import { nodeAgentFileOperations } from './agent-file-operations';
import { DIRECTORY_POLL_INTERVAL_MILLISECONDS } from './watched-directory';
import type { AgentSource, SiblingRead } from './definition-source';
import { createDirectorySource, type DirectorySourceOptions } from './directory-source';
import { pluginLayer } from './plugin-layer';
import { assertReferencePath } from './reference-path';

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
 * that does not exist is an empty one. The documents an agent file's `references` name are read
 * from the same directory, in subdirectories too, by path (a symbolic link is followed, as it is
 * for an agent file). With `options.plugin` the directory is that plugin's read-only layer
 * (COR-1873). See `documentation/agent-files.md`.
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
  const operations = options.operations ?? nodeAgentFileOperations;
  const root = resolve(path);
  async function readSibling(
    sibling: string,
    readOptions: { readonly limit: number; readonly unlessStamp?: string | undefined },
  ): Promise<SiblingRead> {
    assertReferencePath(sibling);
    const target = resolve(root, ...sibling.split('/'));
    const inside = relative(root, target);
    // The path check already refuses `..`; this is the same rule on the resolved path.
    if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) {
      throw new TypeError(
        `The reference path ${JSON.stringify(sibling)} is outside the directory.`,
      );
    }
    const info = await operations.stat(target);
    if (info === undefined) return { kind: 'missing' };
    if (info.size > readOptions.limit) return { kind: 'too-large', size: info.size };
    // A file replaced by a rename has another inode; one edited in place has another time or size.
    const stamp = `${info.size}:${info.inode}:${info.modifiedMilliseconds}`;
    if (readOptions.unlessStamp === stamp) return { kind: 'unchanged' };
    const bytes = await operations.read(target);
    if (bytes === undefined) return { kind: 'missing' };
    if (bytes.byteLength > readOptions.limit) return { kind: 'too-large', size: bytes.byteLength };
    return { kind: 'found', bytes, stamp };
  }
  const agentSource: AgentSource = Object.assign(source, {
    kind: 'agent' as const,
    readSibling,
    ...(options.watch === false
      ? {}
      : { referencePollMilliseconds: DIRECTORY_POLL_INTERVAL_MILLISECONDS }),
    ...(options.tools === undefined ? {} : { tools: options.tools }),
  });
  return options.plugin === undefined ? agentSource : pluginLayer(agentSource, options.plugin);
}
