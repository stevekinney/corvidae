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
 * ## Actions
 *
 * A hook does one of four things for each event it matches (`HookAction`, tagged by `type`):
 *
 * - `webhook` sends the event, signed, to a URL, as above. The only action with a signing secret.
 * - `start-workflow` starts a workflow as the hook's owner. The workflow's input is the event's
 *   payload, or `{ kind, bureauId, emittedAtMs, payload }` when the action says `input: 'event'`.
 *   Input the workflow's `inputSchema` refuses is recorded on the delivery as a `rejected` attempt
 *   and ends it `failed`: it is not retried, because the same event gives the same input. A start
 *   is keyed `hook:<hookId>:<deliveryId>` (Weft's `idempotencyKey`), so a delivery retried or
 *   resumed after an interrupted attempt starts one run, and one whose start had already committed
 *   is delivered with that run, whatever the workflow file says by then
 *   (`BureauWorkflows.findStart`). The hook owner's authority is checked when the hook is written
 *   and again for every delivery: in v1 only the deployment's owner of record
 *   (`anonymous:local`) may own such a hook, because the Bureau knows an owner but not the scopes
 *   its credential held, so it cannot re-check a scope when an event fires. The instance it
 *   starts is tagged (`hook-origin.ts`), and a `start-workflow` hook acts only on events it can
 *   place: a kind that names a run, which it follows back to see whether a hook started it (then
 *   that delivery is written, ends `failed`, and says why), or a kind no run causes. It cannot list
 *   a kind that may come from a run without naming one (`notification.created`, `session.saved`);
 *   this is refused when the hook is written and checked again as the event is dispatched. So
 *   hooks cannot chain.
 * - `notify` writes a notification for the hook's owner, never for anyone else, keyed
 *   `hook:<hookId>:<deliveryId>` so a replayed delivery writes one. It cannot list
 *   `notification.created`, which the notification it writes would fire again; this is refused when
 *   the hook is written and checked again as the event is dispatched.
 *
 * - `plugin` runs an action kind a plugin contributed (COR-1876), named by the plugin and the kind.
 *   The kind's schema parses `configuration` when the hook is written and again for each delivery;
 *   the action receives the event, with `source` set when a plugin's contribution emitted it. A
 *   rejection is a failed attempt and is retried like any other; a kind that is no longer
 *   contributed ends the delivery `failed`.
 *
 * A hook's action type is fixed when it is created; `update` changes the fields of the action.
 * A record stored before actions existed has a top-level `url` and reads as a webhook.
 *
 * ## Matching
 *
 * `hooks.test` sends a test delivery to a webhook hook only: for the other actions it would start a
 * real run or write a real notification, so it is refused.
 *
 *
 * A hook fires on the published event kinds it lists (`PUBLISHED_BUREAU_EVENT_KINDS`), for events
 * of the whole Bureau: the feed is fleet-wide, so the operations require `bureau.events:observe-all`
 * to create or change a hook. Events that happen while the Bureau is down are not replayed;
 * deliveries already created are resumed.
 *
 * @module create-hooks
 */

import { ownerFromPrincipal, ownerOrLocal } from '../owner-of-record.ts';
import type { BureauNotifications } from '../notifications/notification-types.ts';
import { NOTIFICATION_FIELD_LIMITS } from '../notifications/notification-types.ts';
import type { BureauWorkflows } from '../workflow-runtime.ts';
import { PUBLISHED_BUREAU_EVENT_KINDS, type BureauEventEnvelope } from '../bureau-event-feed.ts';
import { BUREAU_EVENT_CATALOG, type BureauEventOrigin } from '../bureau-event-catalog.ts';
import type { AnswerEncryptionKeys } from '../secret-answers.ts';
import type { WebhookDeliveryEngine } from '../webhook-notifier.ts';
import {
  createHookDeliveries,
  DEFAULT_HOOK_REQUEST_TIMEOUT_MILLISECONDS,
  type HookActionRunner,
  type HookEventToDeliver,
} from './hook-delivery.ts';
import { type DeletedChatReference, purgeChatHookDeliveries } from './chat-hook-purge.ts';
import {
  createHookStore,
  createKvHookSecretStore,
  sealHookSecret,
  type HookStore,
  type Stored,
} from './hook-store.ts';
import {
  HookActionError,
  type HookActionKindRegistration,
  HookError,
  NOTIFICATION_CREATED_EVENT_KIND,
  type Hook,
  type HookAction,
  type HookDelivery,
  type HookDeliveryRecord,
  type HookRecord,
  type HookSecretStore,
  type HookWorkflowInput,
} from './hook-types.ts';
import { hookOriginTag, runOfPayload } from './hook-origin.ts';
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

/** Stands in for the hook that started a run when the lookup failed. */
const CHAIN_UNKNOWN = '\u0000unknown';

/** What a hook is asked to do, as `hooks.create` and `hooks.update` take it. */
export type HookActionInput =
  | {
      readonly type: 'webhook';
      /** Where each delivery is POSTed. */
      readonly url: string;
    }
  | {
      readonly type: 'start-workflow';
      /** The workflow to start, as the hook's owner. It must be ready and unpaused. */
      readonly workflowId: string;
      /** What of the event is the input; `payload` when omitted. */
      readonly input?: HookWorkflowInput | undefined;
    }
  | {
      readonly type: 'notify';
      /** The notification's title, at most 200 characters; without one it names the event kind. */
      readonly title?: string | undefined;
    }
  | {
      readonly type: 'plugin';
      /** The plugin that contributes the action kind. */
      readonly plugin: string;
      /** The action kind's name within the plugin. */
      readonly kind: string;
      /** The kind's configuration, checked against the schema the kind declares. */
      readonly configuration?: unknown;
    };

/** What `hooks.create` takes. Name the action with `action`, or with `url` for a webhook. */
export interface HookCreateInput {
  /** A webhook's URL: shorthand for `action: { type: 'webhook', url }`. Give this or `action`, not both. */
  readonly url?: string;
  /** What the hook does. Give this or `url`, not both. */
  readonly action?: HookActionInput;
  /** The published Bureau event kinds the hook fires on. */
  readonly events: readonly string[];
  /** The secret webhook deliveries are signed with, 16 to 256 characters. Required for a webhook and refused otherwise. Sealed on arrival; never returned. */
  readonly signingSecret?: string;
  /** A label, at most 100 characters. */
  readonly name?: string;
  /** Whether the hook fires. Defaults to `true`. */
  readonly enabled?: boolean;
  /** The owner's principal (`api-key:<subject>`); omitted, the hook belongs to `anonymous:local`. */
  readonly principal?: string;
}

/** What `hooks.update` changes; a field left out stays as it is. */
export interface HookUpdateInput {
  /** The new URL of a webhook hook; shorthand for an `action` that only sets `url`. */
  readonly url?: string;
  /** The hook's action again, with new fields. Its `type` must be the hook's: the type is fixed at creation. */
  readonly action?: HookActionInput;
  /** The new event kinds, replacing the list. */
  readonly events?: readonly string[];
  /** A new signing secret, sealed on arrival; never returned. A webhook hook only. */
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
  /** The Bureau's workflows, read when needed; `undefined` while it has none. */
  readonly workflows?:
    | (() => Pick<BureauWorkflows, 'start' | 'assertStartable' | 'findStart'> | undefined)
    | undefined;
  /** The Bureau's notifications, read when needed. */
  readonly notifications?: (() => Pick<BureauNotifications, 'create'> | undefined) | undefined;
  /**
   * Whether `owner` may start workflows, asked when a `start-workflow` hook is written and for each
   * delivery. Defaults to the deployment's owner of record alone.
   */
  readonly mayStartWorkflows?: ((owner: string) => boolean) | undefined;
  /**
   * The hook that started the run `runId` names, or a run above it, or `undefined` when no hook
   * did. A `start-workflow` hook does not start a workflow for an event whose run a hook started,
   * so hooks cannot chain. It may throw; the event is then treated as a hook's own.
   */
  readonly startedByHook?: ((runId: string) => Promise<string | undefined>) | undefined;
  /** How long one request may take. */
  readonly requestTimeoutMilliseconds?: number | undefined;
  /**
   * The hook action kinds plugins contribute (COR-1876), the entry point plugin composition feeds.
   * Two registrations of one plugin and kind name are refused. Omitted, only the built-in actions
   * exist.
   */
  readonly actionKinds?: readonly HookActionKindRegistration[] | undefined;
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
  /** Reports something that is not a failure but that a person may want to see, such as a skipped start. */
  readonly notice?: ((message: string) => void) | undefined;
}

/** What {@link createHooks} returns: the public member, and the two entry points the Bureau drives. */
export interface CreatedHooks {
  /** `Bureau.hooks`. */
  readonly hooks: BureauHooks;
  /**
   * Delivers a published event to every enabled hook that lists its kind. Never throws. Until
   * {@link CreatedHooks.resume} is first called the event is held, not delivered (see `resume`).
   */
  dispatch(envelope: BureauEventEnvelope): void;
  /**
   * Opens the hooks to events and resumes every pending delivery whose lease has expired; resolves
   * with how many. The Bureau calls it once its workflow files are loaded. Events published before
   * then (the session outbox replayed at boot, for one) are held and dispatched here, because a
   * `start-workflow` delivery made earlier would find no workflow, and "does not exist" is a
   * permanent failure that would end the delivery for good.
   */
  resume(): Promise<number>;
  /** Removes settled deliveries last written more than the given milliseconds ago; resolves with how many. */
  prune(olderThanMilliseconds: number): Promise<number>;
  /**
   * Removes the deliveries of events about a deleted chat's runs (COR-1953), pending ones
   * included, so none is still sent; resolves with how many.
   */
  purgeChatDeliveries(chat: DeletedChatReference, runIds: ReadonlySet<string>): Promise<number>;
}

function viewOf(record: HookRecord): Hook {
  const { version: _version, ...hook } = record;
  return hook;
}

function deliveryViewOf(record: HookDeliveryRecord): HookDelivery {
  const { version: _version, leaseUntil: _lease, revision: _revision, ...delivery } = record;
  return delivery;
}

function invalid(path: string | readonly string[], message: string): never {
  throw new HookError('invalid', message, {
    issues: [{ path: typeof path === 'string' ? [path] : [...path], message }],
  });
}

const WORKFLOW_ID_MAXIMUM_LENGTH = 256;

/** The key a contributed action kind is looked up by. Plugin and kind names contain no `/`. */
function actionKindKey(plugin: string, kind: string): string {
  return `${plugin}/${kind}`;
}

/** The kinds `registrations` name, by {@link actionKindKey}; a repeated name is refused. */
function actionKindsOf(
  registrations: readonly HookActionKindRegistration[] | undefined,
): ReadonlyMap<string, HookActionKindRegistration> {
  const kinds = new Map<string, HookActionKindRegistration>();
  for (const registration of registrations ?? []) {
    const key = actionKindKey(registration.plugin, registration.kind.name);
    if (kinds.has(key)) throw new Error(`Hook action kind "${key}" is contributed twice`);
    kinds.set(key, registration);
  }
  return kinds;
}

/** `configuration` parsed with the schema of `registration`'s kind, or the reason it is refused. */
function parsedConfiguration(
  registration: HookActionKindRegistration,
  configuration: unknown,
):
  { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly reason: string } {
  const parsed = registration.kind.configuration.safeParse(configuration);
  if (parsed.success) return { ok: true, value: parsed.data };
  return {
    ok: false,
    reason: parsed.error.issues
      .map((issue) => `${issue.path.join('.') || 'configuration'}: ${issue.message}`)
      .join('; '),
  };
}

/** Checks and copies the fields of `input` that its `type` names; every other field is dropped. */
function checkedAction(
  input: unknown,
  urlPolicy: HookUrlPolicy,
  kinds: ReadonlyMap<string, HookActionKindRegistration>,
): HookAction {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    invalid('action', 'The action must be an object');
  }
  const action = input as Record<string, unknown>;
  switch (action['type']) {
    case 'webhook': {
      const url = action['url'];
      const defect =
        typeof url === 'string' ? hookUrlDefect(url, urlPolicy) : 'The URL is required';
      if (defect !== undefined || typeof url !== 'string') {
        invalid(['action', 'url'], defect ?? 'The URL is required');
      }
      return { type: 'webhook', url };
    }
    case 'start-workflow': {
      const workflowId = action['workflowId'];
      if (
        typeof workflowId !== 'string' ||
        workflowId.length === 0 ||
        workflowId.length > WORKFLOW_ID_MAXIMUM_LENGTH
      ) {
        invalid(
          ['action', 'workflowId'],
          `The workflow identifier must be 1 to ${WORKFLOW_ID_MAXIMUM_LENGTH} characters`,
        );
      }
      const mapping = action['input'] ?? 'payload';
      if (mapping !== 'payload' && mapping !== 'event') {
        invalid(['action', 'input'], 'The input must be "payload" or "event"');
      }
      return { type: 'start-workflow', workflowId, input: mapping };
    }
    case 'notify': {
      const title = action['title'];
      if (title === undefined) return { type: 'notify' };
      if (
        typeof title !== 'string' ||
        title.length === 0 ||
        title.length > NOTIFICATION_FIELD_LIMITS.title
      ) {
        invalid(
          ['action', 'title'],
          `The title must be 1 to ${NOTIFICATION_FIELD_LIMITS.title} characters`,
        );
      }
      return { type: 'notify', title };
    }
    case 'plugin': {
      const plugin = action['plugin'];
      const kind = action['kind'];
      if (typeof plugin !== 'string' || typeof kind !== 'string') {
        invalid(['action', 'kind'], 'A plugin action names its plugin and its kind');
      }
      const registration = kinds.get(actionKindKey(plugin, kind));
      if (registration === undefined) {
        invalid(
          ['action', 'kind'],
          `No plugin contributes the hook action kind "${plugin}/${kind}"`,
        );
      }
      // Copied now: the caller owns `input` and the delivery is created long after. A value JSON
      // cannot carry could not be stored, so it is refused here, not when the hook is written.
      let configuration: unknown;
      try {
        const text = JSON.stringify(action['configuration']);
        configuration = text === undefined ? undefined : (JSON.parse(text) as unknown);
      } catch {
        invalid(['action', 'configuration'], 'The configuration must be JSON');
      }
      const checked = parsedConfiguration(registration, configuration);
      if (!checked.ok) invalid(['action', 'configuration'], checked.reason);
      return configuration === undefined
        ? { type: 'plugin', plugin, kind }
        : { type: 'plugin', plugin, kind, configuration };
    }
    default:
      invalid(
        ['action', 'type'],
        'The action type must be "webhook", "start-workflow", "notify" or "plugin"',
      );
  }
}

/** A notification hook that listed `notification.created` would write a notification for each one it wrote. */
function assertNoNotificationLoop(action: HookAction, events: readonly string[]): void {
  if (action.type === 'notify' && events.includes(NOTIFICATION_CREATED_EVENT_KIND)) {
    invalid(
      'events',
      `A notify hook cannot fire on ${NOTIFICATION_CREATED_EVENT_KIND}: the notification it writes would fire it again`,
    );
  }
}

/** Where an event of `kind` can come from: a kind the catalog does not describe is unattributed. */
function originOfKind(kind: string): BureauEventOrigin {
  return Object.hasOwn(BUREAU_EVENT_CATALOG, kind)
    ? BUREAU_EVENT_CATALOG[kind as keyof typeof BUREAU_EVENT_CATALOG].origin
    : 'unattributed';
}

/**
 * A `start-workflow` hook may list only the kinds whose cause the Bureau can place: a `run` kind,
 * which names a run to follow back to a hook, or an `external` one, which no run causes. An
 * `unattributed` kind (the notification a `notify` hook writes, a session saved, a diagnostic) may
 * be raised by the run the hook started and leads back to no run, so a hook listing it could start
 * itself without end. See `hook-origin.ts`.
 */
function assertNoUnplacedStart(action: HookAction, events: readonly string[]): void {
  if (action.type !== 'start-workflow') return;
  const unplaced = events.filter((kind) => originOfKind(kind) === 'unattributed');
  if (unplaced.length > 0) {
    invalid(
      'events',
      `A start-workflow hook cannot fire on ${unplaced.join(', ')}: a run the hook started can raise ${unplaced.length === 1 ? 'it' : 'them'} and nothing on ${unplaced.length === 1 ? 'it' : 'them'} leads back to that run, so the hook could start itself again`,
    );
  }
}

/**
 * The error codes of a start that a retry cannot change: input the workflow refuses
 * (`input-invalid`), a workflow that is missing or paused (`NOT_FOUND`), a value the engine cannot
 * send (`BAD_REQUEST`), and a key whose run was purged by retention
 * (`IdempotencyKeyPurgedError`, Weft's: the same key answers the same way). Anything else, such as
 * `workflow-apply-failed` (the engine has not followed a file change yet), is retried.
 */
const PERMANENT_ACTION_FAILURES: ReadonlySet<unknown> = new Set([
  'input-invalid',
  'NOT_FOUND',
  'BAD_REQUEST',
  'IdempotencyKeyPurgedError',
]);

/** Whether a failure of a hook action is one a retry cannot change. */
function isPermanentStartFailure(error: unknown): boolean {
  return PERMANENT_ACTION_FAILURES.has((error as { readonly code?: unknown } | null)?.code);
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
  const actionKinds = actionKindsOf(dependencies.actionKinds);
  const mayStartWorkflows =
    dependencies.mayStartWorkflows ?? ((owner: string) => owner === ownerOrLocal(undefined));

  /** The action `input` asks for: `action`, or the webhook that `url` stands for. */
  function actionOfCreate(input: HookCreateInput): HookAction {
    if (input.url !== undefined && input.action !== undefined) {
      invalid('action', 'Give `url` or `action`, not both');
    }
    if (input.action !== undefined) return checkedAction(input.action, urlPolicy, actionKinds);
    if (input.url === undefined) invalid('action', 'A hook needs an action, or a url');
    // The shorthand names its field `url`, as it always has.
    const defect =
      typeof input.url === 'string' ? hookUrlDefect(input.url, urlPolicy) : 'The URL is required';
    if (defect !== undefined) invalid('url', defect);
    return { type: 'webhook', url: input.url };
  }

  /**
   * What must hold for `owner` to have a hook with `action`, checked as the hook is written. A
   * `start-workflow` hook needs a Bureau with workflows, an owner who may start them, and a
   * workflow that is ready and unpaused now.
   */
  async function assertActionAllowed(action: HookAction, owner: string): Promise<void> {
    if (action.type !== 'start-workflow') return;
    if (!mayStartWorkflows(owner)) {
      throw new HookError('forbidden', 'This owner may not start workflows from a hook');
    }
    const workflows = dependencies.workflows?.();
    if (workflows === undefined) {
      invalid(
        ['action', 'workflowId'],
        'This Bureau has no workflow directory, so it has no workflows',
      );
    }
    try {
      workflows.assertStartable(action.workflowId);
    } catch {
      invalid(
        ['action', 'workflowId'],
        `Workflow "${action.workflowId}" does not exist, or is paused or invalid`,
      );
    }
  }

  const actionRunner: HookActionRunner = {
    async run(work, context) {
      // One key per delivery: the delivery is created once per event and hook, and its attempts
      // (a retry, or the one after an interrupted attempt) are the repeats the key makes harmless.
      const key = `hook:${context.hookId}:${context.deliveryId}`;
      if (work.type === 'start-workflow') {
        // Decided as the event was dispatched; see `dispatch`.
        if (work.skip !== undefined) throw new HookActionError(work.skip, true);
        // Asked again as the event fires: the authority is the owner's now, not at creation.
        if (!mayStartWorkflows(context.owner)) {
          throw new HookActionError('The hook’s owner may not start workflows', true);
        }
        const workflows = dependencies.workflows?.();
        if (workflows === undefined) {
          throw new HookActionError('This Bureau has no workflow directory', true);
        }
        // A start may have committed before the delivery's receipt was written (a crash, or a lost
        // response). Its run is the answer whatever the workflow file says now: the file may since
        // have been edited, paused, or deleted, and validating against it would end a delivery
        // `failed` for a run that did start. Only a lookup that cannot answer is an error, and it is
        // retried: it says nothing about whether a run exists.
        try {
          const committed = await workflows.findStart(key);
          if (committed !== undefined) return { runId: committed.runId };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const purged = (error as { readonly code?: unknown } | null)?.code;
          throw new HookActionError(message, purged === 'IdempotencyKeyPurgedError');
        }
        try {
          const started = await workflows.start(work.workflowId, {
            input: work.input,
            owner: context.owner,
            surface: 'api',
            idempotencyKey: key,
            // Marks the instance as a hook's, so the events of its runs start nothing (see `dispatch`).
            tags: [hookOriginTag(context.hookId)],
          });
          return { runId: started.runId };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw new HookActionError(message, isPermanentStartFailure(error));
        }
      }
      if (work.type === 'plugin') {
        // Resolved again as the event fires: the plugin may have been removed since the hook was written.
        const registration = actionKinds.get(actionKindKey(work.plugin, work.kind));
        if (registration === undefined) {
          throw new HookActionError(
            `No plugin contributes the hook action kind "${work.plugin}/${work.kind}"`,
            true,
          );
        }
        const checked = parsedConfiguration(registration, work.configuration);
        if (!checked.ok) {
          throw new HookActionError(
            `The action's configuration is refused: ${checked.reason}`,
            true,
          );
        }
        // A rejection is the delivery's failed attempt; the runner's caller records its message.
        await registration.kind.run({
          event: work.event,
          configuration: checked.value,
          signal: engine.signal,
        });
        return {};
      }
      const notifications = dependencies.notifications?.();
      if (notifications === undefined) {
        throw new HookActionError('This Bureau has no notifications', true);
      }
      try {
        // The owner is the hook's, from the delivery; nothing in the event can name another.
        const written = await notifications.create({
          owner: context.owner,
          kind: 'hook',
          title: work.title,
          body: work.body,
          dedupeKey: key,
        });
        return { notificationId: written.notification.id };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new HookActionError(message, isPermanentStartFailure(error));
      }
    },
  };

  const deliveries = createHookDeliveries({
    engine,
    actions: actionRunner,
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
    return cachedHooks.hooks.filter(
      (hook) =>
        hook.enabled &&
        hook.events.includes(kind) &&
        // A record that lists it anyway (written by something that skipped the check) is not fired.
        !(hook.action.type === 'notify' && kind === NOTIFICATION_CREATED_EVENT_KIND),
    );
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

  // Changes to one hook's record and secret, one at a time. The secret port is the host's and cannot
  // join the record's compare-and-swap, so without this an update that committed revision 2 and is
  // still writing its secret could land after revision 3's write and leave the older secret signing.
  const changing = new Map<string, Promise<unknown>>();
  async function exclusively<T>(hookId: string, work: () => Promise<T>): Promise<T> {
    const previous = changing.get(hookId) ?? Promise.resolve();
    const run = previous.then(work, work);
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    changing.set(hookId, settled);
    try {
      return await run;
    } finally {
      if (changing.get(hookId) === settled) changing.delete(hookId);
    }
  }

  const hooks: BureauHooks = {
    async create(input) {
      // The caller owns `input`: every field is read and checked before the first await.
      const action = actionOfCreate(input);
      const events = checkedEvents(input.events);
      const secret = action.type === 'webhook' ? checkedSecret(input.signingSecret) : undefined;
      if (action.type !== 'webhook' && input.signingSecret !== undefined) {
        invalid('signingSecret', 'Only a webhook hook has a signing secret');
      }
      const name = input.name === undefined ? undefined : checkedName(input.name);
      const owner = ownerFromPrincipal(input.principal, (message) => invalid('principal', message));
      const enabled = input.enabled ?? true;
      assertNoNotificationLoop(action, events);
      assertNoUnplacedStart(action, events);
      await assertActionAllowed(action, owner);
      const now = engine.now();
      const record: HookRecord = {
        version: 1,
        id: dependencies.newId('hook'),
        owner,
        ...(name === undefined ? {} : { name }),
        action,
        events,
        enabled,
        createdAt: now,
        updatedAt: now,
        revision: 1,
      };
      const sealed = secret === undefined ? undefined : await sealSecret(record.id, secret);
      if (sealed !== undefined) await secrets.set(record.id, sealed);
      let created = false;
      try {
        created = await store.createHook(record);
      } finally {
        if (!created && sealed !== undefined)
          await secrets.delete(record.id).catch(() => undefined);
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
        if (input.action !== undefined) invalid('action', 'Give `url` or `action`, not both');
        const defect = hookUrlDefect(url, urlPolicy);
        if (defect !== undefined) invalid('url', defect);
      }
      const replacement =
        input.action === undefined
          ? undefined
          : checkedAction(input.action, urlPolicy, actionKinds);
      const events = input.events === undefined ? undefined : checkedEvents(input.events);
      const secret =
        input.signingSecret === undefined ? undefined : checkedSecret(input.signingSecret);
      const name =
        input.name === null || input.name === undefined ? input.name : checkedName(input.name);
      const enabled = input.enabled;
      const expectedRevision = input.expectedRevision;
      const actor = input.principal;

      return exclusively(hookId, async () => {
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
        if (url !== undefined && before.action.type !== 'webhook') {
          invalid('url', 'Only a webhook hook has a URL');
        }
        if (replacement !== undefined && replacement.type !== before.action.type) {
          invalid(['action', 'type'], 'A hook’s action type cannot change; create another hook');
        }
        if (
          replacement?.type === 'plugin' &&
          before.action.type === 'plugin' &&
          (replacement.plugin !== before.action.plugin || replacement.kind !== before.action.kind)
        ) {
          invalid(
            ['action', 'kind'],
            'A plugin hook’s action kind cannot change; create another hook',
          );
        }
        if (secret !== undefined && before.action.type !== 'webhook') {
          invalid('signingSecret', 'Only a webhook hook has a signing secret');
        }
        const action: HookAction =
          replacement ?? (url === undefined ? before.action : { type: 'webhook', url });
        const nextEvents = events ?? before.events;
        assertNoNotificationLoop(action, nextEvents);
        assertNoUnplacedStart(action, nextEvents);
        // Authority is asked again only when the action is rewritten, so a rename or a disable is
        // never held up by a workflow that has since been paused.
        if (replacement !== undefined) await assertActionAllowed(action, before.owner);
        const after: HookRecord = {
          ...withoutName,
          ...(nextName === undefined ? {} : { name: nextName }),
          action,
          events: nextEvents,
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
      });
    },
    async delete(hookId, options) {
      return exclusively(hookId, async () => {
        const stored = await store.getHook(hookId);
        if (stored === undefined) return false;
        if (!(await store.deleteHook(stored))) return false;
        if (stored.record.action.type === 'webhook') {
          await secrets
            .delete(hookId)
            .catch((cause: unknown) =>
              dependencies.diagnose('Failed to remove a hook’s sealed secret', cause),
            );
        }
        await store.deleteDeliveriesOf(hookId);
        recordChange('hook.deleted', stored.record, options?.principal);
        return true;
      });
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
      if (stored.record.action.type !== 'webhook') {
        invalid(
          'action',
          'Only a webhook hook can be tested: a test would start a real run, write a real notification or run a real plugin action',
        );
      }
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

  /**
   * The hook that started `runId` (or a run above it), or `'unknown'` when that cannot be read: a
   * lookup that fails is treated as a hook's own run, because the cost of a wrong guess is a chain
   * with no end, and the skip is recorded on the delivery where a person can see it.
   */
  async function startedBy(runId: string): Promise<string | undefined> {
    if (dependencies.startedByHook === undefined) return undefined;
    try {
      return await dependencies.startedByHook(runId);
    } catch (cause) {
      dependencies.diagnose('Could not tell whether a hook started a run', cause);
      return CHAIN_UNKNOWN;
    }
  }

  /** Why a `start-workflow` hook starts nothing for an event, or `undefined` when it starts it. */
  function chainSkipReason(
    startedByHook: string | undefined,
    hook: HookRecord,
    event: HookEventToDeliver,
  ): string | undefined {
    if (startedByHook === undefined) return undefined;
    const reason =
      startedByHook === CHAIN_UNKNOWN
        ? 'Skipped: could not tell whether the run this event is about was started by a hook, and a hook does not start a workflow for the events of a run a hook started'
        : `Skipped: ${event.kind} is about a run that hook ${startedByHook} started, and a hook does not start a workflow for the events of a run a hook started`;
    dependencies.notice?.(`[bureau] Hook ${hook.id} did not start a workflow: ${reason}`);
    return reason;
  }

  /**
   * Why a `start-workflow` hook starts nothing for an event whose kind is `origin`, decided without
   * a lookup, or `undefined` when the run it names has to be followed (`run` kind) or nothing needs
   * following (`external`). The same rule the hook was held to when it was written, applied again
   * because a record can list a kind it should not.
   */
  function placementSkipReason(
    origin: BureauEventOrigin,
    runId: string | undefined,
    hook: HookRecord,
    event: HookEventToDeliver,
  ): string | undefined {
    if (origin === 'external') return undefined;
    if (origin === 'run' && runId !== undefined) return undefined;
    const reason =
      origin === 'run'
        ? `Skipped: this ${event.kind} event names no run, so it cannot be told from one about a run a hook started`
        : `Skipped: ${event.kind} can be raised by a run a hook started and names no run, and a hook does not start a workflow for it`;
    dependencies.notice?.(`[bureau] Hook ${hook.id} did not start a workflow: ${reason}`);
    return reason;
  }

  // Events published before `resume()` opens the hooks, in the order they happened. `undefined`
  // once open.
  let held: BureauEventEnvelope[] | undefined = [];

  function dispatch(envelope: BureauEventEnvelope): void {
    if (held !== undefined) {
      held.push(envelope);
      return;
    }
    // A Bureau that is shutting down starts no new delivery: its storage is about to close, and an
    // event that happens while it is down is not replayed.
    if (engine.shuttingDown()) return;
    // Read before the first await: the envelope is the feed's, and the work below outlives the call.
    const event: HookEventToDeliver = {
      kind: envelope.kind,
      bureauId: envelope.bureauId,
      emittedAtMs: envelope.emittedAtMs,
      payload: envelope.payload,
      ...(envelope.source === undefined ? {} : { source: envelope.source }),
    };
    // A failing endpoint's own diagnostic must not become the event that fails it again.
    const scope = event.payload['scope'];
    if (event.kind === 'diagnostic' && (scope === 'webhook' || scope === 'hooks')) return;
    const work = (async () => {
      // The deliveries are awaited here, so the one tracked promise covers all of them: a `flush()`
      // or `dispose()` that took its snapshot before they began still waits for them.
      // A later hook whose delivery cannot be stored must not leave the earlier ones undrained, so
      // the wait is in a `finally`.
      const driving: Promise<void>[] = [];
      try {
        const runId = runOfPayload(event.payload);
        const origin = originOfKind(event.kind);
        let starter: Promise<string | undefined> | undefined;
        for (const hook of await matching(event.kind)) {
          let skip: string | undefined;
          if (hook.action.type === 'start-workflow') {
            skip = placementSkipReason(origin, runId, hook, event);
            if (skip === undefined && origin === 'run' && runId !== undefined) {
              // Asked once per event, and only when a hook would start something.
              starter ??= startedBy(runId);
              skip = chainSkipReason(await starter, hook, event);
            }
          }
          driving.push(deliveries.drive(await deliveries.enqueue(hook, event, false, skip)));
        }
      } finally {
        await Promise.allSettled(driving);
      }
    })().catch((cause: unknown) => dependencies.diagnose('Failed to dispatch a hook event', cause));
    engine.track(work);
  }

  return {
    hooks,
    dispatch,
    async resume() {
      // Opened first, so an event published while the held ones are dispatched is not held behind them.
      const waiting = held ?? [];
      held = undefined;
      for (const envelope of waiting) dispatch(envelope);
      return deliveries.resume();
    },
    prune: (olderThanMilliseconds) => deliveries.prune(olderThanMilliseconds),
    purgeChatDeliveries: (chat, runIds) => purgeChatHookDeliveries(store, chat, runIds),
  };
}
