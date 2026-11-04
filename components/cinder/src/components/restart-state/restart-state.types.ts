import type { Snippet } from 'svelte';

/**
 * Where a restart stands, as the person sees it:
 *
 * - `'restarting'`: the host accepted the restart and is stopping and starting; progress by step.
 * - `'reconnecting'`: the host stopped and has not answered yet; the attempt count, with Retry now.
 * - `'failed'`: the host never answered; what to check, the command to start it again, and Keep
 *   waiting.
 */
export type RestartStatePhase = 'restarting' | 'reconnecting' | 'failed';

/** Props for the RestartState component. */
export type RestartStateProps = {
  /**
   * Whether the state is showing. It never closes itself: nothing the person can press dismisses
   * it, because the host is not answering and the page behind it would show nothing true. The page
   * closes it when the host is back, and says what applied in a banner.
   */
  open: boolean;
  /** Which of the three states to show. */
  phase: RestartStatePhase;
  /**
   * Heading of the state. Defaults to the phase's own words: "Restarting Interborough", "Waiting
   * for Interborough", "Interborough didn’t come back".
   */
  title?: string | undefined;
  /**
   * The sentence under the heading. `restarting` and `failed` name what is happening and what was
   * saved ("Unloading Web search. Running work picks up where it stopped; reviews stay waiting."),
   * so the page supplies them. `reconnecting` builds its own from `retryInSeconds`, `attempt` and
   * `maxAttempts` when this is left out.
   */
  description?: string | undefined;
  /**
   * The labels of the steps, in order, for `restarting`.
   * @default ["Saved your choice", "Stopped the server", "Starting Interborough", "Checking plugins"]
   */
  steps?: readonly string[];
  /**
   * How many of `steps` are done in `restarting`: the step at that index is in progress, and the
   * ones after it are waiting.
   * @default 0
   */
  currentStep?: number;
  /** The attempt under way in `reconnecting`, counted from 1. Fills that many segments of the meter. */
  attempt?: number | undefined;
  /**
   * How many attempts there are. The meter has this many segments.
   * @default 8
   */
  maxAttempts?: number;
  /** Seconds until the next automatic attempt in `reconnecting`. Adds "Trying again in 4 s." */
  retryInSeconds?: number | undefined;
  /**
   * Label of the button that tries at once in `reconnecting`.
   * @default "Retry now"
   */
  retryLabel?: string;
  /** Fired when the person asks to try at once. The button shows only when this is set. */
  onRetry?: (() => void) | undefined;
  /**
   * Heading of the checklist in `failed`.
   * @default "What to check"
   */
  checkTitle?: string;
  /**
   * What to check in `failed`, in plain words: that the host is still running and that its address
   * is reachable from this browser. Left out, the box does not show.
   */
  check?: string | undefined;
  /**
   * The error behind a failure, shown behind the `detailsLabel` disclosure in `failed`. Left out,
   * the disclosure does not show.
   */
  details?: Snippet | undefined;
  /**
   * Label of the disclosure for `details`.
   * @default "Show the error details"
   */
  detailsLabel?: string;
  /**
   * The exact command the host was launched with, in `failed`, with a Copy button: the way back
   * when the host that would restart itself is the one that is not answering. Left out, the line
   * does not show.
   */
  command?: string | undefined;
  /**
   * The words before `command`.
   * @default "Start it again from the terminal:"
   */
  commandLabel?: string;
  /**
   * Label of the button that copies `command`.
   * @default "Copy"
   */
  copyLabel?: string;
  /**
   * Label of the primary button in `failed`. There is no restart-again action, because the route
   * that restarts lives on the host that is not answering.
   * @default "Keep waiting"
   */
  keepWaitingLabel?: string;
  /** Fired when the person chooses to keep waiting. The button shows only when this is set. */
  onKeepWaiting?: (() => void) | undefined;
  /** Optional extra class on the underlying `<Modal>`. */
  class?: string;
};
