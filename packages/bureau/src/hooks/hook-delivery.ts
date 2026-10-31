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
 * some later restart.
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
    context: { readonly owner: string; readonly hookId: string; readonly deliveryId: string },
  ): Promise<HookActionReceipt>;
}

/** What {@link createHookDeliveries} is built from. */
export interface HookDeliveryDependencies {
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

/** The delivery operations {@link createHookDeliveries} offers. */
export interface HookDeliveries {
  /**
   * Writes the pending delivery of `event` to `hook`, and returns its id. A `start-workflow` or
   * `notify` hook's delivery holds the work its action will do, mapped from the event now.
   * `test` is for a webhook only. `skip` is for a `start-workflow` hook: the delivery is written,
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

/** Builds the hook deliveries over the notifier's engine. */
export function createHookDeliveries(dependencies: HookDeliveryDependencies): HookDeliveries {
  const { engine, store } = dependencies;
  const leaseMilliseconds =
    dependencies.requestTimeoutMilliseconds +
    engine.backoffMilliseconds(Math.max(1, engine.maxAttempts)) +
    LEASE_MARGIN_MILLISECONDS;

  /** `record` advanced: a new revision, a fresh lease unless `leaseUntil` is given. */
  function advanced(
    record: HookDeliveryRecord,
    changes: Partial<Pick<HookDeliveryRecord, 'status' | 'attempts' | 'leaseUntil'>>,
  ): HookDeliveryRecord {
    const now = engine.now();
    return {
      ...record,
      ...changes,
      updatedAt: now,
      revision: record.revision + 1,
      leaseUntil: changes.leaseUntil ?? now + leaseMilliseconds,
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
  ): Promise<Omit<HookDeliveryAttempt, 'number' | 'startedAt' | 'finishedAt'>> {
    try {
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

  /** Runs a `start-workflow` or `notify` delivery's work and says how it ended. */
  async function act(record: HookDeliveryRecord): Promise<{
    readonly attempt: Omit<HookDeliveryAttempt, 'number' | 'startedAt' | 'finishedAt'>;
    readonly permanent: boolean;
  }> {
    if (record.work === undefined) {
      return {
        attempt: { outcome: 'rejected', error: 'The delivery has no work to do' },
        permanent: true,
      };
    }
    try {
      const receipt = await dependencies.actions.run(record.work, {
        owner: record.owner,
        hookId: record.hookId,
        deliveryId: record.id,
      });
      return { attempt: { outcome: 'completed', receipt }, permanent: false };
    } catch (error) {
      if (engine.shuttingDown()) return { attempt: { outcome: 'interrupted' }, permanent: false };
      const message = (error instanceof Error ? error.message : String(error)).slice(
        0,
        ERROR_TEXT_LIMIT,
      );
      return error instanceof HookActionError && error.permanent
        ? { attempt: { outcome: 'rejected', error: message }, permanent: true }
        : { attempt: { outcome: 'error', error: message }, permanent: false };
    }
  }

  async function run(id: string): Promise<void> {
    for (;;) {
      const current = await store.getDelivery(id);
      if (current === undefined || current.record.status !== 'pending') return;
      if (engine.shuttingDown()) {
        await release(current);
        return;
      }
      const { record } = current;
      const number = record.attempts.length + 1;
      if (number > record.maxAttempts) {
        await finish(current, 'exhausted');
        return;
      }
      const hook = await store.getHook(record.hookId);
      if (hook === undefined) {
        // The hook is gone, and a delivery nobody can read is not kept.
        await store.deleteDelivery(current);
        return;
      }
      if (
        hook.record.owner !== record.owner ||
        (!hook.record.enabled && !record.test) ||
        hook.record.action.type !== record.actionType ||
        // A notification hook that reacts to its own notification writes one per notification, forever.
        (record.actionType === 'notify' && record.kind === NOTIFICATION_CREATED_EVENT_KIND)
      ) {
        await finish(current, 'aborted');
        return;
      }
      let secret = '';
      if (record.actionType === 'webhook') {
        try {
          if (dependencies.keys === undefined) throw new Error('no key');
          secret = await openHookSecret(record.hookId, dependencies.secrets, dependencies.keys);
        } catch {
          await finish(current, 'failed-secret');
          return;
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
        return;
      }

      // The attempt is on the record before the request is made, or the action is run.
      const sending: HookDeliveryAttempt = { number, startedAt, outcome: 'sending' };
      const opened = await write(
        current,
        advanced(record, { attempts: [...record.attempts, sending] }),
      );
      if (opened === undefined) return;

      const done =
        request === undefined
          ? await act(record)
          : { attempt: await send(request, number, secret), permanent: false };
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
        return;
      }
      if (
        outcome.outcome === 'completed' ||
        (outcome.outcome === 'response' &&
          (outcome.status ?? 0) >= 200 &&
          (outcome.status ?? 0) < 300)
      ) {
        await finish(opened, 'delivered', attempts);
        return;
      }
      if (done.permanent) {
        await finish(opened, 'failed', attempts);
        return;
      }
      if (number >= record.maxAttempts) {
        await finish(opened, 'exhausted', attempts);
        return;
      }
      if ((await write(opened, advanced(opened.record, { attempts }))) === undefined) return;
      await engine.wait(engine.backoffMilliseconds(number));
    }
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
        actionType: hook.action.type,
        kind: event.kind,
        test,
        status: 'pending' as const,
        attempts: [],
        createdAt: now,
        updatedAt: now,
        leaseUntil: now + leaseMilliseconds,
        revision: 0,
      };
      const action = hook.action;
      const record: HookDeliveryRecord =
        action.type === 'webhook'
          ? {
              ...base,
              request: {
                url: action.url,
                headers: {
                  'Content-Type': 'application/json',
                  'User-Agent': 'corvidae-hooks/1',
                  'X-Hook-Id': hook.id,
                  'X-Delivery-Id': id,
                  'Idempotency-Key': id,
                  'X-Event-Kind': event.kind,
                },
                body: JSON.stringify({
                  id,
                  hookId: hook.id,
                  kind: event.kind,
                  bureauId: event.bureauId,
                  emittedAtMs: event.emittedAtMs,
                  test,
                  payload: event.payload,
                  ...(event.source === undefined ? {} : { source: event.source }),
                }),
              },
              maxAttempts: test ? 1 : engine.maxAttempts,
            }
          : {
              ...base,
              work: withSkip(workOf(action, hook, event, dependencies.actionKindVersion), skip),
              maxAttempts: engine.maxAttempts,
            };
      await store.createDelivery(record);
      return id;
    },
    drive,
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
  };
}
