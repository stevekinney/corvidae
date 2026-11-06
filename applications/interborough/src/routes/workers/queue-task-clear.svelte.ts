/**
 * Clear all with an Undo (COR-2018, row 78u). Clearing a failed task deletes it and its payload for
 * good, and Weft keeps nothing to bring it back from, so the page holds the clear instead: the tasks
 * leave the list at once, a toast says so and offers Undo, and the requests go out only when the
 * toast goes without Undo. The toast has no timer and no close button, so that is when another Clear
 * all replaces it, or when the page is left (`flush`, which the route calls as it is torn down). Undo
 * puts the tasks back in the list and sends nothing, so a clear that was never committed (a closed
 * tab) deletes nothing.
 */
import { SvelteSet } from 'svelte/reactivity';

/** What the controller needs from the page. */
export interface TaskClearDependencies {
  /** Clears one failed task for good. */
  readonly clear: (operationId: string) => Promise<unknown>;
  /** Shows an Undo toast and returns its id; Undo calls `undo`. */
  readonly announce: (message: string, undo: () => void) => string | undefined;
  /** Removes a toast `announce` returned the id of. */
  readonly dismiss: (toastId: string) => void;
  /** Asks again for what the clear changed; resolves once the answers are in. */
  readonly refresh: () => Promise<unknown>;
  /** Called with the errors of the clears the server refused. */
  readonly refused: (errors: readonly unknown[]) => void;
}

interface StagedClear {
  readonly queue: string;
  readonly operationIds: readonly string[];
  toastId: string | undefined;
}

/** Holds failed tasks out of the lists while their Undo toast is up, and clears them when it ends. */
export class TaskClearController {
  readonly #hidden = new SvelteSet<string>();
  // Reactive, because the counts and the buttons the page derives from `hiddenCount` follow it.
  readonly #staged = new SvelteSet<StagedClear>();
  readonly #dependencies: TaskClearDependencies;

  constructor(dependencies: TaskClearDependencies) {
    this.#dependencies = dependencies;
  }

  /** The tasks held out of the lists, which a list leaves out while it draws its rows. */
  get hidden(): ReadonlySet<string> {
    return this.#hidden;
  }

  /** How many of `queue`'s tasks are held out of the lists, which its counts leave out. */
  hiddenCount(queue: string): number {
    let count = 0;
    for (const staged of this.#staged) {
      if (staged.queue === queue) count += staged.operationIds.length;
    }
    return count;
  }

  /**
   * Holds `operationIds` of `queue` out of the lists and offers Undo with `message`. A clear
   * already held is committed first: there is one toast at a time.
   */
  stage(queue: string, operationIds: readonly string[], message: string): void {
    void this.flush();
    if (operationIds.length === 0) return;
    const staged: StagedClear = { queue, operationIds, toastId: undefined };
    this.#staged.add(staged);
    for (const operationId of operationIds) this.#hidden.add(operationId);
    staged.toastId = this.#dependencies.announce(message, () => this.#undo(staged));
  }

  /** Sends every held clear now and takes their toasts down. */
  flush(): Promise<void> {
    const committing = [...this.#staged].map((staged) => this.#commit(staged));
    return Promise.all(committing).then(() => undefined);
  }

  #undo(staged: StagedClear): void {
    if (!this.#staged.delete(staged)) return;
    for (const operationId of staged.operationIds) this.#hidden.delete(operationId);
  }

  async #commit(staged: StagedClear): Promise<void> {
    if (!this.#staged.delete(staged)) return;
    if (staged.toastId !== undefined) this.#dependencies.dismiss(staged.toastId);
    const outcomes = await Promise.allSettled(
      staged.operationIds.map((operationId) => this.#dependencies.clear(operationId)),
    );
    const refused = outcomes.flatMap((outcome) =>
      outcome.status === 'rejected' ? [outcome.reason as unknown] : [],
    );
    // The lists are read again before the tasks come back into view, so a cleared task never
    // flickers into them between the request and the answer.
    await this.#dependencies.refresh().catch(() => undefined);
    for (const operationId of staged.operationIds) this.#hidden.delete(operationId);
    if (refused.length > 0) this.#dependencies.refused(refused);
  }
}
