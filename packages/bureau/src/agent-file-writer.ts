/**
 * Writing agent files (COR-1524): `create`, `update`, and `delete` through the same files the
 * catalog loads.
 *
 * A write goes to a temporary dotfile in the same directory and is renamed into place, so a
 * reader (the catalog's own watcher included) never sees half a file. `update` and `delete` take
 * the SHA-256 of the bytes the caller last read and refuse with an {@link AgentFileConflictError}
 * when the file has changed since. Writes are serialized in this process.
 *
 * The write core is `atomic-file-writer.ts`, shared with the workflow files (COR-1527).
 *
 * @module agent-file-writer
 */

import {
  AGENT_FILE_EXTENSION,
  AGENT_FILE_SIZE_LIMIT,
  AgentFileConflictError,
  AgentFileError,
  type AgentFileDefinition,
  type AgentFileDefinitionInput,
  type AgentFileProblem,
  checkAgentIdentifier,
  decodeAgentFile,
  hashAgentFileBytes,
  parseAgentFile,
  resolveAgentFileDefinition,
  serializeNewAgentFile,
  serializeUpdatedAgentFile,
} from './agent-file';
import { createAtomicFileWriter } from './atomic-file-writer';
import type { AgentFileOperations } from './agent-file-operations';

export interface AgentFileWriterDependencies {
  readonly directory: string;
  readonly operations: AgentFileOperations;
  /** The checks that depend on the deployment: a reserved identifier, the model, the tools. */
  validate(id: string, definition: AgentFileDefinition): AgentFileProblem | undefined;
  /** Rescan the directory; resolves once the catalog reflects it. */
  refresh(): Promise<void>;
  /** A name no other file in the directory has, for the temporary file. */
  newTemporaryName(): string;
}

/** What a successful write reports: the identifier and the hash of the file now on disk. */
export interface AgentFileWriteResult {
  readonly id: string;
  readonly hash: string;
}

export interface AgentFileWriter {
  /** The file's text and hash, or `undefined` when there is no such file. */
  read(id: string): Promise<{ readonly hash: string; readonly text: string } | undefined>;
  create(id: string, definition: AgentFileDefinitionInput): Promise<AgentFileWriteResult>;
  update(
    id: string,
    definition: AgentFileDefinitionInput,
    options: { readonly expectedHash: string },
  ): Promise<AgentFileWriteResult>;
  delete(id: string, options: { readonly expectedHash: string }): Promise<AgentFileWriteResult>;
}

function refuse(problem: AgentFileProblem): never {
  throw new AgentFileError(problem.code, problem.message, problem);
}

export function createAgentFileWriter(dependencies: AgentFileWriterDependencies): AgentFileWriter {
  const { directory, operations } = dependencies;
  const files = createAtomicFileWriter({
    directory,
    operations,
    extension: AGENT_FILE_EXTENSION,
    newTemporaryName: () => dependencies.newTemporaryName(),
    notFound: (id) =>
      new AgentFileError('agent-file-not-found', `There is no agent file for "${id}".`),
    exists: (id, currentHash) =>
      new AgentFileConflictError(
        'agent-file-exists',
        `An agent file for "${id}" already exists.`,
        currentHash,
      ),
    changed: (id, currentHash) =>
      new AgentFileConflictError(
        'agent-file-changed',
        `The file for "${id}" has changed since it was read.`,
        currentHash,
      ),
  });
  const { exclusive, readExisting, recheck, publish } = files;

  function checkIdentifier(id: string): void {
    const problem = checkAgentIdentifier(id);
    if (problem !== undefined) refuse(problem);
  }

  /** Refuse unless `bytes` would load as a usable agent named `id`. */
  function checkWritable(id: string, bytes: Uint8Array): void {
    if (bytes.length > AGENT_FILE_SIZE_LIMIT) {
      refuse({
        code: 'file-too-large',
        message: `An agent file may be at most ${AGENT_FILE_SIZE_LIMIT} bytes.`,
      });
    }
    const text = decodeAgentFile(bytes);
    const parsed = text === undefined ? undefined : parseAgentFile(id, text);
    if (parsed === undefined || !parsed.ok) {
      refuse(
        parsed?.ok === false
          ? parsed.problem
          : { code: 'not-utf8', message: 'The agent file is not valid UTF-8.' },
      );
    }
    const problem = dependencies.validate(id, parsed.file.definition);
    if (problem !== undefined) refuse(problem);
  }

  return {
    async read(id) {
      checkIdentifier(id);
      const bytes = await files.readBytes(id);
      if (bytes === undefined) return undefined;
      const text = decodeAgentFile(bytes);
      if (text === undefined) {
        throw new AgentFileError('not-utf8', `The file for "${id}" is not valid UTF-8.`);
      }
      return { hash: hashAgentFileBytes(bytes), text };
    },

    create(id, definition) {
      return exclusive(async () => {
        checkIdentifier(id);
        const bytes = serializeNewAgentFile(definition);
        checkWritable(id, bytes);
        const existing = (): Promise<void> => files.assertAbsent(id);
        await existing();
        await publish(id, bytes, existing);
        await dependencies.refresh();
        return { id, hash: hashAgentFileBytes(bytes) };
      });
    },

    update(id, definition, { expectedHash }) {
      return exclusive(async () => {
        checkIdentifier(id);
        const { bytes: current, hash } = await readExisting(id, expectedHash);
        const text = decodeAgentFile(current);
        const parsed = text === undefined ? undefined : parseAgentFile(id, text);
        if (parsed === undefined || !parsed.ok) {
          throw new AgentFileError(
            'agent-file-unreadable',
            `The file for "${id}" cannot be read as an agent file, so it cannot be updated in place. Delete it and create it again.`,
            parsed?.ok === false ? parsed.problem : undefined,
          );
        }
        // The definition is checked even when it changes nothing: an update never reports a
        // success for a file that would not load.
        const problem = dependencies.validate(id, resolveAgentFileDefinition(id, definition));
        if (problem !== undefined) refuse(problem);
        const next = serializeUpdatedAgentFile(id, parsed.file, definition);
        if (next === undefined) return { id, hash };
        checkWritable(id, next);
        await publish(id, next, () => recheck(id, expectedHash));
        await dependencies.refresh();
        return { id, hash: hashAgentFileBytes(next) };
      });
    },

    delete(id, { expectedHash }) {
      return exclusive(async () => {
        checkIdentifier(id);
        const { hash } = await readExisting(id, expectedHash);
        await recheck(id, expectedHash);
        await files.remove(id);
        await dependencies.refresh();
        return { id, hash };
      });
    },
  };
}
