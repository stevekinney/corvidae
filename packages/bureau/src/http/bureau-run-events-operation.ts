/**
 * `operative.runs.events` as `createBureauHandler` serves it: the same feed, with
 * the owner predicate in front of it.
 *
 * Operative's shared definition declares `events:read` and knows no owners, and
 * it does not change. This wrapper registers the same name with the same input,
 * envelope, and transports, declared `authenticated`: the run's owner may
 * subscribe, and any other principal needs `bureau.tasks:read`. A subscription to
 * another owner's run without that scope answers exactly as a missing run does,
 * because it is handed the registry that holds no run and so produces Operative's
 * own `Unknown run` fault.
 *
 * @module bureau-run-events-operation
 */

import {
  type RunEventsOperationHost,
  runEventsSubscriptionOperation,
} from '@lostgradient/operative';
import { defineOperation } from '@lostgradient/weft';

import { type BureauOwnershipHost } from './owner-predicate.ts';

/** What the wrapper reads from the handler's `host`. */
export type BureauRunEventsOperationHost = RunEventsOperationHost & BureauOwnershipHost;

const noRuns: RunEventsOperationHost = { runFeeds: { get: () => undefined } };

// Operative's definition leaves its parameters undescribed, and it is not changed here, so the
// wrapper publishes the same fields with their descriptions.
const inputShape = runEventsSubscriptionOperation.inputSchema.shape;
const runEventsInput = runEventsSubscriptionOperation.inputSchema.extend({
  runId: inputShape.runId.describe('The identifier of the run whose events to follow.'),
  kinds: inputShape.kinds.describe(
    'One event kind, or several. Omitting it delivers every published kind.',
  ),
  fromCursor: inputShape.fromCursor.describe(
    'The cursor of the last event already seen; the replay continues after it. Omitting it replays from the beginning of what the feed retains. An opaque value taken from an event or the subscription’s envelope.',
  ),
});

export const bureauRunEventsSubscriptionOperation = defineOperation<
  typeof runEventsInput,
  (typeof runEventsSubscriptionOperation)['outputSchema'],
  (typeof runEventsSubscriptionOperation)['eventSchema'],
  BureauRunEventsOperationHost
>({
  name: runEventsSubscriptionOperation.name,
  mcpExposable: false,
  kind: 'subscription',
  summary: runEventsSubscriptionOperation.summary,
  description:
    'Replays the run’s events from `fromCursor` (or the beginning) and then follows live. The run’s owner may subscribe; any other principal needs `bureau.tasks:read`, and a subscription to another owner’s run answers as an unknown run does. The grant is checked when the subscription starts and remains active until unsubscribe, socket close, or feed termination.',
  destructive: false,
  tags: runEventsSubscriptionOperation.tags,
  inputSchema: runEventsInput,
  outputSchema: runEventsSubscriptionOperation.outputSchema,
  producibleFaults: ['InvalidParams', 'NotFound'],
  eventSchema: runEventsSubscriptionOperation.eventSchema,
  access: { kind: 'authenticated' },
  discoverable: true,
  transports: runEventsSubscriptionOperation.transports,
  unknownKeyPolicy: runEventsSubscriptionOperation.unknownKeyPolicy,
  invoke: async (context) => {
    const { host, input, principal } = context;
    const allowed = host.ownership.mayAccess({
      principal,
      resourceOwner: await host.ownership.runOwner(input.runId),
      operatorScope: 'bureau.tasks:read',
    });
    return runEventsSubscriptionOperation.invoke({
      ...context,
      host: allowed ? host : noRuns,
    });
  },
});
