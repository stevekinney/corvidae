/**
 * The interpreter: one workflow definition bound to one validated document.
 * It runs the document's steps in order, so no agent-written code runs: the
 * only code involved is the host's registered activity handlers.
 *
 * @module document-workflow/interpreter
 */

import type { ContextOperationRequest } from '../core/context/operation-request.ts';
import {
  activity,
  signal,
  workflow,
  type ActivityContext,
  type WorkflowContext,
  type WorkflowDefinition,
} from '../core/types.ts';
import type {
  DocumentActivityArgument,
  DocumentWorkflowHost,
  WorkflowDocument,
} from './document.ts';
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

function* documentOperation<T>(
  operation: Generator<unknown, T, unknown>,
  documentStep: number,
): Generator<ContextOperationRequest, T, unknown> {
  let input: unknown;
  while (true) {
    const result = operation.next(input);
    if (result.done) return result.value;
    const request = result.value as ContextOperationRequest;
    if (request.type === 'activity' || request.type === 'sleep' || request.type === 'wait-signal') {
      request.documentStep = documentStep;
    }
    input = yield request;
  }
}

/**
 * Activity retry backoff is an engine operation, not a document step. Mark only
 * the activity dispatches yielded by the retry generator so a retry does not
 * create a file-workflow sleep event or inherit the engine's step counter.
 */
function* documentActivityOperation<T>(
  operation: Generator<unknown, T, unknown>,
  documentStep: number,
): Generator<ContextOperationRequest, T, unknown> {
  let input: unknown;
  while (true) {
    const result = operation.next(input);
    if (result.done) return result.value;
    const request = result.value as ContextOperationRequest;
    if (request.type === 'activity') request.documentStep = documentStep;
    try {
      input = yield request;
    } catch (error) {
      if (operation.throw === undefined) throw error;
      const thrown = operation.throw(error);
      if (thrown.done) return thrown.value;
      const thrownRequest = thrown.value as ContextOperationRequest;
      if (thrownRequest.type === 'activity') thrownRequest.documentStep = documentStep;
      input = yield thrownRequest;
    }
  }
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
  const activities = new Map(
    distinctStepValues(document, (step) =>
      step.kind === 'activity' ? step.handler : undefined,
    ).map((name) => {
      const registered = host.activities[name]!;
      const settings = typeof registered === 'function' ? {} : registered;
      const execute = typeof registered === 'function' ? registered : registered.execute;
      return [
        name,
        // The settings are spread under the name and the execute wrapper, so a definition's
        // retry, timeout, verifier and the rest are the activity's own, as in a code workflow.
        activity({
          ...settings,
          name,
          execute: (argument: DocumentActivityArgument, activityContext?: ActivityContext) =>
            execute(argument, activityContext),
        }),
      ] as const;
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
    let pendingSignal: unknown;
    for (const [index, step] of document.steps.entries()) {
      switch (step.kind) {
        case 'activity':
          // The activity itself, not its name: `ctx.run` reads the retry policy and the
          // per-attempt timeout from the activity it is given, and a name carries neither.
          previous = yield* documentActivityOperation(
            context.run(activities.get(step.handler)!, {
              input: step.input ?? null,
              trigger: firedBy,
              previous,
              ...(pendingSignal === undefined ? {} : { signal: pendingSignal }),
              workflowId: context.workflowId,
              step: index,
            }),
            index,
          );
          pendingSignal = undefined;
          break;
        case 'sleep':
          yield* documentOperation(context.sleep(step.duration), index);
          break;
        case 'await-signal':
          pendingSignal = yield* documentOperation(context.waitForSignal(step.signal), index);
          break;
      }
    }
    const output = document.steps.at(-1)?.kind === 'await-signal' ? pendingSignal : previous;
    checkSchema('output', output);
    return output;
  };

  const builder = workflow({
    name: document.name,
    version: await workflowDocumentVersion(document),
    tags: ['file-workflow'],
  }).activities(Object.fromEntries(activities));
  // A document that awaits no signal declares none, so its contract carries no `signals` entry.
  return signalNames.length === 0
    ? builder.execute(run)
    : builder
        .signals(Object.fromEntries(signalNames.map((name) => [name, signal(name)])))
        .execute(run);
}
