/**
 * The demo plugin's six agents. The Bureau registers them as `demo:assistant`, `demo:tool-runner`,
 * `demo:request-human-input`, `demo:echo`, `demo:model-switcher` and `demo:internal`.
 *
 * - `assistant`: answers every message with one fixed reply.
 * - `tool-runner`: looks an order up (a read-only tool), then asks to refund it (a mutating tool
 *   the toolbox holds for approval). The run stops on the pending approval, and the refund does
 *   not run until an operator approves it. The review's `runId` is the task's id and the task's
 *   context supplies the request context that signs the approval.
 * - `request-human-input`: calls `requestHumanInput` with its question and parks until an
 *   operator answers the review, then thanks them. The review carries the task's context id.
 * - `echo`: answers every message with the text of the last message it was sent. A reply that
 *   quotes parts of earlier replies reaches the model as Markdown block quotes ahead of the typed
 *   text, so the echo shows exactly what the agent received.
 * - `model-switcher`: a selectable agent over two models (`MODEL_SWITCHER_MODELS`), whose reply
 *   names the model that answered, so a session switched with `bureau.contexts.steer` shows which
 *   model each message ran on. It is offered the models the host's catalog holds: the two models
 *   need a configured provider, and a host with none offers no choice, so Chat shows no picker.
 * - `internal`: a plain agent that answers with a scripted bookkeeping reply.
 *
 * @module agents
 */

import type { PluginCodeAgent, PluginSetupContext } from '@lostgradient/interborough-plugin';
import { createAgent, createScriptedGenerate, stopWhen } from '@lostgradient/operative';

import {
  echoGenerate,
  humanInputGenerate,
  MODEL_SWITCHER_MODELS,
  modelSwitcherGenerate,
  repeated,
  reply,
  toolRunnerGenerate,
} from './scripts.ts';
import { createToolRunnerToolbox } from './tools.ts';

/** Every demo agent, by its name inside the plugin. */
export const DEMO_AGENT_NAMES = [
  'assistant',
  'tool-runner',
  'request-human-input',
  'echo',
  'model-switcher',
  'internal',
] as const;

/**
 * The six agents. `approvalSecret` signs the refund approvals `tool-runner` raises; `undefined`
 * builds its toolbox without one, which only happens while the plugin is `needs-setup`, and the
 * plugin's gate then refuses every run of every demo agent. `toolApprovalHooks` is the host's
 * tool-approval rule, from the plugin's setup context.
 */
export function createDemoAgents(
  approvalSecret: string | undefined,
  toolApprovalHooks: PluginSetupContext['toolApprovalHooks'],
): PluginCodeAgent[] {
  return [
    {
      name: 'assistant',
      agent: createAgent({
        name: 'assistant',
        description: 'Answers every message with the same scripted reply.',
        examples: ['Say hello'],
        generate: createScriptedGenerate(
          repeated([
            reply('Hello from the assistant. This reply is scripted; no model was called.'),
          ]),
        ),
        stopWhen: stopWhen.noToolCalls(),
      }),
    },
    {
      name: 'tool-runner',
      agent: createAgent({
        name: 'tool-runner',
        description: 'Looks an order up, then asks for approval to refund it.',
        examples: ['Refund order 1234'],
        generate: toolRunnerGenerate(),
        toolbox: createToolRunnerToolbox(approvalSecret, toolApprovalHooks),
        stopWhen: [stopWhen.pendingApproval(), stopWhen.noToolCalls()],
      }),
    },
    {
      name: 'request-human-input',
      agent: createAgent({
        name: 'request-human-input',
        description: 'Asks a human which environment the release should go to.',
        examples: ['Ship the release'],
        generate: humanInputGenerate(),
        // The run ends on the request so it parks; once an operator answers it continues to the
        // reply, which has no tool call.
        stopWhen: [stopWhen.toolCalled('requestHumanInput'), stopWhen.noToolCalls()],
      }),
    },
    {
      name: 'echo',
      agent: createAgent({
        name: 'echo',
        description: 'Repeats the last message it was sent.',
        examples: ['Hello echo, say this back'],
        generate: echoGenerate(),
        stopWhen: stopWhen.noToolCalls(),
      }),
    },
    {
      name: 'model-switcher',
      agent: createAgent({
        name: 'model-switcher',
        description: 'Names the model it answers as, and can be switched between two.',
        examples: ['Which model are you?'],
        generate: modelSwitcherGenerate(),
        allowedCandidates: MODEL_SWITCHER_MODELS,
        stopWhen: stopWhen.noToolCalls(),
      }),
    },
    {
      name: 'internal',
      agent: createAgent({
        name: 'internal',
        description: 'Answers with a scripted bookkeeping reply.',
        examples: ['Run the bookkeeping'],
        generate: createScriptedGenerate(
          repeated([reply('Internal bookkeeping is done. This reply is scripted.')]),
        ),
        stopWhen: stopWhen.noToolCalls(),
      }),
    },
  ];
}
