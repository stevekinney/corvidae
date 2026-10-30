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
 * The source of agent definitions. `tools` is the deployment's tool catalog: the tools an agent
 * definition may name, by the name it uses. Defaults to none. With a workflow source Bureau adds
 * `workflows-create`, `workflows-update`, `workflows-pause`, `workflows-resume`, and
 * `workflows-list`; a tool of the host's with one of those names is refused with `BureauError`
 * (`BAD_REQUEST`).
 */
export type AgentSource = DefinitionSource & {
  readonly kind: 'agent';
  readonly tools?: Readonly<Record<string, Tool>>;
};

/** The source of workflow definitions. */
export type WorkflowSource = DefinitionSource & { readonly kind: 'workflow' };
