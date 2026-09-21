import { createTool, createToolbox, type ToolRequestContext } from 'armorer';
import { z } from 'zod';

/**
 * One tool, and deliberately one that needs no approval.
 *
 * The approval-gated half of the old SvelteKit lab depended on a second HTTP
 * route that replayed a signed `pendingApproval` token back into the run. This
 * application has no such route, so an approval-gated tool would park the run
 * on a question nothing can answer. A tool that simply executes keeps the
 * Operative loop — stream, tool call, tool result, follow-up turn — observable
 * end to end without pretending the approval path exists.
 */
const rollDice = createTool({
  name: 'roll_dice',
  version: '1.0.0',
  description: 'Roll one or more dice and return the individual results.',
  input: z.object({
    sides: z.number().int().min(2).max(1000),
    count: z.number().int().min(1).max(20),
  }),
  async execute({ sides, count }) {
    const rolls = Array.from({ length: count }, () => 1 + Math.floor(Math.random() * sides));
    return { rolls, total: rolls.reduce((sum, roll) => sum + roll, 0) };
  },
});

/**
 * Stable for the process's lifetime only. Nothing else in this application
 * survives a restart either — the conversation lives in the renderer — so a
 * restart invalidating an in-flight approval is an acceptable limitation
 * rather than a reason to commit a secret to disk.
 */
export const toolbox = createToolbox([rollDice], {
  approvalSecret: crypto.randomUUID(),
});

export const requestContext: ToolRequestContext = {
  authority: {
    principalId: 'chat-user',
    tenantId: 'chat',
    ownerId: 'chat-session',
    capabilities: [],
    authorizationRevision: '1',
  },
  audience: 'tenant',
  agentId: 'chat-assistant',
  runId: 'chat-session',
};
