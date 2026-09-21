import { createAnthropicProviderStream, type ConversationHistory } from '@lostgradient/operative';

import {
  createChatAgent,
  createChatStreamWriter,
  pumpChatRun,
  startChatRun,
} from '@lostgradient/telephone';
import { readEnvironmentConfiguration } from './environment-configuration.ts';
import { requestContext, toolbox } from './toolbox.ts';

import type {
  ApplicationWebviewMessageSender,
  StartChatRunResult,
} from '../../shared/rpc-contract.ts';

const MODEL = 'claude-sonnet-5';
const MAX_TOKENS = 4096;

export type ChatRuns = {
  start(input: { runId: string; conversation: ConversationHistory }): StartChatRunResult;
  abort(runId: string): boolean;
  /** Aborts every in-flight run; used when the owning window goes away. */
  abortAll(): void;
};

/**
 * Marks the newest message as a prompt-cache boundary.
 *
 * Conversationalist lowers this to a `cache_control` breakpoint on that
 * message's last content block inside `toAnthropicMessages` — the same adapter
 * Operative's Anthropic provider calls when no assembler or context budget is
 * configured. Each turn therefore caches the whole prompt prefix and the next
 * turn reads it back instead of re-processing the entire transcript.
 */
function withCacheBoundary(conversation: ConversationHistory): ConversationHistory {
  const lastId = conversation.ids.at(-1);
  const lastMessage = lastId === undefined ? undefined : conversation.messages[lastId];
  if (lastId === undefined || lastMessage === undefined) return conversation;
  return {
    ...conversation,
    messages: {
      ...conversation.messages,
      [lastId]: { ...lastMessage, cacheBoundary: true },
    },
  };
}

/**
 * Owns every in-flight chat turn for one window.
 *
 * This is the main-process counterpart of the old lab's NDJSON `Response`: the
 * same writer, the same pump, the same one-terminal-frame guarantee — only the
 * sink differs. Instead of enqueueing bytes into a `ReadableStream`, each
 * encoded line is sent to the renderer as a `chatStreamLine` message.
 *
 * Per window rather than per process, because `send` targets one webview. Two
 * windows each get their own registry and neither sees the other's frames.
 */
export function createChatRuns(send: ApplicationWebviewMessageSender): ChatRuns {
  const active = new Map<string, { abort: (reason: string) => void }>();

  return {
    start({ runId, conversation }) {
      // A duplicate id would let two runs write interleaved frames under one
      // stream, and the renderer's decoder would reject the result as a
      // sequence that ran backwards. Refuse rather than corrupt the stream.
      if (active.has(runId)) {
        return { status: 'unavailable', message: 'That run is already in flight.' };
      }

      const { anthropicApiKey: apiKey, anthropicBaseUrl: baseURL } = readEnvironmentConfiguration();
      if (!apiKey) {
        return {
          status: 'unavailable',
          message: 'ANTHROPIC_API_KEY is not configured. Set it and restart the application.',
        };
      }

      // Run-local, never module-scoped: the writer owns this run's `sequence`
      // counter and `createChatAgent` builds a run-local event target around
      // it. A shared one would deliver one turn's frames into another's.
      const writer = createChatStreamWriter((line) => {
        send.chatStreamLine({ runId, line });
      });

      const run = startChatRun(
        createChatAgent({
          generate: createAnthropicProviderStream({
            model: MODEL,
            maximumTokens: MAX_TOKENS,
            apiKey,
            // The raw Anthropic SDK reads `ANTHROPIC_BASE_URL` from the
            // environment itself at construction time; Operative's provider
            // does not. Forwarding it explicitly is what lets a fixture host
            // stand in for the real, billed API.
            ...(baseURL === undefined ? {} : { baseURL }),
          }),
          toolbox,
          requestContext,
          writer,
        }),
        withCacheBoundary(conversation),
      );

      active.set(runId, { abort: (reason) => run.abort(reason) });

      void (async () => {
        try {
          await pumpChatRun(run, writer);
          send.chatStreamEnd({ runId, reason: 'completed' });
        } catch {
          // `pumpChatRun` is written never to reject, so reaching here means
          // something outside its contract failed. The renderer is waiting on
          // a stream that will never produce another frame, so tell it the run
          // is over rather than leaving its composer disabled forever.
          send.chatStreamEnd({ runId, reason: 'failed' });
        } finally {
          active.delete(runId);
          try {
            run[Symbol.dispose]();
          } catch {
            // Disposal is cleanup, not the outcome. Letting it throw here
            // would replace the real failure with a disposal error.
          }
        }
      })();

      return { status: 'started' };
    },

    abort(runId) {
      const run = active.get(runId);
      if (run === undefined) return false;
      run.abort('cancelled from the renderer');
      return true;
    },

    abortAll() {
      for (const run of active.values()) run.abort('window closed');
    },
  };
}
