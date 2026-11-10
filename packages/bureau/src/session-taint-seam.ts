/**
 * How a session's guardrail taint is persisted and published (COR-2105).
 *
 * Bureau builds a fresh `createGuardrails` per run, so the taint it raises would reset on every
 * turn. A run of a session instead seeds each tracker it holds (Bureau's, the agent's, and the one
 * an agent override adds) from the session's `guardrailTaint` metadata, and each writes a new taint
 * back the moment it happens. A catalog dispatch has no session and keeps its taint per run.
 *
 * @module session-taint-seam
 */

import {
  persistedSessionTaintOf,
  readSessionTaint,
  SESSION_TAINT_METADATA_KEY,
  type JSONValue,
  type PersistedSessionTaint,
  type SessionStore,
  type SessionTaintedEvent,
  type SessionTaintOptions,
} from '@lostgradient/operative';

/** What a run of a session needs from the session's taint: where it starts, and where it writes. */
export type SessionTaintSeam = Required<Pick<SessionTaintOptions, 'onTainted' | 'runId'>> &
  Pick<SessionTaintOptions, 'initial'>;

/** The session a run belongs to, as far as its taint goes: its id and its stored metadata. */
export interface SessionTaintSource {
  readonly sessionId: string;
  readonly metadata: Readonly<Record<string, JSONValue>> | undefined;
}

/** What the Bureau tells a listener once a taint is first stored in a session. */
export interface SessionTaintPublication {
  readonly sessionId: string;
  readonly runId: string;
  readonly detector: string;
  readonly provenance: string;
  readonly confidence: number;
}

/** What {@link createSessionTaintSeam} reads and calls. */
export interface SessionTaintSeamDependencies {
  readonly store: SessionStore | undefined;
  readonly now: () => number;
  /** Called after the write that moved the session from untainted to tainted commits, once. */
  readonly publish: ((publication: SessionTaintPublication) => void) | undefined;
  readonly diagnose: (cause: unknown) => void;
}

/**
 * The seam for one run of `sessionId`: the taint the session already carries (`metadata`, read as
 * untainted when the key is absent) and an `onTainted` that writes a new one.
 *
 * The write is a compare-and-swap through `SessionStore.update`: it stores the taint only when the
 * session holds none, and publishes only from the write that did, so two trackers in one run, or
 * two runs of one session, publish `session.tainted` once between them. The write never rejects: a
 * failed one is diagnosed, and the run goes on tainted in memory.
 */
export function createSessionTaintSeam(
  dependencies: SessionTaintSeamDependencies,
  session: {
    readonly sessionId: string;
    readonly runId: string;
    readonly metadata: Readonly<Record<string, JSONValue>> | undefined;
  },
): SessionTaintSeam {
  const { store, now, publish, diagnose } = dependencies;
  const { sessionId, runId } = session;
  const initial: PersistedSessionTaint | undefined = readSessionTaint(session.metadata);
  return {
    ...(initial === undefined ? {} : { initial }),
    runId,
    onTainted: async (event: SessionTaintedEvent): Promise<void> => {
      if (store === undefined) return;
      const value = persistedSessionTaintOf(event, now(), runId);
      let stored = false;
      try {
        await store.update(sessionId, (current) => {
          // The updater can run again after a lost race, so it sets the flag every time.
          stored = false;
          if (current === undefined || readSessionTaint(current.metadata) !== undefined) {
            return undefined;
          }
          stored = true;
          return {
            ...current,
            metadata: { ...current.metadata, [SESSION_TAINT_METADATA_KEY]: { ...value } },
          };
        });
      } catch (error) {
        diagnose(error);
        return;
      }
      if (!stored) return;
      try {
        publish?.({
          sessionId,
          runId: value.runId,
          detector: value.detector,
          provenance: value.provenance,
          confidence: value.confidence,
        });
      } catch (error) {
        diagnose(error);
      }
    },
  };
}
