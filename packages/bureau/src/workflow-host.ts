import { readRunWorkspaceAuthority, type RunWorkspaceAuthority } from 'armorer';
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
  type DocumentActivity,
  type DocumentActivityArgument,
  type DocumentActivityHandler,
  type DocumentTriggerValidator,
  type DocumentWorkflowHost,
  type Engine,
  type JSONValue,
  normalizeScheduleSpec,
  definitionSchemaToJsonSchema,
  registerWorkflowDocuments,
  type RegisteredWorkflowDocument,
  type WorkflowDocumentSet,
  workflowDocumentStepSchema,
} from '@lostgradient/weft';
import { z } from 'zod';

import { fromWeftName, isMappedWeftName, isNamespacedIdentifier } from './namespaced-identifier';
import { NO_WORKFLOW_CONTRIBUTIONS, type WorkflowContributions } from './workflow-contributions';
import { toScheduleSpec } from './schedule-spec';
import { isHumanWaitRejection } from './human-wait-signal';
import { toWeftDocumentInput } from './workflow-document-handlers';
import { AGENT_STEP_HANDLER, scheduleTriggerExtensionIssue, TRIGGER_KEYS } from './workflow-file';
import { checkWorkflowSchema, workflowInputOf } from './workflow-schema';

export interface WorkflowCatalog {
  readonly stepKinds: readonly {
    readonly kind: string;
    readonly fields: Readonly<Record<string, unknown>>;
  }[];
  readonly activities: readonly {
    readonly id: string;
    /** What the editor calls the activity: a plugin activity's required `title`; fixed for `agent`. */
    readonly title: string | null;
    readonly description: string | null;
    readonly inputSchema: Readonly<Record<string, unknown>> | null;
  }[];
  readonly triggers: readonly {
    readonly id: string;
    readonly description: string;
    readonly configuration: Readonly<Record<string, unknown>> | null;
  }[];
}

function schemaOf(schema: unknown): Readonly<Record<string, unknown>> | null {
  if (schema === undefined) return null;
  try {
    return definitionSchemaToJsonSchema(
      schema as Parameters<typeof definitionSchemaToJsonSchema>[0],
    );
  } catch {
    return null;
  }
}

/** The JSON Schema contracts enforced by Bureau's built-in workflow trigger validators. */
export const WORKFLOW_TRIGGER_CONFIGURATION_SCHEMAS = {
  schedule: {
    type: 'object',
    properties: {
      spec: { type: 'string', minLength: 1 },
      overlap: { enum: ['skip', 'queue', 'cancel-running', 'allow'] },
      timezone: { type: 'string' },
      catchUp: { type: 'boolean' },
      name: { type: 'string', minLength: 1, maxLength: 120 },
      input: {},
    },
    required: ['spec'],
    additionalProperties: false,
  },
  signal: {
    type: 'object',
    properties: { name: { type: 'string', minLength: 1, maxLength: 256 } },
    required: ['name'],
    additionalProperties: false,
  },
  manual: { type: 'object', additionalProperties: false },
} as const;

/** Build the workflow editor catalog from the exact host registrations. */
export function workflowCatalogOf(
  host: DocumentWorkflowHost,
  contributions: WorkflowContributions,
): WorkflowCatalog {
  const stepSchema = z.toJSONSchema(workflowDocumentStepSchema, {
    io: 'input',
    unrepresentable: 'any',
  }) as {
    properties?: { kind?: { enum?: string[] }; [key: string]: unknown };
  };
  const variants =
    (
      stepSchema as {
        oneOf?: { properties?: Record<string, unknown> }[];
        anyOf?: { properties?: Record<string, unknown> }[];
      }
    ).oneOf ??
    (stepSchema as { anyOf?: { properties?: Record<string, unknown> }[] }).anyOf ??
    [];
  const stepKinds =
    variants.map((variant) => ({
      kind: String((variant.properties?.['kind'] as { const?: string })?.const),
      fields: Object.fromEntries(
        Object.entries(variant.properties ?? {}).filter(([key]) => key !== 'kind'),
      ),
    })) ?? [];
  const activities = Object.entries(host.activities).map(([name, activity]) => {
    const id = fromWeftName(name) ?? name;
    const definition = typeof activity === 'function' ? undefined : activity;
    return {
      id,
      title: Object.hasOwn(contributions.activityTitles, name)
        ? contributions.activityTitles[name]!
        : id === AGENT_STEP_HANDLER
          ? 'Run an agent'
          : null,
      description:
        definition?.description ?? (id === AGENT_STEP_HANDLER ? 'Run a Bureau agent.' : null),
      inputSchema:
        schemaOf(definition?.inputSchema) ??
        (id === AGENT_STEP_HANDLER
          ? schemaOf(z.object({ agent: z.string(), message: z.string() }))
          : null),
    };
  });
  const builtInTriggers = [
    {
      id: 'schedule',
      description: 'Start on a schedule.',
      configuration: WORKFLOW_TRIGGER_CONFIGURATION_SCHEMAS.schedule,
    },
    {
      id: 'signal',
      description: 'Start when a signal is delivered.',
      configuration: WORKFLOW_TRIGGER_CONFIGURATION_SCHEMAS.signal,
    },
    {
      id: 'manual',
      description: 'Start only when explicitly started.',
      configuration: WORKFLOW_TRIGGER_CONFIGURATION_SCHEMAS.manual,
    },
  ];
  const pluginTriggers = [...contributions.triggers.values()].map((entry) => ({
    id: entry.name,
    description: entry.value.description,
    configuration: schemaOf(entry.value.configuration),
  }));
  return { stepKinds, activities, triggers: [...builtInTriggers, ...pluginTriggers] };
}

/** The overlap policies a `schedule` trigger may name; `skip` when it names none. */
export const SCHEDULE_OVERLAP_POLICIES = ['skip', 'queue', 'cancel-running', 'allow'] as const;
export type ScheduleOverlapPolicy = (typeof SCHEDULE_OVERLAP_POLICIES)[number];

/** Why `trigger` is not a valid `schedule` trigger, or `undefined` when it is. */
export const validateScheduleTrigger: DocumentTriggerValidator = (trigger) => {
  const extra = Object.keys(trigger).filter(
    (key) => key !== 'kind' && !TRIGGER_KEYS['schedule']!.includes(key),
  );
  if (extra.length > 0) {
    return `a schedule trigger takes only "spec", "overlap", "timezone", "catchUp", "name", and "input"; unknown ${extra.map((key) => `"${key}"`).join(', ')}`;
  }
  const extension = scheduleTriggerExtensionIssue(trigger);
  if (extension !== undefined) return extension;
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
  const extra = Object.keys(trigger).filter(
    (key) => key !== 'kind' && !TRIGGER_KEYS['signal']!.includes(key),
  );
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
 * Why `trigger` is not a valid `manual` trigger (COR-2009), or `undefined` when it is. A manual
 * trigger is exactly `{ kind: 'manual' }`: the workflow starts only when someone starts it.
 */
export const validateManualTrigger: DocumentTriggerValidator = (trigger) => {
  const extra = Object.keys(trigger).filter((key) => key !== 'kind');
  if (extra.length > 0) {
    return `a manual trigger takes no other key; unknown ${extra.map((key) => `"${key}"`).join(', ')}`;
  }
  return undefined;
};

/**
 * The trigger kinds a workflow file may use; a kind that is not here makes the file `invalid`.
 */
export const WORKFLOW_TRIGGER_KINDS: Readonly<Record<string, DocumentTriggerValidator>> = {
  schedule: validateScheduleTrigger,
  signal: validateSignalTrigger,
  manual: validateManualTrigger,
};

/** What an `agent` step's run returns, and what the next step receives as `previous`. */
export interface AgentStepResult {
  readonly content: string;
  readonly output: JSONValue | null;
  readonly finishReason: string;
}

/** What the `agent` activity hands Bureau to run. */
export interface AgentStepRequest {
  readonly workspaceAuthority?: RunWorkspaceAuthority | undefined;
  readonly agent: string;
  /** The message with the instance's trigger and previous result appended. */
  readonly message: string;
  /** The instance and the step, which together name this step's run across a restart. */
  readonly workflowId: string;
  readonly step: number;
  readonly stepAddress?: string;
}

export interface WorkflowHostDependencies {
  /** Current authority at each activity callback, including contributed activities. */
  readonly admitActivity?: ((argument: DocumentActivityArgument) => Promise<void>) | undefined;
  /** Run one agent as the deployment's owner and resolve its result; rejects when the run fails. */
  readonly runAgentStep: (request: AgentStepRequest) => Promise<AgentStepResult>;
  /**
   * The contributed activities and trigger kinds a file may also name (COR-1874); none for a
   * Bureau without plugins.
   */
  readonly contributions?: WorkflowContributions | undefined;
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
 * instance's trigger, the previous activity's result, and any awaited signal payload.
 * Absent and null values are omitted.
 */
export function composeAgentMessage(
  message: string,
  trigger: unknown,
  previous: unknown,
  signal?: unknown,
): string {
  let composed = message;
  if (trigger !== undefined && trigger !== null) {
    const visibleTrigger =
      typeof trigger === 'object' && workflowInputOf(trigger) !== trigger
        ? Object.fromEntries(
            Object.entries(trigger).filter(
              ([key]) => key !== 'workspaceAuthority' && key !== 'authorityHold',
            ),
          )
        : trigger;
    composed += block('Trigger:', visibleTrigger);
  }
  if (previous !== undefined && previous !== null) composed += block('Previous step:', previous);
  if (signal !== undefined && signal !== null) composed += block('Signal:', signal);
  return composed;
}

/** Build the frozen host. */
export function createWorkflowDocumentHost(
  dependencies: WorkflowHostDependencies,
): DocumentWorkflowHost {
  const contributions = dependencies.contributions ?? NO_WORKFLOW_CONTRIBUTIONS;
  const activities: Record<string, DocumentActivity> = {
    ...contributions.activities,
    [AGENT_STEP_HANDLER]: async (argument: DocumentActivityArgument) => {
      const { agent, message } = argument.input as { agent: string; message: string };
      const trigger = argument.trigger;
      const workspaceAuthority = readRunWorkspaceAuthority(
        typeof trigger === 'object' && trigger !== null
          ? Reflect.get(trigger, 'workspaceAuthority')
          : undefined,
      );
      return dependencies.runAgentStep({
        agent,
        message: composeAgentMessage(message, argument.trigger, argument.previous, argument.signal),
        workflowId: argument.workflowId,
        step: argument.step,
        ...(argument.stepAddress === undefined ? {} : { stepAddress: argument.stepAddress }),
        ...(workspaceAuthority === undefined ? {} : { workspaceAuthority }),
      });
    },
  };
  return Object.freeze({
    activities: Object.freeze(
      Object.fromEntries(
        Object.entries(activities).map(([name, activity]) => {
          if (dependencies.admitActivity === undefined) return [name, activity];
          const execute: DocumentActivityHandler = async (argument, context) => {
            await dependencies.admitActivity!(argument);
            return typeof activity === 'function'
              ? activity(argument, context)
              : activity.execute(argument, context);
          };
          return [name, typeof activity === 'function' ? execute : { ...activity, execute }];
        }),
      ),
    ),
    triggerKinds: Object.freeze({ ...contributions.triggerValidators, ...WORKFLOW_TRIGGER_KINDS }),
    checkSchema: checkWorkflowSchema,
    activityVersions: contributions.activityVersions,
  });
}

/**
 * Which `await-signal` steps of a revision are reviews (`review: true`), by their canonical
 * preorder index; `undefined` for a revision Bureau holds no file or saved version of.
 */
export type ReviewStepsOfRevision = (
  name: string,
  workflowVersion: string,
) => ReadonlySet<number> | undefined;

/**
 * `host` with the rule that a rejected review ends the run (COR-2238). Weft never sees `review`,
 * so it asks, with the step it is at, whether a payload is a rejection: it is one only at a step
 * of `reviews`, whoever sent it (`bureau.reviews.resolve` or a hand-sent signal). A payload of the
 * same shape on a plain `await-signal` is an ordinary payload that reaches the next step, as it did
 * before. A denial continues either way. Register revisions through the result.
 */
export function withReviewRejection(
  host: DocumentWorkflowHost,
  reviews: ReviewStepsOfRevision,
): DocumentWorkflowHost {
  const guarded: DocumentWorkflowHost = {
    ...host,
    isRejection: (payload, { name, workflowVersion, step }) =>
      isHumanWaitRejection(payload) && reviews(name, workflowVersion)?.has(step) === true,
  };
  return Object.freeze(guarded);
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
    if (!isMappedWeftName(name)) return undefined;
    if (engine.getActivityFunction(name) === undefined) return undefined;
    return async (argument) => {
      const run = engine.getActivityFunction(name);
      if (run === undefined) throw new Error(`The activity "${name}" is no longer registered.`);
      return run(argument);
    };
  };
  const activities = new Proxy<Record<string, DocumentActivity>>(
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
          .filter((name) => !Object.hasOwn(host.activities, name) && isMappedWeftName(name)),
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
 * `host` with every contributed trigger kind (`plugin:name`) accepted, loaded or not. Register a
 * revision through it, never read a file through it: the trigger that starts a workflow is needed
 * by a file, which must name a kind that is loaded, and not by a revision that already has
 * instances, which resumes whatever its plugin has since done to the kind (COR-1874). Its
 * activities are still held to exactly the versions the revision pins.
 */
export function acceptContributedTriggers(host: DocumentWorkflowHost): DocumentWorkflowHost {
  const accept: DocumentTriggerValidator = () => undefined;
  const validatorOf = (name: string | symbol): DocumentTriggerValidator | undefined => {
    if (typeof name !== 'string') return undefined;
    if (isNamespacedIdentifier(name)) return accept;
    return Object.hasOwn(host.triggerKinds, name) ? host.triggerKinds[name] : undefined;
  };
  const triggerKinds = new Proxy<Record<string, DocumentTriggerValidator>>(
    {},
    {
      get: (_target, name) => validatorOf(name),
      has: (_target, name) => validatorOf(name) !== undefined,
      ownKeys: () => Object.keys(host.triggerKinds),
      getOwnPropertyDescriptor: (_target, name) => {
        const value = validatorOf(name);
        return value === undefined
          ? undefined
          : { value, enumerable: true, configurable: true, writable: false };
      },
    },
  );
  return Object.freeze({ ...host, triggerKinds });
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
    active: documents.active.map(toWeftDocumentInput),
    ...(documents.retained === undefined
      ? {}
      : { retained: documents.retained.map(toWeftDocumentInput) }),
  });
}
