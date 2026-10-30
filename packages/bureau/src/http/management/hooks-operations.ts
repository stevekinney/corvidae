/**
 * `bureau.hooks.*` (COR-1939): user-defined hooks over the Bureau's published events, through
 * `Bureau.hooks`. A hook POSTs each matching event to its URL, signed with a secret the caller
 * chose (`X-Signature`, `hook-signature.ts`), and keeps every delivery's request, response excerpt
 * and attempts on a record.
 *
 * A hook belongs to the principal that created it. A caller reads, changes, tests and deletes its
 * own hooks, and reads their deliveries, without any scope; `bureau.hooks:read` grants every
 * owner's to `list`, `get` and `deliveries`, and `bureau.hooks:write` grants every owner's to
 * `update`, `delete` and `test`. Neither implies the other. A caller who may not see a hook is
 * answered as for a missing one. The owner comes from the caller's credential and never from a
 * payload.
 *
 * A hook observes the whole Bureau's events, as `bureau.events` does, so anything that sets or
 * widens what it reaches also requires `bureau.events:observe-all`: creating one, and an update that
 * sets `url` (the events go wherever the URL points, so re-pointing a hook is reading them), sets
 * `events`, or enables the hook. `test` does not: it sends a fixed message, never an event.
 * The scope is checked against the caller on every such call, not against the hook's creator, so a
 * key holding only `bureau.hooks:write` (or an owner whose scope was withdrawn) cannot turn an
 * existing fleet-wide hook into a reader of its own.
 *
 * The signing secret is a write-only input of `create` and `update`: no operation, record, log or
 * audit entry returns it. A host that keeps secrets elsewhere (a remote home) refuses a write of
 * one with `Forbidden`, `data: { reason: 'deployment' }`.
 *
 * @module hooks-operations
 */

import { defineOperation, type OperationFault, type Principal } from '@lostgradient/weft';
import { z } from 'zod';

import { PUBLISHED_BUREAU_EVENT_KINDS } from '../../bureau-event-feed.ts';
import {
  type BureauHooks,
  HOOK_SECRET_MAXIMUM_LENGTH,
  HOOK_SECRET_MINIMUM_LENGTH,
} from '../../hooks/create-hooks.ts';
import { type Hook, type HookDelivery, HookError } from '../../hooks/hook-types.ts';
import type { BureauScope } from '../bureau-scopes.ts';
import { type BureauOwnershipHost, ownerOfPrincipal } from '../owner-predicate.ts';
import {
  resourceNotFound,
  unaryTransports as transports,
  unknownKeyPolicy,
} from './management-schemas.ts';

/** What the hooks operations read from the handler's `host`. */
export type BureauHooksOperationHost = BureauOwnershipHost & {
  readonly hooks: BureauHooks | undefined;
};

const hookId = z.string().min(1).max(256).describe('The identifier of the hook.');

const eventKinds = z
  .array(z.enum(PUBLISHED_BUREAU_EVENT_KINDS))
  .min(1)
  .max(64)
  .describe(
    'The published Bureau event kinds the hook fires on, the kinds `bureau.events` serves. A hook cannot list `hook.test`: only `bureau.hooks.test` sends it.',
  );

const urlField = z
  .string()
  .min(1)
  .max(2048)
  .describe(
    'Where each delivery is POSTed: http or https, with no user name, password or fragment. Link-local (including the cloud metadata address), unspecified and multicast addresses are always refused; loopback and private-network addresses are allowed unless the deployment refuses them. Redirects are never followed.',
  );

const signingSecret = z
  .string()
  .min(HOOK_SECRET_MINIMUM_LENGTH)
  .max(HOOK_SECRET_MAXIMUM_LENGTH)
  .describe(
    'The secret deliveries are signed with, 16 to 256 characters. Write-only: it is sealed on arrival and no operation returns it.',
  );

const hookSchema = z.object({
  id: z.string(),
  owner: z.string().describe('The principal that owns the hook.'),
  name: z.string().nullable(),
  url: z.string(),
  events: z.array(z.string()),
  enabled: z.boolean(),
  createdAt: z.number().describe('Epoch milliseconds.'),
  updatedAt: z.number().describe('Epoch milliseconds.'),
  revision: z.number().int().describe('Pass it back as `expectedRevision`.'),
});

const attemptSchema = z.object({
  number: z.number().int(),
  startedAt: z.number(),
  finishedAt: z.number().nullable(),
  outcome: z.enum(['sending', 'response', 'network-error', 'interrupted', 'refused']),
  status: z.number().int().nullable(),
  responseExcerpt: z.string().nullable(),
  responseTruncated: z.boolean().nullable(),
  error: z.string().nullable(),
});

const deliverySchema = z.object({
  id: z.string(),
  hookId: z.string(),
  owner: z.string(),
  kind: z.string(),
  test: z.boolean(),
  status: z.enum(['pending', 'delivered', 'exhausted', 'aborted', 'failed-secret']),
  request: z.object({
    url: z.string(),
    headers: z.record(z.string(), z.string()),
    body: z.string(),
  }),
  attempts: z.array(attemptSchema),
  maxAttempts: z.number().int(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

function hookViewOf(hook: Hook): z.infer<typeof hookSchema> {
  return {
    id: hook.id,
    owner: hook.owner,
    name: hook.name ?? null,
    url: hook.url,
    events: [...hook.events],
    enabled: hook.enabled,
    createdAt: hook.createdAt,
    updatedAt: hook.updatedAt,
    revision: hook.revision,
  };
}

function deliveryViewOf(delivery: HookDelivery): z.infer<typeof deliverySchema> {
  return {
    id: delivery.id,
    hookId: delivery.hookId,
    owner: delivery.owner,
    kind: delivery.kind,
    test: delivery.test,
    status: delivery.status,
    request: {
      url: delivery.request.url,
      headers: { ...delivery.request.headers },
      body: delivery.request.body,
    },
    attempts: delivery.attempts.map((attempt) => ({
      number: attempt.number,
      startedAt: attempt.startedAt,
      finishedAt: attempt.finishedAt ?? null,
      outcome: attempt.outcome,
      status: attempt.status ?? null,
      responseExcerpt: attempt.responseExcerpt ?? null,
      responseTruncated: attempt.responseTruncated ?? null,
      error: attempt.error ?? null,
    })),
    maxAttempts: delivery.maxAttempts,
    createdAt: delivery.createdAt,
    updatedAt: delivery.updatedAt,
  };
}

function unsupported(): OperationFault {
  return {
    code: 'UnsupportedCapability',
    message: 'This Bureau has no hooks',
    data: { capability: 'hooks' },
  };
}

/** The fault a refused hooks call is answered with, or rethrows `error`. */
function faultOf(error: unknown): never {
  if (!(error instanceof HookError)) throw error;
  switch (error.code) {
    case 'not-found':
      throw resourceNotFound('hook', 'unknown');
    case 'invalid':
      throw {
        code: 'InvalidParams',
        message: error.message,
        data: {
          issues: error.issues.map((issue) => ({
            path: [...issue.path],
            message: issue.message,
            code: 'custom',
          })),
        },
      } satisfies OperationFault;
    case 'stale-revision':
      throw {
        code: 'StaleRevision',
        message: error.message,
        data: { currentRevision: error.currentRevision ?? 0 },
      } satisfies OperationFault;
    case 'locked':
      throw {
        code: 'Forbidden',
        message: error.message,
        data: { reason: error.lockReason ?? 'deployment' },
      } satisfies OperationFault;
    case 'no-encryption':
      throw {
        code: 'UnsupportedCapability',
        message: error.message,
        data: { capability: 'encryption' },
      } satisfies OperationFault;
    case 'secret-unavailable':
      throw {
        code: 'Unprocessable',
        message: error.message,
        data: { reason: 'secret-unavailable' },
      } satisfies OperationFault;
  }
}

function holds(principal: Principal, scope: BureauScope): boolean {
  return principal.method !== 'unauthenticated' && principal.hasScope(scope);
}

/** The principal string recorded as the actor of an audit entry, or `undefined` when it names none. */
function actorOf(principal: Principal): string | undefined {
  return ownerOfPrincipal(principal);
}

/** The principal's owner string, or the fault for a credential that names none. */
function ownerFor(principal: Principal): string {
  const owner = ownerOfPrincipal(principal);
  if (owner === undefined) {
    throw {
      code: 'Forbidden',
      message: 'A hook needs an owner, and this credential names none',
      data: { reason: 'no owner of record' },
    } satisfies OperationFault;
  }
  return owner;
}

function requireObserveAll(principal: Principal): void {
  if (!holds(principal, 'bureau.events:observe-all')) {
    throw {
      code: 'Forbidden',
      message:
        'A hook observes the whole Bureau’s events, which requires bureau.events:observe-all',
      data: { reason: 'missing scope bureau.events:observe-all' },
    } satisfies OperationFault;
  }
}

/**
 * The hook `id` when `principal` may use `operatorScope` on it (it owns it, or holds the scope),
 * and `NotFound` otherwise.
 */
async function hookFor(
  host: BureauHooksOperationHost,
  principal: Principal,
  id: string,
  operatorScope: BureauScope,
): Promise<{ readonly hooks: BureauHooks; readonly hook: Hook }> {
  if (host.hooks === undefined) throw unsupported();
  const hook = await host.hooks.get(id);
  if (
    hook === undefined ||
    !host.ownership.mayAccess({ principal, resourceOwner: hook.owner, operatorScope })
  ) {
    throw resourceNotFound('hook', id);
  }
  return { hooks: host.hooks, hook };
}

const createInput = z.object({
  url: urlField,
  events: eventKinds,
  signingSecret,
  name: z.string().min(1).max(100).optional().describe('A label, 1 to 100 characters.'),
  enabled: z.boolean().optional().describe('Whether the hook fires. Defaults to `true`.'),
});

export const hooksCreateOperation = defineOperation<
  typeof createInput,
  typeof hookSchema,
  BureauHooksOperationHost
>({
  name: 'bureau.hooks.create',
  mcpExposable: false,
  summary: 'Create a hook',
  description:
    'Creates a hook owned by the caller: when a published Bureau event of one of `events` happens, `url` is sent a POST whose body is `{ id, hookId, kind, bureauId, emittedAtMs, test, payload }` and whose `X-Signature` header (`t=<unix seconds>,v1=<hex>`, an HMAC-SHA256 of `<t>.<body>` under `signingSecret`) lets the receiver verify it; a delivery that fails is retried with backoff and resumed after a restart, and its request, response excerpt and attempts are kept (`bureau.hooks.deliveries`). `signingSecret` is write-only and is never returned. The caller needs no scope to own a hook, but needs `bureau.events:observe-all`, because a hook observes the whole Bureau’s events. An unacceptable URL, event list or secret is `InvalidParams`. A deployment that keeps secrets elsewhere refuses with `Forbidden` (`data.reason: "deployment"`). A Bureau without hooks, or without an encryption key, answers `UnsupportedCapability`.',
  destructive: false,
  tags: ['Hooks'],
  inputSchema: createInput,
  outputSchema: hookSchema,
  producibleFaults: ['InvalidParams', 'Forbidden', 'UnsupportedCapability'],
  access: { kind: 'authenticated' },
  discoverable: true,
  transports,
  unknownKeyPolicy,
  invoke: async ({ input, host, principal }) => {
    const owner = ownerFor(principal);
    requireObserveAll(principal);
    if (host.hooks === undefined) throw unsupported();
    try {
      return hookViewOf(
        await host.hooks.create({
          url: input.url,
          events: input.events,
          signingSecret: input.signingSecret,
          principal: owner,
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
        }),
      );
    } catch (error) {
      return faultOf(error);
    }
  },
});

const updateInput = z.object({
  hookId,
  url: urlField.optional(),
  events: eventKinds.optional(),
  signingSecret: signingSecret.optional(),
  name: z
    .string()
    .min(1)
    .max(100)
    .nullable()
    .optional()
    .describe('A new label, or `null` to remove it.'),
  enabled: z.boolean().optional().describe('Enable or disable the hook.'),
  expectedRevision: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Apply the change only if the hook is still at this `revision`.'),
});

export const hooksUpdateOperation = defineOperation<
  typeof updateInput,
  typeof hookSchema,
  BureauHooksOperationHost
>({
  name: 'bureau.hooks.update',
  mcpExposable: false,
  summary: 'Change a hook',
  description:
    'Changes the fields given and leaves the rest: `url`, `events` (replacing the list), `signingSecret` (replacing the secret; write-only, never returned), `name` (`null` removes it) and `enabled`. A caller changes its own hooks without a scope; `bureau.hooks:write` changes any owner’s, and anyone else is answered `NotFound`. Setting `url`, setting `events`, or setting `enabled: true` also requires `bureau.events:observe-all` of the caller, because each decides where the whole Bureau’s events go (renaming, replacing the secret and disabling do not). `expectedRevision`, when given, is compared inside the write: a hook that has changed since is a `StaleRevision` fault whose `currentRevision` is the revision now current. Faults for the URL, events and secret are those of `bureau.hooks.create`.',
  destructive: false,
  tags: ['Hooks'],
  inputSchema: updateInput,
  outputSchema: hookSchema,
  producibleFaults: [
    'InvalidParams',
    'Forbidden',
    'NotFound',
    'StaleRevision',
    'UnsupportedCapability',
  ],
  access: { kind: 'authenticated' },
  discoverable: true,
  transports,
  unknownKeyPolicy,
  invoke: async ({ input, host, principal }) => {
    const { hooks } = await hookFor(host, principal, input.hookId, 'bureau.hooks:write');
    // Where the whole Bureau's events go is decided by the url, the kinds, and whether the hook
    // fires at all, so the caller needs the scope for each of them, whoever created the hook.
    if (input.url !== undefined || input.events !== undefined || input.enabled === true) {
      requireObserveAll(principal);
    }
    const actor = actorOf(principal);
    try {
      const updated = await hooks.update(input.hookId, {
        ...(actor === undefined ? {} : { principal: actor }),
        ...(input.url === undefined ? {} : { url: input.url }),
        ...(input.events === undefined ? {} : { events: input.events }),
        ...(input.signingSecret === undefined ? {} : { signingSecret: input.signingSecret }),
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
        ...(input.expectedRevision === undefined
          ? {}
          : { expectedRevision: input.expectedRevision }),
      });
      if (updated === undefined) throw resourceNotFound('hook', input.hookId);
      return hookViewOf(updated);
    } catch (error) {
      return faultOf(error);
    }
  },
});

const idInput = z.object({ hookId });

export const hooksDeleteOperation = defineOperation<
  typeof idInput,
  z.ZodObject<{ hookId: z.ZodString; deleted: z.ZodBoolean }>,
  BureauHooksOperationHost
>({
  name: 'bureau.hooks.delete',
  mcpExposable: false,
  summary: 'Delete a hook',
  description:
    'Deletes one of the caller’s hooks, its sealed signing secret and its delivery records; `bureau.hooks:write` deletes any owner’s, and anyone else is answered `NotFound`. A delivery in flight stops at its next attempt. Answers `{ hookId, deleted: true }`.',
  destructive: true,
  tags: ['Hooks'],
  inputSchema: idInput,
  outputSchema: z.object({ hookId: z.string(), deleted: z.boolean() }),
  producibleFaults: ['NotFound', 'UnsupportedCapability'],
  access: { kind: 'authenticated' },
  discoverable: true,
  transports,
  unknownKeyPolicy,
  invoke: async ({ input, host, principal }) => {
    const { hooks } = await hookFor(host, principal, input.hookId, 'bureau.hooks:write');
    const actor = actorOf(principal);
    const deleted = await hooks.delete(
      input.hookId,
      actor === undefined ? {} : { principal: actor },
    );
    if (!deleted) throw resourceNotFound('hook', input.hookId);
    return { hookId: input.hookId, deleted };
  },
});

export const hooksGetOperation = defineOperation<
  typeof idInput,
  typeof hookSchema,
  BureauHooksOperationHost
>({
  name: 'bureau.hooks.get',
  mcpExposable: false,
  summary: 'Read a hook',
  description:
    'Returns one of the caller’s hooks; a caller holding `bureau.hooks:read` reads any owner’s. Another owner’s hook answers as a missing one does. The signing secret is never part of the answer.',
  destructive: false,
  tags: ['Hooks'],
  inputSchema: idInput,
  outputSchema: hookSchema,
  producibleFaults: ['NotFound', 'UnsupportedCapability'],
  access: { kind: 'authenticated' },
  discoverable: true,
  transports,
  unknownKeyPolicy,
  invoke: async ({ input, host, principal }) => {
    const { hook } = await hookFor(host, principal, input.hookId, 'bureau.hooks:read');
    return hookViewOf(hook);
  },
});

const listInput = z.object({});

export const hooksListOperation = defineOperation<
  typeof listInput,
  z.ZodObject<{ hooks: z.ZodArray<typeof hookSchema> }>,
  BureauHooksOperationHost
>({
  name: 'bureau.hooks.list',
  mcpExposable: false,
  summary: 'List hooks',
  description:
    'Lists the caller’s own hooks, oldest first; a caller holding `bureau.hooks:read` lists every owner’s. The signing secret is never part of the answer.',
  destructive: false,
  tags: ['Hooks'],
  inputSchema: listInput,
  outputSchema: z.object({ hooks: z.array(hookSchema) }),
  producibleFaults: ['Forbidden', 'UnsupportedCapability'],
  access: { kind: 'authenticated' },
  discoverable: true,
  transports,
  unknownKeyPolicy,
  invoke: async ({ host, principal }) => {
    if (host.hooks === undefined) throw unsupported();
    const everyOwner = holds(principal, 'bureau.hooks:read');
    const owner = everyOwner ? undefined : ownerFor(principal);
    const listed = await host.hooks.list(owner === undefined ? {} : { owner });
    return { hooks: listed.map(hookViewOf) };
  },
});

export const hooksTestOperation = defineOperation<
  typeof idInput,
  typeof deliverySchema,
  BureauHooksOperationHost
>({
  name: 'bureau.hooks.test',
  mcpExposable: false,
  summary: 'Send a test delivery',
  description:
    'Sends one signed `hook.test` delivery to the hook, with one attempt and no retry, and answers its record once the attempt has ended: the request, the response status and a bounded excerpt of the response, or the error. It works on a disabled hook and sends a fixed message, never an event, so it needs no `bureau.events:observe-all`. A caller tests its own hooks; `bureau.hooks:write` tests any owner’s. A failed delivery is an answer (`status: "exhausted"`), not a fault.',
  destructive: false,
  tags: ['Hooks'],
  inputSchema: idInput,
  outputSchema: deliverySchema,
  producibleFaults: ['NotFound', 'UnsupportedCapability'],
  access: { kind: 'authenticated' },
  discoverable: true,
  transports,
  unknownKeyPolicy,
  invoke: async ({ input, host, principal }) => {
    const { hooks } = await hookFor(host, principal, input.hookId, 'bureau.hooks:write');
    const actor = actorOf(principal);
    const delivery = await hooks.test(
      input.hookId,
      actor === undefined ? {} : { principal: actor },
    );
    if (delivery === undefined) throw resourceNotFound('hook', input.hookId);
    return deliveryViewOf(delivery);
  },
});

const deliveriesInput = z.object({
  hookId,
  limit: z
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .describe('At most this many, 1 to 200. Defaults to 50.'),
});

export const hooksDeliveriesOperation = defineOperation<
  typeof deliveriesInput,
  z.ZodObject<{ deliveries: z.ZodArray<typeof deliverySchema> }>,
  BureauHooksOperationHost
>({
  name: 'bureau.hooks.deliveries',
  mcpExposable: false,
  summary: 'List a hook’s deliveries',
  description:
    'Lists a hook’s deliveries, newest first: each carries the request that was sent (without its signature), every attempt with its response status and a bounded excerpt of the response (at most 1024 bytes), and its status (`pending`, `delivered`, `exhausted`, `aborted` or `failed-secret`). A caller reads its own hooks’ deliveries; `bureau.hooks:read` reads any owner’s. A pending delivery is resumed after a restart.',
  destructive: false,
  tags: ['Hooks'],
  inputSchema: deliveriesInput,
  outputSchema: z.object({ deliveries: z.array(deliverySchema) }),
  producibleFaults: ['NotFound', 'UnsupportedCapability'],
  access: { kind: 'authenticated' },
  discoverable: true,
  transports,
  unknownKeyPolicy,
  invoke: async ({ input, host, principal }) => {
    const { hooks } = await hookFor(host, principal, input.hookId, 'bureau.hooks:read');
    const listed = await hooks.deliveries(
      input.hookId,
      input.limit === undefined ? {} : { limit: input.limit },
    );
    return { deliveries: listed.map(deliveryViewOf) };
  },
});

/** The seven `bureau.hooks.*` operations. */
export const bureauHooksOperations = [
  hooksCreateOperation,
  hooksUpdateOperation,
  hooksDeleteOperation,
  hooksGetOperation,
  hooksListOperation,
  hooksTestOperation,
  hooksDeliveriesOperation,
] as const;
