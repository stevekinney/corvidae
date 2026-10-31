/**
 * The model the Access specification (`agent-access.spec.ts`) chats through. It calls no model and
 * reads no key: it stands in for the provider path a file agent runs through, and wraps the stub
 * the other specifications use, so an opener without a marker is answered as it always was.
 *
 * An opener that carries {@link ACCESS_LOOKUP_MARKER} gets a script: one call to the read-only
 * `demo:lookup-order` tool, then a fixed reply once the call has a result. An opener that carries
 * {@link ACCESS_LOOP_MARKER} calls the tool on every step and never answers, so only a limit on
 * the run ends it. A call the run's tool policy refuses has a result too (the policy's refusal),
 * so counting the calls already in the conversation keeps the lookup script from asking twice.
 */
import type { GenerateContext, GenerateFunction, GenerateResponse } from '@lostgradient/operative';

import type { HostOptions } from '../../src/host/host.ts';

/** What the first message of a chat carries to be answered with one lookup and a reply. */
export const ACCESS_LOOKUP_MARKER = '[access:lookup]';

/** What the first message of a chat carries to be answered with a lookup on every step. */
export const ACCESS_LOOP_MARKER = '[access:loop]';

/** What the scripted agent says once its lookup has a result. */
export const ACCESS_REPLY = 'The order was looked up.';

type ProviderResolver = NonNullable<HostOptions['resolveProviderGenerate']>;

function openerOf(context: GenerateContext): string | undefined {
  const opener = context.conversation.getMessages().find((message) => message.role === 'user');
  return typeof opener?.content === 'string' ? opener.content : undefined;
}

function lookup(context: GenerateContext, again: boolean): GenerateResponse {
  const calls = context.conversation
    .getMessages()
    .filter((message) => message.toolCall !== undefined).length;
  if (calls > 0 && !again) return { content: ACCESS_REPLY, toolCalls: [] };
  return {
    content: '',
    toolCalls: [
      {
        id: `access-lookup-order-${String(calls + 1)}`,
        name: 'demo:lookup-order',
        arguments: { orderId: 'order-1001' },
      },
    ],
  };
}

/**
 * A provider resolver that scripts the runs whose opener carries one of the access markers and
 * hands every other run to `fallback`.
 */
export function createAccessProviderResolver(fallback: ProviderResolver): ProviderResolver {
  return (definitions, provider, streamEventTarget, streaming) => {
    const stub = fallback(definitions, provider, streamEventTarget, streaming);
    const generate: GenerateFunction = async (context) => {
      const opener = openerOf(context);
      if (opener?.includes(ACCESS_LOOP_MARKER) === true) return lookup(context, true);
      if (opener?.includes(ACCESS_LOOKUP_MARKER) === true) return lookup(context, false);
      return stub(context);
    };
    return generate;
  };
}
