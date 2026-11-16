import { authorizeWorkspaceOperation } from '../workspace-authorization.ts';

/**
 * `bureau.events.catalog` (COR-1940): the published Bureau event kinds, each with a description and
 * the shape of its payload. It is what a person choosing the `events` of a hook reads, and what a
 * `start-workflow` hook's input looks like. It starts with exactly `PUBLISHED_BUREAU_EVENT_KINDS`
 * (a test holds that part to it), which are the kinds `bureau.events` serves and a hook may list.
 * After them come the kinds the running plugins declare (COR-2223), each `plugin:name` with its
 * `source`: they are described here, but nothing publishes them yet, and a hook may not list one.
 *
 * It is read-only: it describes kinds, not events, and returns nothing a caller could not learn
 * from the operation catalog and the plugins that are running, so any authenticated caller may
 * read it.
 *
 * @module events-catalog-operation
 */

import { defineOperation } from '@lostgradient/weft';
import { z } from 'zod';

import { bureauEventCatalog } from '../../bureau-event-catalog.ts';
import { HOOK_SCOPE_KINDS } from '../../hooks/hook-types.ts';
import type { BureauPlugins } from '../../plugins/plugin-types.ts';
import { unaryTransports as transports, unknownKeyPolicy } from './management-schemas.ts';

/** What `bureau.events.catalog` reads from the handler's `host`: the kinds running plugins declare. */
export type BureauEventsCatalogOperationHost = {
  readonly plugins: Pick<BureauPlugins, 'events'>;
};

const catalogInput = z.object({});

const catalogOutput = z.object({
  events: z
    .array(
      z.object({
        kind: z
          .string()
          .describe(
            'The kind, as a hook’s `events` and `bureau.events` name it; `plugin:name` for a kind a plugin declares.',
          ),
        description: z.string().describe('What the event means and when it is published.'),
        origin: z
          .enum(['run', 'external', 'unattributed'])
          .describe(
            'Where the event can come from. A `start-workflow` hook may list `run` kinds (the payload names a run) and `external` kinds (a short allowlist that no run can cause: `schedule.missed`, `bureau.disposed`), never `unattributed` ones, which is every other kind and the default for a new one.',
          ),
        payload: z
          .array(
            z.object({
              name: z.string().describe('The key in the event’s `payload`.'),
              type: z.enum(['string', 'number', 'boolean', 'string[]', 'object', 'unknown']),
              optional: z
                .boolean()
                .describe('Whether the payload leaves the field out for some events of the kind.'),
            }),
          )
          .describe('The fields of the event’s `payload`.'),
        scopes: z
          .array(z.enum(HOOK_SCOPE_KINDS))
          .describe(
            'The kinds of subject a hook that lists this kind may be scoped to; empty for a kind that is about no one subject.',
          ),
        source: z
          .string()
          .optional()
          .describe(
            'The plugin that declares the kind (its `plugin:name` kind belongs to it); absent for a kind the Bureau itself publishes.',
          ),
      }),
    )
    .describe(
      'Every kind the Bureau publishes, in the order `bureau.events` documents them, then the kinds the running plugins declare, in load order.',
    ),
});

export const eventsCatalogOperation = defineOperation<
  typeof catalogInput,
  typeof catalogOutput,
  BureauEventsCatalogOperationHost
>({
  name: 'bureau.events.catalog',
  authorize: authorizeWorkspaceOperation('bureau.events.catalog'),
  mcpExposable: false,
  summary: 'List the published event kinds',
  description:
    'Lists the Bureau’s published event kinds, which `bureau.events` serves and a hook may match, each with a description, its origin (`run`, `external` or `unattributed`, which decides whether a `start-workflow` hook may list it) the fields of its `payload`, and its `scopes`, the kinds of subject (`agent`, `workflow`, `schedule`) a hook that lists it may be scoped to. Every kind the Bureau publishes is described here, in that order. After them come the kinds the running plugins declare, each `plugin:name` with the plugin as its `source`, its payload fields, the origin `unattributed` and no scopes; these are declarations only, which `bureau.events` does not serve and a hook may not yet list. Weft’s own events are not part of it: the feed carries Weft’s `ScheduleMissedFire` as `schedule.missed` and nothing else of Weft’s. Read-only; any authenticated caller may read it.',
  destructive: false,
  tags: ['Events'],
  inputSchema: catalogInput,
  outputSchema: catalogOutput,
  producibleFaults: [],
  access: { kind: 'authenticated' },
  discoverable: true,
  transports,
  unknownKeyPolicy,
  invoke: ({ host }) =>
    Promise.resolve({
      events: [
        ...bureauEventCatalog().map((entry) => ({
          kind: entry.kind,
          description: entry.description,
          origin: entry.origin,
          payload: entry.payload.map((field) => ({ ...field })),
          scopes: [...entry.scopes],
        })),
        // A declared kind is `unattributed` with no scopes: nothing on it leads back to a run, so
        // a `start-workflow` hook cannot list it, and no scope can tell its events apart.
        ...host.plugins.events().map((declared) => ({
          kind: declared.kind,
          description: declared.description,
          origin: 'unattributed' as const,
          payload: declared.payload.map((field) => ({ ...field })),
          scopes: [],
          source: declared.plugin,
        })),
      ],
    }),
});
