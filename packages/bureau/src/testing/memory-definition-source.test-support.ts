/**
 * An in-memory {@link DefinitionSource} for the source contract suite (COR-1702): the same contract
 * the directory sources keep, held in a map, with a hand-driven `watch` so a test decides when an
 * external change is reported.
 */
import {
  type AgentSource,
  type DefinitionEntry,
  type DefinitionSourceChange,
  hashDefinitionBytes,
  SourceConflictError,
  type WorkflowSource,
} from '../sources/definition-source.ts';

export interface MemoryDefinitionSource<TSource extends AgentSource | WorkflowSource> {
  readonly source: TSource;
  /** Change a definition from outside Bureau, reporting nothing. */
  set(id: string, text: string): void;
  /** Remove a definition from outside Bureau, reporting nothing. */
  remove(id: string): void;
  /** The text of a definition, or `undefined`. */
  text(id: string): string | undefined;
  /** Report a change to every watcher, as a source does when it sees one. */
  emit(change: Partial<DefinitionSourceChange>): void;
  /** How many watchers are subscribed. */
  readonly watchers: () => number;
  /** Run `hook` once, inside the next `write`, after its hash check and before it commits. */
  beforeCommit(hook: () => void): void;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function createMemoryDefinitionSource<TKind extends 'agent' | 'workflow'>(
  kind: TKind,
  extras: Record<string, unknown> = {},
): MemoryDefinitionSource<TKind extends 'agent' ? AgentSource : WorkflowSource> {
  const held = new Map<string, Uint8Array>();
  const listeners = new Set<(change: DefinitionSourceChange) => void>();
  let hook: (() => void) | undefined;

  function entryOf(id: string, bytes: Uint8Array): DefinitionEntry {
    return { id, bytes, hash: hashDefinitionBytes(bytes) };
  }

  const source = {
    kind,
    ...extras,
    async load() {
      return [...held].map(([id, bytes]) => entryOf(id, bytes));
    },
    watch(listener: (change: DefinitionSourceChange) => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async write(id: string, bytes: Uint8Array, options: { expectedHash: string | null }) {
      const current = held.get(id);
      const actual = current === undefined ? null : hashDefinitionBytes(current);
      if (actual !== options.expectedHash) {
        throw new SourceConflictError(id, options.expectedHash, actual);
      }
      const pending = hook;
      hook = undefined;
      pending?.();
      // The commit re-checks, as the directory source does just before its rename.
      const latest = held.get(id);
      const latestHash = latest === undefined ? null : hashDefinitionBytes(latest);
      if (latestHash !== options.expectedHash) {
        throw new SourceConflictError(id, options.expectedHash, latestHash);
      }
      held.set(id, bytes);
      return entryOf(id, bytes);
    },
    async delete(id: string, options: { expectedHash: string }) {
      const current = held.get(id);
      const actual = current === undefined ? null : hashDefinitionBytes(current);
      if (actual !== options.expectedHash) {
        throw new SourceConflictError(id, options.expectedHash, actual);
      }
      held.delete(id);
    },
  } as unknown as TKind extends 'agent' ? AgentSource : WorkflowSource;

  return {
    source,
    set: (id, text) => void held.set(id, encoder.encode(text)),
    remove: (id) => void held.delete(id),
    text: (id) => {
      const bytes = held.get(id);
      return bytes === undefined ? undefined : decoder.decode(bytes);
    },
    emit(change) {
      for (const listener of listeners) {
        listener({ added: [], changed: [], removed: [], ...change });
      }
    },
    watchers: () => listeners.size,
    beforeCommit: (next) => {
      hook = next;
    },
  };
}
