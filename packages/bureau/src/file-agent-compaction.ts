/**
 * How a file agent compacts its conversation (COR-1866): the `onCompact` of the agent's
 * `contextManagement`, which summarizes the older messages with the deployment's summarizer model.
 *
 * The summarizer is the `context.summarizerModel` setting, resolved when a compaction runs and not
 * when the agent is built, so a change to the setting reaches an agent that is already running:
 * the next compaction uses the new model. When none is configured by then (the setting was
 * unset, or the model's row turned off) the compaction is skipped, once reported, and the run
 * goes on with the conversation as it is; the catalog lists the agent `invalid` from the next scan,
 * so no new run starts on it. A summarizer that is configured but fails ends the step as any
 * failed compaction does.
 *
 * @module file-agent-compaction
 */

import type { GenerateFunction, StepContext } from '@lostgradient/operative';
import { createContextCompactor } from '@lostgradient/operative';
import { createToolbox } from 'armorer';
import { Conversation, type Message, messageText } from 'conversationalist';

/** What the summarizer is told to do. */
export const COMPACTION_SYSTEM_PROMPT =
  'You compress the earlier part of a conversation between a user and an AI agent so the agent can continue it. Keep what the agent still needs: the user’s goals and instructions, decisions made, facts and names, file paths and identifiers, results of tool calls that matter, and work still open. Leave out pleasantries and detail that no longer matters. Reply with the summary only.';

/** The conversation as plain text, one message per block, for the summarizer to read. */
export function transcriptOf(messages: ReadonlyArray<Message>): string {
  return messages
    .map((message) => `[${message.role}]\n${messageText(message)}`.trimEnd())
    .join('\n\n');
}

/** What {@link createFileAgentCompactor} needs from the Bureau. */
export interface FileAgentCompactorOptions {
  /**
   * The generate function of the summarizer model as it is configured now, or `undefined` when
   * none is. Called for every compaction.
   */
  readonly summarizer: () => GenerateFunction | undefined;
  /** Where a skipped compaction is reported. */
  readonly diagnose: (message: string, cause: unknown) => void;
  /** The agent's identifier, for the report. */
  readonly agentId: string;
}

/** The `onCompact` of a file agent that has `compaction` enabled. */
export function createFileAgentCompactor(
  options: FileAgentCompactorOptions,
): (conversation: Conversation, context: StepContext) => Promise<void> {
  let reported = false;
  return async (conversation, context) => {
    const generate = options.summarizer();
    if (generate === undefined) {
      if (!reported) {
        reported = true;
        options.diagnose(
          `Agent "${options.agentId}" has compaction enabled, but no summarizer model is configured, so its conversation is not compacted.`,
          undefined,
        );
      }
      return;
    }
    const compact = createContextCompactor({
      summarize: async (messages) => {
        const request = new Conversation();
        request.appendSystemMessage(COMPACTION_SYSTEM_PROMPT);
        request.appendUserMessage(transcriptOf(messages));
        const response = await generate({
          conversation: request,
          step: 0,
          signal: context.signal,
          toolbox: createToolbox(),
        });
        if (response.content.trim() === '') {
          throw new Error('The summarizer model returned no summary.');
        }
        return response.content;
      },
    });
    await compact(conversation, context);
  };
}
