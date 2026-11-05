/**
 * The short wait between picking an answer and the run continuing with it.
 *
 * A one-click answer (a choice, a yes or no) cannot be taken back once the agent has it, so the
 * question holds the pick for a few seconds first: the person sees "Answered Staging · Undo (5 s)",
 * can undo, and the answer goes to the host when the count ends. The count pauses while focus or
 * the pointer is inside the question, so a person reading or reaching for Undo is never raced. An
 * answer still held when the question is torn down is sent at once, never dropped.
 *
 * The count is a number of ticks, not a deadline on the clock, so a throttled page lengthens the
 * wait instead of shortening it.
 */

/** How often the held count moves, in milliseconds. */
const TICK_MILLISECONDS = 100;

/** The answer a host takes: nothing, or whether it was accepted (`false` reopens the question). */
export type AnswerSendResult = void | boolean | Promise<void | boolean>;

/** Where a question's one-click answer is in its hold. */
export type AnswerHoldPhase = 'open' | 'held' | 'sent';

/** What {@link AnswerHold} needs from its question. */
export interface AnswerHoldOptions {
  /** How long a pick is held, in milliseconds. Zero or less sends a pick at once. */
  readonly milliseconds: () => number;
  /** Sends the held answer to the host. */
  readonly send: (value: unknown) => AnswerSendResult;
  /** Called when a pick becomes held and when it stops being held (undone or sent). */
  readonly onHoldChange?: ((held: boolean) => void) | undefined;
}

/** One held answer, from the pick to the send. */
export class AnswerHold {
  /** Where the answer is: open (nothing picked), held (counting down), or sent. */
  phase = $state<AnswerHoldPhase>('open');
  /** The answer being held or sent; `undefined` while the question is open. */
  value = $state.raw<unknown>(undefined);
  /** The words the person sees for the held answer ("Staging"). */
  label = $state('');
  /** Which choice was picked, so the grid can mark it; `undefined` for an answer with no choice. */
  pick = $state<string | number | undefined>(undefined);
  /** Whether the count is paused because focus or the pointer is inside the question. */
  paused = $state(false);
  /** Whether the host refused the last answer, so the question came back with an error. */
  failed = $state(false);

  #remaining = $state(0);
  #timer: ReturnType<typeof setInterval> | undefined;
  readonly #options: AnswerHoldOptions;

  /** @param options - The window, the send, and the hold-change callback. */
  constructor(options: AnswerHoldOptions) {
    this.#options = options;
  }

  /** Whole seconds left on the count, rounded up so the last second reads "1 s", never "0 s". */
  get seconds(): number {
    return Math.max(1, Math.ceil(this.#remaining / 1000));
  }

  /** Whether an answer is counting down and can still be undone. */
  get held(): boolean {
    return this.phase === 'held';
  }

  /**
   * Holds `value` (shown as `label`, picked at `pick`) for the window, or sends it at once when the
   * window is zero. Does nothing while an answer is already held or sent.
   */
  hold(value: unknown, label: string, pick?: string | number): void {
    if (this.phase !== 'open') return;
    this.failed = false;
    this.value = value;
    this.label = label;
    this.pick = pick;
    const window = this.#options.milliseconds();
    if (window <= 0) {
      this.#deliver();
      return;
    }
    this.phase = 'held';
    this.#remaining = window;
    this.#options.onHoldChange?.(true);
    this.#timer = setInterval(() => this.#tick(), TICK_MILLISECONDS);
  }

  /** Takes the held answer back; the question is open again. Does nothing once sent. */
  undo(): void {
    if (this.phase !== 'held') return;
    this.#stop();
    this.phase = 'open';
    this.value = undefined;
    this.pick = undefined;
    this.#options.onHoldChange?.(false);
  }

  /** Sends the held answer now, without waiting out the count. */
  flush(): void {
    if (this.phase !== 'held') return;
    this.#stop();
    this.#options.onHoldChange?.(false);
    this.#deliver();
  }

  /**
   * Puts a sent answer back as an open question, for a host that learned after the send that it was
   * refused (a failed request, a validation reason). Does nothing unless the answer was sent.
   */
  reopen(): void {
    if (this.phase !== 'sent') return;
    this.#reopen();
  }

  /** Pauses or resumes the count. */
  setPaused(paused: boolean): void {
    this.paused = paused;
  }

  /** Stops the count and sends a held answer, for a question that is going away. */
  destroy(): void {
    this.flush();
    this.#stop();
  }

  #tick(): void {
    if (this.paused) return;
    this.#remaining -= TICK_MILLISECONDS;
    if (this.#remaining <= 0) this.flush();
  }

  #stop(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  #deliver(): void {
    this.phase = 'sent';
    let result: AnswerSendResult;
    try {
      result = this.#options.send(this.value);
    } catch {
      this.#reopen();
      return;
    }
    if (result === undefined || result === true) return;
    if (result === false) {
      this.#reopen();
      return;
    }
    void this.#settle(result);
  }

  /** Waits for a host that answers asynchronously, and reopens the question if it refuses. */
  async #settle(result: Promise<void | boolean>): Promise<void> {
    try {
      if ((await result) === false) this.#reopen();
    } catch {
      this.#reopen();
    }
  }

  /** The host did not take the answer, so the question comes back for another try. */
  #reopen(): void {
    this.phase = 'open';
    this.value = undefined;
    this.pick = undefined;
    this.failed = true;
  }
}
