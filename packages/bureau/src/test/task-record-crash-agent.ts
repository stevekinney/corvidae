/**
 * The agent and Bureau options shared by `task-record-crash-child.ts` and the test that
 * restarts over its storage, so both halves run the same configuration.
 */
import {
  createAgent,
  type GenerateContext,
  type GenerateFunction,
  stopWhen,
} from '@lostgradient/operative';
import { createToolbox } from 'armorer';

/** An agent that asks a human and parks, and thanks them once answered. */
export function createAskingAgent() {
  const generate: GenerateFunction = async (context: GenerateContext) =>
    context.step === 0
      ? {
          content: '',
          toolCalls: [
            {
              id: 'call-1',
              name: 'requestHumanInput',
              arguments: { signalName: 'answer', prompt: 'Which environment?' },
            },
          ],
        }
      : { content: 'thanks', toolCalls: [] };
  return createAgent({
    generate,
    toolbox: createToolbox([]),
    stopWhen: stopWhen.some(stopWhen.toolCalled('requestHumanInput'), stopWhen.noToolCalls()),
  });
}

export const finishes: GenerateFunction = async () => ({ content: 'done', toolCalls: [] });
