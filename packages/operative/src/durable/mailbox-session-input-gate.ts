import type { RuntimeTimeoutHandle } from '@lostgradient/lifecycle';
import type { ApplicationCommandClaim, Mailbox } from '@lostgradient/weft';

import type {
  ClaimedSessionInput,
  SessionInputDelivery,
  SessionInputDeliveryMode,
  SessionInputGate,
  SessionInputPayload,
} from './types';

/** The most inputs one step boundary claims, so a deep backlog is delivered over several steps. */
export const MAILBOX_SESSION_INPUT_BATCH_LIMIT = 100;

/** How often a gate renews the leases it holds, a third of the mailbox's default 30 second visibility timeout. */
export const MAILBOX_SESSION_INPUT_RENEWAL_INTERVAL_MS = 10_000;

/** What a mailbox command means as a session input. */
export interface DecodedSessionInput {
  readonly payload: SessionInputPayload;
  readonly deliveryMode: SessionInputDeliveryMode;
}

/**
 * Where the state of each command's delivery lives, keyed by the command's
 * immutable identity.
 *
 * It is the authority that keeps delivery exactly-once: the mailbox only says a
 * command is still open, this says which run is delivering it and whether the
 * conversation already holds it.
 */
export interface SessionInputDeliveryStore {
  /**
   * Records `owner` as the run delivering each of `commandIds`, in one atomic
   * step, and reports the outcome for each:
   *
   * - `claimed`: no run had claimed it; `owner` now has.
   * - `owned`: `owner` had already claimed it and it is not yet promoted. The
   *   step that appended it did not survive, so the input is delivered again.
   * - `promoted`: it was already delivered; only its mailbox command is left to
   *   retire.
   * - `foreign`: a different run claimed it and has not promoted it. It must not
   *   be appended here.
   *
   * A record is never overwritten by a different owner.
   */
  claim(
    owner: string,
    commandIds: readonly string[],
  ): Promise<ReadonlyMap<string, SessionInputDeliveryClaim>>;
  /** Commits each delivery as promoted. Idempotent per command: a second call changes nothing. */
  promote(deliveries: readonly SessionInputDelivery[]): Promise<void>;
}

export type SessionInputDeliveryClaim = 'claimed' | 'owned' | 'promoted' | 'foreign';

/** Timers the gate renews its leases with. Defaults to the global ones. */
export interface MailboxSessionInputGateTimers {
  readonly setInterval: (callback: () => void, milliseconds?: number) => RuntimeTimeoutHandle;
  readonly clearInterval: (handle: RuntimeTimeoutHandle) => void;
}

export interface MailboxSessionInputGateOptions {
  /** The session's session-input mailbox, strictly FIFO in admission order. */
  readonly mailbox: Mailbox;
  /** Names the run this gate delivers for, in the delivery store's records. */
  readonly owner: string;
  /**
   * Reads one claimed command as a session input. Throwing marks the command
   * malformed: it is rejected without retry and never delivered.
   */
  readonly decode: (claim: ApplicationCommandClaim) => DecodedSessionInput;
  readonly deliveries: SessionInputDeliveryStore;
  /** Defaults to the global timers. */
  readonly timers?: MailboxSessionInputGateTimers | undefined;
  readonly renewalIntervalMs?: number | undefined;
  /** Receives a failure to renew a lease, which the gate otherwise only retries. */
  readonly onRenewalError?: ((error: unknown) => void) | undefined;
  /**
   * Stops the gate keeping its leases alive when it aborts, such as a host
   * shutting down with a step still generating. The leases then lapse and the
   * inputs are delivered by whichever run next reaches a boundary.
   */
  readonly signal?: AbortSignal | undefined;
}

/**
 * A {@link SessionInputGate} over a Weft mailbox (COR-1476).
 *
 * Delivery is a claim, a durable delivery record, a message in the checkpointed
 * step, then a settlement, and each hand-off is safe to repeat:
 *
 * - `claimPending` leases the mailbox head command by command (the mailbox
 *   yields a command's payload only to a claimant), then records this run as the
 *   one delivering each of them before anything is appended. A command another
 *   run already claimed is released, and so is everything behind it, so a run
 *   never appends an input a peer holds and never delivers out of order.
 * - The leases are renewed while the step generates, so a step that outlives the
 *   mailbox's visibility timeout does not hand the command to another claimant.
 * - `settle` commits the promotion, then acknowledges the lease. An
 *   acknowledgement that fails because the lease lapsed or this process
 *   restarted leaves the command open; the next boundary claims it again, finds
 *   it promoted, and retires it then.
 *
 * Order survives a crash: while any command is leased the gate returns nothing,
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
  const { mailbox, owner, decode, deliveries, onRenewalError } = options;
  const timers: MailboxSessionInputGateTimers = options.timers ?? {
    setInterval: (callback, milliseconds) => globalThis.setInterval(callback, milliseconds),
    clearInterval: (handle) => globalThis.clearInterval(handle as ReturnType<typeof setInterval>),
  };
  const renewalIntervalMs = options.renewalIntervalMs ?? MAILBOX_SESSION_INPUT_RENEWAL_INTERVAL_MS;
  const leases = new Map<string, string>();
  let renewal: { readonly handle: RuntimeTimeoutHandle } | undefined;
  const abandon = (): void => {
    stopRenewal();
    leases.clear();
  };

  function stopRenewal(): void {
    if (renewal === undefined) return;
    timers.clearInterval(renewal.handle);
    renewal = undefined;
    options.signal?.removeEventListener('abort', abandon);
  }

  async function renewLeases(): Promise<void> {
    for (const [commandId, attemptToken] of leases) {
      try {
        const result = await mailbox.renew({ commandId, attemptToken });
        // A lease that could not be renewed is gone; the delivery record, not
        // the lease, is what keeps a peer from appending the input.
        if (result.status !== 'renewed') leases.delete(commandId);
      } catch (error) {
        onRenewalError?.(error);
      }
    }
    if (leases.size === 0) stopRenewal();
  }

  function startRenewal(): void {
    if (renewal !== undefined || leases.size === 0 || options.signal?.aborted === true) return;
    renewal = { handle: timers.setInterval(() => void renewLeases(), renewalIntervalMs) };
    options.signal?.addEventListener('abort', abandon, { once: true });
  }

  async function release(claim: ApplicationCommandClaim, retry: boolean, message: string) {
    await mailbox.reject({
      commandId: claim.receipt.commandId,
      attemptToken: claim.attemptToken,
      failure: { reason: 'application', message },
      retry,
    });
  }

  return {
    async claimPending() {
      await mailbox.runMaintenance();
      const leased = await mailbox.list({
        states: ['claimed', 'cancellation-requested'],
        limit: 1,
      });
      if (leased.length > 0) return [];

      const claims: ApplicationCommandClaim[] = [];
      while (claims.length < MAILBOX_SESSION_INPUT_BATCH_LIMIT) {
        const result = await mailbox.claim();
        if (result.status !== 'claimed') break;
        claims.push(result.claim);
      }

      const decoded: { claim: ApplicationCommandClaim; id: string; input: DecodedSessionInput }[] =
        [];
      for (const claim of claims) {
        const id = claim.receipt.idempotencyKey;
        if (id === undefined) {
          await release(claim, false, 'session input has no id');
          continue;
        }
        try {
          decoded.push({ claim, id, input: decode(claim) });
        } catch (error) {
          await release(
            claim,
            false,
            error instanceof Error ? error.message : 'malformed session input',
          );
        }
      }
      if (decoded.length === 0) return [];

      const outcomes = await deliveries.claim(
        owner,
        decoded.map(({ claim }) => claim.receipt.commandId),
      );
      const claimedInputs: ClaimedSessionInput[] = [];
      let blocked = false;
      for (const { claim, id, input } of decoded) {
        const commandId = claim.receipt.commandId;
        const outcome = outcomes.get(commandId);
        if (blocked) {
          await release(claim, true, 'an earlier input is being delivered by another run');
        } else if (outcome === 'promoted') {
          await mailbox.acknowledge({ commandId, attemptToken: claim.attemptToken });
        } else if (outcome === 'claimed' || outcome === 'owned') {
          leases.set(commandId, claim.attemptToken);
          claimedInputs.push({
            id,
            commandId,
            deliveryMode: input.deliveryMode,
            payload: input.payload,
          });
        } else {
          blocked = true;
          await release(claim, true, 'another run is delivering this input');
        }
      }
      startRenewal();
      return claimedInputs;
    },

    async settle(delivered) {
      await deliveries.promote(delivered);
      for (const { commandId } of delivered) {
        const attemptToken = leases.get(commandId);
        if (attemptToken === undefined) continue;
        leases.delete(commandId);
        await mailbox.acknowledge({ commandId, attemptToken });
      }
      if (leases.size === 0) stopRenewal();
    },

    stepEnded() {
      stopRenewal();
    },

    dispose: abandon,
  };
}
