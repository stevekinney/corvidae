/**
 * The interpreter: one workflow definition bound to one validated document.
 * It runs the document's steps in order, so no agent-written code runs: the
 * only code involved is the host's registered activity handlers.
 *
 * @module document-workflow/interpreter
 */

import {
  activity,
  signal,
  workflow,
  type WorkflowContext,
  type WorkflowDefinition,
} from '../core/types.ts';
import type { DocumentWorkflowHost, WorkflowDocument } from './document.ts';
import { WorkflowDocumentSchemaError, workflowDocumentVersion } from './document.ts';

/** The distinct values `pick` selects from the document's steps, in first-seen order. */
function distinctStepValues(
  document: WorkflowDocument,
  pick: (step: WorkflowDocument['steps'][number]) => string | undefined,
): string[] {
  const values = new Set<string>();
  for (const step of document.steps) {
    const value = pick(step);
    if (value !== undefined) values.add(value);
  }
  return [...values];
}

/**
 * Build the workflow definition that interprets `document`. Its version is the
 * document's {@link workflowDocumentVersion}. Its `.activities()` map holds
 * exactly the handlers the document's activity steps name, and its
 * `.signals()` map exactly the signals its `await-signal` steps wait for, so
 * both appear in the contract.
 */
export async function buildDocumentWorkflowDefinition(
  document: WorkflowDocument,
  host: DocumentWorkflowHost,
): Promise<WorkflowDefinition> {
  const activities = Object.fromEntries(
    distinctStepValues(document, (step) =>
      step.kind === 'activity' ? step.handler : undefined,
    ).map((name) => {
      const handler = host.activities[name]!;
      return [
        name,
        activity({ name, execute: (argument: Parameters<typeof handler>[0]) => handler(argument) }),
      ];
    }),
  );
  const signalNames = distinctStepValues(document, (step) =>
    step.kind === 'await-signal' ? step.signal : undefined,
  );

  /** Throws when the host finds `value` outside the schema; a no-op for a document with none. */
  const checkSchema = (point: 'input' | 'output', value: unknown): void => {
    const schema = point === 'input' ? document.inputSchema : document.outputSchema;
    if (schema === undefined || host.checkSchema === undefined) return;
    const issues = host.checkSchema(point, schema, value);
    if (issues.length > 0) throw new WorkflowDocumentSchemaError(`${point}-invalid`, issues);
  };

  const run = async function* (context: WorkflowContext, trigger: unknown) {
    const firedBy = trigger === undefined ? null : trigger;
    // Pure, and the same on a replay: it reads the recorded input and yields nothing.
    checkSchema('input', firedBy);
    let previous: unknown = null;
    for (const [index, step] of document.steps.entries()) {
      switch (step.kind) {
        case 'activity':
          previous = yield* context.run(step.handler, {
            input: step.input ?? null,
            trigger: firedBy,
            previous,
            workflowId: context.workflowId,
            step: index,
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
    checkSchema('output', previous);
    return previous;
  };

  const builder = workflow({
    name: document.name,
    version: await workflowDocumentVersion(document),
  }).activities(activities);
  // A document that awaits no signal declares none, so its contract carries no `signals` entry.
  return signalNames.length === 0
    ? builder.execute(run)
    : builder
        .signals(Object.fromEntries(signalNames.map((name) => [name, signal(name)])))
        .execute(run);
}
