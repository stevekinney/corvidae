/**
 * `Bureau.hooks` (COR-1939): owner-scoped hooks over the Bureau's published events, each delivered
 * as an HMAC-signed POST that keeps its request, its response, and its attempts on a record, and
 * resumes after a restart. See `hook-signature.ts` for the wire contract, `hook-delivery.ts` for
 * the retry and resume fence, and `hook-url-policy.ts` for which URLs a hook may name.
 *
 * ## The signing secret
 *
 * The caller chooses the secret and sends it with `create` or `update`; nothing ever returns it. It
 * is sealed with COR-1816's scheme under `BureauOptions.answerEncryption` and kept through the
 * host's {@link HookSecretStore}, which holds ciphertext only. A host whose secrets live elsewhere
 * (a remote Interborough home) has its port report a write lock, and a write then fails with
 * {@link HookError} `locked` and the port's reason, `deployment`.
 *
 * ## Matching
 *
 * A hook fires on the published event kinds it lists (`PUBLISHED_BUREAU_EVENT_KINDS`), for events
 * of the whole Bureau: the feed is fleet-wide, so the operations require `bureau.events:observe-all`
 * to create or change a hook. Events that happen while the Bureau is down are not replayed;
 * deliveries already created are resumed.
 *
 * @module create-hooks
 */

import { ownerFromPrincipal } from '../owner-of-record.ts';
import { PUBLISHED_BUREAU_EVENT_KINDS, type BureauEventEnvelope } from '../bureau-event-feed.ts';
import type { AnswerEncryptionKeys } from '../secret-answers.ts';
import type { WebhookDeliveryEngine } from '../webhook-notifier.ts';
import {
  createHookDeliveries,
  DEFAULT_HOOK_REQUEST_TIMEOUT_MILLISECONDS,
  type HookEventToDeliver,
} from './hook-delivery.ts';
import {
  createHookStore,
  createKvHookSecretStore,
  sealHookSecret,
  type HookStore,
  type Stored,
} from './hook-store.ts';
import {
  HookError,
  type Hook,
  type HookDelivery,
  type HookDeliveryRecord,
  type HookRecord,
  type HookSecretStore,
} from './hook-types.ts';
import { type HookUrlPolicy, hookUrlDefect } from './hook-url-policy.ts';
import type { EncryptedValue } from '@lostgradient/cryptography';
import type { ConditionalTextValueStore } from '@lostgradient/storage';

/** The event kind of a `hooks.test` delivery. It is not a published kind, so no hook can list it. */
export const HOOK_TEST_EVENT_KIND = 'hook.test';

/** The most event kinds one hook may list. */
const MAXIMUM_EVENT_KINDS = 64;

/** The shortest and longest signing secret, in characters. */
export const HOOK_SECRET_MINIMUM_LENGTH = 16;
export const HOOK_SECRET_MAXIMUM_LENGTH = 256;

const NAME_MAXIMUM_LENGTH = 100;

/** How long dispatch keeps the hooks it read. */
const HOOK_CACHE_MILLISECONDS = 5_000;

const PUBLISHED_KINDS: ReadonlySet<string> = new Set(PUBLISHED_BUREAU_EVENT_KINDS);

/** What `hooks.create` takes. */
export interface HookCreateInput {
  /** Where each delivery is POSTed. */
  readonly url: string;
  /** The published Bureau event kinds the hook fires on. */
  readonly events: readonly string[];
  /** The secret deliveries are signed with, 16 to 256 characters. Sealed on arrival; never returned. */
  readonly signingSecret: string;
  /** A label, at most 100 characters. */
  readonly name?: string;
  /** Whether the hook fires. Defaults to `true`. */
  readonly enabled?: boolean;
  /** The owner's principal (`api-key:<subject>`); omitted, the hook belongs to `anonymous:local`. */
  readonly principal?: string;
}

/** What `hooks.update` changes; a field left out stays as it is. */
export interface HookUpdateInput {
  /** The new URL. */
  readonly url?: string;
  /** The new event kinds, replacing the list. */
  readonly events?: readonly string[];
  /** A new signing secret, sealed on arrival; never returned. */
  readonly signingSecret?: string;
  /** A new label, or `null` to remove it. */
  readonly name?: string | null;
  /** Enable or disable the hook. */
  readonly enabled?: boolean;
  /** Apply the change only if the hook is still at this revision. */
  readonly expectedRevision?: number;
  /** The caller's principal (`api-key:<subject>`), recorded as the actor of the audit entry; omit when unknown. */
  readonly principal?: string;
}

/** What `hooks.delete` and `hooks.test` take beyond the hook. */
export interface HookCallOptions {
  /** The caller's principal (`api-key:<subject>`), recorded as the actor of the audit entry; omit when unknown. */
  readonly principal?: string;
}

/** The Bureau's hooks: `Bureau.hooks`. Ownership is decided by the caller, as for `Bureau.goals`. */
export interface BureauHooks {
  /** Creates a hook; refuses with {@link HookError}. */
  create(input: HookCreateInput): Promise<Hook>;
  /** Changes a hook, or resolves `undefined` when there is none. */
  update(hookId: string, input: HookUpdateInput): Promise<Hook | undefined>;
  /** Deletes a hook, its sealed secret and its delivery records; `false` when there is none. */
  delete(hookId: string, options?: HookCallOptions): Promise<boolean>;
  /** One hook, or `undefined`. */
  get(hookId: string): Promise<Hook | undefined>;
  /** Every hook, oldest first; `owner` narrows to one owner's. */
  list(filter?: { readonly owner?: string }): Promise<readonly Hook[]>;
  /**
   * Sends one signed `hook.test` delivery to the hook and resolves with its record once the one
   * attempt has ended. A test is not retried. It works on a disabled hook. Resolves `undefined`
   * when there is no such hook.
   */
  test(hookId: string, options?: HookCallOptions): Promise<HookDelivery | undefined>;
  /** The hook's deliveries, newest first, at most `limit` (default 50, at most 200). */
  deliveries(
    hookId: string,
    options?: { readonly limit?: number },
  ): Promise<readonly HookDelivery[]>;
}

/** What {@link createHooks} is built from. */
export interface HooksDependencies {
  /** The Bureau's key-value store. */
  readonly kv: ConditionalTextValueStore;
  /** The notifier's delivery machinery. */
  readonly engine: WebhookDeliveryEngine;
  /** The host's secret port; defaults to a store in `kv`. */
  readonly secrets?: HookSecretStore | undefined;
  /** The keys a secret is sealed with. */
  readonly keys: AnswerEncryptionKeys | undefined;
  /** Which URLs may be delivered to. */
  readonly urlPolicy?: HookUrlPolicy | undefined;
  /** How long one request may take. */
  readonly requestTimeoutMilliseconds?: number | undefined;
  /** The Bureau's identifier, sent in each delivery. */
  readonly bureauId: string;
  /** Mints identifiers. */
  readonly newId: (kind: 'hook' | 'hook-delivery') => string;
  /** Writes an audit entry; best effort. */
  readonly audit: (entry: {
    readonly runId: string;
    readonly type: string;
    readonly principal?: string;
    readonly detail: unknown;
  }) => Promise<void>;
  /** Reports a failure; never carries a secret. */
  readonly diagnose: (message: string, cause?: unknown) => void;
}

/** What {@link createHooks} returns: the public member, and the two entry points the Bureau drives. */
export interface CreatedHooks {
  /** `Bureau.hooks`. */
  readonly hooks: BureauHooks;
  /** Delivers a published event to every enabled hook that lists its kind. Never throws. */
  dispatch(envelope: BureauEventEnvelope): void;
  /** Resumes every pending delivery whose lease has expired; resolves with how many. */
  resume(): Promise<number>;
}

function viewOf(record: HookRecord): Hook {
  const { version: _version, ...hook } = record;
  return hook;
}

function deliveryViewOf(record: HookDeliveryRecord): HookDelivery {
  const { version: _version, leaseUntil: _lease, revision: _revision, ...delivery } = record;
  return delivery;
}

function invalid(path: string, message: string): never {
  throw new HookError('invalid', message, { issues: [{ path: [path], message }] });
}

function checkedEvents(events: readonly string[]): string[] {
  if (!Array.isArray(events) || events.length === 0) {
    invalid('events', 'A hook needs at least one event kind');
  }
  if (events.length > MAXIMUM_EVENT_KINDS) {
    invalid('events', `A hook lists at most ${MAXIMUM_EVENT_KINDS} event kinds`);
  }
  for (const kind of events) {
    if (typeof kind !== 'string' || !PUBLISHED_KINDS.has(kind)) {
      invalid('events', `"${String(kind)}" is not a published Bureau event kind`);
    }
  }
  return [...new Set(events)];
}

function checkedSecret(secret: unknown): string {
  if (
    typeof secret !== 'string' ||
    secret.length < HOOK_SECRET_MINIMUM_LENGTH ||
    secret.length > HOOK_SECRET_MAXIMUM_LENGTH
  ) {
    invalid(
      'signingSecret',
      `The signing secret must be ${HOOK_SECRET_MINIMUM_LENGTH} to ${HOOK_SECRET_MAXIMUM_LENGTH} characters`,
    );
  }
  return secret;
}

function checkedName(name: unknown): string {
  if (typeof name !== 'string' || name.length === 0 || name.length > NAME_MAXIMUM_LENGTH) {
    invalid('name', `The name must be 1 to ${NAME_MAXIMUM_LENGTH} characters`);
  }
  return name;
}

/** Builds `Bureau.hooks` over the notifier's engine. */
export function createHooks(dependencies: HooksDependencies): CreatedHooks {
  const { engine, kv } = dependencies;
  const store: HookStore = createHookStore(kv);
  const secrets = dependencies.secrets ?? createKvHookSecretStore(kv);
  const urlPolicy = dependencies.urlPolicy ?? {};
  const deliveries = createHookDeliveries({
    engine,
    store,
    secrets,
    keys: dependencies.keys,
    urlPolicy,
    requestTimeoutMilliseconds:
      dependencies.requestTimeoutMilliseconds ?? DEFAULT_HOOK_REQUEST_TIMEOUT_MILLISECONDS,
    newId: () => dependencies.newId('hook-delivery'),
    audit: (entry) =>
      dependencies.audit({
        runId: `hook:${entry.hookId}`,
        type: 'hook.delivery.exhausted',
        detail: {
          hookId: entry.hookId,
          owner: entry.owner,
          deliveryId: entry.deliveryId,
          attempts: entry.attempts,
          status: entry.status,
        },
      }),
    diagnose: dependencies.diagnose,
  });

  // The hooks dispatch matches against, read from the store and kept for a few seconds: every
  // published event is matched, and `action` is one of them. This process's own changes drop the
  // copy at once; another process's are seen when it expires.
  let cachedHooks: { readonly hooks: readonly HookRecord[]; readonly readAt: number } | undefined;
  function forgetCachedHooks(): void {
    cachedHooks = undefined;
  }
  async function matching(kind: string): Promise<readonly HookRecord[]> {
    const now = engine.now();
    if (cachedHooks === undefined || now - cachedHooks.readAt > HOOK_CACHE_MILLISECONDS) {
      cachedHooks = { hooks: await store.listHooks(), readAt: now };
    }
    return cachedHooks.hooks.filter((hook) => hook.enabled && hook.events.includes(kind));
  }

  /**
   * The secret sealed for `hookId`, after the checks that precede any write (the host's lock, the
   * Bureau's key). Nothing is written: the caller writes it with {@link HookSecretStore.set} once
   * the hook record it belongs to has been committed.
   */
  async function sealSecret(hookId: string, secret: string): Promise<EncryptedValue> {
    const lock = secrets.writeLock?.();
    if (lock !== undefined) {
      throw new HookError('locked', `This deployment locks hook secrets (${lock})`, {
        lockReason: lock,
      });
    }
    if (dependencies.keys === undefined) {
      throw new HookError(
        'no-encryption',
        'The Bureau has no answerEncryption key, so it cannot seal a signing secret',
      );
    }
    return sealHookSecret(hookId, secret, dependencies.keys);
  }

  /** Records a change; `actor` is the caller's principal (never the owner), omitted when unknown. */
  function recordChange(type: string, record: HookRecord, actor: string | undefined): void {
    forgetCachedHooks();
    void dependencies
      .audit({
        runId: `hook:${record.id}`,
        type,
        ...(actor === undefined ? {} : { principal: actor }),
        detail: { hookId: record.id, owner: record.owner },
      })
      .catch((cause: unknown) => dependencies.diagnose('Failed to audit a hook change', cause));
  }

  const hooks: BureauHooks = {
    async create(input) {
      const url = input.url;
      const defect =
        typeof url === 'string' ? hookUrlDefect(url, urlPolicy) : 'The URL is required';
      if (defect !== undefined) invalid('url', defect);
      const events = checkedEvents(input.events);
      const secret = checkedSecret(input.signingSecret);
      const name = input.name === undefined ? undefined : checkedName(input.name);
      const owner = ownerFromPrincipal(input.principal, (message) => invalid('principal', message));
      const now = engine.now();
      const record: HookRecord = {
        version: 1,
        id: dependencies.newId('hook'),
        owner,
        ...(name === undefined ? {} : { name }),
        url,
        events,
        enabled: input.enabled ?? true,
        createdAt: now,
        updatedAt: now,
        revision: 1,
      };
      const sealed = await sealSecret(record.id, secret);
      await secrets.set(record.id, sealed);
      let created = false;
      try {
        created = await store.createHook(record);
      } finally {
        if (!created) await secrets.delete(record.id).catch(() => undefined);
      }
      if (!created) throw new Error(`Hook id "${record.id}" is already in use`);
      // The creator is the owner, so the owner is also the actor.
      recordChange('hook.created', record, owner);
      return viewOf(record);
    },
    async update(hookId, input) {
      // The caller's input is read, checked and copied before the first await: the caller owns it
      // and may change it while the store is read.
      const url = input.url;
      if (url !== undefined) {
        const defect = hookUrlDefect(url, urlPolicy);
        if (defect !== undefined) invalid('url', defect);
      }
      const events = input.events === undefined ? undefined : checkedEvents(input.events);
      const secret =
        input.signingSecret === undefined ? undefined : checkedSecret(input.signingSecret);
      const name =
        input.name === null || input.name === undefined ? input.name : checkedName(input.name);
      const enabled = input.enabled;
      const expectedRevision = input.expectedRevision;
      const actor = input.principal;

      const stored = await store.getHook(hookId);
      if (stored === undefined) return undefined;
      const before = stored.record;
      if (expectedRevision !== undefined && expectedRevision !== before.revision) {
        throw new HookError('stale-revision', 'The hook has changed since it was read', {
          currentRevision: before.revision,
        });
      }
      const nextName = name === undefined ? before.name : (name ?? undefined);
      const { name: _previousName, ...withoutName } = before;
      const after: HookRecord = {
        ...withoutName,
        ...(nextName === undefined ? {} : { name: nextName }),
        url: url ?? before.url,
        events: events ?? before.events,
        enabled: enabled ?? before.enabled,
        updatedAt: engine.now(),
        revision: before.revision + 1,
      };
      // Sealed (and the lock and key checked) before the commit, written after it: a writer that
      // loses the compare-and-swap leaves the secret the winner's, not its own.
      const sealed = secret === undefined ? undefined : await sealSecret(hookId, secret);
      if (!(await store.replaceHook(stored, after))) {
        const current = await store.getHook(hookId);
        if (current === undefined) return undefined;
        throw new HookError('stale-revision', 'The hook has changed since it was read', {
          currentRevision: current.record.revision,
        });
      }
      if (sealed !== undefined) await secrets.set(hookId, sealed);
      recordChange('hook.updated', after, actor);
      return viewOf(after);
    },
    async delete(hookId, options) {
      const stored = await store.getHook(hookId);
      if (stored === undefined) return false;
      if (!(await store.deleteHook(stored))) return false;
      await secrets
        .delete(hookId)
        .catch((cause: unknown) =>
          dependencies.diagnose('Failed to remove a hook’s sealed secret', cause),
        );
      await store.deleteDeliveriesOf(hookId);
      recordChange('hook.deleted', stored.record, options?.principal);
      return true;
    },
    async get(hookId) {
      const stored: Stored<HookRecord> | undefined = await store.getHook(hookId);
      return stored === undefined ? undefined : viewOf(stored.record);
    },
    async list(filter) {
      const owner = filter?.owner;
      const all = await store.listHooks();
      return all
        .filter((hook) => owner === undefined || hook.owner === owner)
        .toSorted((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
        .map(viewOf);
    },
    async test(hookId, options) {
      const stored = await store.getHook(hookId);
      if (stored === undefined) return undefined;
      const id = await deliveries.enqueue(
        stored.record,
        {
          kind: HOOK_TEST_EVENT_KIND,
          bureauId: dependencies.bureauId,
          emittedAtMs: engine.now(),
          payload: { message: 'This is a test delivery from Corvidae.' },
        },
        true,
      );
      recordChange('hook.tested', stored.record, options?.principal);
      const driving = deliveries.drive(id);
      engine.track(driving);
      await driving;
      const finished = await store.getDelivery(id);
      return finished === undefined ? undefined : deliveryViewOf(finished.record);
    },
    async deliveries(hookId, options) {
      const requested = options?.limit ?? 50;
      const limit = Number.isInteger(requested) ? Math.min(Math.max(requested, 1), 200) : 50;
      const all = await store.listDeliveries();
      return all
        .filter((delivery) => delivery.hookId === hookId)
        .toSorted((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id))
        .slice(0, limit)
        .map(deliveryViewOf);
    },
  };

  function dispatch(envelope: BureauEventEnvelope): void {
    // A Bureau that is shutting down starts no new delivery: its storage is about to close, and an
    // event that happens while it is down is not replayed.
    if (engine.shuttingDown()) return;
    // Read before the first await: the envelope is the feed's, and the work below outlives the call.
    const event: HookEventToDeliver = {
      kind: envelope.kind,
      bureauId: envelope.bureauId,
      emittedAtMs: envelope.emittedAtMs,
      payload: envelope.payload,
    };
    // A failing endpoint's own diagnostic must not become the event that fails it again.
    const scope = event.payload['scope'];
    if (event.kind === 'diagnostic' && (scope === 'webhook' || scope === 'hooks')) return;
    const work = (async () => {
      // The deliveries are awaited here, so the one tracked promise covers all of them: a `flush()`
      // or `dispose()` that took its snapshot before they began still waits for them.
      const driving: Promise<void>[] = [];
      for (const hook of await matching(event.kind)) {
        driving.push(deliveries.drive(await deliveries.enqueue(hook, event, false)));
      }
      await Promise.allSettled(driving);
    })().catch((cause: unknown) => dependencies.diagnose('Failed to dispatch a hook event', cause));
    engine.track(work);
  }

  return { hooks, dispatch, resume: () => deliveries.resume() };
}
