/**
 * `bureau.events.catalog` (COR-1940): the published Bureau event kinds, each with a description and
 * the shape of its payload. It is what a person choosing the `events` of a hook reads, and what a
 * `start-workflow` hook's input looks like. It lists exactly `PUBLISHED_BUREAU_EVENT_KINDS` (a test
 * holds it to that), which are the kinds `bureau.events` serves and a hook may list.
 *
 * It is read-only and static: it describes kinds, not events, and returns nothing a caller could
 * not learn from the operation catalog, so any authenticated caller may read it.
 *
 * @module events-catalog-operation
 */

import { defineOperation } from '@lostgradient/weft';
import { z } from 'zod';

import { bureauEventCatalog } from '../../bureau-event-catalog.ts';
import { HOOK_SCOPE_KINDS } from '../../hooks/hook-types.ts';
import { unaryTransports as transports, unknownKeyPolicy } from './management-schemas.ts';

const catalogInput = z.object({});

const catalogOutput = z.object({
  events: z
    .array(
      z.object({
        kind: z.string().describe('The kind, as a hook’s `events` and `bureau.events` name it.'),
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
      }),
    )
    .describe('Every published kind, in the order `bureau.events` documents them.'),
});

export const eventsCatalogOperation = defineOperation<
  typeof catalogInput,
  typeof catalogOutput,
  object
>({
  name: 'bureau.events.catalog',
  mcpExposable: false,
  summary: 'List the published event kinds',
  description:
    'Lists every Bureau event kind that `bureau.events` serves and a hook may match, each with a description, its origin (`run`, `external` or `unattributed`, which decides whether a `start-workflow` hook may list it) the fields of its `payload`, and its `scopes`, the kinds of subject (`agent`, `workflow`, `schedule`) a hook that lists it may be scoped to. It lists exactly the published kinds: a kind the Bureau publishes is described here. Weft’s own events are not part of it: the feed carries Weft’s `ScheduleMissedFire` as `schedule.missed` and nothing else of Weft’s. Read-only and static; any authenticated caller may read it.',
  destructive: false,
  tags: ['Events'],
  inputSchema: catalogInput,
  outputSchema: catalogOutput,
  producibleFaults: [],
  access: { kind: 'authenticated' },
  discoverable: true,
  transports,
  unknownKeyPolicy,
  invoke: () =>
    Promise.resolve({
      events: bureauEventCatalog().map((entry) => ({
        kind: entry.kind,
        description: entry.description,
        origin: entry.origin,
        payload: entry.payload.map((field) => ({ ...field })),
        scopes: [...entry.scopes],
      })),
    }),
});
