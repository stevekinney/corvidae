/**
 * The host COR-1525's interpreter runs a workflow file on (COR-1527): the activities a file's
 * steps may name and the trigger kinds its `trigger` may use. One host is built per engine and
 * frozen, so the handlers a registered revision binds to cannot change under it; Weft keeps the
 * first registration's handlers when a revision is registered again, so an attempt to register on
 * an engine with a different host is refused with {@link WorkflowHostConflictError} rather than
 * silently ignored.
 *
 * @module workflow-host
 */

import {
  type DocumentActivityArgument,
  type DocumentActivityHandler,
  type DocumentTriggerValidator,
  type DocumentWorkflowHost,
  type Engine,
  type JSONValue,
  normalizeScheduleSpec,
  registerWorkflowDocuments,
  type RegisteredWorkflowDocument,
  type WorkflowDocument,
  type WorkflowDocumentSet,
} from '@lostgradient/weft';

import { isMappedHandlerName } from './namespaced-identifier';
import { toScheduleSpec } from './schedule-spec';
import { toWeftDocument } from './workflow-document-handlers';
import { AGENT_STEP_HANDLER } from './workflow-file';
import { checkWorkflowSchema } from './workflow-schema';

/** The overlap policies a `schedule` trigger may name; `skip` when it names none. */
export const SCHEDULE_OVERLAP_POLICIES = ['skip', 'queue', 'cancel-running', 'allow'] as const;
export type ScheduleOverlapPolicy = (typeof SCHEDULE_OVERLAP_POLICIES)[number];

/** Why `trigger` is not a valid `schedule` trigger, or `undefined` when it is. */
export const validateScheduleTrigger: DocumentTriggerValidator = (trigger) => {
  const extra = Object.keys(trigger).filter(
    (key) => key !== 'kind' && key !== 'spec' && key !== 'overlap',
  );
  if (extra.length > 0) {
    return `a schedule trigger takes only "spec" and "overlap"; unknown ${extra.map((key) => `"${key}"`).join(', ')}`;
  }
  const spec = trigger['spec'];
  if (typeof spec !== 'string' || spec.trim() === '') {
    return 'a schedule trigger needs a "spec": a cron expression or a duration such as "1h"';
  }
  try {
    normalizeScheduleSpec(toScheduleSpec(spec));
  } catch (error) {
    return `"spec" is not a valid schedule: ${error instanceof Error ? error.message : String(error)}`;
  }
  const overlap = trigger['overlap'];
  if (
    overlap !== undefined &&
    !SCHEDULE_OVERLAP_POLICIES.includes(overlap as ScheduleOverlapPolicy)
  ) {
    return `"overlap" must be one of ${SCHEDULE_OVERLAP_POLICIES.join(', ')}`;
  }
  return undefined;
};

/** The longest signal name: what `bureau.workflows.signal` admits, so a trigger can always be signalled. */
export const SIGNAL_NAME_MAXIMUM_LENGTH = 256;

/**
 * Why `trigger` is not a valid `signal` trigger, or `undefined` when it is. A signal trigger is
 * exactly `{ kind: 'signal', name }`, where `name` is a non-empty string of at most
 * {@link SIGNAL_NAME_MAXIMUM_LENGTH} characters.
 */
export const validateSignalTrigger: DocumentTriggerValidator = (trigger) => {
  const extra = Object.keys(trigger).filter((key) => key !== 'kind' && key !== 'name');
  if (extra.length > 0) {
    return `a signal trigger takes only "name"; unknown ${extra.map((key) => `"${key}"`).join(', ')}`;
  }
  const name = trigger['name'];
  if (typeof name !== 'string' || name === '') {
    return 'a signal trigger needs a "name": the non-empty name of the signal that starts it';
  }
  if (name.length > SIGNAL_NAME_MAXIMUM_LENGTH) {
    return `a signal trigger's "name" may be at most ${String(SIGNAL_NAME_MAXIMUM_LENGTH)} characters`;
  }
  return undefined;
};

/**
 * The trigger kinds a workflow file may use; a kind that is not here makes the file `invalid`.
 */
export const WORKFLOW_TRIGGER_KINDS: Readonly<Record<string, DocumentTriggerValidator>> = {
  schedule: validateScheduleTrigger,
  signal: validateSignalTrigger,
};

/** What an `agent` step's run returns, and what the next step receives as `previous`. */
export interface AgentStepResult {
  readonly content: string;
  readonly output: JSONValue | null;
  readonly finishReason: string;
}

/** What the `agent` activity hands Bureau to run. */
export interface AgentStepRequest {
  readonly agent: string;
  /** The message with the instance's trigger and previous result appended. */
  readonly message: string;
  /** The instance and the step, which together name this step's run across a restart. */
  readonly workflowId: string;
  readonly step: number;
}

export interface WorkflowHostDependencies {
  /** Run one agent as the deployment's owner and resolve its result; rejects when the run fails. */
  readonly runAgentStep: (request: AgentStepRequest) => Promise<AgentStepResult>;
}

/** Why an `agent` step failed. The message is what `bureau.workflows.runs.get` shows. */
export class WorkflowAgentStepError extends Error {
  readonly code: 'agent-not-found' | 'agent-run-failed' | 'agent-run-aborted';
  readonly agent: string;
  constructor(
    code: 'agent-not-found' | 'agent-run-failed' | 'agent-run-aborted',
    agent: string,
    message: string,
  ) {
    super(message);
    this.name = 'WorkflowAgentStepError';
    this.code = code;
    this.agent = agent;
  }
}

/**
 * The fence around a JSON block: three backticks, or one more than the longest run of backticks
 * inside the JSON, so a string value can never close the block early.
 */
function fenceFor(json: string): string {
  let longest = 0;
  for (const run of json.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  return '`'.repeat(Math.max(3, longest + 1));
}

function block(label: string, value: unknown): string {
  const json = JSON.stringify(value, null, 2);
  const fence = fenceFor(json);
  return `\n\n${label}\n${fence}json\n${json}\n${fence}`;
}

/**
 * The user message an `agent` step sends: `message`, then one fenced JSON block for the
 * instance's trigger and one for the previous step's result, each only when it is neither absent
 * nor `null`.
 */
export function composeAgentMessage(message: string, trigger: unknown, previous: unknown): string {
  let composed = message;
  if (trigger !== undefined && trigger !== null) composed += block('Trigger:', trigger);
  if (previous !== undefined && previous !== null) composed += block('Previous step:', previous);
  return composed;
}

/** Build the frozen host. */
export function createWorkflowDocumentHost(
  dependencies: WorkflowHostDependencies,
): DocumentWorkflowHost {
  return Object.freeze({
    activities: Object.freeze({
      [AGENT_STEP_HANDLER]: async (argument: DocumentActivityArgument) => {
        const { agent, message } = argument.input as { agent: string; message: string };
        return dependencies.runAgentStep({
          agent,
          message: composeAgentMessage(message, argument.trigger, argument.previous),
          workflowId: argument.workflowId,
          step: argument.step,
        });
      },
    }),
    triggerKinds: Object.freeze({ ...WORKFLOW_TRIGGER_KINDS }),
    checkSchema: checkWorkflowSchema,
  });
}

/** Registering workflow documents on an engine whose documents are bound to another host. */
export class WorkflowHostConflictError extends Error {
  readonly code = 'workflow-host-conflict';
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowHostConflictError';
  }
}

const engineHosts = new WeakMap<Engine, DocumentWorkflowHost>();

/** The names a host offers, for the conflict message. */
function describeHost(host: DocumentWorkflowHost): string {
  return `activities [${Object.keys(host.activities).join(', ')}], trigger kinds [${Object.keys(host.triggerKinds).join(', ')}]`;
}

/**
 * Bind `engine` to `host` the first time, and refuse every later call with a different host. Weft
 * keeps the loader and handlers of the first registration of a revision, so a second host would
 * be ignored without a word; this makes the difference an error.
 */
export function bindWorkflowHost(engine: Engine, host: DocumentWorkflowHost): void {
  const bound = engineHosts.get(engine);
  if (bound === undefined) {
    engineHosts.set(engine, host);
    return;
  }
  if (bound !== host) {
    throw new WorkflowHostConflictError(
      `This engine's workflow documents are bound to a host with ${describeHost(bound)}; they cannot be registered with a different host with ${describeHost(host)}. Register into a new engine to change the host.`,
    );
  }
}

/** A document in Bureau's form as Weft receives it; anything that is not one passes through to Weft's own refusal. */
function mapDocumentInput(input: unknown): unknown {
  const steps = (input as { steps?: unknown } | null)?.steps;
  return Array.isArray(steps) ? toWeftDocument(input as WorkflowDocument) : input;
}

/**
 * `host` with the activities registered directly on `engine` under a mapped handler name
 * (`plugin__name`, which a document names as `plugin:name`) added to it. They are looked up when a
 * document is validated or a step runs, so one registered after this call is seen. Only mapped
 * names are bridged: a bare engine activity is never a document handler. The activity receives the
 * same {@link DocumentActivityArgument} a host handler does.
 */
export function bridgeEngineActivities(
  engine: Engine,
  host: DocumentWorkflowHost,
): DocumentWorkflowHost {
  const bridged = (name: string | symbol): DocumentActivityHandler | undefined => {
    if (typeof name !== 'string' || Object.hasOwn(host.activities, name)) return undefined;
    if (!isMappedHandlerName(name)) return undefined;
    if (engine.getActivityFunction(name) === undefined) return undefined;
    return async (argument) => {
      const run = engine.getActivityFunction(name);
      if (run === undefined) throw new Error(`The activity "${name}" is no longer registered.`);
      return run(argument);
    };
  };
  const activities = new Proxy<Record<string, DocumentActivityHandler>>(
    {},
    {
      get: (_target, name) =>
        typeof name === 'string' && Object.hasOwn(host.activities, name)
          ? host.activities[name]
          : bridged(name),
      has: (_target, name) =>
        (typeof name === 'string' && Object.hasOwn(host.activities, name)) ||
        bridged(name) !== undefined,
      ownKeys: () => [
        ...Object.keys(host.activities),
        ...engine
          .listActivityDefinitions()
          .map((definition) => definition.name)
          .filter((name) => !Object.hasOwn(host.activities, name) && isMappedHandlerName(name)),
      ],
      getOwnPropertyDescriptor: (_target, name) => {
        const value =
          typeof name === 'string' && Object.hasOwn(host.activities, name)
            ? host.activities[name]
            : bridged(name);
        return value === undefined
          ? undefined
          : { value, enumerable: true, configurable: true, writable: false };
      },
    },
  );
  return Object.freeze({ ...host, activities });
}

/**
 * Register `documents` on `engine` through `host`: the binding check above, then Weft's
 * `registerWorkflowDocuments`. Call it before the engine recovers.
 */
export async function registerBureauWorkflowDocuments(
  engine: Engine,
  host: DocumentWorkflowHost,
  documents: WorkflowDocumentSet,
): Promise<readonly RegisteredWorkflowDocument[]> {
  bindWorkflowHost(engine, host);
  return registerWorkflowDocuments(engine, host, {
    active: documents.active.map(mapDocumentInput),
    ...(documents.retained === undefined
      ? {}
      : { retained: documents.retained.map(mapDocumentInput) }),
  });
}
