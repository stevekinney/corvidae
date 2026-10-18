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
import type { AgentSnapshotStore } from './agent-snapshot-store';

export interface FileAgentRuntime {
  readonly files: AgentFileCatalog;
  readonly snapshots: AgentSnapshotStore;
  /**
   * Store the definition `agent` was built from, and tie `runId` to it, before the run starts.
   * Resolves the binding for a file agent and `undefined` for any other. Rejects when the
   * snapshot cannot be written, so a run that could not be resumed is not started.
   */
  recordRunStart(agent: object, runId: string): Promise<FileAgentBinding | undefined>;
  /** Tie an already-bound run to its snapshot; for a session run, whose agent was resolved earlier. */
  recordBoundRun(binding: FileAgentBinding, runId: string): Promise<void>;
  /** Mark the run's reference settled. Never rejects. */
  settleRun(runId: string): Promise<void>;
  /** Drop the run's reference. Never rejects. */
  releaseRun(runId: string): Promise<void>;
  /** The agent a run recorded, rebuilt from its snapshot with the model and tools resolved now. */
  agentForRecordedRun(
    name: string,
    hash: string,
  ): Promise<{ readonly agent: AnyRunnableAgent; readonly binding: FileAgentBinding }>;
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

    async recordBoundRun(binding, runId) {
      await snapshots.recordRun(binding, runId);
    },

    settleRun(runId) {
      return tracked('agent-snapshot-settle', snapshots.settleRun(runId));
    },

    releaseRun(runId) {
      return tracked('agent-snapshot-release', snapshots.releaseRun(runId));
    },

    async agentForRecordedRun(name, hash) {
      const snapshot = await snapshots.load(name, hash);
      if (snapshot === undefined) {
        throw new AgentSnapshotError(
          'snapshot-missing',
          name,
          hash,
          `The run recorded the definition of agent "${name}" at ${hash}, which is no longer stored, so it cannot be resumed.`,
        );
      }
      const agent = files.agentFromSnapshot(snapshot);
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
  };
}
