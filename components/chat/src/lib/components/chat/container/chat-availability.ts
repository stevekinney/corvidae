/**
 * What Chat draws in place of a conversation that is not available yet (COR-2285, rows V2 and V3):
 * a conversation that is still being read, one whose read was canceled, one that could not be read
 * and one that was deleted. The host says which one applies with the `availability` prop; Chat owns
 * the placeholders, the elapsed time and the words.
 */

/** A button the host wants drawn in an availability state. */
export interface ChatAvailabilityAction {
  /** What the button says, such as `All conversations`. */
  readonly label: string;
  /** Called when the button is activated, such as a client-side navigation to the list. */
  readonly onclick: () => void;
}

/** The words an availability state draws; a host replaces any of them, for its own wording or language. */
export interface ChatAvailabilityLabels {
  /** The status line while the conversation loads. The elapsed seconds follow it. Default `Loading conversation…`. */
  readonly loading: string;
  /** The status line once the read is slow. Default `Still loading. This is taking longer than usual.`. */
  readonly slow: string;
  /** The button that stops a slow read. Default `Cancel`. */
  readonly cancel: string;
  /** The title after the read was canceled. Default `Loading was canceled`. */
  readonly canceledTitle: string;
  /** The sentence under that title. Default `The conversation was not loaded. Nothing was lost.`. */
  readonly canceledDescription: string;
  /** The primary button after a cancel. Default `Retry`. */
  readonly retry: string;
  /** The title of a conversation that could not be read. Default `This conversation couldn’t be loaded`. */
  readonly errorTitle: string;
  /** The primary button of a conversation that could not be read. Default `Try again`. */
  readonly tryAgain: string;
  /** The title of a deleted conversation. Default `This conversation was deleted`. */
  readonly deletedTitle: string;
  /** The sentence under that title. Default `It no longer exists, so nothing more can be sent here.`. */
  readonly deletedDescription: string;
  /** What Send reads while the conversation loads and Send waits for it. Default `Loading…`. */
  readonly sendWaits: string;
  /** The unit that follows the elapsed number. Default `s`. */
  readonly secondsUnit: string;
}

/** The words Chat uses when the host sets none. */
export const DEFAULT_CHAT_AVAILABILITY_LABELS: ChatAvailabilityLabels = {
  loading: 'Loading conversation…',
  slow: 'Still loading. This is taking longer than usual.',
  cancel: 'Cancel',
  canceledTitle: 'Loading was canceled',
  canceledDescription: 'The conversation was not loaded. Nothing was lost.',
  retry: 'Retry',
  errorTitle: 'This conversation couldn’t be loaded',
  tryAgain: 'Try again',
  deletedTitle: 'This conversation was deleted',
  deletedDescription: 'It no longer exists, so nothing more can be sent here.',
  sendWaits: 'Loading…',
  secondsUnit: 's',
};

/** The seconds after which a read counts as slow, when the host sets none. */
export const DEFAULT_SLOW_AFTER_SECONDS = 10;

/**
 * What a host passes as `availability` while the conversation cannot be shown as it is.
 *
 * - `loading`: skeleton turns stand where the transcript will be, a status line reads `Loading
 *   conversation…` with the seconds so far, the composer stays and Send waits for the history, and
 *   once the read is slow the line says so, with the elapsed time and Cancel (`onCancel`).
 * - `canceled`: the read was canceled. The same placeholders give way to a state with a primary
 *   Retry (`onRetry`), and the composer still waits.
 * - `error`: the read failed. A Cinder `ErrorState` replaces the transcript and the composer. It names
 *   the `cause`, with a primary Try again (`onRetry`) and a secondary `allConversations`.
 * - `deleted`: the conversation no longer exists. A neutral `ErrorState` replaces the transcript and
 *   the composer, with `allConversations` as its primary button.
 */
export type ChatAvailability =
  | {
      kind: 'loading';
      /** Seconds after which the read counts as slow. Default `10`; `0` shows the slow state at once. */
      slowAfterSeconds?: number | undefined;
      /** Stops a slow read. Cancel is drawn only when this is set. */
      onCancel?: (() => void) | undefined;
      /** The words, any of which the host can replace. */
      labels?: Partial<ChatAvailabilityLabels> | undefined;
    }
  | {
      kind: 'canceled';
      /** Reads the conversation again. */
      onRetry: () => void;
      /** The way back to the list, drawn as a secondary button. */
      allConversations?: ChatAvailabilityAction | undefined;
      /** The words, any of which the host can replace. */
      labels?: Partial<ChatAvailabilityLabels> | undefined;
    }
  | {
      kind: 'error';
      /** Why the read failed, in plain words: what happened and that nothing was lost. */
      cause: string;
      /** Technical detail, such as a fault code, kept behind a disclosure. */
      detail?: string | undefined;
      /** Reads the conversation again; the primary button. */
      onRetry: () => void;
      /** The way back to the list, drawn as a secondary button. */
      allConversations?: ChatAvailabilityAction | undefined;
      /** The words, any of which the host can replace. */
      labels?: Partial<ChatAvailabilityLabels> | undefined;
    }
  | {
      kind: 'deleted';
      /** The way back to the list; the primary button. */
      allConversations: ChatAvailabilityAction;
      /** The words, any of which the host can replace. */
      labels?: Partial<ChatAvailabilityLabels> | undefined;
    };

/** Whether the state replaces the composer too: a conversation that failed or is gone has nothing to send to. */
export function availabilityReplacesComposer(availability: ChatAvailability | undefined): boolean {
  return availability?.kind === 'error' || availability?.kind === 'deleted';
}

/** The words for `availability`, with the host's own over the defaults. */
export function availabilityLabels(
  availability: ChatAvailability | undefined,
): ChatAvailabilityLabels {
  return { ...DEFAULT_CHAT_AVAILABILITY_LABELS, ...availability?.labels };
}

/** The elapsed time as the status line reads it, such as `12 s`. */
export function formatElapsedSeconds(seconds: number, unit: string): string {
  return `${Math.max(0, Math.trunc(seconds))} ${unit}`;
}

/** Whether a read that has run for `elapsedSeconds` counts as slow. */
export function isSlowRead(elapsedSeconds: number, slowAfterSeconds: number | undefined): boolean {
  return elapsedSeconds >= Math.max(0, slowAfterSeconds ?? DEFAULT_SLOW_AFTER_SECONDS);
}
