import type { WorkspaceRuntimeAuthority } from '../http/workspace-principal.ts';
import { recoverRunWorkspaceAuthority } from '../run-authority.ts';
/**
 * The delivery of hook events (COR-1939), on the machinery the webhook notifier already has
 * ({@link WebhookDeliveryEngine}): its HTTP client, clock, retry schedule, abandonable backoff
 * wait, shutdown signal and liveness tracking. What a hook delivery adds is what the notifier's
 * fixed-trigger deliveries do not do: it signs the request, keeps the request and the response on
 * its record, and resumes after a restart.
 *
 * ## The fence
 *
 * Every write of a delivery record is a compare-and-swap on the text it read, so a writer that has
 * lost the record (another process resumed it, a stale generation) writes nothing and stops. An
 * attempt is written as `sending` before the request is made and closed when the outcome is known.
 * A record a restart finds with an attempt still `sending` has an unknown outcome: the attempt is
 * closed `interrupted`, counted against `maxAttempts`, and never sent again. The next send is a new
 * attempt with its own number, a new timestamp, and the same `Idempotency-Key`, so one attempt
 * record produces at most one HTTP request and a receiver that saw an interrupted attempt can drop
 * the repeat.
 *
 * A delivery holds a lease while a process drives it, refreshed on every write. A process that
 * stops cleanly releases it; one that crashes leaves it to expire, and `resume` takes only records
 * whose lease has. It finds them through the pending index (`hook-store.ts`), never by reading every
 * record. A restart inside that window finds the lease still live, so `resume` leaves the
 * record and schedules one tracked re-scan for the earliest expiry it skipped (and again for any
 * that remain); a shutdown abandons the wait. Without it such a delivery would stay pending until
 * some later restart. The lease is the longest an attempt may run (a plugin's reaction sets its own
 * `timeoutMilliseconds`, COR-2175), the longest backoff, and a margin, so a process still inside a
 * reaction's timeout is never taken over.
 *
 * A plugin's reaction is run with a signal that aborts on a shutdown, at its timeout, and when its
 * hook is disabled or deleted (`abortHook`). The attempt ends when it does, whether or not the
 * reaction looks at it: a timeout is an `error` attempt and is retried, a disable or delete ends the
 * delivery `aborted`, and a shutdown makes the attempt `interrupted`.
 *
 * ## Retry and the next attempt
 *
 * While a delivery waits out its backoff its record carries `nextAttemptAt`, dropped by the next
 * write. `retry` (COR-2022) sends the delivery again from its record, never from the hook as it is
 * now: a settled delivery is opened again with room for one more attempt, under the same fence,
 * and one waiting here has its wait cut short. A delivery is never copied, so its body, its
 * `X-Delivery-Id` and its `Idempotency-Key` stay the ones the receiver may already have seen.
 *
 * @module hook-delivery
 */

import type { PluginEvent } from '@lostgradient/interborough-plugin';

import { NOTIFICATION_FIELD_LIMITS } from '../notifications/notification-types.ts';
import type { WebhookDeliveryEngine } from '../webhook-notifier.ts';
import { type AnswerEncryptionKeys } from '../secret-answers.ts';
import { openHookSecret, type HookStore, type Stored } from './hook-store.ts';
import { signHookDelivery } from './hook-signature.ts';
import {
  HOOK_RESPONSE_EXCERPT_BYTES,
  HookActionError,
  NOTIFICATION_CREATED_EVENT_KIND,
  type HookActionReceipt,
  type HookDeliveryAttempt,
  type HookDeliveryRecord,
  type HookDeliveryRequest,
  type HookDeliveryStatus,
  type HookDeliveryWork,
  type HookRecord,
  type HookSecretStore,
} from './hook-types.ts';
import { type HookUrlPolicy, hookUrlDefect } from './hook-url-policy.ts';
import { withoutValues } from './secret-references.ts';

/** How long one request may take before it is given up as a network error. */
export const DEFAULT_HOOK_REQUEST_TIMEOUT_MILLISECONDS = 10_000;

/** The slack added to a lease beyond the longest request and backoff wait it must cover. */
const LEASE_MARGIN_MILLISECONDS = 5_000;

/** The longest error text kept on an attempt. */
const ERROR_TEXT_LIMIT = 500;

/**
 * Does what a `start-workflow` or `notify` delivery says. It checks the hook owner's authority
 * itself, so the check is made when the event fires and not only when the hook was written.
 */
export interface HookActionRunner {
  /**
   * Runs `work` for the hook's `owner`. Resolves what it made. Throws {@link HookActionError}, with
   * `permanent` set when a retry cannot change the answer (invalid input, a missing workflow, an
   * owner who may not start it); any other error is retried.
   */
  run(
    work: HookDeliveryWork,
    context: {
      readonly owner: string;
      readonly hookId: string;
      readonly deliveryId: string;
      /**
       * COR-2183 — which attempt this is, 1-based: the attempts the record holds plus one. An
       * attempt dropped because the plugin needs setup is not recorded, so its number comes again.
       */
      readonly attempt: number;
      /** COR-2183 — whether the delivery is a `hooks.test` one, which runs a reaction's `dryRun` instead of its `run`. */
      readonly test: boolean;
      /**
       * What stops the attempt: a shutdown, and for a plugin's reaction also its timeout and the hook
       * being disabled or deleted. The delivery ends the attempt when it aborts whether or not the
       * action looks at it.
       */
      readonly signal: AbortSignal;
      /**
       * The values the action resolved from secret references and put in its input (COR-2177). The
       * action adds each as it resolves it; the delivery removes them from any error text the
       * attempt keeps, whatever threw it.
       */
      readonly resolvedSecrets: Set<string>;
    },
  ): Promise<HookActionReceipt>;
}

/** What {@link createHookDeliveries} is built from. */
export interface HookDeliveryDependencies {
  /** Revalidated immediately before each external delivery attempt. */
  readonly workspace?: WorkspaceRuntimeAuthority | undefined;
  /** Runs the `start-workflow` and `notify` actions. */
  readonly actions: HookActionRunner;
  /** The notifier's delivery machinery. */
  readonly engine: WebhookDeliveryEngine;
  /** The hook and delivery records. */
  readonly store: HookStore;
  /** Where the sealed signing secrets are kept. */
  readonly secrets: HookSecretStore;
  /** The keys secrets are sealed with; `undefined` when the Bureau has none. */
  readonly keys: AnswerEncryptionKeys | undefined;
  /** Which URLs may be delivered to, checked again at send time. */
  readonly urlPolicy: HookUrlPolicy;
  /** How long one request may take. */
  readonly requestTimeoutMilliseconds: number;
  /** Mints delivery identifiers. */
  readonly newId: () => string;
  /** Records an exhausted delivery. Must not carry the URL: it may hold a token. */
  readonly audit: (entry: {
    readonly hookId: string;
    readonly owner: string;
    readonly deliveryId: string;
    readonly attempts: number;
    readonly status: HookDeliveryStatus;
  }) => Promise<void>;
  /** Reports a failure to write a record; never carries a secret. */
  readonly diagnose: (message: string, cause?: unknown) => void;
  /**
   * COR-1879 — the version of a plugin's hook action kind registered now, which a new delivery of
   * it pins; `undefined` when the kind is not registered or carries no version.
   */
  readonly actionKindVersion?: ((plugin: string, kind: string) => string | undefined) | undefined;
  /**
   * COR-2175 — the `timeoutMilliseconds` of a plugin's hook action kind registered now; `undefined`
   * when the kind is not registered or sets none, which gives it {@link requestTimeoutMilliseconds}.
   */
  readonly actionKindTimeout?: ((plugin: string, kind: string) => number | undefined) | undefined;
  /**
   * COR-2183 — the `maxAttempts` of a plugin's hook action kind registered now, which a new
   * delivery of it keeps on its record; `undefined` when the kind is not registered or sets none,
   * which gives the engine's. A test delivery makes one attempt whatever this says.
   */
  readonly actionKindMaxAttempts?:
    ((plugin: string, kind: string) => number | undefined) | undefined;
  /**
   * COR-2176 — whether a plugin's hook action kind can run now. A delivery of one that cannot (its
   * plugin needs setup) makes no attempt: its lease is released and it waits, `pending`, for the
   * next `resume`. Absent, or for a kind that is not registered, every kind is available; a missing
   * kind is a failed delivery, not a waiting one.
   */
  readonly actionKindAvailable?: ((plugin: string, kind: string) => boolean) | undefined;
  /**
   * An abort signal that fires after `milliseconds`. Defaults to `AbortSignal.timeout`; a test passes
   * one a controller ends, because the engine's `wait` is not a clock the tests share.
   */
  readonly timeoutSignal?: ((milliseconds: number) => AbortSignal) | undefined;
}

/** One event to deliver. */
export interface HookEventToDeliver {
  /** The event kind, or `hook.test`. */
  readonly kind: string;
  /** The Bureau that published it. */
  readonly bureauId: string;
  /** When the event was emitted, in epoch milliseconds. */
  readonly emittedAtMs: number;
  /** The event's projection. */
  readonly payload: Readonly<Record<string, unknown>>;
  /** The plugin whose contribution emitted the event; absent for an event from Bureau core. */
  readonly source?: string;
}

/**
 * A webhook request sent once to a hook that is not saved yet (COR-2022, `hooks.testDraft`): what
 * {@link HookDeliveries.sendDraft} signs and sends, and writes nowhere.
 */
export interface HookDraftToSend {
  /** Stands in for the hook's identifier in the body and the `X-Hook-Id` header. */
  readonly hookId: string;
  /** The principal the draft would belong to. */
  readonly owner: string;
  /** The owner's workspace authority, revalidated before the request as for any delivery. */
  readonly workspaceAuthority?: HookRecord['workspaceAuthority'];
  /** Where the request is POSTed; the caller has already checked it against the URL policy. */
  readonly url: string;
  /** The secret the request is signed with. */
  readonly secret: string;
  /** The event the body carries: a `hook.test` message. */
  readonly event: HookEventToDeliver;
}

/** The delivery operations {@link createHookDeliveries} offers. */
export interface HookDeliveries {
  /**
   * Writes the pending delivery of `event` to `hook`, and returns its id. A `start-workflow` or
   * `notify` hook's delivery holds the work its action will do, mapped from the event now.
   * `test` is for a webhook, or a plugin reaction that has a `dryRun` (COR-2183): one attempt, which
   * runs the `dryRun` and never the `run`. `skip` is for a `start-workflow` hook: the delivery is written,
   * and fails at once with `skip` as its reason, without starting anything.
   */
  enqueue(
    hook: HookRecord,
    event: HookEventToDeliver,
    test: boolean,
    skip?: string,
  ): Promise<string>;
  /** Drives a delivery to a stop: delivered, exhausted, aborted, or released by a shutdown. Never rejects. */
  drive(deliveryId: string): Promise<void>;
  /**
   * Takes every pending delivery whose lease has expired, drives each to a stop, and resolves with
   * how many it took. A pending delivery whose lease is still live is taken by a tracked re-scan
   * when the lease expires; a shutdown cancels it.
   */
  resume(): Promise<number>;
  /**
   * Removes the settled deliveries last written more than `olderThanMilliseconds` ago and resolves
   * with how many it removed. A pending delivery is never removed, however old, and a delivery
   * that changed since it was read is left.
   */
  prune(olderThanMilliseconds: number): Promise<number>;
  /**
   * Sends a delivery again from its record (COR-2022): the request or work recorded when the
   * delivery was created, never one rebuilt from the hook as it is now, under the same
   * `Idempotency-Key` and signed with the hook's current secret. A settled delivery that was not
   * delivered is made `pending` again with room for one more attempt, which is made at once and
   * awaited. A `pending` delivery this process is waiting to retry has its backoff cut short and
   * is not awaited; one whose lease has expired is taken and driven, as `resume` would; one whose
   * attempt is in flight, here or in another process, is left as it is. A `delivered` delivery,
   * and one that is not stored, are left as they are.
   */
  retry(deliveryId: string): Promise<void>;
  /**
   * Aborts the signal of every plugin attempt of `hookId` that is in flight in this process (COR-2175):
   * the hook was disabled or deleted, so its delivery ends `aborted` without another attempt. An
   * attempt in another process, a webhook request, and a delivery waiting out a backoff are not
   * touched; the last is seen at its next pass.
   */
  abortHook(hookId: string): void;
  /**
   * Signs and sends one webhook request for a hook that is not saved (COR-2022), and resolves with
   * the delivery it would have recorded: one attempt, no retry. Nothing is written: no hook,
   * delivery, secret or pending index key.
   */
  sendDraft(draft: HookDraftToSend): Promise<HookDeliveryRecord>;
}

/**
 * The request a webhook delivery sends, without its signature, built once when the delivery is
 * created and kept on its record, so every attempt and every retry sends this text.
 */
function webhookRequestOf(
  deliveryId: string,
  hookId: string,
  url: string,
  event: HookEventToDeliver,
  test: boolean,
): HookDeliveryRequest {
  return {
    url,
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'corvidae-hooks/1',
      'X-Hook-Id': hookId,
      'X-Delivery-Id': deliveryId,
      'Idempotency-Key': deliveryId,
      'X-Event-Kind': event.kind,
    },
    body: JSON.stringify({
      id: deliveryId,
      hookId,
      kind: event.kind,
      bureauId: event.bureauId,
      emittedAtMs: event.emittedAtMs,
      test,
      payload: event.payload,
      ...(event.source === undefined ? {} : { source: event.source }),
    }),
  };
}

/** `text` with every occurrence of `secret` removed. */
function scrubbed(text: string, secret: string): string {
  return text.split(secret).join('[redacted]');
}

/** The first {@link HOOK_RESPONSE_EXCERPT_BYTES} bytes of a response body, and whether there were more. */
async function readExcerpt(
  response: Response,
  secret: string,
): Promise<Pick<HookDeliveryAttempt, 'responseExcerpt' | 'responseTruncated'>> {
  if (response.body === null) return {};
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total <= HOOK_RESPONSE_EXCERPT_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
    }
  } catch {
    // A body that fails mid-read leaves the part already read; the status is what matters.
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder().decode(bytes.subarray(0, HOOK_RESPONSE_EXCERPT_BYTES));
  return {
    responseExcerpt: scrubbed(text, secret).slice(0, HOOK_RESPONSE_EXCERPT_BYTES),
    responseTruncated: total > HOOK_RESPONSE_EXCERPT_BYTES,
  };
}

/** The event as a plugin's action and the `event` input shape see it: `source` only when it is a plugin's. */
function pluginEventOf(event: HookEventToDeliver): PluginEvent {
  return {
    kind: event.kind,
    bureauId: event.bureauId,
    emittedAtMs: event.emittedAtMs,
    payload: event.payload,
    ...(event.source === undefined ? {} : { source: event.source }),
  };
}

/** The longest notification title and body the store accepts, which the work is cut to. */
const NOTIFICATION_TITLE_LIMIT = NOTIFICATION_FIELD_LIMITS.title;
const NOTIFICATION_BODY_LIMIT = NOTIFICATION_FIELD_LIMITS.body;

/**
 * What a `start-workflow` or `notify` action does for `event`, mapped now and kept on the delivery.
 * The input of a `start-workflow` action is the event's payload, or `{ kind, bureauId, emittedAtMs,
 * payload }` when the action asks for `event`. A notification's title is the action's, or names the
 * kind; its body names the kind, the hook and the Bureau, and carries nothing of the payload.
 */
function workOf(
  action: Exclude<HookRecord['action'], { readonly type: 'webhook' }>,
  hook: HookRecord,
  event: HookEventToDeliver,
  actionKindVersion: HookDeliveryDependencies['actionKindVersion'],
): HookDeliveryWork {
  if (action.type === 'plugin') {
    const version = actionKindVersion?.(action.plugin, action.kind);
    return {
      type: 'plugin',
      plugin: action.plugin,
      kind: action.kind,
      ...(action.configuration === undefined ? {} : { configuration: action.configuration }),
      event: pluginEventOf(event),
      ...(version === undefined ? {} : { version }),
    };
  }
  if (action.type === 'start-workflow') {
    return {
      type: 'start-workflow',
      workflowId: action.workflowId,
      input:
        action.input === 'payload'
          ? event.payload
          : {
              ...pluginEventOf(event),
            },
    };
  }
  const label = hook.name === undefined ? hook.id : `“${hook.name}”`;
  return {
    type: 'notify',
    title: (action.title ?? `Event ${event.kind}`).slice(0, NOTIFICATION_TITLE_LIMIT),
    body: `Hook ${label} fired on ${event.kind} from Bureau ${event.bureauId}.`.slice(
      0,
      NOTIFICATION_BODY_LIMIT,
    ),
  };
}

/** `work` marked as not to be done, when a reason is given and the work is a workflow start. */
function withSkip(work: HookDeliveryWork, skip: string | undefined): HookDeliveryWork {
  return skip !== undefined && work.type === 'start-workflow' ? { ...work, skip } : work;
}

/** How one attempt of a delivery's action or request ended. */
interface AttemptResult {
  readonly attempt: Omit<HookDeliveryAttempt, 'number' | 'startedAt' | 'finishedAt'>;
  /** A retry cannot change the answer. */
  readonly permanent: boolean;
  /** The hook was disabled or deleted while the attempt ran. */
  readonly aborted?: true;
  /**
   * The plugin's secret went missing between the availability check and the run (COR-2176): the
   * attempt is dropped, not recorded, so it does not count, and the delivery waits.
   */
  readonly needsSetup?: true;
}

/**
 * `promise`, unless `signal` aborts first, which rejects with its reason: an action that ignores its
 * signal still ends when the signal does. The promise that loses is abandoned, so its rejection is
 * marked handled.
 */
async function endedBy<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  promise.catch(() => undefined);
  signal.throwIfAborted();
  let abandon: () => void = () => undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    abandon = () => reject(signal.reason);
    signal.addEventListener('abort', abandon, { once: true });
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    signal.removeEventListener('abort', abandon);
  }
}

/** Builds the hook deliveries over the notifier's engine. */
export function createHookDeliveries(dependencies: HookDeliveryDependencies): HookDeliveries {
  const { engine, store } = dependencies;
  const timeoutSignal =
    dependencies.timeoutSignal ?? ((milliseconds) => AbortSignal.timeout(milliseconds));

  /** How long one attempt of `work` may run: a plugin's reaction sets its own, everything else is a request. */
  function timeoutOf(work: HookDeliveryWork | undefined): number {
    return work?.type === 'plugin'
      ? (dependencies.actionKindTimeout?.(work.plugin, work.kind) ??
          dependencies.requestTimeoutMilliseconds)
      : dependencies.requestTimeoutMilliseconds;
  }

  /**
   * How long a process that drives a delivery holds it between two writes: the longest an attempt
   * may run, the longest backoff wait that follows the engine's last attempt, and a margin. Per
   * record, because a reaction's own timeout can be longer than a request's, and a lease that expired
   * inside a hung `run` would let a second process run it again. It does not grow with a reaction's
   * own `maxAttempts` (COR-2183): at 20 attempts and a 1-second base the backoff after the last is
   * 6 days, and a crashed delivery would be held that long. A write that schedules a backoff longer
   * than that (an attempt past the engine's own last) extends its own lease instead, in
   * {@link advanced}.
   */
  function leaseFor(record: { readonly work?: HookDeliveryWork | undefined }): number {
    return (
      timeoutOf(record.work) +
      engine.backoffMilliseconds(Math.max(1, engine.maxAttempts)) +
      LEASE_MARGIN_MILLISECONDS
    );
  }

  /**
   * `record` advanced: a new revision, a fresh lease unless `leaseUntil` is given. The time of the
   * next attempt holds only until the record next changes, so it is dropped unless `changes` sets
   * it again.
   */
  function advanced(
    record: HookDeliveryRecord,
    changes: Partial<
      Pick<
        HookDeliveryRecord,
        'status' | 'attempts' | 'leaseUntil' | 'maxAttempts' | 'nextAttemptAt'
      >
    >,
  ): HookDeliveryRecord {
    const now = engine.now();
    const { nextAttemptAt: _due, ...rest } = record;
    // Held until the wait this write schedules is over and an attempt could have run after it, so
    // no other process takes the delivery during a backoff, however long.
    const waitedOut =
      changes.nextAttemptAt === undefined
        ? 0
        : changes.nextAttemptAt + timeoutOf(record.work) + LEASE_MARGIN_MILLISECONDS;
    return {
      ...rest,
      ...changes,
      updatedAt: now,
      revision: record.revision + 1,
      leaseUntil: changes.leaseUntil ?? Math.max(now + leaseFor(record), waitedOut),
    };
  }

  /** Writes `after` over `before`; the new stored record, or `undefined` when the fence was lost. */
  async function write(
    before: Stored<HookDeliveryRecord>,
    after: HookDeliveryRecord,
  ): Promise<Stored<HookDeliveryRecord> | undefined> {
    return (await store.replaceDelivery(before, after))
      ? { record: after, raw: JSON.stringify(after) }
      : undefined;
  }

  /** `attempts` with any attempt still `sending` closed as interrupted. */
  function withoutSending(attempts: readonly HookDeliveryAttempt[]): HookDeliveryAttempt[] {
    return attempts.map((attempt) =>
      attempt.outcome === 'sending'
        ? { ...attempt, outcome: 'interrupted' as const, finishedAt: engine.now() }
        : attempt,
    );
  }

  /** Ends the delivery in `status`, auditing an exhausted one. */
  async function finish(
    current: Stored<HookDeliveryRecord>,
    status: HookDeliveryStatus,
    attempts: readonly HookDeliveryAttempt[] = current.record.attempts,
  ): Promise<void> {
    const written = await write(
      current,
      advanced(current.record, { status, attempts, leaseUntil: 0 }),
    );
    if (written !== undefined && status === 'exhausted') {
      await dependencies
        .audit({
          hookId: current.record.hookId,
          owner: current.record.owner,
          deliveryId: current.record.id,
          attempts: attempts.length,
          status,
        })
        .catch((cause: unknown) => dependencies.diagnose('Failed to audit a hook delivery', cause));
    }
  }

  /** Stops driving a delivery without ending it: the lease is released so a restart resumes it. */
  async function release(current: Stored<HookDeliveryRecord>): Promise<void> {
    await write(
      current,
      advanced(current.record, {
        attempts: withoutSending(current.record.attempts),
        leaseUntil: 0,
      }),
    );
  }

  /** Makes the request for attempt `number` and says how it ended. */
  async function send(
    request: HookDeliveryRequest,
    number: number,
    secret: string,
    record: HookDeliveryRecord,
  ): Promise<Omit<HookDeliveryAttempt, 'number' | 'startedAt' | 'finishedAt'>> {
    try {
      if (
        dependencies.workspace !== undefined &&
        (await recoverRunWorkspaceAuthority(
          dependencies.workspace,
          record.workspaceAuthority,
          record.owner,
        )) === undefined
      )
        return { outcome: 'rejected', error: 'Workspace authority unavailable.' };
      const timestampSeconds = Math.floor(engine.now() / 1000);
      const response = await engine.fetch(request.url, {
        method: 'POST',
        // A redirect is a failure, never followed: it is the way past the URL policy.
        redirect: 'manual',
        headers: {
          ...request.headers,
          'X-Delivery-Attempt': String(number),
          'X-Signature': signHookDelivery({
            secret,
            body: request.body,
            timestampSeconds,
          }),
        },
        body: request.body,
        signal: AbortSignal.any([
          engine.signal,
          AbortSignal.timeout(dependencies.requestTimeoutMilliseconds),
        ]),
      });
      return {
        outcome: 'response',
        status: response.status,
        ...(await readExcerpt(response, secret)),
      };
    } catch (error) {
      if (engine.shuttingDown()) return { outcome: 'interrupted' };
      const message = error instanceof Error ? error.message : String(error);
      return {
        outcome: 'network-error',
        error: scrubbed(message, secret).slice(0, ERROR_TEXT_LIMIT),
      };
    }
  }

  /**
   * Runs a `start-workflow`, `notify` or `plugin` delivery's work and says how it ended. A plugin's
   * reaction is given a signal that aborts on a shutdown, at its timeout, and when its hook is
   * disabled or deleted (`hookAbort`), and the attempt ends when it does even if the reaction
   * ignores it. The cause is read in that order: a shutdown, then the hook, then the timeout.
   */
  async function act(
    record: HookDeliveryRecord,
    hookAbort: AbortController | undefined,
    attempt: number,
  ): Promise<AttemptResult> {
    const { work } = record;
    if (work === undefined) {
      return {
        attempt: { outcome: 'rejected', error: 'The delivery has no work to do' },
        permanent: true,
      };
    }
    // What the action resolves from secret references, removed from whatever it reports.
    const resolvedSecrets = new Set<string>();
    // Started before the first await, so the timeout covers all the action does.
    const timeoutMilliseconds = work.type === 'plugin' ? timeoutOf(work) : undefined;
    const timeout =
      timeoutMilliseconds === undefined ? undefined : timeoutSignal(timeoutMilliseconds);
    const signal =
      timeout === undefined || hookAbort === undefined
        ? engine.signal
        : AbortSignal.any([engine.signal, timeout, hookAbort.signal]);
    try {
      if (
        dependencies.workspace !== undefined &&
        (await recoverRunWorkspaceAuthority(
          dependencies.workspace,
          record.workspaceAuthority,
          record.owner,
        )) === undefined
      )
        return {
          attempt: { outcome: 'rejected', error: 'Workspace authority unavailable.' },
          permanent: true,
        };
      // A disable that landed before the action started stops it before it does anything.
      if (signal !== engine.signal) signal.throwIfAborted();
      const running = dependencies.actions.run(work, {
        owner: record.owner,
        hookId: record.hookId,
        deliveryId: record.id,
        attempt,
        test: record.test,
        signal,
        resolvedSecrets,
      });
      const receipt = signal === engine.signal ? await running : await endedBy(running, signal);
      return { attempt: { outcome: 'completed', receipt }, permanent: false };
    } catch (error) {
      if (engine.shuttingDown()) return { attempt: { outcome: 'interrupted' }, permanent: false };
      if (hookAbort?.signal.aborted === true) {
        return {
          attempt: { outcome: 'error', error: 'The hook was disabled' },
          permanent: false,
          aborted: true,
        };
      }
      if (timeout?.aborted === true) {
        return {
          attempt: {
            outcome: 'error',
            error: `The reaction timed out after ${timeoutMilliseconds} ms`,
          },
          permanent: false,
        };
      }
      // Matched by name: `hooks/` imports nothing from `plugins/`, where the gate's error lives.
      if (error instanceof Error && error.name === 'PluginNeedsSetupError') {
        return { attempt: { outcome: 'error' }, permanent: false, needsSetup: true };
      }
      // The values come out before the text is cut, or a cut could leave half of one in it.
      const message = withoutValues(
        error instanceof Error ? error.message : String(error),
        resolvedSecrets,
      ).slice(0, ERROR_TEXT_LIMIT);
      return error instanceof HookActionError && error.permanent
        ? { attempt: { outcome: 'rejected', error: message }, permanent: true }
        : { attempt: { outcome: 'error', error: message }, permanent: false };
    }
  }

  async function run(id: string): Promise<void> {
    for (;;) {
      const waitMilliseconds = await pass(id);
      if (waitMilliseconds === undefined) return;
      await backoff(id, waitMilliseconds);
    }
  }

  /**
   * One pass over a delivery: the attempt it makes, or the reason it makes none. Resolves with how
   * long to wait before the next pass, or `undefined` when this process stops driving the delivery.
   */
  async function pass(id: string): Promise<number | undefined> {
    const current = await store.getDelivery(id);
    if (current === undefined || current.record.status !== 'pending') return undefined;
    if (engine.shuttingDown()) {
      await release(current);
      return undefined;
    }
    const { record } = current;
    const number = record.attempts.length + 1;
    if (number > record.maxAttempts) {
      await finish(current, 'exhausted');
      return undefined;
    }
    // Registered before the hook is read, so a disable that commits after the read still aborts
    // this attempt: `abortHook` runs after the commit, and finds it.
    const inFlight = record.actionType === 'plugin' ? openAttempt(record.hookId) : undefined;
    try {
      return await attemptOnce(current, number, inFlight);
    } finally {
      inFlight?.close();
    }
  }

  async function attemptOnce(
    current: Stored<HookDeliveryRecord>,
    number: number,
    inFlight: { readonly controller: AbortController } | undefined,
  ): Promise<number | undefined> {
    const { record } = current;
    const hook = await store.getHook(record.hookId);
    if (hook === undefined) {
      // The hook is gone, and a delivery nobody can read is not kept.
      await store.deleteDelivery(current);
      return undefined;
    }
    if (
      hook.record.owner !== record.owner ||
      (!hook.record.enabled && !record.test) ||
      hook.record.action.type !== record.actionType ||
      // A disable that committed after the read above has already aborted this attempt.
      inFlight?.controller.signal.aborted === true ||
      // A notification hook that reacts to its own notification writes one per notification, forever.
      (record.actionType === 'notify' && record.kind === NOTIFICATION_CREATED_EVENT_KIND)
    ) {
      await finish(current, 'aborted');
      return undefined;
    }
    // A plugin that needs setup cannot run its reaction yet: no attempt is made, and none counts
    // against `maxAttempts`. The lease is released so the next `resume` takes the delivery. This
    // comes after the hook checks, so a disabled hook is still aborted, and before the attempt is
    // written; the version pin is checked by the action, once the plugin is available.
    if (
      record.work?.type === 'plugin' &&
      dependencies.actionKindAvailable?.(record.work.plugin, record.work.kind) === false
    ) {
      await release(current);
      return undefined;
    }
    let secret = '';
    if (record.actionType === 'webhook') {
      try {
        if (dependencies.keys === undefined) throw new Error('no key');
        secret = await openHookSecret(record.hookId, dependencies.secrets, dependencies.keys);
      } catch {
        await finish(current, 'failed-secret');
        return undefined;
      }
    }

    const startedAt = engine.now();
    const request = record.request;
    const defect =
      request === undefined ? undefined : hookUrlDefect(request.url, dependencies.urlPolicy);
    if (defect !== undefined) {
      await finish(current, 'exhausted', [
        ...record.attempts,
        { number, startedAt, finishedAt: startedAt, outcome: 'refused', error: defect },
      ]);
      return undefined;
    }

    // The attempt is on the record before the request is made, or the action is run.
    const sending: HookDeliveryAttempt = { number, startedAt, outcome: 'sending' };
    const opened = await write(
      current,
      advanced(record, { attempts: [...record.attempts, sending] }),
    );
    if (opened === undefined) return undefined;

    const done: AttemptResult =
      request === undefined
        ? await act(record, inFlight?.controller, number)
        : { attempt: await send(request, number, secret, record), permanent: false };
    const outcome = done.attempt;
    const closedAttempt: HookDeliveryAttempt = {
      number,
      startedAt,
      finishedAt: engine.now(),
      ...outcome,
    };
    const attempts = [...record.attempts, closedAttempt];

    if (outcome.outcome === 'interrupted') {
      await write(opened, advanced(opened.record, { attempts, leaseUntil: 0 }));
      return undefined;
    }
    if (done.needsSetup) {
      // The `sending` attempt is dropped, not closed: an attempt that never ran must not count
      // toward `maxAttempts`. The delivery waits, with its lease released.
      await write(opened, advanced(opened.record, { attempts: record.attempts, leaseUntil: 0 }));
      return undefined;
    }
    if (
      outcome.outcome === 'completed' ||
      (outcome.outcome === 'response' &&
        (outcome.status ?? 0) >= 200 &&
        (outcome.status ?? 0) < 300)
    ) {
      await finish(opened, 'delivered', attempts);
      return undefined;
    }
    // Before the exhaustion check: a hook that was disabled or deleted has nothing to exhaust.
    if (done.aborted) {
      await finish(opened, 'aborted', attempts);
      return undefined;
    }
    if (done.permanent || outcome.outcome === 'rejected') {
      await finish(opened, 'failed', attempts);
      return undefined;
    }
    if (number >= record.maxAttempts) {
      await finish(opened, 'exhausted', attempts);
      return undefined;
    }
    const backoffMilliseconds = engine.backoffMilliseconds(number);
    const waiting = await write(
      opened,
      advanced(opened.record, { attempts, nextAttemptAt: engine.now() + backoffMilliseconds }),
    );
    return waiting === undefined ? undefined : backoffMilliseconds;
  }

  // The plugin attempts in flight in this process, by hook: what a disable or a delete aborts.
  const attemptsInFlight = new Map<string, Set<AbortController>>();

  /** Registers an attempt of `hookId`'s reaction as in flight until `close` is called. */
  function openAttempt(hookId: string): {
    readonly controller: AbortController;
    close(): void;
  } {
    const controller = new AbortController();
    const attempts = attemptsInFlight.get(hookId) ?? new Set<AbortController>();
    attempts.add(controller);
    attemptsInFlight.set(hookId, attempts);
    return {
      controller,
      close() {
        attempts.delete(controller);
        if (attempts.size === 0 && attemptsInFlight.get(hookId) === attempts) {
          attemptsInFlight.delete(hookId);
        }
      },
    };
  }

  // The deliveries this process is waiting to retry, each with what ends its wait early
  // (`retry`, the person's "Retry now").
  const wakers = new Map<string, () => void>();

  /** Waits out a delivery's backoff, or less when `retry` wakes it or the engine shuts down. */
  async function backoff(id: string, milliseconds: number): Promise<void> {
    const woken = new Promise<void>((resolve) => {
      wakers.set(id, resolve);
    });
    try {
      await Promise.race([engine.wait(milliseconds), woken]);
    } finally {
      wakers.delete(id);
    }
  }

  /** Drives a delivery under the engine's tracking, so `flush()` and `dispose()` wait for it. */
  function driveTracked(id: string): Promise<void> {
    const driving = drive(id);
    engine.track(driving);
    return driving;
  }

  async function drive(id: string): Promise<void> {
    try {
      const first = await store.getDelivery(id);
      if (first === undefined) return;
      await engine.tracked(id, first.record.hookId, () => run(id));
    } catch (cause) {
      dependencies.diagnose('A hook delivery failed to run', cause);
    }
  }

  /**
   * One pass: takes each pending delivery with an expired lease and drives it. Reports the pending
   * deliveries it left because another process's lease is still live, with that lease. `only`
   * narrows the pass to those ids, so a re-scan never claims a delivery this process is driving.
   */
  async function scan(only?: ReadonlySet<string>): Promise<{
    readonly taken: number;
    readonly skipped: ReadonlyMap<string, number>;
  }> {
    const driving: Promise<void>[] = [];
    const skipped = new Map<string, number>();
    for (const id of await store.listPendingDeliveryIds()) {
      if (only !== undefined && !only.has(id)) continue;
      const stored = await store.getDelivery(id);
      if (stored === undefined || stored.record.status !== 'pending') continue;
      if (stored.record.leaseUntil > engine.now()) {
        skipped.set(id, stored.record.leaseUntil);
        continue;
      }
      const claimed = await write(
        stored,
        advanced(stored.record, { attempts: withoutSending(stored.record.attempts) }),
      );
      if (claimed !== undefined) driving.push(drive(id));
    }
    // Awaited, so the tracked `resume()` covers the deliveries it took.
    await Promise.allSettled(driving);
    return { taken: driving.length, skipped };
  }

  /** Waits for the earliest live lease among `skipped`, scans those again, and repeats until none is left or a shutdown. */
  async function rescan(initial: ReadonlyMap<string, number>): Promise<void> {
    try {
      let skipped = initial;
      while (skipped.size > 0 && !engine.shuttingDown()) {
        await engine.wait(Math.max(Math.min(...skipped.values()) - engine.now(), 0));
        if (engine.shuttingDown()) return;
        const scanned = await scan(new Set(skipped.keys()));
        skipped = scanned.skipped;
      }
    } catch (cause) {
      dependencies.diagnose('A hook delivery re-scan failed', cause);
    }
  }

  return {
    async enqueue(hook, event, test, skip) {
      const id = dependencies.newId();
      const now = engine.now();
      const base = {
        version: 1 as const,
        id,
        hookId: hook.id,
        owner: hook.owner,
        ...(hook.workspaceAuthority === undefined
          ? {}
          : { workspaceAuthority: hook.workspaceAuthority }),
        actionType: hook.action.type,
        kind: event.kind,
        test,
        status: 'pending' as const,
        attempts: [],
        createdAt: now,
        updatedAt: now,
        leaseUntil: 0,
        revision: 0,
      };
      const action = hook.action;
      const unleased: HookDeliveryRecord =
        action.type === 'webhook'
          ? {
              ...base,
              request: webhookRequestOf(id, hook.id, action.url, event, test),
              maxAttempts: test ? 1 : engine.maxAttempts,
            }
          : {
              ...base,
              work: withSkip(workOf(action, hook, event, dependencies.actionKindVersion), skip),
              // A test is one attempt; a reaction's own limit, else the engine's, for the rest.
              maxAttempts:
                action.type === 'plugin'
                  ? test
                    ? 1
                    : (dependencies.actionKindMaxAttempts?.(action.plugin, action.kind) ??
                      engine.maxAttempts)
                  : engine.maxAttempts,
            };
      // Held from the start, for as long as the first attempt may run.
      await store.createDelivery({ ...unleased, leaseUntil: now + leaseFor(unleased) });
      return id;
    },
    drive,
    abortHook(hookId) {
      const attempts = attemptsInFlight.get(hookId);
      if (attempts === undefined) return;
      // An abort only settles promises: the attempt removes itself from the set once it has ended.
      for (const controller of attempts) {
        controller.abort(new DOMException('The hook was disabled', 'AbortError'));
      }
    },
    async prune(olderThanMilliseconds) {
      const cutoff = engine.now() - olderThanMilliseconds;
      let removed = 0;
      for (const stored of await store.listStoredDeliveries()) {
        if (stored.record.status === 'pending' || stored.record.updatedAt >= cutoff) continue;
        // Conditional on the text read, so a record that changed since (it cannot be pending again,
        // but a fence is a fence) is left.
        if (await store.deleteDelivery(stored)) removed += 1;
      }
      return removed;
    },
    async resume() {
      await store.indexPendingDeliveries();
      const first = await scan();
      if (first.skipped.size > 0) engine.track(rescan(first.skipped));
      return first.taken;
    },
    async retry(deliveryId) {
      const current = await store.getDelivery(deliveryId);
      if (current === undefined || current.record.status === 'delivered') return;
      const { record } = current;
      if (record.status === 'pending') {
        // Waiting out its backoff here: the next attempt is made now, by the loop already driving it.
        const wake = wakers.get(deliveryId);
        if (wake !== undefined) {
          wake();
          return;
        }
        // Driven now, by this process or another: the attempt in flight is the retry.
        if (record.leaseUntil > engine.now()) return;
        const claimed = await write(
          current,
          advanced(record, { attempts: withoutSending(record.attempts) }),
        );
        if (claimed !== undefined) void driveTracked(deliveryId);
        return;
      }
      // Settled: open the same record again, with room for one more attempt. The request, its
      // body, and its `Idempotency-Key` are the record's; only the signature is made afresh.
      const reopened = await write(
        current,
        advanced(record, {
          status: 'pending',
          attempts: withoutSending(record.attempts),
          maxAttempts: record.attempts.length + 1,
        }),
      );
      if (reopened === undefined) return;
      await driveTracked(deliveryId);
    },
    async sendDraft(draft) {
      // Read before the first await: the caller owns `draft`.
      const { hookId, owner, workspaceAuthority, url, secret, event } = draft;
      const id = dependencies.newId();
      const now = engine.now();
      const request = webhookRequestOf(id, hookId, url, event, true);
      const record: HookDeliveryRecord = {
        version: 1,
        id,
        hookId,
        owner,
        ...(workspaceAuthority === undefined ? {} : { workspaceAuthority }),
        actionType: 'webhook',
        kind: event.kind,
        test: true,
        status: 'pending',
        request,
        attempts: [],
        maxAttempts: 1,
        createdAt: now,
        updatedAt: now,
        leaseUntil: 0,
        revision: 0,
      };
      const startedAt = engine.now();
      const outcome = await send(request, 1, secret, record);
      const status: HookDeliveryStatus =
        outcome.outcome === 'response' &&
        (outcome.status ?? 0) >= 200 &&
        (outcome.status ?? 0) < 300
          ? 'delivered'
          : outcome.outcome === 'rejected'
            ? 'failed'
            : outcome.outcome === 'interrupted'
              ? 'aborted'
              : 'exhausted';
      const finishedAt = engine.now();
      return {
        ...record,
        status,
        attempts: [{ number: 1, startedAt, finishedAt, ...outcome }],
        updatedAt: finishedAt,
      };
    },
  };
}
