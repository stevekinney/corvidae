import { definePlugin, type PluginDescriptor } from '@lostgradient/interborough-plugin';
import { scopedStorage } from '@lostgradient/storage';
import { z } from 'zod';

import { createDemoAgents, type DemoAgentName } from './agents.ts';
import { createAuditInterceptor } from './audit.ts';
import { createRefundLedger } from './refund-ledger.ts';
import { createFakeProcessor, recoverRefund } from './refund-processor.ts';
import { seedDemo } from './seed.ts';
import { createAdmittedRefundTool, createLookupOrderTool } from './tools.ts';
import { createDemoValidators } from './validators.ts';
import { createDemoWorkflows } from './workflows.ts';

export { DEMO_AGENT_NAMES, type DemoAgentName } from './agents.ts';
export { AUDIT_INTERCEPTOR_NAME, auditStepKey, type AuditStepEntry } from './audit.ts';
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
   * Whether `start` creates the seeded schedule and goal. Defaults to `true`. A test turns it
   * off to control when {@link seedDemo} runs.
   */
  readonly seedOnStart?: boolean;
  /**
   * Which of the eight agents the plugin provides, by their names inside it. Defaults to all of
   * them. The showcase leaves out `internal`, which is not part of the sample world, so a disabled
   * Demo holds back exactly the agents the design names.
   */
  readonly agents?: readonly DemoAgentName[];
}

/**
 * The demo plugin: eight scripted agents, two tools, two validators, an every-agent `audit`
 * interceptor set, a goal and a schedule, all of which answer without a model, and one declared
 * event, `demo:greeted`, whose payload names a greeting by its identifier. It is off by default and the owner turns it on in Settings. The
 * host creates `demo-approval-secret` on first enable in local mode; a remote host cannot, so the
 * plugin stays `needs-setup` until the deployment sets the variable.
 */
export function createDemoPlugin(options: DemoPluginOptions = {}): PluginDescriptor {
  const seedOnStart = options.seedOnStart ?? true;
  const provided = options.agents === undefined ? undefined : new Set<string>(options.agents);
  return definePlugin({
    name: 'demo',
    title: 'Demo',
    version: '1.1.0',
    description: 'Sample tools and agents for trying Interborough.',
    enabled: false,
    secrets: [{ key: DEMO_APPROVAL_SECRET, generated: true }],
    async setup({ secrets, storage, approvals }) {
      // Read once: a toolbox takes its approval secret at construction. A plugin composes once, so
      // a secret saved after the start applies on the next one.
      const approvalSecret = (await secrets.get(DEMO_APPROVAL_SECRET)) || undefined;
      const ledger = createRefundLedger(scopedStorage(storage, 'refund-ledger'));
      const processor = createFakeProcessor(scopedStorage(storage, 'refund-processor'));
      const issueRefund = createAdmittedRefundTool(
        ledger,
        processor,
        () => Date.now() + 86_400_000,
        approvals,
      );
      return {
        agents: createDemoAgents(approvalSecret, approvals, ledger, issueRefund).filter(
          ({ name }) => provided === undefined || provided.has(name),
        ),
        tools: [createLookupOrderTool(), issueRefund],
        terminalReviewReleases: [
          {
            name: 'refund',
            agent: 'tool-runner',
            tool: 'issue-refund',
            toolRevision: issueRefund.id,
            identifier(arguments_) {
              const parsed = z
                .object({ refundId: z.string().uuid() })
                .passthrough()
                .parse(arguments_);
              return parsed.refundId;
            },
            async release(input) {
              const intent = await ledger.get(input.identifier);
              if (
                !intent ||
                intent.existingRunId !== input.runId ||
                input.toolRevision !== issueRefund.id
              )
                throw new Error('Terminal review does not match the refund');
              await ledger.cancel(intent.id);
            },
          },
        ],
        validators: createDemoValidators(),
        interceptors: [createAuditInterceptor(storage)],
        workflows: createDemoWorkflows(),
        events: [
          {
            name: 'greeted',
            description:
              'The demo greeted someone. Its payload names the greeting, never its words.',
            payload: z.object({ greetingId: z.string().meta({ identifier: true }) }),
          },
        ],
        async start(host, started) {
          for (const intent of await ledger.recoverable())
            await recoverRefund(ledger, processor, intent.id, Date.now());
          if (seedOnStart) await seedDemo(host, started.storage);
        },
      };
    },
  });
}

/** The demo plugin the workspace ships. */
export default createDemoPlugin();
