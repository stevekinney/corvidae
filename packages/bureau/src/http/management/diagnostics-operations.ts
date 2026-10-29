/**
 * `bureau.diagnostics.get`: what the Bureau is holding right now (COR-1731), through
 * `Bureau.internals.diagnostics()`.
 *
 * It requires `bureau.diagnostics:read`. The reading is deployment-wide, so there is no owner who
 * reaches it without the scope. It carries counts, statuses, and timestamps, and one scan error
 * message per definition source: never an identifier of a run, review, or agent, a message, a
 * credential, a file's contents, or an error's stack.
 *
 * @module diagnostics-operations
 */

import { defineOperation } from '@lostgradient/weft';
import { z } from 'zod';

import type { BureauDiagnostics } from '../../types.ts';
import { unaryTransports as transports, unknownKeyPolicy } from './management-schemas.ts';

/** What the diagnostics operation reads from the handler's `host`. */
export type BureauDiagnosticsOperationHost = {
  readonly diagnostics: {
    /** The Bureau's `internals.diagnostics()`, read at the moment of the call. */
    readonly snapshot: () => BureauDiagnostics;
  };
};

const getInput = z.object({});

const getOutput = z.object({
  recovery: z
    .object({
      status: z
        .enum(['pending', 'clean', 'partial', 'failed'])
        .describe(
          'How boot recovery ended: `pending` while a deferred recovery has not finished, otherwise the pass’s outcome.',
        ),
      failedRunCount: z
        .number()
        .int()
        .nonnegative()
        .describe('How many runs the recovery pass cancelled.'),
    })
    .describe('The boot recovery pass.'),
  lifecycle: z
    .enum(['ready', 'draining', 'stopped'])
    .describe('The Bureau’s lifecycle: `draining` once shutdown has closed admission.'),
  liveFrameSubscriberCount: z
    .number()
    .int()
    .nonnegative()
    .describe('How many in-process live-frame listeners are subscribed.'),
  eventFeedSubscriberCount: z
    .number()
    .int()
    .nonnegative()
    .describe('How many live subscriptions the Bureau’s event feed holds.'),
  watchers: z
    .array(
      z.object({
        source: z
          .enum(['agents', 'workflows'])
          .describe('Which definition source the watcher reads.'),
        lastScanAt: z
          .number()
          .int()
          .nullable()
          .describe(
            'When the last scan finished, in epoch milliseconds; `null` before the first scan finishes.',
          ),
        lastScanError: z
          .string()
          .nullable()
          .describe(
            'The message of the error the last scan failed with; `null` when it succeeded or none has finished.',
          ),
      }),
    )
    .describe('One entry per configured definition source (agents, then workflows).'),
  modelCatalogRevision: z
    .number()
    .int()
    .nonnegative()
    .describe('The model catalog’s revision: 1 at boot, plus one for each replace.'),
  runningRunCount: z
    .number()
    .int()
    .nonnegative()
    .describe('How many runs this process is executing.'),
  abortingRunCount: z
    .number()
    .int()
    .nonnegative()
    .describe('How many runs have a requested cancellation that has not yet settled.'),
  pendingReviewCount: z
    .number()
    .int()
    .nonnegative()
    .describe('How many reviews await a human decision.'),
});

export const diagnosticsGetOperation = defineOperation<
  typeof getInput,
  typeof getOutput,
  BureauDiagnosticsOperationHost
>({
  name: 'bureau.diagnostics.get',
  mcpExposable: false,
  summary: 'Read the Bureau’s diagnostics',
  description:
    'Returns a point-in-time reading of what the Bureau is holding: the boot `recovery` outcome (`status`, `failedRunCount`), the `lifecycle`, the `liveFrameSubscriberCount` and `eventFeedSubscriberCount`, one `watchers` entry per configured definition source (`lastScanAt`, and the `lastScanError` message of a scan that failed), the `modelCatalogRevision`, and the `runningRunCount`, `abortingRunCount`, and `pendingReviewCount`. It carries counts, statuses, and timestamps only, never an identifier of a run, review, or agent, a message, a credential, a file’s contents, or a stack. Requires `bureau.diagnostics:read`.',
  destructive: false,
  tags: ['Deployment'],
  inputSchema: getInput,
  outputSchema: getOutput,
  producibleFaults: ['Forbidden'],
  access: { kind: 'scoped', scopes: { kind: 'allOf', scopes: ['bureau.diagnostics:read'] } },
  discoverable: true,
  transports,
  unknownKeyPolicy,
  invoke: ({ host }) => {
    const reading = host.diagnostics.snapshot();
    // Built field by field: the wire carries exactly the fields named here, and a field added to
    // the in-process reading reaches no caller until it is added here and in the schema above.
    return Promise.resolve({
      recovery: {
        status: reading.recovery.status,
        failedRunCount: reading.recovery.failedRunCount,
      },
      lifecycle: reading.lifecycle,
      liveFrameSubscriberCount: reading.liveFrameSubscriberCount,
      eventFeedSubscriberCount: reading.eventFeedSubscriberCount,
      watchers: reading.watchers.map((watcher) => ({
        source: watcher.source,
        lastScanAt: watcher.lastScanAt,
        lastScanError: watcher.lastScanError,
      })),
      modelCatalogRevision: reading.modelCatalogRevision,
      runningRunCount: reading.runningRunCount,
      abortingRunCount: reading.abortingRunCount,
      pendingReviewCount: reading.pendingReviewCount,
    });
  },
});
