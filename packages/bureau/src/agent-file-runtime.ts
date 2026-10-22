/**
 * What a run of a file-based agent needs from Bureau (COR-1524): the snapshot it starts on, the
 * reference that keeps the snapshot while the run is retained, and the agent rebuilt from that
 * snapshot when the run is resumed. Everything here is a no-op for a code-defined agent.
 *
 * @module agent-file-runtime
 */

import type { AnyRunnableAgent } from './agent-catalog';
import { AgentSnapshotError } from './agent-file';
import {
  type AgentFileCatalog,
  type FileAgentBinding,
  readFileAgentBinding,
} from './agent-file-catalog';
import type { AgentRunReferenceEntry, AgentSnapshotStore } from './agent-snapshot-store';

/** What the durable engine says about a run, as reconciliation needs it. */
export type DurableRunState =
  | { readonly kind: 'active' }
  | { readonly kind: 'ended'; readonly at: string }
  | { readonly kind: 'absent' };

/**
 * How long a reference may sit with no run behind it before the run is taken for one that never
 * started and the reference is released: ten minutes. A durable run appears in the engine within
 * moments of its reference being written; a reference this old with none is a start that failed.
 */
export const UNSTARTED_RUN_REFERENCE_GRACE_MILLISECONDS = 10 * 60 * 1000;

/** A start of a run whose identifier another execution may also be claiming. */
export interface FileAgentStart {
  readonly binding: FileAgentBinding;
  /** The run is this execution's: tie it to the snapshot. */
  hold(runId: string): Promise<void>;
  /** The run will not exist: drop the snapshot if nothing holds it. */
  abandon(): Promise<void>;
}

export interface FileAgentRuntime {
  readonly files: AgentFileCatalog;
  readonly snapshots: AgentSnapshotStore;
  /**
   * Store the definition `agent` was built from and tie `runId` to it, for a run whose identifier
   * nothing else can claim. Resolves the binding for a file agent and `undefined` for any other.
   * Rejects when the snapshot cannot be written, so a run that could not be resumed is not started.
   */
  recordRunStart(agent: object, runId: string): Promise<FileAgentBinding | undefined>;
  /**
   * Store the definition `agent` was built from and return the start, without tying any run to
   * it: for a run whose identifier is claimed first (a child or a goal attempt), which holds the
   * start only once the claim is won and abandons it on every other path.
   */
  beginRunStart(agent: object): Promise<FileAgentStart | undefined>;
  /** Tie an already-bound run to its snapshot; for a session run, whose agent was resolved earlier. */
  recordBoundRun(binding: FileAgentBinding, runId: string): Promise<void>;
  /** Mark the run's reference settled, now or at `at`. Never rejects. */
  settleRun(runId: string, at?: string): Promise<void>;
  /** Drop the run's reference. Never rejects. */
  releaseRun(runId: string): Promise<void>;
  /**
   * The agent a run recorded, rebuilt from its snapshot with the model and tools resolved now. It
   * reports `revision`, the definition revision the run recorded, never the file's current one: a
   * snapshot is keyed by content, so a revision cannot be read back from it.
   */
  agentForRecordedRun(
    name: string,
    hash: string,
    revision?: number,
  ): Promise<{ readonly agent: AnyRunnableAgent; readonly binding: FileAgentBinding }>;
  /**
   * Settle or release every reference that is still open against what the durable engine says:
   * an ended run is settled at its end, a run the engine has no record of is released once its
   * reference is older than {@link UNSTARTED_RUN_REFERENCE_GRACE_MILLISECONDS}, and a run this
   * process is driving, or one still active, is left alone. This is what finishes a reference
   * whose in-process settlement never ran (a crash, a recovered run, an aborted start).
   */
  reconcile(input: {
    readonly now: number;
    readonly isLive: (runId: string) => boolean;
    readonly durableState: (reference: AgentRunReferenceEntry) => Promise<DurableRunState>;
  }): Promise<{ readonly settled: number; readonly released: number }>;
}

export function createFileAgentRuntime(options: {
  readonly files: AgentFileCatalog;
  readonly snapshots: AgentSnapshotStore;
  readonly diagnose: (message: string, cause: unknown) => void;
  /** Registers background work with the Bureau, so a test can wait for it to settle. */
  readonly track?: ((promise: Promise<unknown>, label: string) => void) | undefined;
}): FileAgentRuntime {
  const { files, snapshots } = options;
  const tracked = async (label: string, work: Promise<void>): Promise<void> => {
    const settled = work.catch((error: unknown) => {
      options.diagnose(`The agent snapshot step "${label}" failed.`, error);
    });
    options.track?.(settled, label);
    await settled;
  };
  return {
    files,
    snapshots,

    async recordRunStart(agent, runId) {
      const binding = readFileAgentBinding(agent);
      if (binding === undefined) return undefined;
      await snapshots.recordRun(binding, runId);
      return binding;
    },

    async beginRunStart(agent) {
      const binding = readFileAgentBinding(agent);
      if (binding === undefined) return undefined;
      const ticket = await snapshots.begin(binding);
      return { binding, hold: (runId) => ticket.hold(runId), abandon: () => ticket.abandon() };
    },

    async recordBoundRun(binding, runId) {
      await snapshots.recordRun(binding, runId);
    },

    settleRun(runId, at) {
      return tracked('agent-snapshot-settle', snapshots.settleRun(runId, at));
    },

    releaseRun(runId) {
      return tracked('agent-snapshot-release', snapshots.releaseRun(runId));
    },

    async agentForRecordedRun(name, hash, revision) {
      const snapshot = await snapshots.load(name, hash);
      if (snapshot === undefined) {
        throw new AgentSnapshotError(
          'snapshot-missing',
          name,
          hash,
          `The run recorded the definition of agent "${name}" at ${hash}, which is no longer stored, so it cannot be resumed.`,
        );
      }
      const agent = files.agentFromSnapshot(snapshot, revision);
      const binding = readFileAgentBinding(agent);
      if (binding === undefined) {
        throw new AgentSnapshotError(
          'snapshot-unresolvable',
          name,
          hash,
          `The snapshot of agent "${name}" did not build an agent.`,
        );
      }
      return { agent, binding };
    },

    async reconcile({ now, isLive, durableState }) {
      let settled = 0;
      let released = 0;
      for (const reference of await snapshots.unsettledReferences()) {
        if (isLive(reference.runId)) continue;
        try {
          const state = await durableState(reference);
          if (state.kind === 'active') continue;
          if (state.kind === 'ended') {
            await snapshots.settleRun(reference.runId, state.at);
            settled += 1;
          } else if (
            now - Date.parse(reference.startedAt) >
            UNSTARTED_RUN_REFERENCE_GRACE_MILLISECONDS
          ) {
            await snapshots.releaseRun(reference.runId);
            released += 1;
          }
        } catch (error) {
          options.diagnose(
            `Could not reconcile the agent snapshot reference of run "${reference.runId}".`,
            error,
          );
        }
      }
      return { settled, released };
    },
  };
}
