import { bootstrapWorkflowResultResolver } from '../handle-result.ts';
import type { EngineInternals } from '../internals.ts';
import { cleanupTerminalWorkflowImmediately, type TerminationCallbacks } from './cleanup.ts';

/**
 * A terminate that found the durable record already terminal (another engine, or an earlier
 * cancel, finished the run) writes nothing, but this engine may still hold the run's result waiter
 * and in-memory state, which no terminal commit of its own will ever settle. Settle the waiter from
 * the durable outcome and release the local state, so a cancel that loses to a terminal commit
 * elsewhere still leaves nothing waiting. A record that now belongs to a replacement run is left
 * alone: its waiter and state are the replacement's.
 */
export async function settleLocalWaiterFromTerminalRecord(
  internals: EngineInternals,
  workflowId: string,
  callbacks: TerminationCallbacks,
): Promise<void> {
  const waiter = internals.resultResolvers.get(workflowId);
  if (waiter === undefined) return;
  const outcome = await bootstrapWorkflowResultResolver(internals, workflowId, waiter);
  if (outcome === 'settled') cleanupTerminalWorkflowImmediately(internals, workflowId, callbacks);
}
