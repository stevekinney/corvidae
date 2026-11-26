import type { WorkspaceRuntimeAuthority } from '../http/workspace-principal.ts';
import { captureRunWorkspaceAuthority } from '../run-authority.ts';
/**
 * `Bureau.hooks` (COR-1939): owner-scoped hooks over the Bureau's published events, each delivered
 * as an HMAC-signed POST that keeps its request, its response, and its attempts on a record, and
 * resumes after a restart. See `hook-signature.ts` for the wire contract, `hook-delivery.ts` for
 * the retry and resume fence, and `hook-url-policy.ts` for which URLs a hook may name.
 *
 * ## The signing secret
 *
 * A webhook created without a secret gets one the Bureau generates (`whsec_` and 24 hexadecimal
 * digits), returned on the created hook and never again; `replaceSigningSecret` makes a new one the
 * same way (COR-2009). A caller may still choose the secret and send it with `create` or `update`,
 * and that one is never returned. Every secret is sealed with COR-1816's scheme under `BureauOptions.answerEncryption` and kept through the
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
 * `hooks.test` sends a test delivery to a webhook hook, or to a plugin hook whose reaction has a
 * `dryRun` (COR-2183), which it calls instead of `run`: for the other actions it would start a real
 * run or write a real notification, so it is refused. `hooks.testDraft` sends the same test to
 * a webhook URL before the hook is saved, and writes nothing (COR-2022).
 *
 * `hooks.retryDelivery` sends a delivery again from its record, never a delivery rebuilt from the
 * hook as it is now (COR-2022; see `hook-delivery.ts`).
 *
 *
 * A hook fires on the published event kinds it lists (`PUBLISHED_BUREAU_EVENT_KINDS`), for events
 * of the whole Bureau: the feed is fleet-wide, so the operations require `bureau.events:observe-all`
 * to create or change a hook. Events that happen while the Bureau is down are not replayed;
 * deliveries already created are resumed.
 *
 * A hook may also list a kind a running plugin declares (COR-2226), which it stores pinned to the
 * declaration's version (`reports:digest-ready@1.0.0`) and which fires only while that version is
 * loaded. A pinned kind whose plugin is gone or loaded at another version is `missing`: it fires
 * nothing, `hooks.list` says so as an `event-missing` problem, and the hook's other kinds still
 * fire. See `hook-event-kinds.ts`.
 *
 * ## Scope
 *
 * A hook may name one subject, an agent, a workflow or a schedule, as `scope` (COR-1978), and then
 * fires only for events about that subject. What an event is about is read from the event and the
 * Bureau's own records as it is dispatched (`hook-scope.ts`). An event outside the scope makes no
 * delivery, and an event the Bureau cannot place is outside it. A hook with no scope fires as it
 * always has. Every kind a scoped hook lists must be one the scope can be told by
 * (`BureauEventCatalogEntry.scopes`); `create` and `update` refuse any other, so a scope never
 * silently misses a kind the hook asked for.
 *
 * @module create-hooks
 */

import { isDeepStrictEqual } from 'node:util';

import { sha256HexSync } from '@lostgradient/cryptography';

import type { HookDeliveryFailedEvent, HookDeliveryGaveUpEvent } from '../events.ts';
import { ownerFromPrincipal, ownerOrLocal } from '../owner-of-record.ts';
import type { BureauNotifications } from '../notifications/notification-types.ts';
import { NOTIFICATION_FIELD_LIMITS } from '../notifications/notification-types.ts';
import type { BureauWorkflows } from '../workflow-runtime.ts';
import type { BureauEventEnvelope } from '../bureau-event-feed.ts';
import { BUREAU_EVENT_CATALOG, type BureauEventOrigin } from '../bureau-event-catalog.ts';
import {
  createBureauEventFormatter,
  type BureauEventFormatter,
} from '../bureau-event-formatting.ts';
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
  type DeclaredHookEventKind,
  declaredVersionsOf,
  hookEventInputOf,
  hookEventKindOf,
  hookEventsMatch,
  resolveHookEvent,
} from './hook-event-kinds.ts';
import { generateHookSigningSecret } from './hook-signature.ts';
import {
  createHookStore,
  createKvHookSecretStore,
  sealHookSecret,
  type HookStore,
  type Stored,
} from './hook-store.ts';
import {
  HOOK_DELIVERY_EVENT_PREFIX,
  HOOK_RECEIPT_SUMMARY_LIMIT,
  HOOK_SCOPE_KINDS,
  HookActionError,
  type HookActionKindRegistration,
  type HookActionReceipt,
  type HookConfigurationIssue,
  HookError,
  NOTIFICATION_CREATED_EVENT_KIND,
  REACTION_MAXIMUM_ATTEMPTS,
  isReactionMaxAttempts,
  type Hook,
  type HookAction,
  type HookDeclaredBy,
  type HookDelivery,
  type HookDeliveryRecord,
  type HookDeliverySummary,
  type HookProblem,
  type HookRecord,
  type HookScope,
  type HookScopeKind,
  type HookSecretStore,
  type HookWorkflowInput,
  type ListedHook,
} from './hook-types.ts';
import { hookOriginTag, runOfPayload } from './hook-origin.ts';
import {
  SECRET_REFERENCE_DEFECT,
  isSecretReference,
  issueIsAtSecret,
  secretFieldAt,
  secretFieldsOf,
  withValueAt,
  withoutValues,
} from './secret-references.ts';
import {
  type HookEventSubjects,
  type HookSubjectSources,
  scopeMatches,
  subjectsOfPayload,
} from './hook-scope.ts';
import { type HookUrlPolicy, hookUrlDefect } from './hook-url-policy.ts';
import type { EncryptedValue } from '@lostgradient/cryptography';
import type {
  PluginEvent,
  PluginFormatting,
  PluginReactionContext,
} from '@lostgradient/interborough-plugin';
import type { ConditionalTextValueStore } from '@lostgradient/storage';

/** The event kind of a `hooks.test` delivery. It is not a published kind, so no hook can list it. */
export const HOOK_TEST_EVENT_KIND = 'hook.test';

/** The most event kinds one hook may list. */
const MAXIMUM_EVENT_KINDS = 64;

/** The longest entry of a hook's `events`, as given and as stored: a plugin kind's pin included. */
export const HOOK_EVENT_KIND_MAXIMUM_LENGTH = 256;

/** The shortest and longest signing secret, in characters. */
export const HOOK_SECRET_MINIMUM_LENGTH = 16;
export const HOOK_SECRET_MAXIMUM_LENGTH = 256;

const NAME_MAXIMUM_LENGTH = 100;

/** The longest subject a scope may name, the longest workflow identifier a hook may name. */
const SCOPE_ID_MAXIMUM_LENGTH = 256;

/** How long dispatch keeps the hooks it read. */
const HOOK_CACHE_MILLISECONDS = 5_000;

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

/** The one subject a hook fires for, as `hooks.create` and `hooks.update` take it. */
export interface HookScopeInput {
  /** What `id` names. */
  readonly kind: HookScopeKind;
  /** The agent's name, the workflow's identifier, or the schedule's id; 1 to 256 characters. */
  readonly id: string;
}

/** What `hooks.create` takes. Name the action with `action`, or with `url` for a webhook. */
export interface HookCreateInput {
  /** A webhook's URL: shorthand for `action: { type: 'webhook', url }`. Give this or `action`, not both. */
  readonly url?: string;
  /** What the hook does. Give this or `url`, not both. */
  readonly action?: HookActionInput;
  /**
   * The event kinds the hook fires on: published Bureau kinds, and kinds a running plugin declares
   * (`<plugin>:<name>`), which the hook stores pinned to the declaration's version (COR-2226). A
   * kind given pinned (`<plugin>:<name>@<version>`) must be pinned to the version loaded now.
   */
  readonly events: readonly string[];
  /** The one subject the hook fires for; every kind in `events` must be one it can be told by. Omitted, it fires for the whole Bureau. */
  readonly scope?: HookScopeInput;
  /**
   * The secret webhook deliveries are signed with, 16 to 256 characters; refused for any other
   * action. Sealed on arrival and never returned. Omitted for a webhook, the Bureau generates one
   * ({@link generateHookSigningSecret}) and returns it once, on the created hook.
   */
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
  /**
   * The new event kinds, replacing the list, read as `create` reads them; a pinned kind that is
   * `missing` now is kept when the hook already lists it, so a hook whose plugin is gone still saves.
   */
  readonly events?: readonly string[];
  /** A new subject, or `null` so the hook fires for the whole Bureau again. */
  readonly scope?: HookScopeInput | null;
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

/**
 * COR-2179 — a hook a plugin declares as a default: what {@link BureauHooks.reconcileDeclared}
 * takes. The `name` is the key the hook is reconciled by, within its plugin.
 */
export interface HookDeclaration {
  /** The hook's label and its reconcile key, 1 to 100 characters, unique within the declarations. */
  readonly name: string;
  /**
   * The event kinds the hook fires on: published Bureau kinds and kinds a running plugin declares,
   * each of the latter pinned to its version as the hook is reconciled (COR-2226).
   */
  readonly events: readonly string[];
  /** The name of the plugin's reaction kind the hook runs. */
  readonly reaction: string;
  /** The reaction's configuration, checked against the schema the reaction declares. */
  readonly configuration?: unknown;
  /** The one subject the hook fires for; every kind in `events` must be one it can be told by. */
  readonly scope?: HookScopeInput;
}

/** What `hooks.delete` and `hooks.test` take beyond the hook. */
export interface HookCallOptions {
  /** The caller's principal (`api-key:<subject>`), recorded as the actor of the audit entry; omit when unknown. */
  readonly principal?: string;
}

/**
 * A hook as `hooks.create` and `hooks.replaceSigningSecret` answer it: the hook, and the signing
 * secret the Bureau generated for it, the one time it is shown (COR-2009). Nothing reads it back
 * afterwards: `get`, `list` and every later answer leave it out, and a person who lost it replaces it.
 */
export interface HookWithSigningSecret extends Hook {
  /**
   * The secret the Bureau generated, `whsec_` and 24 hexadecimal digits. On `create` it is present
   * only for a webhook created without a secret of the caller's own.
   */
  readonly signingSecret?: string;
}

/** What `hooks.replaceSigningSecret` takes beyond the hook. */
export interface HookReplaceSecretOptions extends HookCallOptions {
  /** Replace the secret only if the hook is still at this revision. */
  readonly expectedRevision?: number;
}

/**
 * Stands in for the hook's identifier in a draft test (`hooks.testDraft`): the body's `hookId` and
 * the `X-Hook-Id` header carry it, because the hook has no identifier until it is saved.
 */
export const HOOK_DRAFT_ID = 'draft';

/** What `hooks.testDraft` takes: the webhook a person is writing, before it is saved. */
export interface HookDraftTestInput {
  /** Where the test is POSTed; refused as `create` refuses it. */
  readonly url: string;
  /**
   * The secret to sign the test with, 16 to 256 characters, when the person chose one. Omitted,
   * the test is signed with a secret generated for it alone and then forgotten, since the secret
   * the hook keeps is made when it is first saved.
   */
  readonly signingSecret?: string;
  /** The caller's principal (`api-key:<subject>`); omitted, `anonymous:local`. */
  readonly principal?: string;
}

/** The Bureau's hooks: `Bureau.hooks`. Ownership is decided by the caller, as for `Bureau.goals`. */
export interface BureauHooks {
  /**
   * Creates a hook; refuses with {@link HookError}. A webhook created without `signingSecret` gets
   * one the Bureau generates, returned on this answer and never again.
   */
  create(input: HookCreateInput): Promise<HookWithSigningSecret>;
  /**
   * Replaces a webhook hook's signing secret with a new one the Bureau generates, and resolves with
   * the hook and that secret, shown this once (COR-2009). The old secret stops signing at once.
   * Refuses a hook that is not a webhook with {@link HookError} `invalid`, and a changed revision
   * with `stale-revision`; resolves `undefined` when there is no such hook.
   */
  replaceSigningSecret(
    hookId: string,
    options?: HookReplaceSecretOptions,
  ): Promise<(HookWithSigningSecret & { readonly signingSecret: string }) | undefined>;
  /**
   * Changes a hook, or resolves `undefined` when there is none. A default hook (`declaredBy`,
   * COR-2179) takes `enabled` alone, which sets or clears the owner's override; every other field is
   * refused with {@link HookError} `invalid` at that field, and a withdrawn hook cannot be enabled.
   */
  update(hookId: string, input: HookUpdateInput): Promise<Hook | undefined>;
  /**
   * Deletes a hook, its sealed secret and its delivery records; `false` when there is none. A
   * default hook is refused with {@link HookError} `invalid` at `declaredBy`: turn it off instead.
   */
  delete(hookId: string, options?: HookCallOptions): Promise<boolean>;
  /**
   * COR-2179 — makes the hooks `plugin` declares what `declarations` say, and resolves with them in
   * declaration order. A missing hook is created (an id of `plugin` and the name decide it, so two
   * processes make one); a changed declaration replaces the hook in place, with its id, `createdAt`,
   * deliveries and the owner's `enabled` override kept; an unchanged one writes nothing; and a hook
   * of `plugin` that is no longer declared is withdrawn: disabled and kept, never deleted. `[]` withdraws
   * them all. Everything is checked as `create` checks it before anything is written, and a refusal is
   * {@link HookError} `invalid` at `[index, field]`. A declaration of a reaction no plugin
   * contributes is refused, so a plugin that is disabled is never reconciled with a list that would
   * withdraw its hooks by mistake: only an empty list withdraws, and only the host's caller says so.
   */
  reconcileDeclared(
    plugin: string,
    declarations: readonly HookDeclaration[],
  ): Promise<readonly Hook[]>;
  /**
   * COR-2179 — a copy of a hook an owner can change: the same action, events and scope, disabled,
   * and no `declaredBy`. It is named `options.name` (COR-2181), else as the hook is. It belongs to
   * `principal`, else to the owner of record. Resolves `undefined` when there is no such hook;
   * refuses as `create` does, so the copy of a hook whose plugin no longer offers its action is refused.
   * With `expectedRevision`, a hook that has changed since the caller read it is refused with
   * `stale-revision` and nothing is made, so the copy is of the hook the caller was allowed to copy.
   */
  duplicate(
    hookId: string,
    options?: HookCallOptions & { readonly name?: string; readonly expectedRevision?: number },
  ): Promise<HookWithSigningSecret | undefined>;
  /**
   * COR-2180 — the plugins that made a default hook, withdrawn ones included, each once. It reads
   * the hook records alone, never a delivery, so a Bureau can ask at start.
   */
  declaredPlugins(): Promise<readonly string[]>;
  /** One hook, or `undefined`. */
  get(hookId: string): Promise<Hook | undefined>;
  /**
   * Every hook, oldest first, each with its newest delivery: `owner` narrows to one owner's, and
   * `scope` to the hooks scoped to exactly that subject.
   */
  list(filter?: {
    readonly owner?: string;
    readonly scope?: HookScope;
  }): Promise<readonly ListedHook[]>;
  /**
   * Sends one signed `hook.test` delivery to the hook and resolves with its record once the one
   * attempt has ended. A test is not retried. It works on a disabled hook. Resolves `undefined`
   * when there is no such hook. A plugin hook is tested by calling its reaction's `dryRun` (COR-2183),
   * with the context `run` gets and one attempt, and never `run`; a hook whose reaction has no
   * `dryRun`, is not registered or needs setup, and any `start-workflow` or `notify` hook, is
   * refused with {@link HookError} `invalid` at `action`.
   */
  test(hookId: string, options?: HookCallOptions): Promise<HookDelivery | undefined>;
  /**
   * Sends one signed `hook.test` request to a webhook that is not saved yet (COR-2022): one
   * attempt, no retry, and nothing written, neither a hook, a delivery, nor a secret. Resolves with
   * the delivery as it would have been recorded, whose `hookId` is {@link HOOK_DRAFT_ID}. Refuses
   * a URL or secret `create` would refuse with {@link HookError} `invalid`.
   */
  testDraft(input: HookDraftTestInput): Promise<HookDelivery>;
  /**
   * Sends one of the hook's deliveries again from its record (COR-2022): the request (or work)
   * recorded when the delivery was made, with its body and `Idempotency-Key`, never one rebuilt
   * from the hook as it is now; a webhook's is signed with the hook's current secret. A settled
   * delivery gets one more attempt, made now, and resolves once it has ended. A `pending` one that
   * is waiting out its backoff is tried now ("Retry now") and resolves at once. A delivered one is
   * refused with {@link HookError} `invalid`. Resolves `undefined` when the hook has no such
   * delivery.
   */
  retryDelivery(
    hookId: string,
    deliveryId: string,
    options?: HookCallOptions,
  ): Promise<HookDelivery | undefined>;
  /** The hook's deliveries, newest first, at most `limit` (default 50, at most 200). */
  deliveries(
    hookId: string,
    options?: { readonly limit?: number },
  ): Promise<readonly HookDelivery[]>;
}

/** What {@link createHooks} is built from. */
export interface HooksDependencies {
  /** Runtime directory; no credential is persisted in a hook. */
  readonly workspace?: WorkspaceRuntimeAuthority | undefined;
  /** Workspace privacy projection applied before any delivery is persisted. */
  readonly eventForHookOwner?:
    | ((owner: string, event: HookEventToDeliver) => Promise<HookEventToDeliver | undefined>)
    | undefined;
  /** The Bureau's key-value store. */
  readonly kv: ConditionalTextValueStore;
  /**
   * COR-2178 — writes an event as a person reads it: what a reaction's `format` returns and what a
   * `notify` delivery stores as its title and body when a formatter claims the event's kind. Absent,
   * the Bureau has no formatter, and an event reads as its kind.
   */
  readonly formatEvent?: BureauEventFormatter | undefined;
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
  readonly mayStartWorkflows?: ((owner: string) => boolean | Promise<boolean>) | undefined;
  /**
   * The hook that started the run `runId` names, or a run above it, or `undefined` when no hook
   * did. A `start-workflow` hook does not start a workflow for an event whose run a hook started,
   * so hooks cannot chain. It may throw; the event is then treated as a hook's own.
   */
  readonly startedByHook?: ((runId: string) => Promise<string | undefined>) | undefined;
  /**
   * The Bureau's records a hook's scope is matched against, read only when a scoped hook lists the
   * event's kind. Omitted, a scope matches what the event's own payload says and nothing further.
   */
  readonly subjects?: HookSubjectSources | undefined;
  /** How long one request may take. */
  readonly requestTimeoutMilliseconds?: number | undefined;
  /**
   * An abort signal that fires after the given milliseconds: how long a plugin's reaction may run.
   * Defaults to `AbortSignal.timeout`; a test passes one a controller ends.
   */
  readonly timeoutSignal?: ((milliseconds: number) => AbortSignal) | undefined;
  /**
   * COR-2177 — reads the secret a stored `{ "$secret": "<key>" }` in a reaction's configuration
   * names, by the key the workspace published it under. Asked for each attempt, so an attempt gets
   * the value published by then, and never held. Omitted, a reference cannot be resolved and the
   * attempt fails.
   */
  readonly configurationSecrets?: { get(key: string): Promise<string | undefined> } | undefined;
  /**
   * The hook action kinds plugins contribute (COR-1876), the entry point plugin composition feeds.
   * Two registrations of one plugin and kind name are refused. Omitted, only the built-in actions
   * exist.
   */
  readonly actionKinds?: readonly HookActionKindRegistration[] | undefined;
  /**
   * COR-2226 — the event kinds running plugins declare, each at its version (`plugins.events()`).
   * Asked when a hook is written, for each event dispatched and for each `list`, so what a hook
   * lists is read against what is loaded then. Omitted, no plugin declares a kind.
   */
  readonly declaredEvents?: (() => readonly DeclaredHookEventKind[]) | undefined;
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
  /**
   * COR-2099 — publishes a delivery's `hook.delivery.failed` and `hook.delivery.gave-up` events on
   * the Bureau's emitter. Absent, nothing is published. See {@link HookDeliveryDependencies.publish}.
   */
  readonly publish?:
    ((event: HookDeliveryFailedEvent | HookDeliveryGaveUpEvent) => void) | undefined;
}

/** What {@link createHooks} returns: the public member, and the two entry points the Bureau drives. */
export interface CreatedHooks {
  /** `Bureau.hooks`. */
  readonly hooks: BureauHooks;
  /**
   * Delivers a published event to every enabled hook that lists its kind and whose scope, if it has
   * one, is the event's subject. Never throws. Until
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
  const { version: _version, workspaceAuthority: _authority, ...hook } = record;
  return hook;
}

function deliveryViewOf(record: HookDeliveryRecord): HookDelivery {
  const {
    version: _version,
    workspaceAuthority: _authority,
    leaseUntil: _lease,
    revision: _revision,
    ...delivery
  } = record;
  return delivery;
}

/** A delivery as `hooks.list` shows it: where it stands, and how its last attempt ended. */
function deliverySummaryOf(record: HookDeliveryRecord): HookDeliverySummary {
  const last = record.attempts.at(-1);
  return {
    id: record.id,
    kind: record.kind,
    test: record.test,
    status: record.status,
    ...(last === undefined
      ? {}
      : {
          lastAttempt: {
            number: last.number,
            startedAt: last.startedAt,
            outcome: last.outcome,
            ...(last.finishedAt === undefined ? {} : { finishedAt: last.finishedAt }),
            ...(last.status === undefined ? {} : { status: last.status }),
            ...(last.error === undefined ? {} : { error: last.error }),
          },
        }),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

/** Whether `a` is a later delivery than `b`, in the order `hooks.deliveries` lists them. */
function isNewerDelivery(a: HookDeliveryRecord, b: HookDeliveryRecord): boolean {
  return a.createdAt > b.createdAt || (a.createdAt === b.createdAt && a.id > b.id);
}

function invalid(path: string | readonly string[], message: string): never {
  throw new HookError('invalid', message, {
    issues: [{ path: typeof path === 'string' ? [path] : [...path], message }],
  });
}

/**
 * The check a delete makes before it writes: a default hook (`declaredBy`) is refused with
 * {@link HookError} `invalid` at `declaredBy`. The delete and its dry run both call this, so a
 * dry run answers the fault the real call answers.
 */
export function assertHookDeletable(hook: {
  readonly declaredBy?: HookDeclaredBy | undefined;
}): void {
  if (hook.declaredBy !== undefined) {
    invalid('declaredBy', 'A default hook cannot be deleted; disable it instead');
  }
}

const WORKFLOW_ID_MAXIMUM_LENGTH = 256;

/** The key a contributed action kind is looked up by. Plugin and kind names contain no `/`. */
function actionKindKey(plugin: string, kind: string): string {
  return `${plugin}/${kind}`;
}

/**
 * The kinds `registrations` name, by {@link actionKindKey}. A repeated name is refused, and so is a
 * `timeoutMilliseconds` that is not a positive safe integer (a delivery's lease is built from it) or a
 * `maxAttempts` that is not an integer from 1 to 20.
 */
function actionKindsOf(
  registrations: readonly HookActionKindRegistration[] | undefined,
): ReadonlyMap<string, HookActionKindRegistration> {
  const kinds = new Map<string, HookActionKindRegistration>();
  for (const registration of registrations ?? []) {
    const key = actionKindKey(registration.plugin, registration.kind.name);
    if (kinds.has(key)) throw new Error(`Hook action kind "${key}" is contributed twice`);
    const timeout = registration.kind.timeoutMilliseconds;
    if (timeout !== undefined && !(Number.isSafeInteger(timeout) && timeout > 0)) {
      throw new Error(
        `Hook action kind "${key}" has a timeoutMilliseconds that is not a positive safe integer`,
      );
    }
    const { maxAttempts } = registration.kind;
    if (maxAttempts !== undefined && !isReactionMaxAttempts(maxAttempts)) {
      throw new Error(
        `Hook action kind "${key}" has a maxAttempts that is not an integer from 1 to ${REACTION_MAXIMUM_ATTEMPTS}`,
      );
    }
    kinds.set(key, registration);
  }
  return kinds;
}

/**
 * `configuration` parsed with the schema of `registration`'s kind, or the reason it is refused. An
 * issue at or beneath one of `secretPaths` is left out: a hook is written with a reference where
 * the schema declares a string, and the reference is checked for what it is instead.
 */
function parsedConfiguration(
  registration: HookActionKindRegistration,
  configuration: unknown,
  secretPaths: readonly (readonly string[])[] = [],
):
  | { readonly ok: true; readonly value: unknown }
  | {
      readonly ok: false;
      readonly reason: string;
      /** Each refused field by its path and Zod's code, which carry no value (COR-2182). */
      readonly issues: readonly HookConfigurationIssue[];
    } {
  const parsed = registration.kind.configuration.safeParse(configuration);
  if (parsed.success) return { ok: true, value: parsed.data };
  const issues = parsed.error.issues.filter((issue) => !issueIsAtSecret(issue.path, secretPaths));
  if (issues.length === 0) return { ok: true, value: configuration };
  return {
    ok: false,
    reason: issues
      .map((issue) => `${issue.path.join('.') || 'configuration'}: ${issue.message}`)
      .join('; '),
    issues: issues.map((issue) => ({ path: issue.path.map(String), code: issue.code })),
  };
}

/** The most characters of an `id` a reaction's receipt keeps. */
const RECEIPT_ID_LIMIT = 200;
/** The most characters of a `url` a reaction's receipt keeps, as a hook's own URL is held to. */
const RECEIPT_URL_LIMIT = 2048;

/**
 * The receipt a reaction resolved, as the attempt keeps it (COR-2182): its `id`, `url` and `summary`
 * and nothing else. A field that is not text, an `id` over {@link RECEIPT_ID_LIMIT} characters, a
 * `url` that is not an `https:` address of at most {@link RECEIPT_URL_LIMIT} characters, and a
 * `summary` over {@link HOOK_RECEIPT_SUMMARY_LIMIT} characters is dropped, and `dropped` names the
 * fields (never what they held). A secret value the attempt resolved is removed from `id` and
 * `summary`, and a `url` that holds one is dropped, so the record never keeps what a reference named.
 */
function receiptOf(
  resolved: unknown,
  secrets: ReadonlySet<string>,
): { readonly receipt: HookActionReceipt; readonly dropped: readonly string[] } {
  const given: unknown =
    typeof resolved === 'object' && resolved !== null
      ? (resolved as { readonly receipt?: unknown }).receipt
      : undefined;
  if (typeof given !== 'object' || given === null || Array.isArray(given)) {
    return { receipt: {}, dropped: [] };
  }
  const { id, url, summary } = given as Record<'id' | 'url' | 'summary', unknown>;
  const receipt: { id?: string; url?: string; summary?: string } = {};
  const dropped: string[] = [];
  if (id !== undefined) {
    if (typeof id === 'string' && id.length <= RECEIPT_ID_LIMIT)
      receipt.id = withoutValues(id, secrets);
    else dropped.push('id');
  }
  if (url !== undefined) {
    if (
      typeof url === 'string' &&
      url.length <= RECEIPT_URL_LIMIT &&
      withoutValues(url, secrets) === url &&
      URL.canParse(url) &&
      new URL(url).protocol === 'https:'
    ) {
      receipt.url = url;
    } else dropped.push('url');
  }
  if (summary !== undefined) {
    if (typeof summary === 'string' && summary.length <= HOOK_RECEIPT_SUMMARY_LIMIT) {
      receipt.summary = withoutValues(summary, secrets);
    } else dropped.push('summary');
  }
  return { receipt, dropped };
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
      // A secret field holds a reference, never a value (COR-2177): checked for what it is, and
      // the schema's own refusal of a reference where it declares a string is left out.
      const secretFields = secretFieldsOf(registration.kind.configuration);
      if ('refusal' in secretFields) {
        invalid(
          ['action', 'configuration'],
          `The configuration of "${plugin}/${kind}" cannot be written: ${secretFields.refusal}`,
        );
      }
      for (const path of secretFields.paths) {
        const field = secretFieldAt(configuration, path);
        if (field !== undefined && !isSecretReference(field.value)) {
          invalid(['action', 'configuration', ...path], SECRET_REFERENCE_DEFECT);
        }
      }
      const checked = parsedConfiguration(registration, configuration, secretFields.paths);
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

/** Checks and copies a scope; every other field of `input` is dropped. */
function checkedScope(input: HookScopeInput): HookScope {
  const { kind, id } = (input ?? {}) as Partial<HookScopeInput>;
  if (typeof kind !== 'string' || !(HOOK_SCOPE_KINDS as readonly string[]).includes(kind)) {
    invalid(['scope', 'kind'], `The scope must be one of: ${HOOK_SCOPE_KINDS.join(', ')}`);
  }
  if (typeof id !== 'string' || id.length === 0 || id.length > SCOPE_ID_MAXIMUM_LENGTH) {
    invalid(['scope', 'id'], `The scope must name 1 to ${SCOPE_ID_MAXIMUM_LENGTH} characters`);
  }
  return { kind, id };
}

/** The kinds of subject an event of `kind` can be told by. A kind the catalog does not describe has none. */
function scopesOfKind(kind: string): readonly string[] {
  return Object.hasOwn(BUREAU_EVENT_CATALOG, kind)
    ? BUREAU_EVENT_CATALOG[kind as keyof typeof BUREAU_EVENT_CATALOG].scopes
    : [];
}

/** A scope that a listed kind cannot be told by would silently never fire for it, so it is refused. */
function assertScopeFits(scope: HookScope | undefined, events: readonly string[]): void {
  if (scope === undefined) return;
  const unfit = events.filter((kind) => !scopesOfKind(kind).includes(scope.kind));
  if (unfit.length > 0) {
    invalid(
      'scope',
      `A hook scoped to a ${scope.kind} cannot fire on ${unfit.join(', ')}: ${unfit.length === 1 ? 'that event names' : 'those events name'} no ${scope.kind}`,
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
  // COR-2099: a failing webhook on `notification.created` makes a failure for each notification, and
  // a notify hook on a failure writes a notification for each, so the failures would multiply for ever.
  const delivery = events.filter((kind) => kind.startsWith(HOOK_DELIVERY_EVENT_PREFIX));
  if (action.type === 'notify' && delivery.length > 0) {
    invalid(
      'events',
      `A notify hook cannot fire on ${delivery.join(', ')}: the notification it writes could fail to be delivered, and that failure would write another`,
    );
  }
}

/**
 * Refuses a plugin action listing a kind its own plugin declares (`<plugin>:<name>`, pinned or
 * not). Every such event comes from that plugin (`host.publish` marks it `source: <plugin>`), and a
 * reaction never fires on its own plugin's events (the source guard in `dispatch`, COR-2173), so
 * the hook could never fire. A webhook or notify hook on any declared kind, and a plugin action on
 * another plugin's kind, are not refused here.
 */
function assertNoOwnPluginEvents(action: HookAction, events: readonly string[]): void {
  if (action.type !== 'plugin') return;
  const own = events.filter((entry) => hookEventKindOf(entry).startsWith(`${action.plugin}:`));
  if (own.length > 0) {
    invalid(
      'events',
      `A plugin's reaction cannot run on that plugin's own events: ${own.join(', ')} come from plugin ${action.plugin}, and its reaction ${action.kind} never fires on them`,
    );
  }
}

/** Whether a stored `notify` hook lists a kind it may not (see {@link assertNoNotificationLoop}) and is skipped for it. */
function notifyMayNotFireOn(hook: HookRecord, kind: string): boolean {
  return (
    hook.action.type === 'notify' &&
    (kind === NOTIFICATION_CREATED_EVENT_KIND || kind.startsWith(HOOK_DELIVERY_EVENT_PREFIX))
  );
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

/**
 * Whether a reaction rejected with a `PluginReactionError` that says no retry can change the answer
 * (`permanent: true`). Read by shape, never with `instanceof`: a plugin loaded from a folder has its
 * own copy of the plugin package, so its class is not this process's.
 */
function isPermanentReactionError(error: unknown): error is Error {
  return (
    error instanceof Error &&
    error.name === 'PluginReactionError' &&
    (error as { readonly permanent?: unknown }).permanent === true
  );
}

/** A hook's events as `create`, `update` or a declaration asks for them, checked and pinned. */
interface CheckedEvents {
  /** What the hook stores: each kind once, a declared kind pinned to its version (COR-2226). */
  readonly events: string[];
  /** The pinned entries among them that are `missing` now, each with why. */
  readonly missing: readonly { readonly entry: string; readonly message: string }[];
}

/**
 * Checks the kinds a hook is asked to list against the kinds `declared` now, and pins each declared
 * one. Each kind is kept once, and of two entries for one kind the one pinned to the version loaded
 * now wins. A kind no one publishes is refused here; a pinned kind that is `missing` is returned
 * for the caller, which refuses it unless the hook already lists it ({@link assertNoMissingEvents}).
 */
function checkedEvents(
  events: readonly string[],
  declared: ReadonlyMap<string, string>,
): CheckedEvents {
  if (!Array.isArray(events) || events.length === 0) {
    invalid('events', 'A hook needs at least one event kind');
  }
  if (events.length > MAXIMUM_EVENT_KINDS) {
    invalid('events', `A hook lists at most ${MAXIMUM_EVENT_KINDS} event kinds`);
  }
  const byKind = new Map<string, string>();
  const missing = new Map<string, string>();
  for (const kind of events) {
    if (typeof kind !== 'string') invalid('events', 'Each event kind must be a string');
    if (kind.length > HOOK_EVENT_KIND_MAXIMUM_LENGTH) {
      invalid(
        'events',
        `An event kind is at most ${HOOK_EVENT_KIND_MAXIMUM_LENGTH} characters, and "${kind.slice(0, 40)}…" is ${kind.length}`,
      );
    }
    const input = hookEventInputOf(kind, declared);
    if (!input.ok && input.reason === 'unknown') invalid('events', input.message);
    // A kind within the bound can pass it once pinned; the stored entry is bounded too, so the
    // hook's own events are never refused when they are sent back.
    if (input.entry.length > HOOK_EVENT_KIND_MAXIMUM_LENGTH) {
      invalid(
        'events',
        `"${kind.slice(0, 40)}…" pinned to its version is longer than ${HOOK_EVENT_KIND_MAXIMUM_LENGTH} characters`,
      );
    }
    const listed = hookEventKindOf(input.entry);
    const previous = byKind.get(listed);
    if (previous !== undefined && !(missing.has(previous) && input.ok)) continue;
    if (previous !== undefined) missing.delete(previous);
    byKind.set(listed, input.entry);
    if (!input.ok) missing.set(input.entry, input.message);
  }
  return {
    events: [...byKind.values()],
    missing: [...missing].map(([entry, message]) => ({ entry, message })),
  };
}

/**
 * Refuses a pinned kind that is `missing` now unless `listed`, the hook's events before the write,
 * already has it: a hook whose plugin is gone still saves, and nothing new is pinned to a version
 * that is not loaded.
 */
function assertNoMissingEvents(
  missing: CheckedEvents['missing'],
  listed: readonly string[] = [],
): void {
  const refused = missing.find(({ entry }) => !listed.includes(entry));
  if (refused !== undefined) invalid('events', refused.message);
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

/**
 * The identifier of the default hook `plugin` declares as `name` (COR-2179): `default-` and the
 * first 32 hexadecimal digits of SHA-256 over the plugin, a NUL and the name. It is the same in
 * every process, so a store that holds the id already is the fence against two processes creating
 * the one hook.
 */
function defaultHookIdOf(plugin: string, name: string): string {
  return `default-${sha256HexSync(`${plugin}\u0000${name}`).slice(0, 32)}`;
}

/** A declaration after every check `create` makes of the same fields. */
interface CheckedDeclaration {
  readonly name: string;
  readonly events: readonly string[];
  readonly action: HookAction;
  readonly scope: HookScope | undefined;
}

/**
 * Where a refusal of the check of declaration `index` is: `checkedAction` names the fields of an
 * action, which a declaration holds flat (`reaction` for the action's `kind`).
 */
function atDeclaration(index: number, error: unknown): never {
  if (!(error instanceof HookError) || error.code !== 'invalid') throw error;
  throw new HookError('invalid', error.message, {
    issues: error.issues.map((issue) => {
      const [first, second, ...rest] = issue.path;
      const field =
        first === 'action'
          ? second === 'kind'
            ? ['reaction']
            : [second ?? 'reaction', ...rest]
          : issue.path;
      return { path: [String(index), ...field], message: issue.message };
    }),
  });
}

/** `declaredBy` with the owner's override set (`disabled`) or cleared. */
function withOwnerOverride(declaredBy: HookDeclaredBy, disabled: boolean): HookDeclaredBy {
  const { ownerDisabled: _previous, ...rest } = declaredBy;
  return disabled ? { ...rest, ownerDisabled: true } : rest;
}

/**
 * Whether the stored default hook `before` already is what `declared` says: its events as a set, its
 * action and its scope, and not withdrawn. `enabled` and the owner's override are not compared: they
 * are the owner's, and a reconcile keeps them.
 */
function declarationIsCurrent(before: HookRecord, declared: CheckedDeclaration): boolean {
  return (
    before.declaredBy?.withdrawn !== true &&
    before.events.length === declared.events.length &&
    declared.events.every((kind) => before.events.includes(kind)) &&
    isDeepStrictEqual(before.action, declared.action) &&
    isDeepStrictEqual(before.scope, declared.scope)
  );
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

  /**
   * COR-2182 — whether `hook` runs a plugin's reaction that is not registered now: the plugin is
   * disabled, was removed, failed to set up, or dropped the kind. One answer for the two places that
   * act on it, so a hook that lists the problem is the hook dispatch writes nothing for.
   */
  function reactionUnavailable(hook: HookRecord): boolean {
    return (
      hook.action.type === 'plugin' &&
      !actionKinds.has(actionKindKey(hook.action.plugin, hook.action.kind))
    );
  }

  /**
   * COR-2182 — what is wrong with `hook` as it is now: its reaction is not registered, or its
   * reaction's schema refuses the configuration it stored (a plugin upgrade changed the schema).
   * The configuration is checked as `create` checks it, so a secret field that holds a reference is
   * no problem. Empty when nothing is, and for every action but a plugin's. A default hook its
   * plugin withdrew (R8 turned it off) is `reaction-unavailable` too, though the plugin may still
   * register the reaction: the plugin no longer offers the hook, which stays off and runs nothing.
   */
  function problemsOf(
    hook: HookRecord,
    declared: ReadonlyMap<string, string>,
    ownerMayStartWorkflows: boolean,
  ): readonly HookProblem[] {
    return [...actionProblemsOf(hook, ownerMayStartWorkflows), ...eventProblemsOf(hook, declared)];
  }

  function actionProblemsOf(
    hook: HookRecord,
    ownerMayStartWorkflows: boolean,
  ): readonly HookProblem[] {
    if (hook.action.type === 'start-workflow') {
      if (!ownerMayStartWorkflows) return [{ code: 'workflow-unavailable' }];
      const workflows = dependencies.workflows?.();
      if (workflows === undefined) return [{ code: 'workflow-unavailable' }];
      try {
        workflows.assertStartable(hook.action.workflowId);
      } catch {
        // The list names only a bounded state. It does not disclose whether the workflow was deleted,
        // paused, invalid, or unavailable to this owner.
        return [{ code: 'workflow-unavailable' }];
      }
      return [];
    }
    if (hook.action.type !== 'plugin') return [];
    if (reactionUnavailable(hook) || hook.declaredBy?.withdrawn === true) {
      return [{ code: 'reaction-unavailable' }];
    }
    const registration = actionKinds.get(actionKindKey(hook.action.plugin, hook.action.kind));
    if (registration === undefined) return [];
    const secretFields = secretFieldsOf(registration.kind.configuration);
    const paths = 'refusal' in secretFields ? [] : secretFields.paths;
    const checked = parsedConfiguration(registration, hook.action.configuration, paths);
    return checked.ok ? [] : [{ code: 'configuration-invalid', issues: checked.issues }];
  }

  /**
   * COR-2226 — an `event-missing` problem for each kind `hook` lists that fires nothing now: a
   * pinned plugin kind whose plugin is not loaded, or is loaded at another version. Any action's
   * hook may have one, and its other kinds still fire.
   */
  function eventProblemsOf(
    hook: HookRecord,
    declared: ReadonlyMap<string, string>,
  ): readonly HookProblem[] {
    return hook.events.flatMap((entry): HookProblem[] => {
      const resolution = resolveHookEvent(entry, declared);
      if (resolution.status !== 'missing') return [];
      return [
        {
          code: 'event-missing',
          kind: entry,
          ...(resolution.loadedVersion === undefined
            ? {}
            : { loadedVersion: resolution.loadedVersion }),
        },
      ];
    });
  }

  /** The kinds running plugins declare now, each at its version (COR-2226). */
  function declaredNow(): ReadonlyMap<string, string> {
    return declaredVersionsOf(dependencies.declaredEvents?.() ?? []);
  }

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
    if (!(await mayStartWorkflows(owner))) {
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

  /**
   * `stored` with each secret field's reference replaced by the value published for its key now
   * (COR-2177); `stored` itself, which the delivery keeps, is not touched. A value found in a secret
   * field is not a reference, so it is refused for good and never passed on. A key that has no value
   * now (no reader, nothing published, or the read failed) fails the attempt but not the delivery:
   * it can be published before the next attempt. Every value resolved is added to `resolvedSecrets`,
   * so the delivery can remove it from whatever the attempt reports.
   */
  async function withResolvedSecrets(
    stored: unknown,
    paths: readonly (readonly string[])[],
    resolvedSecrets: Set<string>,
  ): Promise<unknown> {
    const fields: Array<{ readonly path: readonly string[]; readonly key: string }> = [];
    for (const path of paths) {
      const field = secretFieldAt(stored, path);
      if (field === undefined) continue;
      if (!isSecretReference(field.value)) {
        // Written before the field was marked secret: the stored value is never passed to `run`.
        throw new HookActionError(
          `The action's configuration is refused: ${path.join('.')} is a secret field and holds a value where a secret reference belongs`,
          true,
        );
      }
      fields.push({ path, key: field.value.$secret });
    }
    let configuration = stored;
    for (const { path, key } of fields) {
      let value: string | undefined;
      try {
        value = await dependencies.configurationSecrets?.get(key);
      } catch {
        value = undefined;
      }
      if (typeof value !== 'string' || value === '') {
        throw new HookActionError(`The secret "${key}" has no published value`, false);
      }
      resolvedSecrets.add(value);
      configuration = withValueAt(configuration, path, value);
    }
    return configuration;
  }

  const formatEvent = dependencies.formatEvent ?? createBureauEventFormatter(undefined);

  /**
   * What a reaction's `format` returns (COR-2178): the formatter's title and the rest of its
   * formatting, without the fields that say which event it was (`kind`, `runId`, `source`) or which
   * formatter wrote it. A reaction passes any event it likes, so a formatter that throws on it, or an
   * argument that is no event, reads as its kind, and the failure goes to `diagnose` and nowhere else.
   */
  function formatForReaction(event: PluginEvent): PluginFormatting {
    try {
      const { title, body, tier, icon, link } = formatEvent(event);
      return {
        title,
        ...(body === undefined ? {} : { body }),
        tier,
        ...(icon === undefined ? {} : { icon }),
        ...(link === undefined ? {} : { link }),
      };
    } catch (cause) {
      dependencies.diagnose('An event formatter failed for a reaction', cause);
      return { title: typeof event?.kind === 'string' ? event.kind : 'event', tier: 'info' };
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
        if (!(await mayStartWorkflows(context.owner))) {
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
        // A delivery runs on the version it was created against, and never on another (COR-1879).
        if (work.version !== undefined && registration.version !== work.version) {
          throw new HookActionError(
            `The delivery pins the hook action kind "${work.plugin}/${work.kind}" at version ${work.version}, and ${
              registration.version === undefined
                ? 'the kind registered now has no version'
                : `version ${registration.version} is registered`
            } (version-mismatch)`,
            true,
          );
        }
        // A test delivery runs `dryRun` and never falls back to `run`, which would have the real
        // effect the test is there to avoid: a kind that has none now (an upgrade removed it) fails.
        if (context.test && typeof registration.kind.dryRun !== 'function') {
          throw new HookActionError(
            `The hook action kind "${work.plugin}/${work.kind}" has no dryRun, so it cannot be tested`,
            true,
          );
        }
        const secretFields = secretFieldsOf(registration.kind.configuration);
        if ('refusal' in secretFields) {
          throw new HookActionError(
            `The action's configuration is refused: ${secretFields.refusal}`,
            true,
          );
        }
        // Resolved for this attempt, so a later attempt gets what is published by then. The stored
        // delivery keeps the reference: the values live in this call and in the copy `run` gets.
        const resolved = await withResolvedSecrets(
          work.configuration,
          secretFields.paths,
          context.resolvedSecrets,
        );
        const checked = parsedConfiguration(registration, resolved);
        if (!checked.ok) {
          throw new HookActionError(
            `The action's configuration is refused: ${checked.reason}`,
            true,
          );
        }
        // A rejection is the delivery's failed attempt; the runner's caller records its message.
        const reaction: PluginReactionContext = {
          event: work.event,
          configuration: checked.value,
          signal: context.signal,
          deliveryId: context.deliveryId,
          idempotencyKey: key,
          format: formatForReaction,
          hookId: context.hookId,
          owner: context.owner,
          attempt: context.attempt,
        };
        try {
          // `dryRun` was checked above, before anything was resolved.
          const answer: unknown = context.test
            ? await registration.kind.dryRun?.(reaction)
            : await registration.kind.run(reaction);
          // What it says it made (COR-2182): a field that is not allowed is dropped, one warning
          // names them, and the delivery is still completed.
          const { receipt, dropped } = receiptOf(answer, context.resolvedSecrets);
          if (dropped.length > 0) {
            dependencies.notice?.(
              `[bureau] Hook ${context.hookId} dropped the ${dropped.join(' and ')} of the receipt of ${work.plugin}/${work.kind}: ${dropped.length === 1 ? 'it is' : 'they are'} not allowed in a receipt`,
            );
          }
          return receipt;
        } catch (error) {
          if (isPermanentReactionError(error)) throw new HookActionError(error.message, true);
          throw error;
        }
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
    workspace: dependencies.workspace,
    engine,
    actions: actionRunner,
    store,
    secrets,
    keys: dependencies.keys,
    urlPolicy,
    requestTimeoutMilliseconds:
      dependencies.requestTimeoutMilliseconds ?? DEFAULT_HOOK_REQUEST_TIMEOUT_MILLISECONDS,
    newId: () => dependencies.newId('hook-delivery'),
    actionKindVersion: (plugin, kind) => actionKinds.get(actionKindKey(plugin, kind))?.version,
    actionKindTimeout: (plugin, kind) =>
      actionKinds.get(actionKindKey(plugin, kind))?.kind.timeoutMilliseconds,
    actionKindMaxAttempts: (plugin, kind) =>
      actionKinds.get(actionKindKey(plugin, kind))?.kind.maxAttempts,
    actionKindAvailable: (plugin, kind) =>
      actionKinds.get(actionKindKey(plugin, kind))?.availability?.() !== 'needs-setup',
    timeoutSignal: dependencies.timeoutSignal,
    formatEvent,
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
    publish: dependencies.publish,
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
    // Read after the store, so a plugin kind matches the version loaded as the event is matched.
    const declared = declaredNow();
    return cachedHooks.hooks.filter(
      (hook) =>
        hook.enabled &&
        // A plugin's kind matches only an entry pinned to the version loaded now (COR-2226).
        hookEventsMatch(hook.events, kind, declared) &&
        // A default hook whose plugin contributes no such reaction now (the plugin is disabled, or
        // its setup failed) fires nothing and writes no delivery. An owner's hook of a missing
        // plugin still does: its delivery fails where a person can read why.
        !(
          hook.declaredBy !== undefined &&
          hook.action.type === 'plugin' &&
          !actionKinds.has(actionKindKey(hook.action.plugin, hook.action.kind))
        ) &&
        // A record that lists it anyway (written by something that skipped the check) is not fired.
        !notifyMayNotFireOn(hook, kind),
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
      const checkedKinds = checkedEvents(input.events, declaredNow());
      assertNoMissingEvents(checkedKinds.missing);
      const events = checkedKinds.events;
      const scope = input.scope === undefined ? undefined : checkedScope(input.scope);
      // A webhook created without a secret gets one generated here, and shown once on the answer.
      const generated =
        action.type === 'webhook' && input.signingSecret === undefined
          ? generateHookSigningSecret()
          : undefined;
      const secret =
        action.type === 'webhook' ? (generated ?? checkedSecret(input.signingSecret)) : undefined;
      if (action.type !== 'webhook' && input.signingSecret !== undefined) {
        invalid('signingSecret', 'Only a webhook hook has a signing secret');
      }
      const name = input.name === undefined ? undefined : checkedName(input.name);
      const owner = ownerFromPrincipal(input.principal, (message) => invalid('principal', message));
      const enabled = input.enabled ?? true;
      assertNoNotificationLoop(action, events);
      assertNoOwnPluginEvents(action, events);
      assertNoUnplacedStart(action, events);
      assertScopeFits(scope, events);
      await assertActionAllowed(action, owner);
      const now = engine.now();
      const workspaceAuthority =
        dependencies.workspace === undefined
          ? undefined
          : await captureRunWorkspaceAuthority(dependencies.workspace, owner);
      if (dependencies.workspace !== undefined && workspaceAuthority === undefined)
        throw new Error('Workspace authority unavailable.');
      const record: HookRecord = {
        ...(workspaceAuthority === undefined ? {} : { workspaceAuthority }),
        version: 1,
        id: dependencies.newId('hook'),
        owner,
        ...(name === undefined ? {} : { name }),
        action,
        events,
        ...(scope === undefined ? {} : { scope }),
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
      return generated === undefined
        ? viewOf(record)
        : { ...viewOf(record), signingSecret: generated };
    },
    async replaceSigningSecret(hookId, options) {
      // The caller owns `options`: read before the first await.
      const principal = options?.principal;
      const expectedRevision = options?.expectedRevision;
      const stored = await store.getHook(hookId);
      if (stored === undefined) return undefined;
      if (stored.record.action.type !== 'webhook') {
        invalid('signingSecret', 'Only a webhook hook has a signing secret');
      }
      const signingSecret = generateHookSigningSecret();
      const replaced = await hooks.update(hookId, {
        signingSecret,
        ...(principal === undefined ? {} : { principal }),
        ...(expectedRevision === undefined ? {} : { expectedRevision }),
      });
      return replaced === undefined ? undefined : { ...replaced, signingSecret };
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
      const checkedKinds =
        input.events === undefined ? undefined : checkedEvents(input.events, declaredNow());
      const events = checkedKinds?.events;
      const scope =
        input.scope === null || input.scope === undefined ? input.scope : checkedScope(input.scope);
      const secret =
        input.signingSecret === undefined ? undefined : checkedSecret(input.signingSecret);
      const name =
        input.name === null || input.name === undefined ? input.name : checkedName(input.name);
      const enabled = input.enabled;
      const expectedRevision = input.expectedRevision;
      const actor = input.principal;
      // The fields that change a hook, in the order a refusal names them (COR-2179).
      const changed = (
        [
          ['url', url],
          ['action', replacement],
          ['events', events],
          ['scope', scope],
          ['name', name],
          ['signingSecret', secret],
        ] as const
      )
        .filter(([, value]) => value !== undefined)
        .map(([field]) => field);

      return exclusively(hookId, async () => {
        const stored = await store.getHook(hookId);
        if (stored === undefined) return undefined;
        const before = stored.record;
        // A default hook is the plugin's: the owner may only turn it off or on.
        if (before.declaredBy !== undefined) {
          if (changed.length > 0) {
            throw new HookError('invalid', 'A default hook can only be enabled or disabled', {
              issues: changed.map((field) => ({
                path: [field],
                message: `A default hook declared by a plugin cannot change its ${field}; only \`enabled\` can be set`,
              })),
            });
          }
          if (enabled === true && before.declaredBy.withdrawn === true) {
            invalid('enabled', 'The plugin no longer declares this hook, so it cannot be enabled');
          }
        }
        if (expectedRevision !== undefined && expectedRevision !== before.revision) {
          throw new HookError('stale-revision', 'The hook has changed since it was read', {
            currentRevision: before.revision,
          });
        }
        // A kind the hook already lists stays, though it is missing now (COR-2226).
        if (checkedKinds !== undefined) assertNoMissingEvents(checkedKinds.missing, before.events);
        const nextName = name === undefined ? before.name : (name ?? undefined);
        const nextScope = scope === undefined ? before.scope : (scope ?? undefined);
        const { name: _previousName, scope: _previousScope, ...rest } = before;
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
        // Asked when the events change, so a rename or a disable of a hook written before the
        // refusal still saves; dispatch's source guard keeps such a hook from firing.
        if (events !== undefined) assertNoOwnPluginEvents(action, nextEvents);
        // Asked when either side changes, so a rename or a disable is never held up by a record
        // whose scope this release cannot read.
        if (scope !== undefined || events !== undefined) assertScopeFits(nextScope, nextEvents);
        // Authority is asked again only when the action is rewritten, so a rename or a disable is
        // never held up by a workflow that has since been paused.
        if (replacement !== undefined) await assertActionAllowed(action, before.owner);
        // `enabled` on a default hook sets or clears the owner's override, which a reconcile keeps.
        const declaredBy =
          before.declaredBy === undefined || enabled === undefined
            ? before.declaredBy
            : withOwnerOverride(before.declaredBy, !enabled);
        const after: HookRecord = {
          ...rest,
          ...(nextName === undefined ? {} : { name: nextName }),
          action,
          events: nextEvents,
          ...(nextScope === undefined ? {} : { scope: nextScope }),
          ...(declaredBy === undefined ? {} : { declaredBy }),
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
        // After the commit, never before it: a disable that lost the compare-and-swap aborts nothing.
        if (before.enabled && !after.enabled) deliveries.abortHook(hookId);
        if (sealed !== undefined) await secrets.set(hookId, sealed);
        recordChange('hook.updated', after, actor);
        return viewOf(after);
      });
    },
    async delete(hookId, options) {
      return exclusively(hookId, async () => {
        const stored = await store.getHook(hookId);
        if (stored === undefined) return false;
        // Nothing is written, aborted or audited: the plugin's hook stays, and the owner turns it off.
        assertHookDeletable(stored.record);
        if (!(await store.deleteHook(stored))) return false;
        deliveries.abortHook(hookId);
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
    async reconcileDeclared(plugin, declarations) {
      // The caller owns `declarations`: every field is read, checked and copied before the first
      // await, and nothing is written until every declaration has passed.
      const checked = checkedDeclarations(plugin, declarations);
      const reconciled: Hook[] = [];
      // Created and replaced first, in declaration order, and withdrawn after: a crash between
      // leaves a hook too many firing, never one too few, and the next reconcile finishes.
      for (const declared of checked) reconciled.push(await reconcileDefaultHook(plugin, declared));
      await withdrawUndeclaredHooks(plugin, new Set(checked.map((declared) => declared.name)));
      return reconciled;
    },
    async duplicate(hookId, options) {
      // The caller owns `options`: read before the first await.
      const principal = options?.principal;
      const copyName = options?.name;
      const expectedRevision = options?.expectedRevision;
      const stored = await store.getHook(hookId);
      if (stored === undefined) return undefined;
      if (expectedRevision !== undefined && expectedRevision !== stored.record.revision) {
        throw new HookError('stale-revision', 'The hook has changed since it was read', {
          currentRevision: stored.record.revision,
        });
      }
      const { action, events, scope, name: sourceName } = stored.record;
      const name = copyName ?? sourceName;
      return hooks.create({
        action,
        events,
        ...(scope === undefined ? {} : { scope: scope as HookScopeInput }),
        ...(name === undefined ? {} : { name }),
        enabled: false,
        ...(principal === undefined ? {} : { principal }),
      });
    },
    async declaredPlugins() {
      const plugins = new Set<string>();
      for (const hook of await store.listHooks()) {
        if (hook.declaredBy !== undefined) plugins.add(hook.declaredBy.plugin);
      }
      return [...plugins];
    },
    async get(hookId) {
      const stored: Stored<HookRecord> | undefined = await store.getHook(hookId);
      return stored === undefined ? undefined : viewOf(stored.record);
    },
    async list(filter) {
      // The caller owns `filter`: every field is read before the first await.
      const owner = filter?.owner;
      const scopeKind = filter?.scope?.kind;
      const scopeId = filter?.scope?.id;
      const all = await store.listHooks();
      const listed = all
        .filter(
          (hook) =>
            (owner === undefined || hook.owner === owner) &&
            (scopeKind === undefined ||
              (hook.scope?.kind === scopeKind && hook.scope.id === scopeId)),
        )
        .toSorted((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
      // One read of the delivery records for the whole answer, not one per hook.
      const wanted = new Set(listed.map((hook) => hook.id));
      const newest = new Map<string, HookDeliveryRecord>();
      if (wanted.size > 0) {
        for (const delivery of await store.listDeliveries()) {
          if (!wanted.has(delivery.hookId)) continue;
          const current = newest.get(delivery.hookId);
          if (current === undefined || isNewerDelivery(delivery, current)) {
            newest.set(delivery.hookId, delivery);
          }
        }
      }
      const workflowOwners = new Set(
        listed.filter((hook) => hook.action.type === 'start-workflow').map((hook) => hook.owner),
      );
      // A list may include several workflow hooks per owner. Check their current authority once.
      const workflowAuthority = new Map(
        await Promise.all(
          [...workflowOwners].map(
            async (hookOwner) => [hookOwner, await mayStartWorkflows(hookOwner)] as const,
          ),
        ),
      );
      const declared = declaredNow();
      return listed.map((hook) => {
        const last = newest.get(hook.id);
        return {
          ...viewOf(hook),
          lastDelivery: last === undefined ? null : deliverySummaryOf(last),
          problems: problemsOf(hook, declared, workflowAuthority.get(hook.owner) === true),
        };
      });
    },
    async test(hookId, options) {
      const stored = await store.getHook(hookId);
      if (stored === undefined) return undefined;
      const { action } = stored.record;
      if (action.type === 'plugin') {
        // A test of a plugin hook runs the reaction's `dryRun`, never its `run`: without one, a
        // test would have the real effect (COR-2183). A kind that is gone, or whose plugin needs
        // setup, cannot be tested either.
        const registration = actionKinds.get(actionKindKey(action.plugin, action.kind));
        if (registration === undefined) {
          invalid(
            'action',
            `No plugin contributes the hook action kind "${action.plugin}/${action.kind}", so it cannot be tested`,
          );
        }
        if (typeof registration.kind.dryRun !== 'function') {
          invalid(
            'action',
            `The hook action kind "${action.plugin}/${action.kind}" has no dryRun, so a test would run it for real`,
          );
        }
        if (registration.availability?.() === 'needs-setup') {
          invalid(
            'action',
            `The plugin "${action.plugin}" needs setup, so its hook action kind cannot be tested yet`,
          );
        }
      } else if (action.type !== 'webhook') {
        invalid(
          'action',
          'Only a webhook hook, or a plugin hook whose reaction has a dryRun, can be tested: a test would start a real run or write a real notification',
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
    async testDraft(input) {
      // The caller owns `input`: every field is read and checked before the first await.
      const url = input.url;
      const defect = hookUrlDefect(url, urlPolicy);
      if (defect !== undefined) invalid('url', defect);
      const secret =
        input.signingSecret === undefined
          ? generateHookSigningSecret()
          : checkedSecret(input.signingSecret);
      const owner = ownerFromPrincipal(input.principal, (message) => invalid('principal', message));
      const workspaceAuthority =
        dependencies.workspace === undefined
          ? undefined
          : await captureRunWorkspaceAuthority(dependencies.workspace, owner);
      if (dependencies.workspace !== undefined && workspaceAuthority === undefined)
        throw new Error('Workspace authority unavailable.');
      const sent = await deliveries.sendDraft({
        hookId: HOOK_DRAFT_ID,
        owner,
        ...(workspaceAuthority === undefined ? {} : { workspaceAuthority }),
        url,
        secret,
        event: {
          kind: HOOK_TEST_EVENT_KIND,
          bureauId: dependencies.bureauId,
          emittedAtMs: engine.now(),
          payload: { message: 'This is a test delivery from Corvidae.' },
        },
      });
      return deliveryViewOf(sent);
    },
    async retryDelivery(hookId, deliveryId, options) {
      // The caller owns `options`: read before the first await.
      const principal = options?.principal;
      const stored = await store.getDelivery(deliveryId);
      // A delivery is reached through its own hook, so another hook's identifier finds nothing.
      if (stored === undefined || stored.record.hookId !== hookId) return undefined;
      if (stored.record.status === 'delivered') {
        invalid('deliveryId', 'The delivery was delivered, so there is nothing to retry');
      }
      void dependencies
        .audit({
          runId: `hook:${hookId}`,
          type: 'hook.delivery.retried',
          ...(principal === undefined ? {} : { principal }),
          detail: { hookId, owner: stored.record.owner, deliveryId },
        })
        .catch((cause: unknown) => dependencies.diagnose('Failed to audit a hook retry', cause));
      await deliveries.retry(deliveryId);
      const after = await store.getDelivery(deliveryId);
      return after === undefined ? undefined : deliveryViewOf(after.record);
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
   * `declarations` checked as `create` checks the same fields, each refusal named by its place
   * (`[index, field]`), and copied: the caller owns the input. A repeated name is refused at its
   * second place. Nothing is written.
   */
  function checkedDeclarations(
    plugin: string,
    declarations: readonly HookDeclaration[],
  ): readonly CheckedDeclaration[] {
    if (typeof plugin !== 'string' || plugin === '') {
      invalid('plugin', 'A declaration names the plugin that declares it');
    }
    if (!Array.isArray(declarations)) invalid('declarations', 'The declarations must be a list');
    const declared = declaredNow();
    const names = new Set<string>();
    return declarations.map((declaration, index): CheckedDeclaration => {
      if (typeof declaration !== 'object' || declaration === null || Array.isArray(declaration)) {
        invalid([String(index)], 'A declaration must be an object');
      }
      try {
        const name = checkedName(declaration.name);
        if (names.has(name)) invalid('name', `The name "${name}" is declared twice`);
        names.add(name);
        const checkedKinds = checkedEvents(declaration.events, declared);
        assertNoMissingEvents(checkedKinds.missing);
        const events = checkedKinds.events;
        const scope = declaration.scope === undefined ? undefined : checkedScope(declaration.scope);
        const action = checkedAction(
          {
            type: 'plugin',
            plugin,
            kind: declaration.reaction,
            configuration: declaration.configuration,
          },
          urlPolicy,
          actionKinds,
        );
        // A default hook runs its own plugin's reaction, so it cannot list its own plugin's kinds.
        assertNoOwnPluginEvents(action, events);
        assertScopeFits(scope, events);
        return { name, events, action, scope };
      } catch (error) {
        return atDeclaration(index, error);
      }
    });
  }

  /**
   * Makes the default hook `plugin` declares as `declared` what it says, and resolves with it: creates
   * it when it is missing, replaces it when it differs (or was withdrawn), and writes nothing when it
   * is current. The owner's override (`ownerDisabled`) is kept. A write that loses its
   * compare-and-swap means another writer committed first, so the hook is read again and the
   * decision made again from what is there, until it writes or has nothing to write.
   */
  function reconcileDefaultHook(plugin: string, declared: CheckedDeclaration): Promise<Hook> {
    const hookId = defaultHookIdOf(plugin, declared.name);
    return exclusively(hookId, async () => {
      let lostCreate = false;
      for (;;) {
        const stored = await store.getHook(hookId);
        if (stored === undefined) {
          // The create was lost to a record that this release cannot read: it would be lost for ever.
          if (lostCreate) throw new Error(`The default hook "${hookId}" exists and cannot be read`);
          const record = await newDefaultHook(hookId, plugin, declared);
          if (await store.createHook(record)) {
            recordChange('hook.created', record, undefined);
            return viewOf(record);
          }
          lostCreate = true;
          continue;
        }
        const before = stored.record;
        if (before.declaredBy?.plugin !== plugin || before.name !== declared.name) {
          throw new Error(
            `Hook id "${hookId}" is already in use by a hook that is not a default hook of ${plugin}`,
          );
        }
        if (declarationIsCurrent(before, declared)) return viewOf(before);
        const ownerDisabled = before.declaredBy.ownerDisabled === true;
        const { scope: _previousScope, declaredBy: _previousOrigin, ...rest } = before;
        const after: HookRecord = {
          ...rest,
          action: declared.action,
          events: [...declared.events],
          ...(declared.scope === undefined ? {} : { scope: declared.scope }),
          declaredBy: { plugin, ...(ownerDisabled ? { ownerDisabled: true as const } : {}) },
          enabled: !ownerDisabled,
          updatedAt: engine.now(),
          revision: before.revision + 1,
        };
        if (!(await store.replaceHook(stored, after))) continue;
        // After the commit, as `update` does: a write that lost aborts nothing.
        if (before.enabled && !after.enabled) deliveries.abortHook(hookId);
        recordChange('hook.updated', after, undefined);
        return viewOf(after);
      }
    });
  }

  /** The record of a default hook that does not exist yet, as `create` would write it for the owner of record. */
  async function newDefaultHook(
    hookId: string,
    plugin: string,
    declared: CheckedDeclaration,
  ): Promise<HookRecord> {
    const owner = ownerOrLocal(undefined);
    const now = engine.now();
    const workspaceAuthority =
      dependencies.workspace === undefined
        ? undefined
        : await captureRunWorkspaceAuthority(dependencies.workspace, owner);
    if (dependencies.workspace !== undefined && workspaceAuthority === undefined)
      throw new Error('Workspace authority unavailable.');
    return {
      ...(workspaceAuthority === undefined ? {} : { workspaceAuthority }),
      version: 3,
      id: hookId,
      owner,
      name: declared.name,
      action: declared.action,
      events: [...declared.events],
      ...(declared.scope === undefined ? {} : { scope: declared.scope }),
      declaredBy: { plugin },
      enabled: true,
      createdAt: now,
      updatedAt: now,
      revision: 1,
    };
  }

  /**
   * Withdraws every default hook of `plugin` whose name is not in `declared`, oldest first: disabled
   * and kept, with the owner's override as it was. A hook that another writer withdrew, or changed, is
   * read again and judged as it is now.
   */
  async function withdrawUndeclaredHooks(
    plugin: string,
    declared: ReadonlySet<string>,
  ): Promise<void> {
    const everyHook = await store.listHooks();
    const undeclared = everyHook
      .filter(
        (hook) =>
          hook.declaredBy?.plugin === plugin &&
          hook.declaredBy.withdrawn !== true &&
          !declared.has(hook.name ?? ''),
      )
      .toSorted((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    for (const { id: hookId } of undeclared) {
      await exclusively(hookId, async () => {
        for (;;) {
          const stored = await store.getHook(hookId);
          if (stored === undefined) return;
          const before = stored.record;
          if (
            before.declaredBy?.plugin !== plugin ||
            before.declaredBy.withdrawn === true ||
            declared.has(before.name ?? '')
          ) {
            return;
          }
          const after: HookRecord = {
            ...before,
            declaredBy: { ...before.declaredBy, withdrawn: true },
            enabled: false,
            updatedAt: engine.now(),
            revision: before.revision + 1,
          };
          if (!(await store.replaceHook(stored, after))) continue;
          // After the commit: a withdrawal that lost aborts nothing, and one of a hook already off has nothing to abort.
          if (before.enabled) deliveries.abortHook(hookId);
          recordChange('hook.updated', after, undefined);
          return;
        }
      });
    }
  }

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

  /**
   * The subjects of an event, or `undefined` when they cannot be read: every scoped hook then treats
   * the event as outside its scope, so a failed lookup never fires a hook for someone else's subject.
   */
  async function subjectsOf(event: HookEventToDeliver): Promise<HookEventSubjects | undefined> {
    const sources: HookSubjectSources = dependencies.subjects ?? {
      run: async () => ({ agent: undefined, workflows: [], schedules: [] }),
      agentOfSchedule: async () => undefined,
      agentOfGoal: async () => undefined,
    };
    try {
      return await subjectsOfPayload(event.payload, sources);
    } catch (cause) {
      dependencies.diagnose(`Could not tell what a ${event.kind} event is about`, cause);
      return undefined;
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

  // A secret saved, or removed, makes a plugin's reactions available, or not (COR-2176). The
  // deliveries that waited for it released their leases, so a resume takes them without a restart.
  // Nothing is taken before the hooks are open: the boot `resume()` does that, once the workflow
  // files are loaded.
  for (const registration of actionKinds.values()) {
    registration.onAvailabilityChange?.(() => {
      if (held !== undefined || engine.shuttingDown()) return;
      if (registration.availability?.() === 'needs-setup') return;
      engine.track(
        deliveries.resume().then(
          () => undefined,
          (cause: unknown) =>
            dependencies.diagnose(
              'Failed to resume the hook deliveries that waited for a plugin',
              cause,
            ),
        ),
      );
    });
  }

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
        let subjects: Promise<HookEventSubjects | undefined> | undefined;
        for (const hook of await matching(event.kind)) {
          // A reaction does not fire on its own plugin's events, or one that raises the kind it lists
          // would run itself for ever. Nothing is written: this is a hook that does not match. A
          // hook listing its own plugin's kind is refused when written (`assertNoOwnPluginEvents`);
          // one written before that refusal is skipped here.
          if (hook.action.type === 'plugin' && event.source === hook.action.plugin) {
            dependencies.notice?.(
              `[bureau] Hook ${hook.id} did not run its plugin action: Skipped: ${event.kind} came from plugin ${hook.action.plugin}, and a plugin's reaction does not fire on its own plugin's events`,
            );
            continue;
          }
          // COR-2182 — nothing is written for a hook whose reaction is not registered (its plugin is
          // disabled or gone): a delivery would only fail, and the hook lists the problem instead.
          if (reactionUnavailable(hook)) continue;
          const projected =
            dependencies.eventForHookOwner === undefined
              ? event
              : await dependencies.eventForHookOwner(hook.owner, event);
          if (projected === undefined) continue;
          if (hook.scope !== undefined) {
            // Asked once per event, and only when a scoped hook lists its kind.
            subjects ??= subjectsOf(event);
            const about = await subjects;
            if (about === undefined || !scopeMatches(hook.scope, about)) continue;
          }
          let skip: string | undefined;
          if (hook.action.type === 'start-workflow') {
            skip = placementSkipReason(origin, runId, hook, event);
            if (skip === undefined && origin === 'run' && runId !== undefined) {
              // Asked once per event, and only when a hook would start something.
              starter ??= startedBy(runId);
              skip = chainSkipReason(await starter, hook, event);
            }
          }
          driving.push(deliveries.drive(await deliveries.enqueue(hook, projected, false, skip)));
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
