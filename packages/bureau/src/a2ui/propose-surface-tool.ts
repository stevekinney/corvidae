/**
 * The model-facing tool that proposes an A2UI surface (COR-837). A model's proposal is untrusted
 * content, exactly as an author's is: it goes through the same adapter and the same validation, and
 * a refusal comes back as structured feedback the model can repair the proposal from.
 *
 * The model chooses the surface's components and the names and intents of its actions. It never
 * chooses what an action does: the host supplies each action's continuation, and an action the host
 * will not continue is refused. A proposal that names an event the surface does not declare, a
 * catalog that was not negotiated, or a function the catalog lacks commits nothing.
 *
 * @experimental A2UI support is pinned to v0.9.1 and may change until a stable A2UI 1.0 review.
 * @module propose-surface-tool
 */

import { createTool } from 'armorer';
import { z } from 'zod';

import type {
  InteractiveSurfaceActionDefinition,
  InteractiveSurfaceActionIntent,
  InteractiveSurfaceContinuation,
} from '../interactive-surface/types.ts';
import type { A2uiAdapter } from './adapter.ts';

/** What the host supplies to build the tool for one task. @experimental */
export interface ProposeA2uiSurfaceToolOptions {
  readonly adapter: A2uiAdapter;
  /** The task the proposing run belongs to. */
  readonly taskId: string;
  /**
   * What continuing the task means for an action the model declared. Return `undefined` to refuse
   * the action. Omit it and every proposal is display-only.
   */
  readonly continuationFor?:
    | ((action: {
        readonly name: string;
        readonly intent: InteractiveSurfaceActionIntent;
      }) => InteractiveSurfaceContinuation | undefined)
    | undefined;
  /** The catalogs the task's audience declared. Omitted, only the basic catalog may be used. */
  readonly supportedCatalogIds?: readonly string[] | undefined;
}

const INTENTS = ['answer', 'submit', 'approve', 'deny'] as const;

const input = z.object({
  surfaceId: z
    .string()
    .min(1)
    .max(128)
    .describe('A name for the surface, unique within this task.'),
  messages: z
    .array(z.record(z.string(), z.unknown()))
    .min(1)
    .max(64)
    .describe(
      'A2UI v0.9.1 server-to-client messages for this surface, in order: createSurface (first, to begin), then updateComponents and updateDataModel; deleteSurface alone to end it.',
    ),
  summary: z
    .string()
    .min(1)
    .max(500)
    .optional()
    .describe('Plain text shown where the surface cannot be rendered.'),
  actions: z
    .array(
      z.object({
        name: z.string().min(1).max(128).describe('The event name your components raise.'),
        intent: z.enum(INTENTS).describe('What the action does to this task.'),
        label: z.string().max(128).optional(),
        valueSchema: z
          .record(z.string(), z.unknown())
          .optional()
          .describe('JSON Schema the action’s value must satisfy.'),
      }),
    )
    .max(32)
    .optional()
    .describe('The actions the surface offers. A component can raise only an event named here.'),
  baseRevision: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('The revision this update builds on, when updating.'),
});

type Input = z.infer<typeof input>;

function commandIdOf(taskId: string, proposal: Input): string {
  const digest = new Bun.CryptoHasher('sha256')
    .update(
      JSON.stringify([
        taskId,
        proposal.surfaceId,
        proposal.baseRevision ?? null,
        proposal.messages,
        proposal.actions ?? null,
      ]),
    )
    .digest('hex');
  return `a2ui-${digest.slice(0, 40)}`;
}

/**
 * Creates the `propose-a2ui-surface` tool for one task.
 *
 * @experimental
 */
export function createProposeA2uiSurfaceTool(options: ProposeA2uiSurfaceToolOptions) {
  const { adapter, taskId, continuationFor, supportedCatalogIds } = options;
  return createTool({
    name: 'propose-a2ui-surface',
    description:
      'Show the user an interactive surface (an A2UI v0.9.1 UI made from the basic catalog). The proposal is validated; if it is refused, the result lists what to fix. Actions only offer choices to the user: you cannot make an action run a tool.',
    input,
    execute: async (proposal: Input) => {
      const actions: InteractiveSurfaceActionDefinition[] = [];
      for (const declared of proposal.actions ?? []) {
        const continuation = continuationFor?.({ name: declared.name, intent: declared.intent });
        if (continuation === undefined) {
          return JSON.stringify({
            outcome: 'rejected',
            reason: 'unsupported-capability',
            detail: `Action "${declared.name}" cannot be offered here; this surface can only display.`,
            issues: [
              { path: `/actions/${declared.name}`, message: 'no continuation is available' },
            ],
          });
        }
        actions.push({
          name: declared.name,
          intent: declared.intent,
          continuation,
          ...(declared.label === undefined ? {} : { label: declared.label }),
          ...(declared.valueSchema === undefined
            ? {}
            : {
                valueSchema:
                  declared.valueSchema as InteractiveSurfaceActionDefinition['valueSchema'],
              }),
        });
      }
      const result = await adapter.apply(
        {
          taskId,
          commandId: commandIdOf(taskId, proposal),
          messages: proposal.messages.map((message) => ({ ...message })),
          ...(proposal.summary === undefined ? {} : { summary: proposal.summary }),
          ...(proposal.actions === undefined ? {} : { actions }),
          ...(supportedCatalogIds === undefined ? {} : { supportedCatalogIds }),
          ...(proposal.baseRevision === undefined ? {} : { baseRevision: proposal.baseRevision }),
          complete: !proposal.messages.some((message) => 'deleteSurface' in message),
        },
        { taskId },
      );
      if (result.outcome === 'rejected') {
        return JSON.stringify({
          outcome: 'rejected',
          reason: result.reason,
          detail: result.detail,
          issues: result.issues,
          ...(result.currentRevision === undefined
            ? {}
            : { currentRevision: result.currentRevision }),
        });
      }
      return JSON.stringify({
        outcome: 'accepted',
        surfaceId: proposal.surfaceId,
        revision: result.receipt.committedRevision,
      });
    },
  });
}
