/**
 * The browser's view of the Bureau's hooks: `bureau.hooks.*` (COR-1939, COR-1940) and the event
 * catalog a hook chooses its events from (`bureau.events.catalog`), through the generated client.
 *
 * A hook belongs to the principal that created it. When one of its events happens, its action runs:
 * a `webhook` sends the event, signed, to a URL; `start-workflow` starts a workflow; `notify` writes
 * the owner a notification. A hook of an action kind a plugin contributes reads as `plugin`.
 *
 * The signing secret is shown once (COR-2022): a webhook created without one gets a secret the
 * Bureau makes, carried by the `create` answer alone, and `replaceHookSecret` makes a new one,
 * carried by its answer alone. No read returns it, and a secret the person chose and sent with
 * `create` or `update` never comes back.
 *
 * A hook may name one agent, workflow or schedule as its `scope`, and then fires only for events
 * about that subject; the Bureau decides what an event is about, and a list carries each hook's
 * newest delivery so a page needs no read per hook. A delivery carries the request it sent, body
 * included, and the time its next try is due while it waits; `retryHookDelivery` sends that
 * recorded delivery again, and `testHookDraft` tests a webhook before it is saved.
 *
 * `update` names the revision of the hook the caller read, so a hook that changed since is refused
 * (`StaleRevision`) instead of being overwritten.
 */
import { bureauClient, type BureauInput, type BureauOutput } from './bureau-api.ts';
import type { Fetcher } from './bureau-client.ts';

type Options = { readonly signal?: AbortSignal; readonly fetch?: Fetcher };

/** One hook as `bureau.hooks.get` and `update` show it. */
export type Hook = Omit<BureauOutput<'bureau.hooks.get'>, 'action'> & {
  readonly action: HookAction;
};

type WireAction = BureauOutput<'bureau.hooks.get'>['action'];

/**
 * What a hook does for each event, tagged by `type`. A hook of an action kind a plugin contributes
 * reads as `plugin`, whose `configuration` is absent from a Bureau that does not say.
 */
export type HookAction =
  | Exclude<WireAction, { readonly type: 'plugin' }>
  | (Omit<Extract<WireAction, { readonly type: 'plugin' }>, 'configuration'> & {
      readonly configuration?: unknown;
    });

/**
 * The built-in kinds of action a person can choose when writing a hook. The kinds running plugins
 * contribute are offered beside them (`bureau.plugins.contributions`) and written as a `plugin` action.
 */
export const HOOK_ACTION_TYPES = ['webhook', 'start-workflow', 'notify'] as const;

/** An action a person can write. */
export type HookActionType = (typeof HOOK_ACTION_TYPES)[number];

/** Every kind of subject a hook can be scoped to. */
export const HOOK_SCOPE_KINDS = ['agent', 'workflow', 'schedule'] as const;

/** A kind of subject a hook can be scoped to. */
export type HookScopeKind = (typeof HOOK_SCOPE_KINDS)[number];

/** The one subject a hook is asked to fire for. */
export type HookScopeInput = {
  /** What `id` names. */
  readonly kind: HookScopeKind;
  /** The agent's name, the workflow's identifier, or the schedule's id. */
  readonly id: string;
};

/** The one subject a hook fires for, as the Bureau holds it. */
export type HookScope = NonNullable<Hook['scope']>;

/**
 * A hook as `bureau.hooks.create` answers it: the hook, and the signing secret the Bureau made for
 * a webhook created without one, shown this once. `null` when the person chose the secret, or the
 * action has none.
 */
export type CreatedHook = BureauOutput<'bureau.hooks.create'>;

/** A hook as `bureau.hooks.secret.replace` answers it, with its new signing secret, shown this once. */
export type HookWithNewSecret = BureauOutput<'bureau.hooks.secret.replace'>;

/** Every status a delivery can have. */
export const HOOK_DELIVERY_STATUSES = [
  'pending',
  'delivered',
  'exhausted',
  'aborted',
  'failed-secret',
  'failed',
] as const;

/** Where a delivery stands. */
export type HookDeliveryStatus = (typeof HOOK_DELIVERY_STATUSES)[number];

/**
 * One delivery of one event to a hook: where it stands, every attempt made, the request a webhook
 * delivery sent (its URL, its headers without the signature, and its exact JSON body), and, while
 * it waits out its backoff, when its next try is due (`nextAttemptAt`, epoch milliseconds).
 */
export type HookDelivery = Pick<
  BureauOutput<'bureau.hooks.test'>,
  | 'id'
  | 'hookId'
  | 'actionType'
  | 'kind'
  | 'test'
  | 'status'
  | 'request'
  | 'maxAttempts'
  | 'createdAt'
  | 'updatedAt'
> & {
  readonly attempts: readonly HookAttempt[];
  readonly nextAttemptAt: number | null;
};

/** One try of a delivery: when it started and ended, how it ended, the status, an excerpt of the answer, and the error. */
export type HookAttempt = Pick<
  BureauOutput<'bureau.hooks.test'>['attempts'][number],
  | 'number'
  | 'startedAt'
  | 'finishedAt'
  | 'outcome'
  | 'status'
  | 'responseExcerpt'
  | 'responseTruncated'
  | 'error'
>;

/**
 * A created hook as a Bureau that does not say has it: with no signing secret. The server's schema
 * always sends the field, so this default belongs to the browser, applied to the typed result.
 */
export function createdHookOf(
  hook: Omit<CreatedHook, 'signingSecret'> & { readonly signingSecret?: string | null | undefined },
): CreatedHook {
  return { ...hook, signingSecret: hook.signingSecret ?? null };
}

/**
 * A delivery as a Bureau that predates `nextAttemptAt` has it: with no try due. The server's schema
 * always sends the field, so this default belongs to the browser, applied to the typed result.
 */
export function deliveryOf(
  delivery: Omit<BureauOutput<'bureau.hooks.test'>, 'nextAttemptAt'> & {
    readonly nextAttemptAt?: number | null | undefined;
  },
): HookDelivery {
  return {
    id: delivery.id,
    hookId: delivery.hookId,
    actionType: delivery.actionType,
    kind: delivery.kind,
    test: delivery.test,
    status: delivery.status,
    request: delivery.request,
    attempts: delivery.attempts,
    maxAttempts: delivery.maxAttempts,
    nextAttemptAt: delivery.nextAttemptAt ?? null,
    createdAt: delivery.createdAt,
    updatedAt: delivery.updatedAt,
  };
}

/**
 * The body a webhook delivery sent, parsed, for showing the payload: the envelope `{ id, hookId,
 * kind, bureauId, emittedAtMs, test, payload, source? }`. `undefined` for a delivery that sent no
 * request (an action other than a webhook) and for a body that is not JSON.
 */
export function deliveryBody(delivery: Pick<HookDelivery, 'request'>): unknown {
  if (delivery.request === null) return undefined;
  try {
    return JSON.parse(delivery.request.body) as unknown;
  } catch {
    return undefined;
  }
}

/** A hook's newest delivery as a list shows it: where it stands and how its last attempt ended. */
export type HookDeliverySummary = NonNullable<ListedHook['lastDelivery']>;

/** One hook as `bureau.hooks.list` shows it, with its newest delivery. */
export type ListedHook = Omit<BureauOutput<'bureau.hooks.list'>['hooks'][number], 'action'> & {
  readonly action: HookAction;
};

/** The caller's hooks, oldest first; `scope` narrows them to the hooks of exactly that subject. */
export async function listHooks(
  filter?: { readonly scope?: HookScopeInput },
  options?: Options,
): Promise<ListedHook[]> {
  const params = filter?.scope === undefined ? {} : { scope: filter.scope };
  const answer = await bureauClient['bureau.hooks.list'](params, options);
  return [...answer.hooks];
}

/** One hook by its identifier; a hook that is not the caller's is `NotFound`. */
export async function getHook(hookId: string, options?: Options): Promise<Hook> {
  return bureauClient['bureau.hooks.get']({ hookId }, options);
}

/** What a hook is written from. */
export type HookInput = {
  /** A label for the list; 1 to 100 characters. */
  readonly name?: string;
  /** The event kinds the hook listens to; at least one, at most 64. */
  readonly events: readonly string[];
  /** The one subject the hook fires for; left out, it fires for its events everywhere. */
  readonly scope?: HookScopeInput;
  /** What the hook does for each event. */
  readonly action:
    | { readonly type: 'webhook'; readonly url: string }
    | {
        readonly type: 'start-workflow';
        readonly workflowId: string;
        readonly input: 'payload' | 'event';
      }
    | { readonly type: 'notify'; readonly title?: string }
    | {
        readonly type: 'plugin';
        readonly plugin: string;
        readonly kind: string;
        readonly configuration: Readonly<Record<string, unknown>>;
      };
  /**
   * The secret a webhook is signed with, 16 to 256 characters. Sealed on arrival and never
   * returned. Left out of a webhook, the Bureau makes one and the answer carries it once.
   */
  readonly signingSecret?: string;
  /** Whether the hook fires; on unless said. */
  readonly enabled?: boolean;
};

/**
 * The event kinds as the operations name them. The page reads them from the event catalog as
 * strings, and the Bureau refuses a kind it does not know, so the names are passed on as they are.
 */
function eventNames(events: readonly string[]): BureauInput<'bureau.hooks.create'>['events'] {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return events as BureauInput<'bureau.hooks.create'>['events'];
}

/**
 * Creates a hook the caller owns. A webhook created without a signing secret answers with the one
 * the Bureau made, as `signingSecret`, this once; nothing reads it back afterwards.
 */
export async function createHook(input: HookInput, options?: Options): Promise<CreatedHook> {
  const created = await bureauClient['bureau.hooks.create'](
    { ...input, events: eventNames(input.events) },
    options,
  );
  return createdHookOf(created);
}

/**
 * Replaces a webhook hook's signing secret with a new one the Bureau makes, and answers the hook
 * with it, this once; the old secret stops signing at once. Given `expectedRevision`, a hook that
 * changed since is refused (`StaleRevision`).
 */
export async function replaceHookSecret(
  hookId: string,
  expectedRevision?: number,
  options?: Options,
): Promise<HookWithNewSecret> {
  const params = expectedRevision === undefined ? { hookId } : { hookId, expectedRevision };
  return bureauClient['bureau.hooks.secret.replace'](params, options);
}

/** What `update` changes; a field left out stays. A `null` name removes it. */
export type HookChange = {
  /** A new label, or `null` to remove it. */
  readonly name?: string | null;
  /** The new event kinds, replacing the list. */
  readonly events?: readonly string[];
  /** A new subject, or `null` so the hook fires for its events everywhere. */
  readonly scope?: HookScopeInput | null;
  /** The action again, with new fields; its type is the hook's own. */
  readonly action?: HookInput['action'];
  /** A new signing secret, which replaces the old one. Never returned. */
  readonly signingSecret?: string;
  /** Turns the hook on or off. */
  readonly enabled?: boolean;
};

/** Changes a hook, if it is still at `expectedRevision`. */
export async function updateHook(
  hookId: string,
  expectedRevision: number,
  change: HookChange,
  options?: Options,
): Promise<Hook> {
  const { events, ...rest } = change;
  return bureauClient['bureau.hooks.update'](
    {
      hookId,
      expectedRevision,
      ...rest,
      ...(events === undefined ? {} : { events: eventNames(events) }),
    },
    options,
  );
}

/** Deletes a hook, its secret and its delivery records. */
export async function deleteHook(hookId: string, options?: Options): Promise<void> {
  await bureauClient['bureau.hooks.delete']({ hookId }, options);
}

/**
 * Sends one signed test message to a webhook hook and answers its record once the one attempt has
 * ended. The Bureau refuses a hook of any other action, because a test would start a real run or
 * write a real notification.
 */
export async function testHook(hookId: string, options?: Options): Promise<HookDelivery> {
  return deliveryOf(await bureauClient['bureau.hooks.test']({ hookId }, options));
}

/** The webhook a person is writing, tested before it is saved. */
export type HookDraft = {
  /** Where the test is sent. */
  readonly url: string;
  /** The secret the person chose, if any; it signs the test and is never returned. */
  readonly signingSecret?: string;
};

/**
 * Sends one signed test message to a webhook that is not saved yet, and answers what the delivery
 * would have recorded once its one attempt has ended. Nothing is saved: no hook and no delivery.
 */
export async function testHookDraft(draft: HookDraft, options?: Options): Promise<HookDelivery> {
  const params =
    draft.signingSecret === undefined
      ? { url: draft.url }
      : { url: draft.url, signingSecret: draft.signingSecret };
  return deliveryOf(await bureauClient['bureau.hooks.draft.test'](params, options));
}

/**
 * Sends one of a hook's deliveries again from its record: the same request and body, never one
 * rebuilt from the hook as it is now. A delivery that failed gets one more try, and the answer is
 * its record once that try has ended; one waiting out its backoff is tried now ("Retry now"), and
 * the answer is its record at once. A delivered delivery is refused (`InvalidParams`).
 */
export async function retryHookDelivery(
  hookId: string,
  deliveryId: string,
  options?: Options,
): Promise<HookDelivery> {
  return deliveryOf(
    await bureauClient['bureau.hooks.deliveries.retry']({ hookId, deliveryId }, options),
  );
}

/** The newest deliveries of a hook, newest first, at most `limit`. */
export async function listHookDeliveries(
  hookId: string,
  limit: number,
  options?: Options,
): Promise<HookDelivery[]> {
  const answer = await bureauClient['bureau.hooks.deliveries']({ hookId, limit }, options);
  return answer.deliveries.map(deliveryOf);
}

/** One event kind a hook can listen to, with what the Bureau says about it. */
export type HookEventKind = Pick<
  BureauOutput<'bureau.events.catalog'>['events'][number],
  'kind' | 'description' | 'origin' | 'scopes'
>;

/** Every event kind a hook can listen to, in the order the Bureau documents them. */
export async function listHookEventKinds(options?: Options): Promise<HookEventKind[]> {
  const catalog = await bureauClient['bureau.events.catalog']({}, options);
  // The page reads the kind, what it is, where it comes from and what it can be scoped to.
  return catalog.events.map(({ kind, description, origin, scopes }) => ({
    kind,
    description,
    origin,
    scopes,
  }));
}
