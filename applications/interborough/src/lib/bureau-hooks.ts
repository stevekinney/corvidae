/**
 * The browser's view of the Bureau's hooks: `bureau.hooks.*` (COR-1939, COR-1940) and the event
 * catalog a hook chooses its events from (`bureau.events.catalog`), parsed at the boundary.
 *
 * A hook belongs to the principal that created it. When one of its events happens, its action runs:
 * a `webhook` sends the event, signed, to a URL; `start-workflow` starts a workflow; `notify` writes
 * the owner a notification. A hook of an action kind a plugin contributes reads as `plugin`. The
 * signing secret is write-only: it goes out with `create` or `update` and no answer carries it back.
 *
 * `update` names the revision of the hook the caller read, so a hook that changed since is refused
 * (`StaleRevision`) instead of being overwritten.
 */
import { z } from 'zod';

import { callBureau, type Fetcher } from './bureau-client.ts';

type Options = { readonly signal?: AbortSignal; readonly fetch?: Fetcher };

const actionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('webhook'), url: z.string() }),
  z.object({
    type: z.literal('start-workflow'),
    workflowId: z.string(),
    input: z.enum(['payload', 'event']),
  }),
  z.object({ type: z.literal('notify'), title: z.string().nullable() }),
  z.object({
    type: z.literal('plugin'),
    plugin: z.string(),
    kind: z.string(),
    configuration: z.unknown().optional(),
  }),
]);

/** What a hook does for each event, tagged by `type`. */
export type HookAction = z.infer<typeof actionSchema>;

/**
 * The built-in kinds of action a person can choose when writing a hook. The kinds running plugins
 * contribute are offered beside them (`bureau.plugins.kinds`) and written as a `plugin` action.
 */
export const HOOK_ACTION_TYPES = ['webhook', 'start-workflow', 'notify'] as const;

/** An action a person can write. */
export type HookActionType = (typeof HOOK_ACTION_TYPES)[number];

const hookSchema = z.object({
  id: z.string(),
  owner: z.string(),
  name: z.string().nullable(),
  action: actionSchema,
  events: z.array(z.string()),
  enabled: z.boolean(),
  createdAt: z.number(),
  updatedAt: z.number(),
  revision: z.number().int(),
});

/** One hook as `bureau.hooks.list`, `get`, `create` and `update` show it. */
export type Hook = z.infer<typeof hookSchema>;

const attemptSchema = z.object({
  number: z.number().int(),
  startedAt: z.number(),
  finishedAt: z.number().nullable(),
  outcome: z.enum([
    'sending',
    'response',
    'network-error',
    'interrupted',
    'refused',
    'completed',
    'rejected',
    'error',
  ]),
  status: z.number().int().nullable(),
  responseExcerpt: z.string().nullable(),
  responseTruncated: z.boolean().nullable(),
  error: z.string().nullable(),
});

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

const deliverySchema = z.object({
  id: z.string(),
  hookId: z.string(),
  actionType: z.enum(['webhook', 'start-workflow', 'notify', 'plugin']),
  kind: z.string(),
  test: z.boolean(),
  status: z.enum(HOOK_DELIVERY_STATUSES),
  request: z.object({ url: z.string() }).nullable(),
  attempts: z.array(attemptSchema),
  maxAttempts: z.number().int(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

/** One delivery of one event to a hook: where it stands and every attempt made. */
export type HookDelivery = z.infer<typeof deliverySchema>;

/** The caller's hooks, oldest first. */
export async function listHooks(options?: Options): Promise<Hook[]> {
  const answer = z
    .object({ hooks: z.array(hookSchema) })
    .parse(await callBureau('bureau.hooks.list', {}, options));
  return answer.hooks;
}

/** One hook by its identifier; a hook that is not the caller's is `NotFound`. */
export async function getHook(hookId: string, options?: Options): Promise<Hook> {
  return hookSchema.parse(await callBureau('bureau.hooks.get', { hookId }, options));
}

/** What a hook is written from. */
export type HookInput = {
  /** A label for the list; 1 to 100 characters. */
  readonly name?: string;
  /** The event kinds the hook listens to; at least one, at most 64. */
  readonly events: readonly string[];
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
  /** The secret a webhook is signed with, 16 to 256 characters. Sealed on arrival and never returned. */
  readonly signingSecret?: string;
  /** Whether the hook fires; on unless said. */
  readonly enabled?: boolean;
};

/** Creates a hook the caller owns. */
export async function createHook(input: HookInput, options?: Options): Promise<Hook> {
  return hookSchema.parse(await callBureau('bureau.hooks.create', input, options));
}

/** What `update` changes; a field left out stays. A `null` name removes it. */
export type HookChange = {
  /** A new label, or `null` to remove it. */
  readonly name?: string | null;
  /** The new event kinds, replacing the list. */
  readonly events?: readonly string[];
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
  return hookSchema.parse(
    await callBureau('bureau.hooks.update', { hookId, expectedRevision, ...change }, options),
  );
}

/** Deletes a hook, its secret and its delivery records. */
export async function deleteHook(hookId: string, options?: Options): Promise<void> {
  await callBureau('bureau.hooks.delete', { hookId }, options);
}

/**
 * Sends one signed test message to a webhook hook and answers its record once the one attempt has
 * ended. The Bureau refuses a hook of any other action, because a test would start a real run or
 * write a real notification.
 */
export async function testHook(hookId: string, options?: Options): Promise<HookDelivery> {
  return deliverySchema.parse(await callBureau('bureau.hooks.test', { hookId }, options));
}

/** The newest deliveries of a hook, newest first, at most `limit`. */
export async function listHookDeliveries(
  hookId: string,
  limit: number,
  options?: Options,
): Promise<HookDelivery[]> {
  const answer = z
    .object({ deliveries: z.array(deliverySchema) })
    .parse(await callBureau('bureau.hooks.deliveries', { hookId, limit }, options));
  return answer.deliveries;
}

const catalogSchema = z.object({
  events: z.array(
    z.object({
      kind: z.string(),
      description: z.string(),
      origin: z.enum(['run', 'external', 'unattributed']),
    }),
  ),
});

/** One event kind a hook can listen to, with what the Bureau says about it. */
export type HookEventKind = z.infer<typeof catalogSchema>['events'][number];

/** Every event kind a hook can listen to, in the order the Bureau documents them. */
export async function listHookEventKinds(options?: Options): Promise<HookEventKind[]> {
  return catalogSchema.parse(await callBureau('bureau.events.catalog', {}, options)).events;
}
