import type { GenerateFunction } from '@lostgradient/operative';
import { describe, expect, test } from 'bun:test';

import {
  ACCESS_LOOKUP_MARKER,
  ACCESS_LOOP_MARKER,
  ACCESS_REPLY,
  createAccessProviderResolver,
} from './e2e/access-provider.ts';

type Row = { role: 'user' | 'assistant'; content: unknown; toolCall?: unknown };

/** The part of a generate context the access models read: the conversation's rows. */
function contextOf(...rows: Row[]) {
  const messages = rows.map((row) => ({ metadata: {}, ...row }));
  return { conversation: { getMessages: () => messages } } as never;
}

const STUB_REPLY = { content: 'the stub', toolCalls: [] };

async function generateWith(...rows: Row[]) {
  const stub: GenerateFunction = async () => STUB_REPLY;
  const resolver = (() => stub) as never;
  const generate = createAccessProviderResolver(resolver)(
    [],
    { provider: 'anthropic', model: 'sonnet', apiKey: 'fixture' },
    undefined,
    undefined,
  );
  return generate(contextOf(...rows));
}

const CALL = { id: 'call-1', name: 'lookup-order', arguments: {} };

describe('the access provider resolver', () => {
  test('answers the lookup opener with one call to the read-only tool, then a fixed reply', async () => {
    const opener: Row = { role: 'user', content: `${ACCESS_LOOKUP_MARKER} Find it.` };

    const first = await generateWith(opener);
    expect(first.toolCalls?.map((call) => call.name)).toEqual(['lookup-order']);

    const second = await generateWith(opener, { role: 'assistant', content: '', toolCall: CALL });
    expect(second).toEqual({ content: ACCESS_REPLY, toolCalls: [] });
  });

  test('answers the loop opener with a call on every step, with a fresh identifier each time', async () => {
    const opener: Row = { role: 'user', content: `${ACCESS_LOOP_MARKER} Keep going.` };

    const first = await generateWith(opener);
    const second = await generateWith(opener, { role: 'assistant', content: '', toolCall: CALL });

    expect(second.toolCalls).toHaveLength(1);
    expect(second.toolCalls?.[0]?.id).not.toBe(first.toolCalls?.[0]?.id);
  });

  test('hands an opener with no marker to the stub it wraps', async () => {
    expect(await generateWith({ role: 'user', content: 'Say hello' })).toEqual(STUB_REPLY);
  });
});
