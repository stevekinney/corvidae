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
import {
  documentStepAddress,
  WorkflowDocumentBranchError,
  WorkflowDocumentMapError,
  WorkflowDocumentSchemaError,
  workflowDocumentVersion,
} from './document.ts';

/** The distinct values `pick` selects from the document's steps, in first-seen order. */
function distinctStepValues(
  document: WorkflowDocument,
  pick: (step: WorkflowDocument['steps'][number]) => string | undefined,
): string[] {
  const values = new Set<string>();
  const visit = (steps: readonly WorkflowDocument['steps'][number][]): void => {
    for (const step of steps) {
      const value = pick(step);
      if (value !== undefined) values.add(value);
      if (step.kind === 'branch') {
        branchCaseSteps(step).forEach(visit);
        if (step.otherwise !== undefined) visit(step.otherwise);
      } else if (step.kind === 'map') visit(step.steps);
    }
  };
  visit(document.steps);
  return [...values];
}

/** Traverse branch cases in the same UTF-16 key order used by canonical document JSON. */
function branchCaseSteps(
  step: Extract<WorkflowDocument['steps'][number], { kind: 'branch' }>,
): readonly (readonly WorkflowDocument['steps'][number][])[] {
  return Object.keys(step.cases)
    .toSorted()
    .map((literal) => Object.getOwnPropertyDescriptor(step.cases, literal)?.value ?? []);
}

function documentStepIndexes(
  document: WorkflowDocument,
): Map<WorkflowDocument['steps'][number], number> {
  const indexes = new Map<WorkflowDocument['steps'][number], number>();
  let next = 0;
  const visit = (steps: readonly WorkflowDocument['steps'][number][]): void => {
    for (const step of steps) {
      indexes.set(step, next++);
      if (step.kind === 'branch') {
        branchCaseSteps(step).forEach(visit);
        if (step.otherwise !== undefined) visit(step.otherwise);
      } else if (step.kind === 'map') visit(step.steps);
    }
  };
  visit(document.steps);
  return indexes;
}

function* documentOperation<T>(
  operation: Generator<unknown, T, unknown>,
  documentStep: number,
  stepAddress: string,
): Generator<ContextOperationRequest, T, unknown> {
  let input: unknown;
  while (true) {
    const result = operation.next(input);
    if (result.done) return result.value;
    const request = result.value as ContextOperationRequest;
    if (request.type === 'activity' || request.type === 'sleep' || request.type === 'wait-signal') {
      request.documentStep = documentStep;
      request.documentStepAddress = stepAddress;
    }
    input = yield request;
  }
}

/**
 * Activity retry backoff is an engine operation, not a document step. Mark only
 * the activity dispatches yielded by the retry generator so a retry does not
 * create a file-workflow sleep event or inherit the engine's step counter.
 */
export function* documentActivityOperation<T>(
  operation: Generator<unknown, T, unknown>,
  documentStep: number,
  stepAddress: string,
): Generator<ContextOperationRequest, T, unknown> {
  let input: unknown;
  while (true) {
    const result = operation.next(input);
    if (result.done) return result.value;
    const request = result.value as ContextOperationRequest;
    if (request.type === 'activity') {
      request.documentStep = documentStep;
      request.documentStepAddress = stepAddress;
    }
    try {
      input = yield request;
    } catch (error) {
      if (operation.throw === undefined) throw error;
      const thrown = operation.throw(error);
      if (thrown.done) return thrown.value;
      const thrownRequest = thrown.value as ContextOperationRequest;
      if (thrownRequest.type === 'activity') {
        thrownRequest.documentStep = documentStep;
        thrownRequest.documentStepAddress = stepAddress;
      }
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
  const stepIndexes = documentStepIndexes(document);
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
    type RunState = { previous: unknown; pendingSignal: unknown; lastStepWasSignal: boolean };
    const runSteps = function* (
      steps: readonly WorkflowDocument['steps'][number][],
      iteration: readonly (string | number)[],
      state: RunState,
    ): Generator<ContextOperationRequest, unknown, unknown> {
      for (const step of steps) {
        const index = stepIndexes.get(step);
        if (index === undefined) throw new Error('Document step is missing from its static index');
        const address = documentStepAddress(index, iteration);
        state.lastStepWasSignal = step.kind === 'await-signal';
        switch (step.kind) {
          case 'activity':
            state.previous = yield* documentActivityOperation(
              context.run(activities.get(step.handler)!, {
                input: step.input ?? null,
                trigger: firedBy,
                previous: state.previous,
                ...(state.pendingSignal === undefined ? {} : { signal: state.pendingSignal }),
                workflowId: context.workflowId,
                step: index,
                iteration,
                stepAddress: address,
              }),
              index,
              address,
            );
            state.pendingSignal = undefined;
            break;
          case 'sleep':
            yield* documentOperation(context.sleep(step.duration), index, address);
            break;
          case 'await-signal':
            state.pendingSignal = yield* documentOperation(
              context.waitForSignal(step.signal),
              index,
              address,
            );
            break;
          case 'branch': {
            const candidate =
              typeof state.previous === 'object' &&
              state.previous !== null &&
              Object.hasOwn(state.previous, step.on)
                ? Object.getOwnPropertyDescriptor(state.previous, step.on)?.value
                : undefined;
            const literal = String(candidate);
            const selected = Object.hasOwn(step.cases, literal)
              ? step.cases[literal]
              : step.otherwise;
            if (selected === undefined) throw new WorkflowDocumentBranchError(step.on, candidate);
            yield* runSteps(selected, iteration, state);
            break;
          }
          case 'map': {
            if (!Array.isArray(state.previous)) {
              throw new WorkflowDocumentMapError(
                'not-array',
                `Map step ${String(index)} requires the previous result to be an array`,
              );
            }
            if (state.previous.length > 1000) {
              throw new WorkflowDocumentMapError(
                'too-many',
                `Map step ${String(index)} cannot iterate more than 1000 items (received ${String(state.previous.length)})`,
              );
            }
            const concurrency = step.concurrency ?? 4;
            const values = state.previous;
            const results: unknown[] = [];
            for (let start = 0; start < values.length; start += concurrency) {
              const batch = values.slice(start, start + concurrency);
              const operations = batch.map((value, offset) => {
                const itemState: RunState = {
                  previous: value,
                  pendingSignal: undefined,
                  lastStepWasSignal: false,
                };
                return (function* () {
                  const result = yield* runSteps(
                    step.steps,
                    [...iteration, start + offset],
                    itemState,
                  );
                  return itemState.lastStepWasSignal
                    ? itemState.pendingSignal
                    : result === undefined
                      ? itemState.previous
                      : result;
                })();
              });
              results.push(...(yield* context.all(operations)));
            }
            state.previous = results;
            state.pendingSignal = undefined;
            break;
          }
        }
      }
      return state.lastStepWasSignal ? state.pendingSignal : state.previous;
    };
    const state: RunState = { previous: null, pendingSignal: undefined, lastStepWasSignal: false };
    const output = yield* runSteps(document.steps, [], state);
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
