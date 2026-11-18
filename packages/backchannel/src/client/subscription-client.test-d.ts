import type { z } from 'zod';

import { createProbeClient } from '../__fixtures__/probe-client/operation-client.generated.ts';
import { testEventSchema } from '../handler/operation-handler.test-support.ts';
import type { SubscriptionMessage } from './subscription-client.ts';

// The client below is generated from the fixture catalog, whose `probe.jobs.watch` subscription
// declares `testEventSchema` as its `eventSchema`.
const client = createProbeClient({ baseUrl: '/api' });
const controller = new AbortController();

const messages = client['probe.jobs.watch'](
  { topic: 'jobs' },
  { signal: controller.signal, fetch: async () => new Response(), lastEventId: '3' },
);

type Message = typeof messages extends AsyncIterable<infer Each> ? Each : never;
type EventMessage = Extract<Message, { readonly type: 'event' }>;
type SchemaEvent = z.output<typeof testEventSchema>;

// A message is an event or the replay-complete marker, and nothing else.
export const shape: Message extends SubscriptionMessage<unknown> ? true : false = true;
export const marker: Extract<Message, { readonly type: 'replay-complete' }> = {
  type: 'replay-complete',
};

// An event carries its id and `data`, which is the operation's `eventSchema` in both directions.
export const id: string = null as unknown as EventMessage['id'];
export const fromGenerated: SchemaEvent = null as unknown as EventMessage['data'];
export const toGenerated: EventMessage['data'] = null as unknown as SchemaEvent;
// @ts-expect-error `data` has no field the event schema does not declare.
export const unknownField = null as unknown as EventMessage['data']['nope'];

// The iteration narrows on `type`.
export async function narrow(): Promise<string | undefined> {
  for await (const message of messages) {
    if (message.type === 'event') return message.data.kind;
  }
  return undefined;
}

// The input is the operation's, and it is required.
// @ts-expect-error the input is required.
export const withoutInput = client['probe.jobs.watch']();
// @ts-expect-error `limit` belongs to another operation.
export const wrongInput = client['probe.jobs.watch']({ limit: 1 });
// @ts-expect-error an option the call does not know is refused.
export const unknownOption = client['probe.jobs.watch']({}, { timeout: 1 });

// Only subscriptions on the generic route get a method: not one without an HTTP route, nor one the
// generator was told to leave out.
// @ts-expect-error `probe.jobs.audit` has no HTTP route.
export const noRoute = client['probe.jobs.audit'];
// @ts-expect-error `other.feed.watch` belongs to another host.
export const otherHost = client['other.feed.watch'];
