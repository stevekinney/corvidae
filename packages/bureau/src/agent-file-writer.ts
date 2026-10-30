/**
 * Writing agent files (COR-1524): `create`, `update`, and `delete` through the same files the
 * catalog loads.
 *
 * A write goes to a temporary dotfile in the same directory and is renamed into place, so a
 * reader (the catalog's own watcher included) never sees half a file. `update` and `delete` take
 * the SHA-256 of the bytes the caller last read and refuse with an {@link AgentFileConflictError}
 * when the file has changed since. Writes are serialized in this process.
 *
 * The write goes through the agent source (COR-1702): `source.write` and `source.delete` compare
 * against the hash the caller read as late as possible and reject with a `SourceConflictError`,
 * which this module reports as the {@link AgentFileConflictError} callers know. The directory
 * source's atomic rename is `sources/atomic-file-writer.ts`.
 *
 * @module agent-file-writer
 */

import {
  AGENT_FILE_SIZE_LIMIT,
  AgentFileConflictError,
  AgentFileError,
  type AgentFileDefinition,
  type AgentFileDefinitionInput,
  type AgentFileProblem,
  agentFileInputOf,
  checkAgentIdentifier,
  decodeAgentFile,
  hashAgentFileBytes,
  parseAgentFile,
  resolveAgentFileDefinition,
  serializeNewAgentFile,
  serializeUpdatedAgentFile,
} from './agent-file';
import { isNamespacedIdentifier } from './namespaced-identifier';
import {
  type AgentSource,
  type DefinitionEntry,
  SourceConflictError,
  SourceReadOnlyError,
} from './sources/definition-source';

export interface AgentFileWriterDependencies {
  readonly source: AgentSource;
  /** The checks that depend on the deployment: a reserved identifier, the model, the tools. */
  validate(
    id: string,
    definition: AgentFileDefinition,
  ): AgentFileProblem | undefined | Promise<AgentFileProblem | undefined>;
  /** The definition as the source holds it now, read from the source and not from the last scan. */
  read(id: string): Promise<DefinitionEntry | undefined>;
  /** Reload the source after a write; resolves once the catalog reflects it, rejects if it cannot. */
  refresh(): Promise<void>;
  /**
   * Called before a write reaches the source, with the hash the bytes will have and who is saving
   * them (COR-1815), so the version the catalog records for that hash names the saver and not the
   * watcher that may see the file first. Returns the call that ends the declaration, which the
   * writer makes once the write has settled, whatever its outcome.
   */
  expectSave?(id: string, hash: string, savedBy: string | undefined): () => void;
}

/** Who is saving a write, for the version it produces. */
export interface AgentFileSaveOptions {
  /**
   * The principal saving the file, recorded as the version's `savedBy`. Omitted, the write is
   * recorded as made by the deployment's anonymous local owner: a write through the writer is
   * never recorded as an edit outside it.
   */
  readonly savedBy?: string | undefined;
}

/** What a successful write reports: the identifier and the hash of the file now on disk. */
export interface AgentFileWriteResult {
  readonly id: string;
  readonly hash: string;
}

export interface AgentFileWriter {
  /** The file's text and hash, or `undefined` when there is no such file. */
  read(id: string): Promise<{ readonly hash: string; readonly text: string } | undefined>;
  create(
    id: string,
    definition: AgentFileDefinitionInput,
    options?: AgentFileSaveOptions,
  ): Promise<AgentFileWriteResult>;
  update(
    id: string,
    definition: AgentFileDefinitionInput,
    options: { readonly expectedHash: string } & AgentFileSaveOptions,
  ): Promise<AgentFileWriteResult>;
  delete(id: string, options: { readonly expectedHash: string }): Promise<AgentFileWriteResult>;
  /**
   * COR-1873 — copy the plugin agent `id` (`plugin:name`) into the owner's source as `name.md`,
   * an agent the owner can edit. A tool the file names with a pinned version (`plugin:tool@1.2.0`)
   * is written unversioned (`plugin:tool`), so the copy uses whichever version is loaded. Refuses
   * with `agent-file-exists` when the owner already has `name`, `agent-file-not-found` when there is
   * no such plugin agent, and `agent-file-has-references` for an agent whose `references` name
   * documents beside the plugin's files, which the copy could not read.
   */
  duplicate(id: string, options?: AgentFileSaveOptions): Promise<AgentFileWriteResult>;
}

/** `name` without a pinned `@version`: files float to whichever version is loaded (COR-1873). */
function unversioned(name: string): string {
  const at = name.indexOf('@');
  return at === -1 ? name : name.slice(0, at);
}

function refuse(problem: AgentFileProblem): never {
  throw new AgentFileError(problem.code, problem.message, problem);
}

export function createAgentFileWriter(dependencies: AgentFileWriterDependencies): AgentFileWriter {
  const { source } = dependencies;
  let tail: Promise<unknown> = Promise.resolve();
  /** Run `work` after every earlier write has settled: writes are serialized in this process. */
  function exclusive<T>(work: () => Promise<T>): Promise<T> {
    const result = tail.then(work, work);
    tail = result.catch(() => undefined);
    return result;
  }

  /** The error for a source that found the file in a state the caller did not expect. */
  function conflictOf(error: SourceConflictError): AgentFileError {
    const { id, expectedHash, actualHash } = error;
    if (actualHash === null) {
      return new AgentFileError('agent-file-not-found', `There is no agent file for "${id}".`);
    }
    return expectedHash === null
      ? new AgentFileConflictError(
          'agent-file-exists',
          `An agent file for "${id}" already exists.`,
          actualHash,
        )
      : new AgentFileConflictError(
          'agent-file-changed',
          `The file for "${id}" has changed since it was read.`,
          actualHash,
        );
  }

  async function throughSource<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof SourceReadOnlyError) throw readOnly(error.id, error.plugin);
      throw error instanceof SourceConflictError ? conflictOf(error) : error;
    }
  }

  /** The refusal of a write to an agent a plugin's read-only layer holds (COR-1873). */
  function readOnly(id: string, plugin: string): AgentFileError {
    return new AgentFileError('agent-file-read-only', new SourceReadOnlyError(id, plugin).message);
  }

  /** The file's bytes, which must still hold `expectedHash`. */
  async function readExisting(id: string, expectedHash: string): Promise<Uint8Array> {
    const entry = await dependencies.read(id);
    if (entry === undefined) throw conflictOf(new SourceConflictError(id, expectedHash, null));
    if (entry.problem !== undefined) {
      throw new AgentFileError(
        'agent-file-unreadable',
        `The file for "${id}" cannot be read: ${entry.problem.message}`,
      );
    }
    if (entry.hash !== expectedHash) {
      throw conflictOf(new SourceConflictError(id, expectedHash, entry.hash));
    }
    return entry.bytes;
  }

  /** Replace the file, which must still hold `expectedHash`, with `bytes`. */
  async function replace(
    id: string,
    bytes: Uint8Array,
    expectedHash: string | null,
    savedBy: string | undefined,
  ): Promise<AgentFileWriteResult> {
    // Declared before the source sees the bytes: a watcher that scans the new file in the gap
    // between the write and this call would otherwise record it as an edit made outside the writer.
    const endSave = dependencies.expectSave?.(id, hashAgentFileBytes(bytes), savedBy);
    try {
      const written = await throughSource(() => source.write(id, bytes, { expectedHash }));
      await dependencies.refresh();
      return { id, hash: written.hash };
    } finally {
      endSave?.();
    }
  }

  function checkIdentifier(id: string): void {
    // A plugin's agent is never written, whether or not the plugin is loaded (COR-1873).
    if (isNamespacedIdentifier(id)) throw readOnly(id, id.slice(0, id.indexOf(':')));
    const problem = checkAgentIdentifier(id);
    if (problem !== undefined) refuse(problem);
  }

  /** The copy of the plugin agent `id` the owner's `name.md` holds. */
  async function duplicateBytes(id: string): Promise<{ name: string; bytes: Uint8Array }> {
    if (!isNamespacedIdentifier(id)) {
      throw new AgentFileError(
        'invalid-identifier',
        `"${id}" is not a plugin's agent: only a plugin:name agent can be duplicated.`,
      );
    }
    const name = id.slice(id.indexOf(':') + 1);
    const entry = await dependencies.read(id);
    if (entry === undefined) throw conflictOf(new SourceConflictError(id, '', null));
    if (entry.problem !== undefined) {
      throw new AgentFileError(
        'agent-file-unreadable',
        `The file for "${id}" cannot be read: ${entry.problem.message}`,
      );
    }
    const text = decodeAgentFile(entry.bytes);
    const parsed = text === undefined ? undefined : parseAgentFile(id, text);
    if (parsed === undefined || !parsed.ok) {
      throw new AgentFileError(
        'agent-file-unreadable',
        `The file for "${id}" cannot be read as an agent file, so it cannot be duplicated.`,
        parsed?.ok === false ? parsed.problem : undefined,
      );
    }
    const { definition, raw } = parsed.file;
    if (definition.references !== undefined && definition.references.length > 0) {
      throw new AgentFileError(
        'agent-file-has-references',
        `"${id}" names reference documents that sit beside the plugin's files, so it cannot be duplicated.`,
      );
    }
    const input = agentFileInputOf(definition);
    const toolApproval =
      definition.toolApproval === undefined
        ? null
        : Object.fromEntries(
            Object.entries(definition.toolApproval).map(([tool, mode]) => [
              unversioned(tool),
              mode,
            ]),
          );
    const bytes =
      serializeUpdatedAgentFile(name, parsed.file, {
        ...input,
        // A file without a `name` is labelled by its identifier, which the copy changes.
        name: Object.hasOwn(raw, 'name') ? definition.name : undefined,
        tools: definition.tools.map(unversioned),
        toolApproval,
      }) ?? entry.bytes;
    return { name, bytes };
  }

  /** Refuse unless `bytes` would load as a usable agent named `id`. */
  async function checkWritable(id: string, bytes: Uint8Array): Promise<void> {
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
    const problem = await dependencies.validate(id, parsed.file.definition);
    if (problem !== undefined) refuse(problem);
  }

  return {
    async read(id) {
      // A plugin's agent can be read, only not written.
      if (!isNamespacedIdentifier(id)) checkIdentifier(id);
      const entry = await dependencies.read(id);
      if (entry === undefined) return undefined;
      if (entry.problem !== undefined) {
        throw new AgentFileError(
          'agent-file-unreadable',
          `The file for "${id}" cannot be read: ${entry.problem.message}`,
        );
      }
      const text = decodeAgentFile(entry.bytes);
      if (text === undefined) {
        throw new AgentFileError('not-utf8', `The file for "${id}" is not valid UTF-8.`);
      }
      return { hash: entry.hash, text };
    },

    create(id, definition, saveOptions) {
      return exclusive(async () => {
        checkIdentifier(id);
        const bytes = serializeNewAgentFile(definition);
        await checkWritable(id, bytes);
        return replace(id, bytes, null, saveOptions?.savedBy);
      });
    },

    update(id, definition, { expectedHash, savedBy }) {
      return exclusive(async () => {
        checkIdentifier(id);
        const current = await readExisting(id, expectedHash);
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
        const { definition: before } = parsed.file;
        const problem = await dependencies.validate(
          id,
          resolveAgentFileDefinition(id, {
            ...definition,
            // A key the update leaves out keeps the file's value, and is checked as the file has it.
            ...(definition.compaction === undefined ? { compaction: before.compaction } : {}),
            ...(definition.references === undefined ? { references: before.references } : {}),
          }),
        );
        if (problem !== undefined) refuse(problem);
        const next = serializeUpdatedAgentFile(id, parsed.file, definition);
        if (next === undefined) return { id, hash: expectedHash };
        await checkWritable(id, next);
        return replace(id, next, expectedHash, savedBy);
      });
    },

    duplicate(id, saveOptions) {
      return exclusive(async () => {
        const { name, bytes } = await duplicateBytes(id);
        checkIdentifier(name);
        await checkWritable(name, bytes);
        return replace(name, bytes, null, saveOptions?.savedBy);
      });
    },

    delete(id, { expectedHash }) {
      return exclusive(async () => {
        checkIdentifier(id);
        await throughSource(() => source.delete(id, { expectedHash }));
        await dependencies.refresh();
        return { id, hash: expectedHash };
      });
    },
  };
}
