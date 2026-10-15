/**
 * Per-workflow-id record of the claim generations (epochs) this engine
 * acquired and later lost to another engine. `WorkflowClaimRegistry` writes it
 * when a renewal finds a claim taken, or when a replacement claim is installed
 * over a generation whose durable epoch another engine had already moved past.
 * `lostClaim` reads it so the answer for one run generation survives a later
 * run reusing the same workflow id. In-memory and per-process, like the
 * takeover cooldown: a restart forgets it, and a fresh process holds no
 * generation to ask about.
 *
 * @module core/engine/workflow-claim-lost-generations
 */
export class WorkflowClaimLostGenerations {
  readonly #epochsByWorkflowId = new Map<string, Set<number>>();

  /** Remember that generation `epoch` of `workflowId` was lost to another engine. */
  record(workflowId: string, epoch: number): void {
    const epochs = this.#epochsByWorkflowId.get(workflowId);
    if (epochs === undefined) this.#epochsByWorkflowId.set(workflowId, new Set([epoch]));
    else epochs.add(epoch);
  }

  /**
   * A new claim is replacing the tracked generation `replacedEpoch` (when any).
   * That generation never reached `release` here. When the durable epoch the new
   * claim was minted from (`observedEpoch`) is not `replacedEpoch`, another
   * engine moved the epoch past it, so it is recorded lost before its entry
   * disappears. A matching epoch is this engine re-minting its own claim, which
   * supersedes the generation without losing it.
   */
  recordReplaced(
    workflowId: string,
    replacedEpoch: number | undefined,
    observedEpoch: number,
  ): void {
    if (replacedEpoch !== undefined && replacedEpoch !== observedEpoch) {
      this.record(workflowId, replacedEpoch);
    }
  }

  /** Whether generation `epoch` of `workflowId` was recorded lost. */
  has(workflowId: string, epoch: number): boolean {
    return this.#epochsByWorkflowId.get(workflowId)?.has(epoch) === true;
  }
}
