import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createConversationHistory } from 'conversationalist';

import { createChatRuns } from '../../src/bun/chat/chat-runs.ts';
import { applicationRpcContract } from '../../src/shared/rpc-contract.ts';
import { createValidatedRequestHandlers } from '../../src/shared/rpc-validation.ts';

import type { ApplicationWebviewMessageSender } from '../../src/shared/rpc-contract.ts';

/**
 * The request path as the main process actually assembles it, one layer below
 * the Electrobun transport: contract validation, handler dispatch, and output
 * validation. Only the native hop is absent.
 *
 * This is where `conversationInput` earns its keep. It is a `z.custom` piped
 * into `conversationSchema` so a deeply readonly `ConversationHistory` types
 * cleanly at the call site; if that pipe ever stopped parsing, the handler
 * would reject every real conversation with "Invalid RPC input" and the only
 * symptom would be a banner in the running application.
 */
function createHandlers() {
  const sent: string[] = [];
  const sender: ApplicationWebviewMessageSender = {
    chatStreamLine: () => sent.push('line'),
    chatStreamEnd: () => sent.push('end'),
  };
  const runs = createChatRuns(sender);
  return {
    runs,
    handlers: createValidatedRequestHandlers(applicationRpcContract.bun, {
      startChatRun: ({ runId, conversation }) => runs.start({ runId, conversation }),
      abortChatRun: ({ runId }) => ({ aborted: runs.abort(runId) }),
    }),
  };
}

describe('the validated request handlers', () => {
  const originalKey = process.env['ANTHROPIC_API_KEY'];

  beforeEach(() => {
    delete process.env['ANTHROPIC_API_KEY'];
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env['ANTHROPIC_API_KEY'];
    else process.env['ANTHROPIC_API_KEY'] = originalKey;
  });

  test('accepts a real conversation and returns a contract-valid refusal', async () => {
    const { handlers } = createHandlers();

    const result = await handlers.startChatRun?.({
      runId: 'run-1',
      conversation: createConversationHistory({ id: 'test' }),
    });

    // Reaching a refusal at all proves the conversation parsed: a rejected
    // input throws before the handler runs, and a response that did not match
    // the output union would throw on the way back out.
    expect(result).toMatchObject({ status: 'unavailable' });
  });

  test('rejects a malformed conversation at the contract boundary', async () => {
    const { handlers } = createHandlers();

    await expect(
      handlers.startChatRun?.({
        runId: 'run-1',
        // Missing every required field. The boundary that owns the contract
        // should refuse this rather than letting it reach the agent loop.
        conversation: { id: 'test' } as never,
      }),
    ).rejects.toThrow('Invalid RPC input');
  });

  test('rejects an empty run id', async () => {
    const { handlers } = createHandlers();

    await expect(
      handlers.startChatRun?.({
        runId: '',
        conversation: createConversationHistory({ id: 'test' }),
      }),
    ).rejects.toThrow('Invalid RPC input');
  });

  test('answers an abort for an unknown run without throwing', async () => {
    const { handlers } = createHandlers();

    await expect(handlers.abortChatRun?.({ runId: 'never-existed' })).resolves.toEqual({
      aborted: false,
    });
  });

  test('registers exactly the contract’s requests and nothing else', () => {
    const { handlers } = createHandlers();

    // A handler the contract does not declare is never registered, so a
    // renderer calling it reaches nothing rather than a permission check it
    // could be trusted to respect.
    expect(Object.keys(handlers).toSorted()).toEqual(['abortChatRun', 'startChatRun']);
  });
});
