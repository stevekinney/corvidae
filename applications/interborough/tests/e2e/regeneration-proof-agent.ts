/**
 * A real-host agent for the Chat regeneration proof. Its first turn performs one actual tool call
 * and then answers; when Bureau regenerates that ended answer, the durable tool result is already in
 * the conversation, so the replacement is deliberately answer-only.
 */
import {
  createAgent,
  stopWhen,
  withBackendDescriptors,
  type GenerateFunction,
} from '@lostgradient/operative';
import { anthropicRows } from '@lostgradient/operative-anthropic';
import { createTool, createToolbox } from 'armorer';
import { z } from 'zod';

export const REGENERATION_PROOF_AGENT = 'e2e:regeneration-proof';
export const REGENERATION_PROOF_TOOL = 'regeneration-proof-lookup';
export const EXPIRING_APPROVAL_AGENT = 'e2e:expiring-approval';
export const EXPIRING_APPROVAL_TOOL = 'expiring-approval-mutation';
export const REMEMBER_APPROVAL_AGENT = 'e2e:remember-approval';

const lookup = createTool({
  name: REGENERATION_PROOF_TOOL,
  version: '1.0.0',
  description: 'Reads the proof record for the requested question.',
  input: z.object({ question: z.string() }),
  metadata: { readOnly: true },
  execute: async ({ question }) => ({ question, source: 'real-host-tool-step', value: 'verified' }),
});

const generate: GenerateFunction = async ({ conversation, toolbox }) => {
  const toolResult = conversation
    .getMessages()
    .findLast((message) => message.toolResult?.callId !== undefined)?.toolResult;
  if (toolResult !== undefined) {
    const offeredTools = toolbox.tools();
    // Bureau regeneration replays the ended answer with an empty toolbox, but it keeps the
    // durable step number from the original run. `step === 0` therefore describes neither the
    // initial answer nor regeneration reliably; the toolbox is the protocol signal here.
    const regenerationStep = offeredTools.length === 0;
    return {
      content: regenerationStep
        ? 'The regenerated answer is distinct after the real tool step.'
        : 'The verified answer is retained after the real tool step.',
      toolCalls: [],
    };
  }
  return {
    content: '',
    toolCalls: [
      {
        id: 'regeneration-proof-lookup-1',
        name: REGENERATION_PROOF_TOOL,
        arguments: { question: 'Is the proof record valid?' },
      },
    ],
  };
};

const regenerationModel =
  anthropicRows().find(
    (descriptor) => descriptor.provider === 'anthropic' && descriptor.model === 'claude-sonnet-5',
  ) ??
  (() => {
    throw new Error('The regeneration proof model is not cataloged.');
  })();

/** The retry's frozen clock starts ahead of the real clock that the host uses to sweep reviews. */
const RETRY_APPROVAL_CLOCK_OFFSET_MILLISECONDS = 60 * 60 * 1000;

export function createRegenerationProofAgent() {
  let retryApprovalTime: number | undefined;
  const expiringTool = createTool({
    name: EXPIRING_APPROVAL_TOOL,
    version: '1.0.0',
    description: 'Performs the approval-expiry proof mutation.',
    input: z.object({ value: z.string() }),
    metadata: { mutates: true },
    execute: async ({ value }) => ({ value, committed: true }),
  });
  const rememberTool = createTool({
    name: 'remember-proof-mutation',
    version: '1.0.0',
    description: 'Records a harmless approval fixture value.',
    input: z.object({ value: z.string() }),
    metadata: { mutates: true },
    execute: async ({ value }) => ({ value, recorded: true }),
  });
  const rememberAgent = createAgent({
    name: REMEMBER_APPROVAL_AGENT,
    description: 'Asks before recording a harmless fixture value.',
    generate: (async ({ conversation }) => {
      if (conversation.getMessages().some((message) => message.toolResult?.outcome === 'success'))
        return { content: 'The fixture value was recorded.', toolCalls: [] };
      return {
        content: '',
        toolCalls: [
          { id: 'remember-proof-1', name: rememberTool.name, arguments: { value: 'proof' } },
        ],
      };
    }) satisfies GenerateFunction,
    toolbox: createToolbox([rememberTool], {
      approvalSecret: 'e2e-remember-approval-secret',
      approvalPolicy: { mode: 'on-mutation' },
    }),
    stopWhen: [stopWhen.pendingApproval(), stopWhen.noToolCalls()],
  });
  const expiringAgent = createAgent({
    name: EXPIRING_APPROVAL_AGENT,
    description: 'Leaves a short-lived real approval pending.',
    generate: (async ({ conversation }) => {
      const latestToolResult = conversation
        .getMessages()
        .findLast((message) =>
          message.toolResult?.callId?.startsWith('expiring-approval-'),
        )?.toolResult;
      if (latestToolResult?.outcome === 'success') {
        return {
          content: 'The approved proof mutation completed on the real host.',
          toolCalls: [],
        };
      }
      const userTurns = conversation
        .getMessages()
        .filter((message) => message.role === 'user').length;
      // Let the first binding expire on the host's real clock. While the test reloads the retry,
      // freeze its toolbox clock for both issuance and validation, with an expiry the host will
      // leave alone. An offset on a moving clock would still let validation expire it in 20 seconds.
      retryApprovalTime =
        userTurns > 1 ? Date.now() + RETRY_APPROVAL_CLOCK_OFFSET_MILLISECONDS : undefined;
      return {
        content: '',
        toolCalls: [
          {
            id: `expiring-approval-${userTurns}`,
            name: EXPIRING_APPROVAL_TOOL,
            arguments: { value: 'durable-expiry-proof' },
          },
        ],
      };
    }) satisfies GenerateFunction,
    toolbox: createToolbox([expiringTool], {
      approvalSecret: 'e2e-expiring-approval-secret',
      approvalPolicy: { mode: 'on-mutation' },
      approvalBindingTtlMs: 20_000,
      approvalNow: () => retryApprovalTime ?? Date.now(),
    }),
    stopWhen: [stopWhen.pendingApproval(), stopWhen.noToolCalls()],
  });
  return {
    [REMEMBER_APPROVAL_AGENT]: rememberAgent,
    [REGENERATION_PROOF_AGENT]: createAgent({
      name: REGENERATION_PROOF_AGENT,
      description: 'Performs one real lookup before answering.',
      generate: withBackendDescriptors(generate, [regenerationModel]),
      toolbox: createToolbox([lookup]),
      stopWhen: stopWhen.noToolCalls(),
    }),
    [EXPIRING_APPROVAL_AGENT]: expiringAgent,
  };
}
