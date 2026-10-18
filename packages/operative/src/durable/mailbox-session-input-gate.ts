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

/** The states in which a command is leased by some gate. */
const LEASED_COMMAND_STATES: ReadonlySet<string> = new Set(['claimed', 'cancellation-requested']);
/** The states the mailbox counts as open: not yet terminal. */
const OPEN_COMMAND_STATES: ReadonlySet<string> = new Set([
  'accepted',
  'available',
  'claimed',
  'cancellation-requested',
]);

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
 *   An acknowledgement that fails leaves the lease with the gate and the
 *   command on the retirement list, which the next boundary retries before it
 *   looks for new input, so a peer run is never blocked past this run's next
 *   boundary; `dispose` releases what was never retired. A process that died
 *   first leaves the command open for the next boundary to lease, find
 *   promoted, and retire.
 * - `dispose` rejects (for retry) every lease the gate still holds and stops the
 *   timer. It is called when the run ends, however it ends.
 *
 * The invariant behind the four hand-offs: every lease the gate acquires ends
 * in exactly one of three states, acknowledged, released, or cancelled, by the
 * time `dispose()` resolves, unless the process dies first, or the release in
 * `dispose()` itself fails, in which case the lease lapses at the visibility
 * timeout: disposal is the end of the line, nothing retries after it, so it
 * clears the table before its release pass rather than keeping a lease
 * nobody will settle. The gate therefore
 * keeps a lease in its table from the claim until the mailbox call that
 * settles it (an acknowledgement or a rejection) has committed, and only
 * `settleLease` removes one: on failure the lease stays and is listed for
 * retirement, so the next boundary retries it or disposal releases it. The
 * gate also rechecks disposal after each await that follows a claim, before it
 * returns anything, and releases what it acquired while being disposed.
 *
 * A cancellation another process requests (a session deleted there) reaches a
 * leaseholder only through the `cancellationRequested` flag its renewal
 * reports, and by then the turn is in the conversation: `claimPending` returns
 * an input and the step appends it in the same turn, so renewal can only ever
 * report the cancellation after the append. The gate therefore keeps the lease
 * and changes nothing. The step's checkpoint write promotes the turn, and the
 * acknowledgement that follows closes the command, which the mailbox records
 * as `cancelled` for a cancellation-requested command; `dispose` closes it the
 * same way. The receipt reads `accepted` until that checkpoint commits and
 * `promoted` after it, never `canceled`: a turn the conversation holds is
 * delivered, whatever became of its command. The one check before the append
 * is at the end of `claimPending`, which re-reads each lease and drops a
 * command whose cancellation landed between the claim and the return.
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
  /**
   * Commands whose settlement failed, with the lease still held: the next
   * boundary retries them with an acknowledgement, or disposal releases them.
   */
  const awaitingRetirement = new Set<string>();
  let renewal: { readonly handle: RuntimeTimeoutHandle } | undefined;
  let disposed = false;

  function stopRenewal(): void {
    if (renewal === undefined) return;
    timers.clearInterval(renewal.handle);
    renewal = undefined;
  }

  async function renewLeases(): Promise<void> {
    for (const [commandId, attemptToken] of leases) {
      try {
        const result = await mailbox.renew({ commandId, attemptToken });
        // A lease that could not be renewed is gone; the delivery record, not
        // the lease, is what keeps a peer from appending the input. A renewed
        // lease stays, whether or not another process has asked for the
        // command's cancellation: the turn is already appended (see the module
        // doc), and the acknowledgement after the checkpoint closes it.
        if (result.status !== 'renewed') leases.delete(commandId);
      } catch (error) {
        onError?.(error);
      }
    }
    if (leases.size === 0) stopRenewal();
  }

  /**
   * The one way a lease leaves the table: `call` is the mailbox call that
   * settles the command, and the lease is deleted only once it has committed.
   * If it fails the lease stays, listed for retirement, so nothing in the table
   * ever describes a settlement the mailbox has not recorded. A lease disposal
   * cleared meanwhile is neither re-added nor deleted.
   */
  async function settleLease(
    commandId: string,
    call: (attemptToken: string) => Promise<unknown>,
  ): Promise<void> {
    const attemptToken = leases.get(commandId);
    if (attemptToken === undefined) return;
    try {
      await call(attemptToken);
    } catch (error) {
      onError?.(error);
      if (leases.get(commandId) === attemptToken) awaitingRetirement.add(commandId);
      return;
    }
    if (leases.get(commandId) === attemptToken) leases.delete(commandId);
    awaitingRetirement.delete(commandId);
  }

  /**
   * Retires the commands whose earlier settlement failed. An acknowledgement
   * closes a promoted command, and closes a cancellation-requested one as
   * `cancelled`, so one call settles either.
   */
  async function retireAwaiting(): Promise<void> {
    for (const commandId of awaitingRetirement) {
      if (!leases.has(commandId)) {
        awaitingRetirement.delete(commandId);
        continue;
      }
      await settleLease(commandId, (attemptToken) =>
        mailbox.acknowledge({ commandId, attemptToken }),
      );
    }
  }

  function startRenewal(): void {
    if (renewal !== undefined || leases.size === 0 || disposed) return;
    const handle = timers.setInterval(() => void renewLeases(), renewalIntervalMs);
    // A lease kept alive for a run nobody is waiting on must not hold the
    // process open.
    (handle as { unref?: () => void } | null)?.unref?.();
    renewal = { handle };
  }

  async function reject(claim: ApplicationCommandClaim, retry: boolean, message: string) {
    await mailbox.reject({
      commandId: claim.receipt.commandId,
      attemptToken: claim.attemptToken,
      failure: { reason: 'application', message },
      retry,
    });
  }

  /** Returns leases to the mailbox, for whichever run next reaches a boundary. */
  async function release(held: Iterable<readonly [string, string]>, message: string) {
    for (const [commandId, attemptToken] of held) {
      try {
        await mailbox.reject({
          commandId,
          attemptToken,
          failure: { reason: 'application', message },
          retry: true,
        });
      } catch (error) {
        onError?.(error);
      }
    }
  }

  async function dispose(): Promise<void> {
    disposed = true;
    stopRenewal();
    options.signal?.removeEventListener('abort', onAbort);
    const held = [...leases];
    leases.clear();
    awaitingRetirement.clear();
    await release(held, 'the run ended before delivering this input');
  }

  function onAbort(): void {
    void dispose();
  }

  options.signal?.addEventListener('abort', onAbort, { once: true });

  /**
   * Whether any command another gate leased is outstanding. Read by walking
   * the records the mailbox holds, newest first and resumed page by page,
   * never by one bounded listing: a listing examines a fixed number of index
   * entries, and a lease behind more retained records than that would read as
   * absent, letting this gate deliver a later command first. Open commands are
   * the newest, so the walk stops once it has seen as many open commands as
   * the mailbox's exhaustive open count, which bounds it to the open set. A
   * command admitted after that count was read has a sequence at or past the
   * lifetime admission count (sequences are dense from zero, one per
   * admission) and is skipped: it is newer than anything this call could
   * claim, so a lease on it is never ahead of what the claim returns.
   */
  async function leasedElsewhere(): Promise<boolean> {
    const { open, admitted } = await mailbox.capacity();
    if (open === 0) return false;
    let openSeen = 0;
    let afterSequence: number | undefined;
    for (;;) {
      const page = await mailbox.list({
        limit: MAILBOX_SESSION_INPUT_BATCH_LIMIT,
        reverse: true,
        ...(afterSequence === undefined ? {} : { afterSequence }),
      });
      if (page.length === 0) return false;
      for (const receipt of page) {
        if (receipt.sequence >= admitted || !OPEN_COMMAND_STATES.has(receipt.state)) continue;
        if (LEASED_COMMAND_STATES.has(receipt.state) && !leases.has(receipt.commandId)) return true;
        openSeen += 1;
        if (openSeen >= open) return false;
      }
      afterSequence = page.at(-1)!.sequence;
    }
  }

  /** A claim acquired while the gate was being disposed: nothing is left to hold it. */
  async function releaseIfDisposed(claims: readonly ApplicationCommandClaim[]): Promise<boolean> {
    if (!disposed) return false;
    await release(
      claims.map((claim) => [claim.receipt.commandId, claim.attemptToken] as const),
      'the run ended while claiming this input',
    );
    return true;
  }

  return {
    async claimPending() {
      if (disposed) return [];
      await mailbox.runMaintenance();
      await retireAwaiting();
      // Leases this gate itself holds (an earlier ask in the same step) are not
      // in the way: they precede whatever is claimed now. Anyone else's are.
      if (await leasedElsewhere()) return [];

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
      if (await releaseIfDisposed(claims)) return [];

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
      if (await releaseIfDisposed(decoded.map(({ claim }) => claim))) return [];
      const claimedInputs: ClaimedSessionInput[] = [];
      let blocked = false;
      for (const { claim, id, input } of decoded) {
        const commandId = claim.receipt.commandId;
        const outcome = outcomes.get(commandId);
        if (outcome === undefined) blocked = true;
        if (blocked) {
          await reject(claim, true, 'another run is delivering this input or one before it');
        } else if (outcome === 'promoted') {
          // Already in a transcript; only its command is left to retire. A failure
          // to retire it is never thrown out of this boundary: the lease is kept
          // and the command listed for retirement, so the next boundary retries
          // it, or disposal releases it.
          leases.set(commandId, claim.attemptToken);
          await settleLease(commandId, (attemptToken) =>
            mailbox.acknowledge({ commandId, attemptToken }),
          );
        } else if (leases.has(commandId)) {
          // A command this gate already returned and has not settled: its lease
          // lapsed under a step still running and was claimed again. The step in
          // flight holds the input, so keep the new lease for it and return nothing.
          leases.set(commandId, claim.attemptToken);
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
      // Disposal landed during the retirements above: nothing may hold what
      // this call leased, and nothing is returned for a step to append. A
      // release that fails here is reported and the lease kept, as
      // `settleLease` does everywhere, but with the gate disposed nothing
      // retries it: the lease lapses at the visibility timeout, the same
      // exception the module doc states for `dispose()` itself.
      if (disposed) {
        const acquired = decoded
          .map(({ claim }) => claim)
          .filter((claim) => leases.get(claim.receipt.commandId) === claim.attemptToken);
        for (const claim of acquired) {
          await settleLease(claim.receipt.commandId, (attemptToken) =>
            mailbox.reject({
              commandId: claim.receipt.commandId,
              attemptToken,
              failure: {
                reason: 'application',
                message: 'the run ended while claiming this input',
              },
              retry: true,
            }),
          );
        }
        return [];
      }
      // The only check before the append: a cancellation that landed between
      // the claim and this return is settled here, not delivered.
      const deliverable: ClaimedSessionInput[] = [];
      for (const claimed of claimedInputs) {
        const receipt = await mailbox.receipt(claimed.commandId);
        if (receipt?.state !== 'cancellation-requested') {
          deliverable.push(claimed);
          continue;
        }
        await settleLease(claimed.commandId, (attemptToken) =>
          mailbox.reject({
            commandId: claimed.commandId,
            attemptToken,
            failure: {
              reason: 'application',
              message: 'the input was cancelled before it was delivered',
            },
            retry: false,
          }),
        );
      }
      // Disposal landed during the re-reads above: it released and cleared
      // every lease it found, so nothing here is this gate's to deliver.
      if (disposed) return [];
      startRenewal();
      return deliverable;
    },

    async settle(delivered) {
      for (const { commandId } of delivered) {
        // Promotion already committed with the transcript, so a failure here
        // never fails the run: the lease stays with the gate and the command
        // is listed, and the next boundary retries the retirement, or disposal
        // releases it.
        await settleLease(commandId, (attemptToken) =>
          mailbox.acknowledge({ commandId, attemptToken }),
        );
      }
      if (leases.size === 0) stopRenewal();
    },

    dispose,
  };
}
