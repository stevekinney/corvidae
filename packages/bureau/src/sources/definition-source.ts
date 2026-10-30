/**
 * Where Bureau gets agent and workflow definitions from (COR-1702). A {@link DefinitionSource}
 * hands Bureau the raw bytes of each definition and takes bytes back; Bureau keeps parsing,
 * validation, snapshots, revisions, and the write-through operations.
 *
 * This module has no file-system imports on purpose: Bureau's main entry imports it for the
 * types and for {@link SourceConflictError}, and the Node-only directory sources live behind the
 * `@lostgradient/bureau/sources` subpath.
 *
 * @module definition-source
 */

import { createHash } from 'node:crypto';

import type { RuntimeServices } from '@lostgradient/lifecycle';
import type { Tool } from 'armorer';

/**
 * Why a source could not hand over a definition's bytes. The definition is still listed, as
 * `invalid`, and never runs.
 */
export interface DefinitionEntryProblem {
  /** `file-too-large` for a definition over the source's size cap; `unreadable` when its bytes could not be read. */
  readonly code: 'file-too-large' | 'unreadable';
  /** For `file-too-large`, the size in bytes; for `unreadable`, the reason the read failed. */
  readonly message: string;
  /** The size in bytes, for `file-too-large`. */
  readonly size?: number;
}

/**
 * One definition a source holds.
 *
 * A source may attach a {@link DefinitionEntry.problem} instead of bytes (an extension of the
 * contract the directory sources need, so a file over the size cap is listed as invalid and never
 * read into memory); `bytes` is then empty and `hash` is the empty string.
 */
export interface DefinitionEntry {
  /** The filename stem for a directory source. */
  readonly id: string;
  readonly bytes: Uint8Array;
  /** The SHA-256, as lowercase hex, of `bytes`, computed by the source. */
  readonly hash: string;
  readonly modifiedAt?: string;
  /** Set when the source could not hand over the definition's bytes. */
  readonly problem?: DefinitionEntryProblem;
  /**
   * The plugin whose read-only layer holds the definition (COR-1873); its `id` is then
   * `plugin:name`. Absent for an owner's definition, whose `id` is a bare stem.
   */
  readonly plugin?: string;
}

/** What changed in one report from {@link DefinitionSource.watch}, by identifier. */
export interface DefinitionSourceChange {
  readonly added: string[];
  readonly changed: string[];
  readonly removed: string[];
}

/** What Bureau lends a source when it starts using it. */
export interface DefinitionSourceHost {
  /** The runtime services the source's timers should use. */
  readonly runtime: RuntimeServices;
  /** Where watcher and scan failures are reported. */
  readonly diagnose: (message: string, cause: unknown) => void;
}

/** A place definitions are loaded from, watched in, and written back to. */
export interface DefinitionSource {
  /**
   * The plugin whose read-only layer this is (COR-1873). Its definitions are listed as
   * `plugin:name`, and `write` and `delete` reject with a {@link SourceReadOnlyError}. Absent for
   * an owner's source.
   */
  readonly plugin?: string | undefined;
  /** Every definition the source holds right now. */
  load(): Promise<readonly DefinitionEntry[]>;
  /**
   * Tell `listener` about changes made outside Bureau's own write-through. A report of a change
   * Bureau already made is harmless: Bureau reloads, and a reload is idempotent. A report may
   * list nothing: Bureau's catalogs depend on state outside the bytes (a revision record another
   * process raised), so a source that rescans on a timer calls the listener on every rescan, and
   * Bureau settles that state again. A listener may be called before `watch` returns. Returns the
   * unsubscribe.
   */
  watch(listener: (change: DefinitionSourceChange) => void): () => void;
  /**
   * Create (`expectedHash: null`) or replace the definition `id`. Rejects with a
   * {@link SourceConflictError}, writing nothing, when the definition's current hash is not
   * `expectedHash`.
   */
  write(
    id: string,
    bytes: Uint8Array,
    options: { expectedHash: string | null },
  ): Promise<DefinitionEntry>;
  /**
   * Remove the definition `id`. Rejects with a {@link SourceConflictError}, removing nothing,
   * when its current hash is not `expectedHash`.
   */
  delete(id: string, options: { expectedHash: string }): Promise<void>;
  /**
   * Called once by Bureau before it first loads, with the runtime and the diagnostics channel it
   * runs on. A source that was given its own keeps those.
   */
  attach?(host: DefinitionSourceHost): void;
}

/** The SHA-256 of a definition's bytes, as lowercase hex: the `hash` of a {@link DefinitionEntry}. */
export function hashDefinitionBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** A write or delete that found the definition in a different state than the caller expected. */
export class SourceConflictError extends Error {
  readonly id: string;
  /** The hash the caller expected, or `null` when it expected the definition not to exist. */
  readonly expectedHash: string | null;
  /** The hash the definition has, or `null` when it does not exist. */
  readonly actualHash: string | null;

  constructor(id: string, expectedHash: string | null, actualHash: string | null) {
    super(
      `The definition "${id}" ${
        actualHash === null
          ? 'does not exist'
          : expectedHash === null
            ? 'already exists'
            : 'has changed since it was read'
      }.`,
    );
    this.name = 'SourceConflictError';
    this.id = id;
    this.expectedHash = expectedHash;
    this.actualHash = actualHash;
  }
}

/**
 * A write or delete of a definition a read-only layer holds (COR-1873): a plugin's definitions are
 * never changed in place. Duplicate one into the owner's source to edit it.
 */
export class SourceReadOnlyError extends Error {
  /** The `plugin:name` identifier the write or delete named. */
  readonly id: string;
  /** The plugin whose layer holds the definition. */
  readonly plugin: string;

  constructor(id: string, plugin: string) {
    super(
      `The definition "${id}" belongs to the plugin "${plugin}" and is read-only; duplicate it to edit a copy.`,
    );
    this.name = 'SourceReadOnlyError';
    this.id = id;
    this.plugin = plugin;
  }
}

/** What {@link AgentSource.readSibling} found at a path. */
export type SiblingRead =
  | {
      readonly kind: 'found';
      readonly bytes: Uint8Array;
      /**
       * An opaque token that changes when the document does (an ETag, or a file's size, inode and
       * modification time). A caller that kept the bytes passes it back as `unlessStamp`. Absent
       * when the source cannot tell.
       */
      readonly stamp?: string | undefined;
    }
  | { readonly kind: 'unchanged' }
  | { readonly kind: 'missing' }
  | { readonly kind: 'too-large'; readonly size: number };

/**
 * The source of agent definitions. Beyond the definitions themselves it reads the documents an
 * agent file's `references` name, which sit beside the definitions: see
 * {@link AgentSource.readSibling}. `tools` is the deployment's tool catalog: the tools an agent
 * definition may name, by the name it uses. Defaults to none. With a workflow source Bureau adds
 * `workflows-create`, `workflows-update`, `workflows-pause`, `workflows-resume`, and
 * `workflows-list`; a tool of the host's with one of those names is refused with `BureauError`
 * (`BAD_REQUEST`).
 */
export type AgentSource = DefinitionSource & {
  readonly kind: 'agent';
  readonly tools?: Readonly<Record<string, Tool>>;
  /**
   * Read the document at `path`, which is relative to the place the agent files live (the
   * directory, or the key prefix) and written with `/`. A path that is not a valid reference
   * path (`agentReferencePathProblem`: absolute, a `..` or dotfile segment, a backslash) is
   * refused with a `TypeError` before anything is read, so a source never reads outside its own
   * location. A document larger than `options.limit` bytes is reported as `too-large` without
   * being read in full where the source can tell; a document that is not there is `missing`.
   * Rejects when the document exists and cannot be read.
   *
   * With `options.unlessStamp` set to the `stamp` of an earlier `found`, a document whose stamp is
   * still that one is answered `unchanged` without its content being read: the caller keeps the
   * bytes it has. A source that cannot stamp a document ignores the option and reads it.
   */
  readSibling(
    path: string,
    options: {
      readonly limit: number;
      readonly unlessStamp?: string | undefined;
      /**
       * The agent whose `references` name the document (COR-1873). A layered source reads it from
       * the layer that holds that agent; a single source ignores it.
       */
      readonly definitionId?: string | undefined;
    },
  ): Promise<SiblingRead>;
  /**
   * How often, in milliseconds, the source looks for changes on its own: its poll interval. The
   * catalog reads an agent's reference documents again at this period, because nothing else
   * reports an edit to one. Absent when the source does not watch (`watch: false`), in which case
   * a document is read again by the next scan only.
   */
  readonly referencePollMilliseconds?: number | undefined;
};

/** The source of workflow definitions. */
export type WorkflowSource = DefinitionSource & { readonly kind: 'workflow' };
