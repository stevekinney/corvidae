import { definePlugin, type PluginDescriptor } from '@lostgradient/interborough-plugin';

import { createDemoAgents } from './agents.ts';
import { seedDemo } from './seed.ts';
import { createIssueRefundTool, createLookupOrderTool } from './tools.ts';
import { createDemoValidators } from './validators.ts';

export { DEMO_AGENT_NAMES } from './agents.ts';
export {
  HUMAN_INPUT_PROMPT,
  HUMAN_INPUT_SIGNAL,
  MODEL_SWITCHER_MODELS,
  modelSwitcherReply,
} from './scripts.ts';
export { SEEDED_GOAL_RUN_IDENTIFIER, SEEDED_SCHEDULE_DESCRIPTION } from './seed.ts';
export { NEVER_PASSING } from './validators.ts';

/**
 * The Bungalow secret that signs the refund approvals `demo:tool-runner` raises. It is the
 * plugin's own, not the host's `approval-secret`, which the host keeps for itself and refuses a
 * plugin to declare: the toolbox that raised an approval is the one that verifies it, so the host
 * never needs this value.
 */
export const DEMO_APPROVAL_SECRET = 'demo-approval-secret';

/** What {@link createDemoPlugin} takes. */
export interface DemoPluginOptions {
  /**
   * Whether `afterStart` creates the seeded schedule and goal. Defaults to `true`. A test turns it
   * off to control when {@link seedDemo} runs.
   */
  readonly seedOnStart?: boolean;
}

/**
 * The demo plugin: six scripted agents, two tools, two validators, a goal and a schedule, all of
 * which answer without a model. It is off by default and the owner turns it on in Settings. The
 * host creates `demo-approval-secret` on first enable in local mode; a remote host cannot, so the
 * plugin stays `needs-setup` until the deployment sets the variable.
 */
export function createDemoPlugin(options: DemoPluginOptions = {}): PluginDescriptor {
  const seedOnStart = options.seedOnStart ?? true;
  return definePlugin({
    name: 'demo',
    version: '1.0.0',
    description:
      'Scripted agents, tools, validators, a goal, and a schedule that run without a model provider, for trying Interborough out.',
    enabledByDefault: false,
    secrets: [{ key: DEMO_APPROVAL_SECRET, generated: true }],
    async setup({ secrets, toolApprovalHooks }) {
      // Read once: a toolbox takes its approval secret at construction. A plugin composes once, so
      // a secret saved after the start applies on the next one.
      const approvalSecret = (await secrets.get(DEMO_APPROVAL_SECRET)) || undefined;
      return {
        codeAgents: createDemoAgents(approvalSecret, toolApprovalHooks),
        tools: [createLookupOrderTool(), createIssueRefundTool()],
        validators: createDemoValidators(),
        ...(seedOnStart
          ? {
              afterStart: (host, { storage }) => seedDemo(host, storage),
            }
          : {}),
      };
    },
  });
}

/** The demo plugin the workspace ships. */
export default createDemoPlugin();
