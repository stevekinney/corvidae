import type { RuntimeTimeoutHandle } from '@lostgradient/lifecycle';
import type { ApplicationCommandClaim, Mailbox } from '@lostgradient/weft';

import type { SessionInputDeliveryClaim } from './session-input-delivery-store';
import type {
  ClaimedSessionInput,
  SessionInputDeliveryMode,
  SessionInputGate,
  SessionInputPayload,
} from './types';

export type { SessionInputDeliveryClaim } from './session-input-delivery-store';

/** The most inputs one step boundary claims, so a deep backlog is delivered over several steps. */
export const MAILBOX_SESSION_INPUT_BATCH_LIMIT = 100;

/** How often a gate renews the leases it holds, a third of the mailbox's default 30 second visibility timeout. */
export const MAILBOX_SESSION_INPUT_RENEWAL_INTERVAL_MS = 10_000;

/** The longest the gate waits at a boundary for a released command's retry backoff to pass. */
export const MAILBOX_SESSION_INPUT_HELD_WAIT_LIMIT_MS = 1_000;

/** What a mailbox command means as a session input. */
export interface DecodedSessionInput {
  readonly payload: SessionInputPayload;
  readonly deliveryMode: SessionInputDeliveryMode;
}

/**
 * Where the gate records which run is delivering each command (see
 * `session-input-delivery-store.ts`). Promotion is not here: it commits with the
 * run's transcript, in the checkpoint write.
 */
export interface MailboxSessionInputDeliveries {
  /**
   * Records this gate's run as the one delivering each of `commandIds`, which
   * are in mailbox order, and reports the deliverable PREFIX of them. A command
   * missing from the result, and everything behind it, is not deliverable by this
   * run: another live run is delivering it.
   */
  claim(commandIds: readonly string[]): Promise<ReadonlyMap<string, SessionInputDeliveryClaim>>;
}

/** Timers the gate renews its leases with. Defaults to the global ones. */
export interface MailboxSessionInputGateTimers {
  readonly setInterval: (callback: () => void, milliseconds?: number) => RuntimeTimeoutHandle;
  readonly clearInterval: (handle: RuntimeTimeoutHandle) => void;
}

export interface MailboxSessionInputGateOptions {
  /** The session's session-input mailbox, strictly FIFO in admission order. */
  readonly mailbox: Mailbox;
  /**
   * Reads one claimed command as a session input. Throwing marks the command
   * malformed: it is rejected without retry and never delivered.
   */
  readonly decode: (claim: ApplicationCommandClaim) => DecodedSessionInput;
  readonly deliveries: MailboxSessionInputDeliveries;
  /** Defaults to the global timers. */
  readonly timers?: MailboxSessionInputGateTimers | undefined;
  readonly renewalIntervalMs?: number | undefined;
  /** The mailbox's clock. Defaults to `Date.now`. */
  readonly now?: (() => number) | undefined;
  /** Receives a failure the gate otherwise only retries or tolerates: a renewal, an acknowledgement, a release. */
  readonly onError?: ((error: unknown) => void) | undefined;
  /**
   * Disposes the gate when it aborts, such as a host shutting down with a step
   * still generating. The leases are released and the inputs are delivered by
   * whichever run next reaches a boundary.
   */
  readonly signal?: AbortSignal | undefined;
}

/**
 * A {@link SessionInputGate} over a Weft mailbox (COR-1476).
 *
 * Delivery is a claim, a durable delivery record, a message in the checkpointed
 * step, the promotion that commits with that transcript, then an acknowledgement.
 * Each hand-off is safe to repeat:
 *
 * - `claimPending` leases the mailbox head command by command (the mailbox
 *   yields a command's payload only to a claimant), then records this run as the
 *   one delivering the deliverable prefix of them before anything is appended.
 *   A command another live run is delivering is released, and so is everything
 *   behind it, without a record, so a run never appends an input a peer holds
 *   and never delivers out of order. A command already promoted is acknowledged
 *   and not returned.
 * - One timer per gate renews every held lease for as long as the gate holds any,
 *   across the whole step and its checkpoint writes, so a step that outlives the
 *   mailbox's visibility timeout does not hand the command to another claimant.
 * - `settle` only acknowledges: promotion already committed with the transcript.
 *   An acknowledgement that fails, or a process that died first, leaves the
 *   command open; the next boundary leases it, finds it promoted, and retires it.
 * - `dispose` rejects (for retry) every lease the gate still holds and stops the
 *   timer. It is called when the run ends, however it ends.
 *
 * Order survives a crash: while any command another gate leased is outstanding the gate returns nothing,
 * since the mailbox would otherwise skip the leased head and deliver a later
 * command first. It runs the mailbox's maintenance first so an expired lease is
 * released rather than blocking forever. A lease a crashed process still holds
 * therefore delays delivery by up to the visibility timeout.
 *
 * Several live runs on one session each drain the same mailbox. An input goes to
 * exactly one of them, and inputs are ordered within each run, not across runs.
 */
export function createMailboxSessionInputGate(
  options: MailboxSessionInputGateOptions,
): SessionInputGate {
  const { mailbox, decode, deliveries, onError } = options;
  const timers: MailboxSessionInputGateTimers = options.timers ?? {
    setInterval: (callback, milliseconds) => globalThis.setInterval(callback, milliseconds),
    clearInterval: (handle) => globalThis.clearInterval(handle as ReturnType<typeof setInterval>),
  };
  const renewalIntervalMs = options.renewalIntervalMs ?? MAILBOX_SESSION_INPUT_RENEWAL_INTERVAL_MS;
  const leases = new Map<string, string>();
  let renewal: { readonly handle: RuntimeTimeoutHandle } | undefined;
  let disposed = false;

  function stopRenewal(): void {
    if (renewal === undefined) return;
    timers.clearInterval(renewal.handle);
    renewal = undefined;
    options.signal?.removeEventListener('abort', onAbort);
  }

  async function renewLeases(): Promise<void> {
    for (const [commandId, attemptToken] of leases) {
      try {
        const result = await mailbox.renew({ commandId, attemptToken });
        // A lease that could not be renewed is gone; the delivery record, not
        // the lease, is what keeps a peer from appending the input.
        if (result.status !== 'renewed') leases.delete(commandId);
      } catch (error) {
        onError?.(error);
      }
    }
    if (leases.size === 0) stopRenewal();
  }

  function startRenewal(): void {
    if (renewal !== undefined || leases.size === 0 || disposed) return;
    const handle = timers.setInterval(() => void renewLeases(), renewalIntervalMs);
    // A lease kept alive for a run nobody is waiting on must not hold the
    // process open.
    (handle as { unref?: () => void } | null)?.unref?.();
    renewal = { handle };
    options.signal?.addEventListener('abort', onAbort, { once: true });
  }

  async function reject(claim: ApplicationCommandClaim, retry: boolean, message: string) {
    await mailbox.reject({
      commandId: claim.receipt.commandId,
      attemptToken: claim.attemptToken,
      failure: { reason: 'application', message },
      retry,
    });
  }

  async function dispose(): Promise<void> {
    disposed = true;
    stopRenewal();
    const held = [...leases];
    leases.clear();
    for (const [commandId, attemptToken] of held) {
      try {
        await mailbox.reject({
          commandId,
          attemptToken,
          failure: { reason: 'application', message: 'the run ended before delivering this input' },
          retry: true,
        });
      } catch (error) {
        onError?.(error);
      }
    }
  }

  function onAbort(): void {
    void dispose();
  }

  return {
    async claimPending() {
      if (disposed) return [];
      await mailbox.runMaintenance();
      // Leases this gate itself holds (an earlier ask in the same step) are not
      // in the way: they precede whatever is claimed now. Anyone else's are.
      const leased = await mailbox.list({
        states: ['claimed', 'cancellation-requested'],
        limit: MAILBOX_SESSION_INPUT_BATCH_LIMIT,
      });
      if (leased.some((receipt) => !leases.has(receipt.commandId))) return [];

      const claims: ApplicationCommandClaim[] = [];
      while (claims.length < MAILBOX_SESSION_INPUT_BATCH_LIMIT) {
        let result = await mailbox.claim();
        // A command just released (a run that ended, a lease that lapsed) is held
        // for its short retry backoff. Wait it out rather than skip a boundary,
        // or a run whose only boundary this is would end without it.
        if (result.status === 'held' && claims.length === 0) {
          const remaining = result.availableAt - (options.now ?? Date.now)();
          if (remaining <= MAILBOX_SESSION_INPUT_HELD_WAIT_LIMIT_MS) {
            const budget = Math.max(remaining, 0) + 20;
            // The mailbox measures its budget on its own clock, which a host may
            // hold still; the signal bounds the wait in real time regardless.
            await mailbox.waitForAvailable({
              timeoutMs: budget,
              pollIntervalMs: 10,
              signal: AbortSignal.timeout(budget + 50),
            });
            result = await mailbox.claim();
          }
        }
        if (result.status !== 'claimed') break;
        claims.push(result.claim);
      }

      const decoded: { claim: ApplicationCommandClaim; id: string; input: DecodedSessionInput }[] =
        [];
      for (const claim of claims) {
        const id = claim.receipt.idempotencyKey;
        if (id === undefined) {
          await reject(claim, false, 'session input has no id');
          continue;
        }
        // A cancellation that arrived while the command was being claimed is
        // honored before anything is appended.
        if (claim.signal.aborted) {
          await reject(claim, false, 'the input was cancelled before it was delivered');
          continue;
        }
        try {
          decoded.push({ claim, id, input: decode(claim) });
        } catch (error) {
          await reject(
            claim,
            false,
            error instanceof Error ? error.message : 'malformed session input',
          );
        }
      }
      if (decoded.length === 0) return [];

      const outcomes = await deliveries.claim(decoded.map(({ claim }) => claim.receipt.commandId));
      const claimedInputs: ClaimedSessionInput[] = [];
      let blocked = false;
      for (const { claim, id, input } of decoded) {
        const commandId = claim.receipt.commandId;
        const outcome = outcomes.get(commandId);
        if (outcome === undefined) blocked = true;
        if (blocked) {
          await reject(claim, true, 'another run is delivering this input or one before it');
        } else if (outcome === 'promoted') {
          await mailbox.acknowledge({ commandId, attemptToken: claim.attemptToken });
        } else {
          leases.set(commandId, claim.attemptToken);
          claimedInputs.push({
            id,
            commandId,
            deliveryMode: input.deliveryMode,
            payload: input.payload,
          });
        }
      }
      startRenewal();
      return claimedInputs;
    },

    async settle(delivered) {
      for (const { commandId } of delivered) {
        const attemptToken = leases.get(commandId);
        if (attemptToken === undefined) continue;
        leases.delete(commandId);
        try {
          await mailbox.acknowledge({ commandId, attemptToken });
        } catch (error) {
          // Promotion already committed with the transcript; an input left open
          // is retired by the next boundary, so this never fails the run.
          onError?.(error);
        }
      }
      if (leases.size === 0) stopRenewal();
    },

    dispose,
  };
}
