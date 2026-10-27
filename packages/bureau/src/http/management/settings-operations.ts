/**
 * `bureau.settings.get`, `bureau.settings.schema`, `bureau.settings.update`, and
 * `bureau.settings.events`: the deployment's runtime settings through `Bureau.settings`
 * (COR-1710).
 *
 * Reading the settings, their schema, or their changes requires `bureau.settings:read`; changing
 * them requires `bureau.settings:write`. Settings are deployment-wide, so there is no owner who
 * reaches them without a scope. The principal that changed them is recorded on the
 * `settings.changed` audit record, with the keys and the new revision and never a value.
 *
 * | Outcome                               | Fault           | `data`                                  |
 * | ------------------------------------- | --------------- | --------------------------------------- |
 * | `expectedRevision` is not current     | `StaleRevision` | `expectedRevision`, `currentRevision`   |
 * | a patched key is locked               | `Unprocessable` | `reason: 'locked'`; the keys in `message` |
 * | a patched key is unknown              | `InvalidParams` | `issues`, one per key                   |
 * | a patched value is invalid            | `InvalidParams` | `issues`, one per key                   |
 *
 * @module settings-operations
 */

import { defineOperation, type OperationFault } from '@lostgradient/weft';
import { z } from 'zod';

import type { BureauSettings, SettingsChange } from '../../settings/types.ts';
import { ownerOfPrincipal } from '../owner-predicate.ts';
import { unaryTransports as transports, unknownKeyPolicy } from './management-schemas.ts';

/** What the settings operations read from the handler's `host`. */
export type BureauSettingsOperationHost = {
  readonly settings: BureauSettings;
};

const read = {
  kind: 'scoped',
  scopes: { kind: 'allOf', scopes: ['bureau.settings:read'] },
} as const;

const write = {
  kind: 'scoped',
  scopes: { kind: 'allOf', scopes: ['bureau.settings:write'] },
} as const;

const keyStateSchema = z.object({
  apply: z.enum(['live', 'restart']),
  locked: z.boolean(),
  pendingRestart: z.boolean(),
});

const snapshotSchema = z.object({
  /** Each key's value, by dotted key. */
  values: z.record(z.string(), z.unknown()),
  revision: z.number().int(),
  persisted: z.boolean(),
  keys: z.record(z.string(), keyStateSchema),
});

const getInput = z.object({});

export const settingsGetOperation = defineOperation<
  typeof getInput,
  typeof snapshotSchema,
  BureauSettingsOperationHost
>({
  name: 'bureau.settings.get',
  mcpExposable: false,
  summary: 'Read the runtime settings',
  description:
    'Returns every setting’s value by dotted key (the stored value, or the code option where none is stored or the key is locked), the record’s `revision` to pass back as `expectedRevision`, whether the record is `persisted` beyond the process, and per key how it applies (`live` or `restart`), whether the deployment `locked` it, and whether a stored `restart` value is `pendingRestart`. Requires `bureau.settings:read`.',
  destructive: false,
  tags: ['Settings'],
  inputSchema: getInput,
  outputSchema: snapshotSchema,
  producibleFaults: ['Forbidden'],
  access: read,
  discoverable: true,
  transports,
  unknownKeyPolicy,
  invoke: async ({ host }) => {
    const snapshot = await host.settings.get();
    return { ...snapshot, values: { ...snapshot.values }, keys: { ...snapshot.keys } };
  },
});

const schemaOutput = z.object({ schema: z.record(z.string(), z.unknown()) });

export const settingsSchemaOperation = defineOperation<
  typeof getInput,
  typeof schemaOutput,
  BureauSettingsOperationHost
>({
  name: 'bureau.settings.schema',
  mcpExposable: false,
  summary: 'Read the runtime settings’ JSON Schema',
  description:
    'Returns the settings as JSON Schema 2020-12: one optional property per dotted key, each with its description. Durations are milliseconds. Requires `bureau.settings:read`.',
  destructive: false,
  tags: ['Settings'],
  inputSchema: getInput,
  outputSchema: schemaOutput,
  producibleFaults: ['Forbidden'],
  access: read,
  discoverable: true,
  transports,
  unknownKeyPolicy,
  invoke: ({ host }) => Promise.resolve({ schema: host.settings.schema() }),
});

const updateInput = z.object({
  /** The keys to change, by dotted key. */
  patch: z.record(z.string(), z.unknown()),
  /** The revision the patch was written against. */
  expectedRevision: z.number().int().nonnegative(),
});

const updateOutput = z.object({
  revision: z.number().int(),
  /** The `restart` keys the change set, which apply at the next start. */
  pendingRestart: z.array(z.string()),
});

function invalidKeys(keys: readonly string[], message: string): OperationFault {
  return {
    code: 'InvalidParams',
    message,
    data: {
      issues: (keys.length === 0 ? ['patch'] : keys).map((key) => ({
        path: key === 'patch' && keys.length === 0 ? ['patch'] : ['patch', key],
        message,
        code: 'custom',
      })),
    },
  };
}

export const settingsUpdateOperation = defineOperation<
  typeof updateInput,
  typeof updateOutput,
  BureauSettingsOperationHost
>({
  name: 'bureau.settings.update',
  mcpExposable: false,
  summary: 'Change runtime settings',
  description:
    'Changes the keys in `patch`, all or none, and returns the new `revision` and the `restart` keys it set. A `live` key takes effect at its next point of use; a `restart` key at the next start. `expectedRevision` is compared with the stored record inside the write: a record that has changed since is a `StaleRevision` fault whose `currentRevision` is the revision now current, and nothing is written. A key the deployment locked is `Unprocessable` with reason `locked`; an unknown key or an invalid value is `InvalidParams`. The change is recorded as a `settings.changed` audit entry naming the keys and the revision, never a value. Requires `bureau.settings:write`.',
  destructive: true,
  tags: ['Settings'],
  inputSchema: updateInput,
  outputSchema: updateOutput,
  producibleFaults: ['InvalidParams', 'StaleRevision', 'Unprocessable', 'Forbidden'],
  access: write,
  discoverable: true,
  transports,
  unknownKeyPolicy,
  invoke: async ({ input, host, principal }) => {
    const owner = ownerOfPrincipal(principal);
    const result = await host.settings.update(input.patch, {
      expectedRevision: input.expectedRevision,
      ...(owner === undefined ? {} : { principal: owner }),
    });
    if (result.outcome === 'applied') {
      return { revision: result.revision, pendingRestart: [...result.pendingRestart] };
    }
    switch (result.reason) {
      case 'stale-revision':
        throw {
          code: 'StaleRevision',
          message: result.message,
          data: {
            expectedRevision: input.expectedRevision,
            currentRevision: result.currentRevision,
          },
        } satisfies OperationFault;
      case 'locked':
        throw {
          code: 'Unprocessable',
          message: result.message,
          data: { reason: 'locked' },
        } satisfies OperationFault;
      case 'unknown-key':
      case 'invalid-value':
        throw invalidKeys(result.keys, result.message);
    }
  },
});

const eventsInput = z.object({});

const eventsEnvelope = z.object({ subscriptionId: z.string() });

const changeSchema = z.object({
  revision: z.number().int(),
  keys: z.array(z.string()),
});

/** Buffers every change from subscription onward until `signal` aborts. */
function changesOf(
  settings: BureauSettings,
  signal: AbortSignal,
): AsyncIterable<z.infer<typeof changeSchema>> {
  const pending: SettingsChange[] = [];
  let wake: (() => void) | undefined;
  const unsubscribe = settings.subscribe((change) => {
    pending.push(change);
    wake?.();
  });
  // An aborted subscription stops listening whether or not it was ever iterated.
  const onAbort = () => {
    unsubscribe();
    wake?.();
  };
  signal.addEventListener('abort', onAbort, { once: true });
  return {
    async *[Symbol.asyncIterator]() {
      try {
        while (!signal.aborted) {
          const next = pending.shift();
          if (next !== undefined) {
            yield { revision: next.revision, keys: [...next.keys] };
            continue;
          }
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
          wake = undefined;
        }
      } finally {
        unsubscribe();
        signal.removeEventListener('abort', onAbort);
      }
    },
  };
}

let subscriptionCount = 0;

export const settingsEventsOperation = defineOperation<
  typeof eventsInput,
  typeof eventsEnvelope,
  typeof changeSchema,
  BureauSettingsOperationHost
>({
  name: 'bureau.settings.events',
  mcpExposable: false,
  kind: 'subscription',
  summary: 'Follow changes to the runtime settings',
  description:
    'Delivers one event per change this process applies from the moment of subscription, its own or one another process made and this one re-read on its maintenance pass: the new `revision` and the keys it changed, never their values. There is no replay; read `bureau.settings.get` for the current values. Requires `bureau.settings:read`.',
  destructive: false,
  tags: ['Settings'],
  inputSchema: eventsInput,
  outputSchema: eventsEnvelope,
  producibleFaults: ['Forbidden'],
  eventSchema: changeSchema,
  access: read,
  discoverable: true,
  // WebSocket only: with no replay there is no cursor for `Last-Event-ID` to resume from.
  transports: { http: false, jsonRpcHttp: false, jsonRpcWebSocket: true, jsonRpcStdio: false },
  unknownKeyPolicy,
  invoke: ({ host }) => {
    const controller = new AbortController();
    const iterable = changesOf(host.settings, controller.signal);
    subscriptionCount += 1;
    const close = () => {
      controller.abort();
      return Promise.resolve();
    };
    const subscriptionId = `settings-${subscriptionCount}`;
    return Promise.resolve({
      subscriptionId,
      envelope: { subscriptionId },
      iterable: Object.assign(iterable, { close }),
      close,
    });
  },
});

/** The operations of the `bureau.settings` namespace. */
export const bureauSettingsOperations = [
  settingsGetOperation,
  settingsSchemaOperation,
  settingsUpdateOperation,
  settingsEventsOperation,
] as const;
