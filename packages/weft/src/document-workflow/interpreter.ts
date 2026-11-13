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
import {
  WorkflowDocumentBranchError,
  WorkflowDocumentMapError,
  WorkflowDocumentReviewRejectedError,
  WorkflowDocumentSchemaError,
} from './document-errors.ts';
import type {
  DocumentActivityArgument,
  DocumentWorkflowHost,
  WorkflowDocument,
} from './document.ts';
import { documentStepAddress, workflowDocumentVersion } from './document.ts';

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
      else if (step.kind === 'parallel')
        parallelBranches(step).forEach(([, nested]) => visit(nested));
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

/** A parallel step's branches in the UTF-16 key order of canonical document JSON. */
function parallelBranches(
  step: Extract<WorkflowDocument['steps'][number], { kind: 'parallel' }>,
): readonly (readonly [string, readonly WorkflowDocument['steps'][number][]])[] {
  return Object.keys(step.branches)
    .toSorted()
    .map((name) => [name, Object.getOwnPropertyDescriptor(step.branches, name)?.value ?? []]);
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
      else if (step.kind === 'parallel')
        parallelBranches(step).forEach(([, nested]) => visit(nested));
    }
  };
  visit(document.steps);
  return indexes;
}

function containsWait(steps: readonly WorkflowDocument['steps'][number][]): boolean {
  return steps.some(
    (step) =>
      step.kind === 'await-signal' ||
      (step.kind === 'branch' &&
        (Object.values(step.cases).some(containsWait) ||
          (step.otherwise !== undefined && containsWait(step.otherwise)))) ||
      (step.kind === 'map' && containsWait(step.steps)) ||
      (step.kind === 'parallel' && Object.values(step.branches).some(containsWait)),
  );
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

function mapSource(
  step: Extract<WorkflowDocument['steps'][number], { kind: 'map' }>,
  index: number,
  previous: unknown,
): readonly unknown[] {
  const source =
    typeof previous === 'object' && previous !== null
      ? Object.getOwnPropertyDescriptor(previous, step.over)?.value
      : undefined;
  if (!Array.isArray(source)) {
    throw new WorkflowDocumentMapError(
      'not-array',
      `Map step ${String(index)} requires field "${step.over}" of the previous result to be an array`,
    );
  }
  if (source.length > 1000) {
    throw new WorkflowDocumentMapError(
      'too-many',
      `Map step ${String(index)} cannot iterate more than 1000 items (received ${String(source.length)})`,
    );
  }
  return source;
}

/**
 * A settled round reports a rejection in its durable `{ name, message }` form, on
 * the live run and on a replay alike. Rebuild an `Error` before throwing it into
 * the item's generator so retry policies (`nonRetryableErrors`) and the run's
 * failure see an error, not a plain record.
 */
function rejectionError(reason: unknown): Error {
  if (reason instanceof Error) return reason;
  const { name, message } = (typeof reason === 'object' && reason !== null ? reason : {}) as {
    name?: unknown;
    message?: unknown;
  };
  const error = new Error(typeof message === 'string' ? message : String(reason));
  if (typeof name === 'string') error.name = name;
  return error;
}

function* runMapBatch(
  context: WorkflowContext,
  generators: Generator<ContextOperationRequest, unknown, unknown>[],
): Generator<ContextOperationRequest, unknown[], unknown> {
  const itemResults: unknown[] = Array.from({ length: generators.length });
  let pending: {
    generator: Generator<ContextOperationRequest, unknown, unknown>;
    itemIndex: number;
    resume: { kind: 'next'; value: unknown } | { kind: 'throw'; error: unknown };
  }[] = generators.map((generator, itemIndex) => ({
    generator,
    itemIndex,
    resume: { kind: 'next', value: undefined },
  }));
  while (pending.length > 0) {
    const nextPending: typeof pending = [];
    const operations: Generator<ContextOperationRequest, unknown, unknown>[] = [];
    for (const entry of pending) {
      const next =
        entry.resume.kind === 'throw'
          ? entry.generator.throw(entry.resume.error)
          : entry.generator.next(entry.resume.value);
      if (next.done) itemResults[entry.itemIndex] = next.value;
      else {
        operations.push(
          (function* (): Generator<ContextOperationRequest, unknown, unknown> {
            return yield next.value;
          })(),
        );
        nextPending.push(entry);
      }
    }
    if (operations.length === 0) break;
    const operationResults = yield* context.allSettled(operations) as unknown as Generator<
      ContextOperationRequest,
      unknown[],
      unknown
    >;
    for (let resultIndex = 0; resultIndex < nextPending.length; resultIndex++) {
      const outcome = operationResults[resultIndex] as
        { status: 'fulfilled'; value: unknown } | { status: 'rejected'; reason: unknown };
      nextPending[resultIndex]!.resume =
        outcome.status === 'fulfilled'
          ? { kind: 'next', value: outcome.value }
          : { kind: 'throw', error: rejectionError(outcome.reason) };
    }
    pending = nextPending;
  }
  return itemResults;
}

function branchSteps(
  step: Extract<WorkflowDocument['steps'][number], { kind: 'branch' }>,
  previous: unknown,
): readonly WorkflowDocument['steps'][number][] {
  const candidate =
    typeof previous === 'object' && previous !== null && Object.hasOwn(previous, step.on)
      ? Object.getOwnPropertyDescriptor(previous, step.on)?.value
      : undefined;
  const literal = String(candidate);
  const selected = Object.hasOwn(step.cases, literal) ? step.cases[literal] : step.otherwise;
  if (selected === undefined) throw new WorkflowDocumentBranchError(step.on, candidate);
  return selected;
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
  const workflowVersion = await workflowDocumentVersion(document);
  const revision = { name: document.name, workflowVersion };

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
    type RunSteps = (
      steps: readonly WorkflowDocument['steps'][number][],
      iteration: readonly (string | number)[],
      state: RunState,
    ) => Generator<ContextOperationRequest, unknown, unknown>;
    const indexOf = (step: WorkflowDocument['steps'][number]): number => {
      const index = stepIndexes.get(step);
      if (index === undefined) throw new Error('Document step is missing from its static index');
      return index;
    };
    function* runMap(
      step: Extract<WorkflowDocument['steps'][number], { kind: 'map' }>,
      index: number,
      iteration: readonly (string | number)[],
      state: RunState,
      runNested: RunSteps,
    ): Generator<ContextOperationRequest, void, unknown> {
      const source = mapSource(step, index, state.previous);
      const results: unknown[] = [];
      if (containsWait(step.steps)) {
        for (const [offset, value] of source.entries()) {
          const itemState: RunState = {
            previous: value,
            pendingSignal: undefined,
            lastStepWasSignal: false,
          };
          yield* runNested(step.steps, [...iteration, offset], itemState);
          results.push(itemState.lastStepWasSignal ? itemState.pendingSignal : itemState.previous);
        }
      } else {
        const batchSize = step.concurrency ?? 4;
        for (let start = 0; start < source.length; start += batchSize) {
          const generators = source.slice(start, start + batchSize).map((value, offset) => {
            const itemState: RunState = {
              previous: value,
              pendingSignal: undefined,
              lastStepWasSignal: false,
            };
            return (function* (): Generator<ContextOperationRequest, unknown, unknown> {
              return yield* runNested(step.steps, [...iteration, start + offset], itemState);
            })();
          });
          results.push(...(yield* runMapBatch(context, generators)));
        }
      }
      state.previous = results;
      state.pendingSignal = undefined;
    }
    /** Lockstep `ctx.allSettled` rounds, cached whole: see `parallel` in document.ts for the limit. */
    function* runParallel(
      step: Extract<WorkflowDocument['steps'][number], { kind: 'parallel' }>,
      iteration: readonly (string | number)[],
      state: RunState,
      runNested: RunSteps,
    ): Generator<ContextOperationRequest, void, unknown> {
      const branches = parallelBranches(step);
      const generators = branches.map(([name, nested]) => {
        const branchState: RunState = {
          previous: state.previous,
          pendingSignal: undefined,
          lastStepWasSignal: false,
        };
        return (function* (): Generator<ContextOperationRequest, unknown, unknown> {
          return yield* runNested(nested, [...iteration, name], branchState);
        })();
      });
      const results = yield* runMapBatch(context, generators);
      state.previous = Object.fromEntries(
        branches.map(([name], offset) => [name, results[offset]]),
      );
      state.pendingSignal = undefined;
    }
    /** One `activity` step: the handler runs with the step before it as `previous`. */
    function* runActivity(
      step: Extract<WorkflowDocument['steps'][number], { kind: 'activity' }>,
      index: number,
      iteration: readonly (string | number)[],
      address: string,
      state: RunState,
    ): Generator<ContextOperationRequest, void, unknown> {
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
    }
    /** One `await-signal` step: a plain wait, or one that races a sleep when it has a `timeout`. */
    function* runAwaitSignal(
      step: Extract<WorkflowDocument['steps'][number], { kind: 'await-signal' }>,
      index: number,
      address: string,
      state: RunState,
    ): Generator<ContextOperationRequest, void, unknown> {
      if (step.timeout === undefined) {
        state.pendingSignal = yield* documentOperation(
          context.waitForSignal(step.signal),
          index,
          address,
        );
      } else {
        // The wait races a sleep: whichever finishes first is the recorded winner, so a
        // replay takes the same side without asking the clock again.
        const outcome = yield* documentOperation(
          context.raceKeyed({
            signal: documentOperation(context.waitForSignal(step.signal), index, address),
            timeout: context.sleep(step.timeout),
          }),
          index,
          address,
        );
        if (outcome.key === 'timeout') {
          // The marker takes the place of `previous`, exactly as an activity's result would.
          state.previous = { timedOut: true };
          state.pendingSignal = undefined;
          state.lastStepWasSignal = false;
          return;
        }
        state.pendingSignal = outcome.value;
      }
      // Pure and replayed from the recorded payload: a rejection ends the run before any later step.
      if (host.isRejection?.(state.pendingSignal, { ...revision, step: index }) === true) {
        throw new WorkflowDocumentReviewRejectedError();
      }
    }
    const runSteps = function* (
      steps: readonly WorkflowDocument['steps'][number][],
      iteration: readonly (string | number)[],
      state: RunState,
    ): Generator<ContextOperationRequest, unknown, unknown> {
      for (const step of steps) {
        const index = indexOf(step);
        const address = documentStepAddress(index, iteration);
        state.lastStepWasSignal = step.kind === 'await-signal';
        switch (step.kind) {
          case 'activity':
            yield* runActivity(step, index, iteration, address, state);
            break;
          case 'sleep':
            yield* documentOperation(context.sleep(step.duration), index, address);
            break;
          case 'await-signal':
            yield* runAwaitSignal(step, index, address, state);
            break;
          case 'branch': {
            yield* runSteps(branchSteps(step, state.previous), iteration, state);
            break;
          }
          case 'map': {
            yield* runMap(step, index, iteration, state, runSteps);
            break;
          }
          case 'parallel': {
            yield* runParallel(step, iteration, state, runSteps);
            state.lastStepWasSignal = false;
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
    version: workflowVersion,
    tags: ['file-workflow'],
  }).activities(Object.fromEntries(activities));
  // A document that awaits no signal declares none, so its contract carries no `signals` entry.
  return signalNames.length === 0
    ? builder.execute(run)
    : builder
        .signals(Object.fromEntries(signalNames.map((name) => [name, signal(name)])))
        .execute(run);
}
