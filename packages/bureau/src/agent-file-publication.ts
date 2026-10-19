/**
 * Publishing and withdrawing an agent file (COR-1526): setting `published` in its frontmatter and
 * nothing else.
 *
 * Both are an `update` whose definition is the file's own, with `published` changed. The input is
 * built from the keys the file actually has, not from the definition with its defaults applied:
 * a file that has no `name` key must not gain `name: <identifier>` because it was published. A
 * file that already has the requested state is not rewritten.
 *
 * @module agent-file-publication
 */

import {
  AgentFileConflictError,
  AgentFileError,
  type AgentFileDefinitionInput,
  parseAgentFile,
  type ParsedAgentFile,
} from './agent-file';
import type { AgentFileWriter, AgentFileWriteResult } from './agent-file-writer';

/** The input that rewrites `file` with `published` set and every other key it has as it is. */
function inputWithPublished(file: ParsedAgentFile, published: boolean): AgentFileDefinitionInput {
  const { definition, raw } = file;
  const has = (key: string): boolean => raw[key] !== undefined && raw[key] !== null;
  return {
    ...(has('name') ? { name: definition.name } : {}),
    ...(has('description') ? { description: definition.description } : {}),
    model: definition.model,
    ...(has('tools') ? { tools: definition.tools } : {}),
    ...(has('skills') ? { skills: definition.skills } : {}),
    published,
    instructions: file.body,
  };
}

/**
 * Set `published` on the agent file for `id`, if it still hashes to `expectedHash`.
 *
 * Fails as `update` does: `AgentFileError` (`agent-file-not-found`, `agent-file-unreadable`, or
 * the problem a rewrite would leave) and `AgentFileConflictError` (`agent-file-changed`, with
 * `currentHash`) when the file is not the one the caller read. Writes nothing in either case.
 */
export async function setAgentPublished(
  files: Pick<AgentFileWriter, 'read' | 'update'>,
  id: string,
  published: boolean,
  options: { readonly expectedHash: string },
): Promise<AgentFileWriteResult> {
  const current = await files.read(id);
  if (current === undefined) {
    throw new AgentFileError('agent-file-not-found', `There is no agent file for "${id}".`);
  }
  if (current.hash !== options.expectedHash) {
    throw new AgentFileConflictError(
      'agent-file-changed',
      `The file for "${id}" has changed since it was read.`,
      current.hash,
    );
  }
  const parsed = parseAgentFile(id, current.text);
  if (!parsed.ok) {
    throw new AgentFileError(
      'agent-file-unreadable',
      `The file for "${id}" cannot be read as an agent file, so it cannot be ${published ? 'published' : 'withdrawn'}.`,
      parsed.problem,
    );
  }
  return files.update(id, inputWithPublished(parsed.file, published), {
    expectedHash: options.expectedHash,
  });
}
