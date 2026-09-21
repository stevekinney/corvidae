import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createConversationHistory } from 'conversationalist';

import { createChatRuns } from '../../src/bun/chat/chat-runs.ts';

import type {
  ApplicationWebviewMessageSender,
  ChatStreamEndMessage,
  ChatStreamLineMessage,
} from '../../src/shared/rpc-contract.ts';

function createSender() {
  const lines: ChatStreamLineMessage[] = [];
  const ends: ChatStreamEndMessage[] = [];
  const sender: ApplicationWebviewMessageSender = {
    chatStreamLine: (payload) => lines.push(payload),
    chatStreamEnd: (payload) => ends.push(payload),
  };
  return { sender, lines, ends };
}

const conversation = () => createConversationHistory({ id: 'test' });

/**
 * These exercise the refusal paths, which are the ones a person actually meets:
 * a missing key on first launch, and a renderer that reuses a run id. The
 * streaming path needs a provider and is covered by the transport's own tests
 * from the other side of the wire.
 */
describe('the chat run registry', () => {
  const originalKey = process.env['ANTHROPIC_API_KEY'];
  const originalBaseUrl = process.env['ANTHROPIC_BASE_URL'];

  beforeEach(() => {
    delete process.env['ANTHROPIC_API_KEY'];
    // The duplicate-id case has to start a real run to occupy the id, and a
    // started run opens a provider request. Point it at a closed local port so
    // the suite never reaches the network, billed or otherwise.
    process.env['ANTHROPIC_BASE_URL'] = 'http://127.0.0.1:1';
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env['ANTHROPIC_API_KEY'];
    else process.env['ANTHROPIC_API_KEY'] = originalKey;
    if (originalBaseUrl === undefined) delete process.env['ANTHROPIC_BASE_URL'];
    else process.env['ANTHROPIC_BASE_URL'] = originalBaseUrl;
  });

  test('refuses a run when no API key is configured, and says which one', () => {
    const { sender, lines, ends } = createSender();
    const runs = createChatRuns(sender);

    const result = runs.start({ runId: 'run-1', conversation: conversation() });

    expect(result.status).toBe('unavailable');
    // The renderer renders this verbatim in the failure banner, so it has to
    // name the variable rather than say "not configured".
    expect(result).toMatchObject({ message: expect.stringContaining('ANTHROPIC_API_KEY') });
    // A refused run never opened a stream, so it must not emit frames either.
    expect(lines).toEqual([]);
    expect(ends).toEqual([]);
  });

  test('a refused run leaves no registration behind', () => {
    const { sender } = createSender();
    const runs = createChatRuns(sender);

    runs.start({ runId: 'run-1', conversation: conversation() });

    // Nothing to cancel: the run never started. Reporting `true` here would
    // tell the renderer it had stopped something that never existed.
    expect(runs.abort('run-1')).toBe(false);
  });

  test('reports an unknown run id as nothing aborted rather than throwing', () => {
    const { sender } = createSender();
    const runs = createChatRuns(sender);

    // The run may have settled between the renderer deciding to abort and the
    // request arriving, which is ordinary rather than exceptional.
    expect(runs.abort('never-existed')).toBe(false);
  });

  test('aborting everything is safe with nothing in flight', () => {
    const { sender } = createSender();
    const runs = createChatRuns(sender);

    // Runs on window close, including a window that never sent a message.
    expect(() => runs.abortAll()).not.toThrow();
  });

  test('refuses a duplicate run id once a run is in flight', () => {
    const { sender } = createSender();
    const runs = createChatRuns(sender);
    process.env['ANTHROPIC_API_KEY'] = 'test-key-not-a-real-credential';

    const first = runs.start({ runId: 'run-1', conversation: conversation() });
    expect(first.status).toBe('started');

    // Two runs writing under one id would interleave frames into a single
    // stream, and the decoder rejects a sequence that runs backwards.
    const second = runs.start({ runId: 'run-1', conversation: conversation() });
    expect(second).toEqual({
      status: 'unavailable',
      message: 'That run is already in flight.',
    });

    runs.abortAll();
  });
});
