import { HANG_GUARD_MILLISECONDS, afterAwakeTime } from './hang-guard.ts';

/** Hand control back for one full event-loop turn, then drain microtasks. */
export async function yieldEventLoopTurn(): Promise<void> {
  await new Promise<void>((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      channel.port2.close();
      resolve();
    };
    channel.port2.postMessage(undefined);
  });
  await Promise.resolve();
}

export interface WaitUntilOptions {
  /** What the wait is for, named in the failure. Defaults to `condition`. */
  message?: string;
  /**
   * Hands control back between checks. Defaults to one event-loop turn. A test that runs under
   * fake timers passes a turn that advances them.
   */
  yieldTurn?: () => Promise<void>;
  /** Awake time after which the wait fails. Only a test of the guard itself shortens it. */
  hangGuardMilliseconds?: number;
  /** Whether fake timers are installed, so awake time cannot be measured. Defaults to never. */
  fakeTimersActive?: () => boolean;
}

/**
 * Wait until `condition` holds, checking it between event-loop turns.
 *
 * This is the wait a test uses for something that must eventually happen, so its only deadline is
 * the awake-time hang guard (`HANG_GUARD_MILLISECONDS`): it fails when the condition never comes,
 * never because a loaded host needed more turns, or more milliseconds, than a fixed cap allowed.
 * A count of turns is a performance bound in disguise, since how many turns a round trip takes
 * depends on the machine. `scripts/check-load-sensitive-deadlines.ts` rejects the loop that
 * counts them.
 */
export async function waitUntil(
  condition: () => boolean | Promise<boolean>,
  options: WaitUntilOptions = {},
): Promise<void> {
  const {
    message = 'condition',
    yieldTurn = yieldEventLoopTurn,
    hangGuardMilliseconds = HANG_GUARD_MILLISECONDS,
    fakeTimersActive,
  } = options;
  let hung = false;
  const cancel = afterAwakeTime(
    hangGuardMilliseconds,
    () => {
      hung = true;
    },
    fakeTimersActive === undefined ? {} : { fakeTimersActive },
  );
  try {
    while (!(await condition())) {
      if (hung) {
        throw new Error(
          `waitUntil gave up after ${hangGuardMilliseconds}ms of awake time waiting for ${message}`,
        );
      }
      await yieldTurn();
    }
  } finally {
    cancel();
  }
}
