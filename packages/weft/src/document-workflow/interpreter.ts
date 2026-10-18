/**
 * The interpreter: one workflow definition bound to one validated document.
 * It runs the document's steps in order, so no agent-written code runs: the
 * only code involved is the host's registered activity handlers.
 *
 * @module document-workflow/interpreter
 */

import {
  activity,
  workflow,
  type WorkflowContext,
  type WorkflowDefinition,
} from '../core/types.ts';
import type { DocumentWorkflowHost, WorkflowDocument } from './document.ts';
import { workflowDocumentVersion } from './document.ts';

/**
 * Build the workflow definition that interprets `document`. Its version is the
 * document's {@link workflowDocumentVersion}, and its `.activities()` map holds
 * exactly the handlers the document's activity steps name, so those steps
 * appear in the contract's activity list.
 */
export async function buildDocumentWorkflowDefinition(
  document: WorkflowDocument,
  host: DocumentWorkflowHost,
): Promise<WorkflowDefinition> {
  const handlerNames = new Set<string>();
  for (const step of document.steps) {
    if (step.kind === 'activity') handlerNames.add(step.handler);
  }
  const activities = Object.fromEntries(
    [...handlerNames].map((name) => {
      const handler = host.activities[name]!;
      return [
        name,
        activity({ name, execute: (argument: Parameters<typeof handler>[0]) => handler(argument) }),
      ];
    }),
  );

  return workflow({ name: document.name, version: await workflowDocumentVersion(document) })
    .activities(activities)
    .execute(async function* (context: WorkflowContext, trigger: unknown) {
      const firedBy = trigger === undefined ? null : trigger;
      let previous: unknown = null;
      for (const step of document.steps) {
        switch (step.kind) {
          case 'activity':
            previous = yield* context.run(step.handler, {
              input: step.input ?? null,
              trigger: firedBy,
              previous,
            });
            break;
          case 'sleep':
            yield* context.sleep(step.duration);
            previous = null;
            break;
          case 'await-signal':
            previous = yield* context.waitForSignal(step.signal);
            break;
        }
      }
      return previous;
    });
}
