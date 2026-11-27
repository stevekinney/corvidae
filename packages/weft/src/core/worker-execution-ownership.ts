import type { WorkerLike } from '../workers/pool.ts';

export class WorkerExecutionOwnership {
  readonly #activeWorkersByWorkflowId = new Map<string, WorkerLike>();
  readonly #parkedWorkersByWorkflowId = new Map<string, WorkerLike>();
  readonly #activeWorkflowIdByWorker = new Map<WorkerLike, string>();
  readonly #cancelledWorkflowIds = new Set<string>();

  resetWorkflow(workflowId: string): void {
    this.#cancelledWorkflowIds.delete(workflowId);
  }

  markCancelled(workflowId: string): void {
    this.#cancelledWorkflowIds.add(workflowId);
  }

  consumeCancelled(workflowId: string): boolean {
    return this.#cancelledWorkflowIds.delete(workflowId);
  }

  getActiveWorker(workflowId: string): WorkerLike | undefined {
    return this.#activeWorkersByWorkflowId.get(workflowId);
  }

  getParkedWorker(workflowId: string): WorkerLike | undefined {
    return this.#parkedWorkersByWorkflowId.get(workflowId);
  }

  getTargetWorker(workflowId: string): WorkerLike | undefined {
    return this.getActiveWorker(workflowId) ?? this.getParkedWorker(workflowId);
  }

  setActive(workflowId: string, worker: WorkerLike): void {
    this.#activeWorkersByWorkflowId.set(workflowId, worker);
    this.#activeWorkflowIdByWorker.set(worker, workflowId);
  }

  releaseActive(workflowId: string): WorkerLike | undefined {
    const worker = this.#activeWorkersByWorkflowId.get(workflowId);
    if (!worker) return undefined;
    this.#activeWorkersByWorkflowId.delete(workflowId);
    this.#activeWorkflowIdByWorker.delete(worker);
    return worker;
  }

  parkActive(workflowId: string, worker: WorkerLike): boolean {
    if (this.#activeWorkersByWorkflowId.get(workflowId) !== worker) {
      return false;
    }
    this.#activeWorkersByWorkflowId.delete(workflowId);
    this.#activeWorkflowIdByWorker.delete(worker);
    this.#parkedWorkersByWorkflowId.set(workflowId, worker);
    return true;
  }

  activateParked(workflowId: string, worker: WorkerLike): boolean {
    if (this.#parkedWorkersByWorkflowId.get(workflowId) !== worker) {
      return false;
    }
    this.#parkedWorkersByWorkflowId.delete(workflowId);
    this.setActive(workflowId, worker);
    return true;
  }

  deleteParked(workflowId: string): void {
    this.#parkedWorkersByWorkflowId.delete(workflowId);
  }

  isWorkflowClosed(workflowId: string): boolean {
    return (
      !this.#activeWorkersByWorkflowId.has(workflowId) &&
      !this.#parkedWorkersByWorkflowId.has(workflowId)
    );
  }

  activeWorkflowIds(): string[] {
    return [...this.#activeWorkersByWorkflowId.keys()];
  }

  workflowIdsForWorker(worker: WorkerLike): string[] {
    const workflowIds: string[] = [];
    const activeWorkflowId = this.#activeWorkflowIdByWorker.get(worker);
    if (activeWorkflowId) {
      workflowIds.push(activeWorkflowId);
    }
    for (const [workflowId, parkedWorker] of this.#parkedWorkersByWorkflowId) {
      if (parkedWorker === worker) {
        workflowIds.push(workflowId);
      }
    }
    return workflowIds;
  }

  forgetWorkflow(workflowId: string): void {
    const activeWorker = this.#activeWorkersByWorkflowId.get(workflowId);
    if (activeWorker) {
      this.#activeWorkflowIdByWorker.delete(activeWorker);
    }
    this.#activeWorkersByWorkflowId.delete(workflowId);
    this.#parkedWorkersByWorkflowId.delete(workflowId);
    this.#cancelledWorkflowIds.delete(workflowId);
  }

  clear(): void {
    this.#activeWorkersByWorkflowId.clear();
    this.#parkedWorkersByWorkflowId.clear();
    this.#activeWorkflowIdByWorker.clear();
    this.#cancelledWorkflowIds.clear();
  }

  workerIsIdle(worker: WorkerLike): boolean {
    if (this.#activeWorkflowIdByWorker.has(worker)) {
      return false;
    }
    for (const parkedWorker of this.#parkedWorkersByWorkflowId.values()) {
      if (parkedWorker === worker) {
        return false;
      }
    }
    return true;
  }
}
