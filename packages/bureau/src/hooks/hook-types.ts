import type { RunWorkspaceAuthority } from 'armorer';
/**
 * The records and errors of Bureau hooks (COR-1939): a stored hook, a delivery of one event to it,
 * and the port the signing secrets are kept through.
 *
 * @module hook-types
 */

import type { EncryptedValue } from '@lostgradient/cryptography';
import type { PluginEvent, PluginReaction } from '@lostgradient/interborough-plugin';

import type { SettingLockReason } from '../settings/settings-schema.ts';

/** What a hook does when one of its events happens. */
export type HookActionType = 'webhook' | 'start-workflow' | 'notify' | 'plugin';

/** The event, as the workflow a `start-workflow` hook starts receives it as its input. */
export type HookWorkflowInput =
  /** The event's payload alone: the object `bureau.events.catalog` describes for its kind. */
  | 'payload'
  /** `{ kind, bureauId, emittedAtMs, payload }`: the payload and what identifies the event. */
  | 'event';

/** Sends each event, signed, to `url`. The only action a hook had before COR-1940. */
export interface WebhookHookAction {
  /** Always `webhook`. */
  readonly type: 'webhook';
  /** Where each delivery is POSTed. See `hook-url-policy.ts` for what a URL may be. */
  readonly url: string;
}

/**
 * Starts the workflow `workflowId` as the hook's owner for each event, with the event as its input.
 * The run is started with the idempotency key `hook:<hookId>:<deliveryId>`, so a delivery that is
 * retried or resumed starts at most one run.
 */
export interface StartWorkflowHookAction {
  /** Always `start-workflow`. */
  readonly type: 'start-workflow';
  /** The workflow to start. */
  readonly workflowId: string;
  /** What of the event is the workflow's input. */
  readonly input: HookWorkflowInput;
}

/**
 * Writes a notification for the hook's owner, and nobody else, for each event. It cannot list
 * `notification.created`: the notification it writes would fire the hook again.
 */
export interface NotifyHookAction {
  /** Always `notify`. */
  readonly type: 'notify';
  /** The notification's title; without one it names the event kind. At most 200 characters. */
  readonly title?: string;
}

/**
 * Runs an action kind a plugin contributed (COR-1876). The kind is named by the plugin and its own
 * name, and `configuration` is what the kind's schema parsed when the hook was written. The kind
 * is resolved again for each delivery, so a hook whose plugin is gone fails its deliveries
 * (`rejected`) instead of vanishing.
 */
export interface PluginHookAction {
  /** Always `plugin`. */
  readonly type: 'plugin';
  /** The plugin that contributes the kind. */
  readonly plugin: string;
  /** The kind's name, unique within the plugin. */
  readonly kind: string;
  /** The kind's configuration, parsed with its schema; `undefined` when the schema accepted none. */
  readonly configuration?: unknown;
}

/** An action kind a plugin contributes, with the plugin that contributes it (COR-1876). */
export interface HookActionKindRegistration {
  /** The plugin's name; the `plugin` of a {@link PluginHookAction} that runs the kind. */
  readonly plugin: string;
  /** The kind itself. */
  readonly kind: PluginReaction;
  /**
   * COR-1879 — the version a delivery of this kind pins: the kind's own `version`, else its
   * plugin's. A delivery created while one version is registered runs only on that version; one
   * still pending after an upgrade fails, permanently, rather than run another. Absent for a kind
   * registered without one, whose deliveries pin nothing.
   */
  readonly version?: string | undefined;
  /**
   * COR-2176 — whether the kind's plugin can run it now: `needs-setup` while a secret the plugin
   * declared is missing. A delivery of a kind that needs setup makes no attempt and waits, with its
   * lease released, until {@link HookActionKindRegistration.onAvailabilityChange} reports the
   * secret saved. Absent, the kind is always available.
   */
  readonly availability?: (() => 'available' | 'needs-setup') | undefined;
  /**
   * COR-2176 — calls `listener` whenever {@link HookActionKindRegistration.availability} may have
   * changed; returns the function that stops it. Absent, a delivery that waits for the kind is taken
   * again only by the next `resume`, which is a restart.
   */
  readonly onAvailabilityChange?: ((listener: () => void) => () => void) | undefined;
}

/** What a hook does for an event, tagged by `type`. */
export type HookAction =
  WebhookHookAction | StartWorkflowHookAction | NotifyHookAction | PluginHookAction;

/** Every kind of subject a hook can be scoped to, in the order the catalog and the wire list them. */
export const HOOK_SCOPE_KINDS = ['agent', 'workflow', 'schedule'] as const;

/** A kind of subject a hook can be scoped to. See {@link HOOK_SCOPE_KINDS}. */
export type HookScopeKind = (typeof HOOK_SCOPE_KINDS)[number];

/**
 * The one subject a hook fires for (COR-1978): an agent by name, a workflow file by identifier, or
 * a schedule by id. `create` and `update` take a {@link HookScopeKind} only; `kind` is a string here
 * because a record is read as stored, and a kind this release does not know stays on the record and
 * never fires (see `hook-scope.ts`).
 */
export interface HookScope {
  /** What `id` names: one of {@link HOOK_SCOPE_KINDS} on any record this release wrote. */
  readonly kind: string;
  /** The agent's name, the workflow's identifier, or the schedule's id. */
  readonly id: string;
}

/**
 * COR-2179 — where a default hook comes from: the plugin that declared it (the hook's `name` is the
 * key it is reconciled by). An owner's own hook has none. The owner may only turn a default hook
 * off or on (`ownerDisabled`), and a plugin that stops declaring it withdraws it (`withdrawn`): the
 * hook is disabled and kept, never deleted.
 */
export interface HookDeclaredBy {
  /** The plugin that declared the hook. */
  readonly plugin: string;
  /** The owner turned the hook off; a reconcile that replaces the hook keeps it off. Absent when it is on. */
  readonly ownerDisabled?: true;
  /** The plugin no longer declares the hook, so it is disabled and the owner cannot enable it. Absent otherwise. */
  readonly withdrawn?: true;
}

/** A hook: when a published Bureau event of one of `events` happens, its `action` runs. */
export interface Hook {
  /** The hook's identifier, minted by the Bureau. */
  readonly id: string;
  /** The principal that owns the hook: `api-key:<subject>` or `anonymous:local`. Never taken from a payload. */
  readonly owner: string;
  /** A label for the person reading a list; at most 100 characters. */
  readonly name?: string;
  /** What the hook does for each event. A record stored before actions existed reads as a webhook. */
  readonly action: HookAction;
  /**
   * The event kinds the hook fires on; never empty. A published Bureau kind as it is, and a kind a
   * plugin declares pinned to the version it was written at, `<plugin>:<name>@<version>` (COR-2226).
   */
  readonly events: readonly string[];
  /**
   * The one subject the hook fires for. Absent, it fires for its events across the whole Bureau, as
   * every hook stored before scopes existed does.
   */
  readonly scope?: HookScope;
  /**
   * COR-2179 — present on a default hook, a hook a plugin declared: the plugin, whether the owner
   * turned it off and whether the plugin withdrew it. Absent on a hook an owner wrote.
   */
  readonly declaredBy?: HookDeclaredBy;
  /** Whether the hook fires. A disabled hook keeps its secret and its delivery records. */
  readonly enabled: boolean;
  /** Epoch milliseconds the hook was created. */
  readonly createdAt: number;
  /** Epoch milliseconds the hook was last changed. */
  readonly updatedAt: number;
  /** Increases by one on every change; pass it back as `expectedRevision`. */
  readonly revision: number;
}

/**
 * The record under which a hook is stored. A record written before actions existed has a top-level
 * `url` and no `action`; the store reads it as `{ type: 'webhook', url }` and never needs it
 * rewritten.
 */
export interface HookRecord extends Hook {
  /** Durable authorization distinct from audit and resource ownership. */
  readonly workspaceAuthority?: RunWorkspaceAuthority | undefined;
  /**
   * The stored shape's version: 3 when the record has `declaredBy` (COR-2179), so a release that
   * predates default hooks refuses it instead of firing a hook its owner may have turned off, 2 when
   * it has a `scope`, so a release that predates scopes refuses it instead of firing it for the
   * whole Bureau, and 1 otherwise. The store sets it on every write.
   */
  readonly version: 1 | 2 | 3;
}

/** What one attempt to deliver came to. */
export type HookAttemptOutcome =
  /** The request is being sent; the attempt has no outcome yet. After a restart this means the outcome is unknown. */
  | 'sending'
  /** The receiver answered; `status` says how. */
  | 'response'
  /** The request failed before an answer: a network error, or the timeout. */
  | 'network-error'
  /** The Bureau stopped while the request was in flight, or before its outcome was written. The request may have been received. */
  | 'interrupted'
  /** The URL was refused by the policy at send time; no request was made. */
  | 'refused'
  /** A `start-workflow`, `notify` or `plugin` action ran; `receipt` says what it made. */
  | 'completed'
  /** A `start-workflow`, `notify` or `plugin` action failed in a way a retry cannot change; `error` says why. */
  | 'rejected'
  /** A `start-workflow`, `notify` or `plugin` action failed in a way a retry may change; `error` says why. */
  | 'error';

/**
 * The attempts that did not deliver, which `hook.delivery.failed` publishes (COR-2099): a closed
 * list, so the published event names how an attempt failed and never says why in free text.
 */
export type HookDeliveryFailureOutcome =
  'response' | 'network-error' | 'refused' | 'error' | 'rejected';

/** One attempt to deliver, in the order made. */
export interface HookDeliveryAttempt {
  /** 1-based; one attempt record produces at most one HTTP request. */
  readonly number: number;
  /** Epoch milliseconds the attempt began. */
  readonly startedAt: number;
  /** Epoch milliseconds the attempt ended; absent while it is `sending`. */
  readonly finishedAt?: number;
  /** How the attempt ended. */
  readonly outcome: HookAttemptOutcome;
  /** The HTTP status, when the receiver answered. */
  readonly status?: number;
  /** The start of the response body, at most {@link HOOK_RESPONSE_EXCERPT_BYTES} bytes. */
  readonly responseExcerpt?: string;
  /** Whether the response body was longer than the excerpt. */
  readonly responseTruncated?: boolean;
  /** Why the attempt failed, with the signing secret removed. */
  readonly error?: string;
  /** What a `completed` action made: the run it started, or the notification it wrote. */
  readonly receipt?: HookActionReceipt;
}

/** What an action made. */
export interface HookActionReceipt {
  /** The run a `start-workflow` action started. */
  readonly runId?: string;
  /** The notification a `notify` action wrote, or found already written for this delivery. */
  readonly notificationId?: string;
  /** COR-2182 — what a plugin's reaction made in the other service, as it named it. */
  readonly id?: string;
  /** COR-2182 — where the owner can see it: an `https:` address; a reaction's other value is dropped. */
  readonly url?: string;
  /** COR-2182 — what was made, at most {@link HOOK_RECEIPT_SUMMARY_LIMIT} characters; a longer one is dropped. */
  readonly summary?: string;
}

/** The longest `summary` a reaction's receipt keeps, in characters. */
export const HOOK_RECEIPT_SUMMARY_LIMIT = 200;

/** Where a delivery stands. */
export type HookDeliveryStatus =
  /** Not finished; it is retried until it succeeds or runs out of attempts, and resumed after a restart. */
  | 'pending'
  /** The receiver answered with a 2xx status. */
  | 'delivered'
  /** Every attempt failed. */
  | 'exhausted'
  /** The hook was deleted or disabled before the delivery finished. */
  | 'aborted'
  /** The signing secret could not be read, so no request was made. */
  | 'failed-secret'
  /** A `start-workflow` or `notify` action failed in a way a retry cannot change, such as input the workflow refuses. */
  | 'failed';

/** The request a delivery sends, without its signature: the signature is made fresh for each attempt. */
export interface HookDeliveryRequest {
  /** The URL as it was when the delivery was created. */
  readonly url: string;
  /** The headers the signature does not cover; the same on every attempt except `X-Delivery-Attempt`. */
  readonly headers: Readonly<Record<string, string>>;
  /** The exact JSON text sent as the body. */
  readonly body: string;
}

/**
 * What a `start-workflow` or `notify` delivery will do, fixed when the delivery is created from the
 * hook as it was then, as a webhook delivery's request is.
 */
export type HookDeliveryWork =
  | {
      readonly type: 'start-workflow';
      readonly workflowId: string;
      /** The input the workflow is started with, mapped from the event. */
      readonly input: unknown;
      /**
       * Why the workflow is not started: the event belongs to a run a hook started, or is of a kind
       * a run may raise and that names no run to follow. Set when the delivery is created; the delivery then ends `failed` with this as the `rejected` attempt's
       * error, and nothing is started.
       */
      readonly skip?: string;
    }
  | {
      readonly type: 'notify';
      readonly title: string;
      readonly body: string;
    }
  | {
      readonly type: 'plugin';
      readonly plugin: string;
      /** The action kind's name within the plugin. */
      readonly kind: string;
      /** The configuration the hook held when the delivery was created. */
      readonly configuration?: unknown;
      /** The event, as the action receives it; its `source` is present only for a plugin's event. */
      readonly event: PluginEvent;
      /**
       * COR-1879 — the version of the kind registered when the delivery was created, which the
       * delivery runs on and on no other. Absent when the kind was registered without one.
       */
      readonly version?: string;
    };

/** A delivery of one event to one hook: the action, every attempt, and where it stands. */
export interface HookDelivery {
  /** The delivery's identifier, also sent as `X-Delivery-Id` and `Idempotency-Key`. */
  readonly id: string;
  /** The hook it belongs to. */
  readonly hookId: string;
  /** The hook's owner; the only principal that reads the record without an operator scope. */
  readonly owner: string;
  /** What the delivery does. A record stored before actions existed reads as `webhook`. */
  readonly actionType: HookActionType;
  /** The event kind delivered, or `hook.test` for a test delivery. */
  readonly kind: string;
  /** Whether this is a `hooks.test` delivery. */
  readonly test: boolean;
  /** Where the delivery stands. */
  readonly status: HookDeliveryStatus;
  /** The request of a `webhook` delivery; absent for the other actions. */
  readonly request?: HookDeliveryRequest;
  /** What a `start-workflow` or `notify` delivery does; absent for a webhook. */
  readonly work?: HookDeliveryWork;
  /** Every attempt made, in order. */
  readonly attempts: readonly HookDeliveryAttempt[];
  /**
   * How many attempts the delivery may make. A retry of a settled delivery
   * (`hooks.retryDelivery`) raises it by one, for the attempt the retry makes.
   */
  readonly maxAttempts: number;
  /**
   * Epoch milliseconds the next attempt is due, while a `pending` delivery waits out its backoff
   * after a failed attempt (COR-2022). Absent before the first attempt, while an attempt is being
   * sent, once the delivery has settled, and on a record written before it existed.
   */
  readonly nextAttemptAt?: number;
  /** Epoch milliseconds the delivery was created. */
  readonly createdAt: number;
  /** Epoch milliseconds the delivery was last changed. */
  readonly updatedAt: number;
}

/** The last attempt of a delivery as `hooks.list` shows it: how it ended, without the response body. */
export type HookDeliverySummaryAttempt = Pick<
  HookDeliveryAttempt,
  'number' | 'startedAt' | 'finishedAt' | 'outcome' | 'status' | 'error'
>;

/** A hook's newest delivery as `hooks.list` shows it: where it stands, without its request or work. */
export interface HookDeliverySummary {
  /** The delivery's identifier. */
  readonly id: string;
  /** The event kind delivered, or `hook.test` for a test delivery. */
  readonly kind: string;
  /** Whether this is a `hooks.test` delivery. */
  readonly test: boolean;
  /** Where the delivery stands. */
  readonly status: HookDeliveryStatus;
  /** The attempt made last; absent before the first. */
  readonly lastAttempt?: HookDeliverySummaryAttempt;
  /** Epoch milliseconds the delivery was created. */
  readonly createdAt: number;
  /** Epoch milliseconds the delivery was last changed. */
  readonly updatedAt: number;
}

/**
 * One thing the schema of a plugin hook's reaction refuses in the configuration the hook stores
 * (COR-2182): where it is and Zod's code for it, never its message, which can quote a value.
 */
export interface HookConfigurationIssue {
  /** The path to the field, from the configuration's root; empty for the configuration as a whole. */
  readonly path: readonly string[];
  /** Zod's issue code, such as `invalid_type` or `too_small`. */
  readonly code: string;
}

/**
 * Why a hook cannot do what it says, as `hooks.list` shows it (COR-2182). Each is a code and
 * identifiers, never free text.
 */
export type HookProblem =
  | {
      /**
       * The plugin hook's reaction is not registered: its plugin is disabled, was removed, failed
       * to set up, or dropped the kind. The hook writes no delivery until the reaction is back. A
       * default hook its plugin withdrew has it too, while it stays withdrawn.
       */
      readonly code: 'reaction-unavailable';
    }
  | {
      /** The reaction's schema now refuses the configuration the hook stored (an upgrade changed it). */
      readonly code: 'configuration-invalid';
      /** Every field the schema refuses. */
      readonly issues: readonly HookConfigurationIssue[];
    }
  | {
      /**
       * COR-2226 — a plugin kind the hook lists is `missing`: its plugin is not loaded, or is loaded
       * at a version other than the one the hook pinned. That kind fires nothing; the others still do.
       */
      readonly code: 'event-missing';
      /** The entry as the hook lists it, pinned: `reports:digest-ready@1.0.0`. */
      readonly kind: string;
      /** The version of the kind loaded now; absent when no running plugin declares it. */
      readonly loadedVersion?: string;
    };

/** A hook as `hooks.list` answers it, with its newest delivery. */
export interface ListedHook extends Hook {
  /** The hook's newest delivery, a test included; `null` when it has none. */
  readonly lastDelivery: HookDeliverySummary | null;
  /** Why the hook cannot do what it says; empty when nothing is wrong. */
  readonly problems: readonly HookProblem[];
}

/** The record under which a delivery is stored. */
export interface HookDeliveryRecord extends HookDelivery {
  /** Durable authorization distinct from audit and resource ownership. */
  readonly workspaceAuthority?: RunWorkspaceAuthority | undefined;
  /** The stored shape's version. */
  readonly version: 1;
  /** Epoch milliseconds before which another process must not resume the delivery; `0` once released. */
  readonly leaseUntil: number;
  /** Increases by one on every write; every write compares it. */
  readonly revision: number;
}

/** COR-2183 — the most attempts a plugin's reaction may ask for with its own `maxAttempts`. */
export const REACTION_MAXIMUM_ATTEMPTS = 20;

/** Whether `value` is an acceptable `maxAttempts` for a reaction: an integer from 1 to {@link REACTION_MAXIMUM_ATTEMPTS}. */
export function isReactionMaxAttempts(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= REACTION_MAXIMUM_ATTEMPTS
  );
}

/** The event a `notify` hook may not list: the notification it writes is announced by this event, so the hook would loop. */
export const NOTIFICATION_CREATED_EVENT_KIND = 'notification.created';

/**
 * What every event a hook delivery publishes starts with (COR-2099: `hook.delivery.failed` and
 * `hook.delivery.gave-up`). A delivery of such an event publishes neither, so a hook that watches
 * its own failures, or two that watch each other's, settle after the delivery that began it. A
 * `notify` hook cannot list one: its notification would carry the failure forward without end.
 */
export const HOOK_DELIVERY_EVENT_PREFIX = 'hook.delivery.';

/** The longest response body kept on an attempt. */
export const HOOK_RESPONSE_EXCERPT_BYTES = 1024;

/**
 * Where a hook's signing secret is kept. Bureau seals the secret before it reaches the port
 * (COR-1816's scheme and `answerEncryption` keys), so a port holds ciphertext only. A host injects
 * its own; without one Bureau keeps the ciphertext in its key-value store.
 */
export interface HookSecretStore {
  /**
   * Why this host refuses to write a hook secret, or `undefined` when it accepts them. A remote
   * Interborough home answers `deployment`: its secrets live in the environment, not here.
   */
  writeLock?(): SettingLockReason | undefined;
  /** The sealed secret of a hook, or `undefined` when there is none. */
  get(hookId: string): Promise<EncryptedValue | undefined>;
  /** Keep a hook's sealed secret, replacing any earlier one. */
  set(hookId: string, encrypted: EncryptedValue): Promise<void>;
  /** Forget a hook's secret. */
  delete(hookId: string): Promise<void>;
}

/** Why a hooks call was refused. */
export type HookErrorCode =
  /** There is no such hook. */
  | 'not-found'
  /** An input is not acceptable; `issues` names the fields. */
  | 'invalid'
  /** `expectedRevision` is not the hook's revision. */
  | 'stale-revision'
  /** The host refuses to write a signing secret; `lockReason` says why. */
  | 'locked'
  /** The Bureau has no `answerEncryption` key, so it cannot seal a secret. */
  | 'no-encryption'
  /** The hook's secret cannot be opened (the key is no longer held), so no delivery can be signed. */
  | 'secret-unavailable'
  /** The hook's owner may not do what its action does (start the workflow). */
  | 'forbidden';

/** A refused hooks call. */
export class HookError extends Error {
  /** Why the call was refused. */
  readonly code: HookErrorCode;
  /** The fields an `invalid` refusal names. */
  readonly issues: readonly { readonly path: readonly string[]; readonly message: string }[];
  /** The revision now current, for a `stale-revision` refusal. */
  readonly currentRevision: number | undefined;
  /** Why the host locks secret writes, for a `locked` refusal. */
  readonly lockReason: SettingLockReason | undefined;

  constructor(
    code: HookErrorCode,
    message: string,
    details: {
      readonly issues?: HookError['issues'];
      readonly currentRevision?: number;
      readonly lockReason?: SettingLockReason;
    } = {},
  ) {
    super(message);
    this.name = 'HookError';
    this.code = code;
    this.issues = details.issues ?? [];
    this.currentRevision = details.currentRevision;
    this.lockReason = details.lockReason;
  }
}

/** Thrown by a hook action that failed; `permanent` says whether a retry could change the answer. */
export class HookActionError extends Error {
  /** `true` when a retry cannot change the answer, so the delivery ends `failed` instead of retrying. */
  readonly permanent: boolean;

  constructor(message: string, permanent: boolean) {
    super(message);
    this.name = 'HookActionError';
    this.permanent = permanent;
  }
}
