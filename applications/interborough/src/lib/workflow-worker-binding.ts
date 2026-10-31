/**
 * Worker-versioning vocabulary for a workflow run (COR-164): the runtime guard
 * for the `workerVersioningPolicy` and `workerBinding` fields of
 * `weft.workflows.get`'s output (typed `unknown` by the generated client), the
 * plain-language explanation of why a binding may or may not change, and the
 * rule for when a start override can be previewed.
 *
 * Nothing here evaluates an upgrade or picks a build. Weft owns that
 * (`evaluateWorkflowWorkerUpgrade`, `resolveWorkflowWorkerStartBinding`); this
 * module reads the durable record and restates the rules it can verify from
 * that record alone. Whether a routed candidate exists right now is only ever
 * answered by the server, through the override preview.
 *
 * ## Why policy and binding must arrive together
 *
 * Weft writes `workerVersioningPolicy` and `workerBinding` in one step
 * (`createInitialWorkflowState`), and a workflow that declares no policy has
 * neither. A record with exactly one of them cannot come from a healthy
 * server, so it reads as malformed rather than being papered over.
 *
 * Lives in `src/lib`, beside `workflow-revision.ts`, so no route imports a
 * sibling route's modules.
 *
 * @module
 */
import type { WorkflowState, WorkflowWorkerBinding } from '@lostgradient/weft';

/** The worker versioning policy a workflow declares. */
export type WorkerVersioningPolicy = NonNullable<WorkflowState['workerVersioningPolicy']>;
/** A worker versioning policy in the `auto-upgrade` mode. */
export type AutoUpgradePolicy = Extract<WorkerVersioningPolicy, { mode: 'auto-upgrade' }>;

/**
 * The part of a workflow's worker binding record the dashboard reads: the current binding and its
 * history.
 */
export interface WorkerBindingRecordLike {
  readonly current: WorkflowWorkerBinding;
  readonly history: readonly WorkflowWorkerBinding[];
}

/**
 * What a workflow's state says about its worker binding: none, a malformed record with the reason,
 * or a policy with its record.
 */
export type WorkerBindingReading =
  | { readonly kind: 'absent' }
  | { readonly kind: 'malformed'; readonly reason: string }
  | {
      readonly kind: 'bound';
      readonly policy: WorkerVersioningPolicy;
      readonly record: WorkerBindingRecordLike;
    };

type Fields = Record<string, unknown>;

function isRecord(value: unknown): value is Fields {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const BINDING_STRING_FIELDS = [
  'workflowId',
  'workflowType',
  'deploymentName',
  'buildId',
  'artifactDigest',
  'manifestDigest',
  'workflowRevision',
  'workflowContractHash',
  'activityName',
  'activityContractHash',
  'checkpointId',
] as const;

const BINDING_NUMBER_FIELDS = ['routingGeneration', 'boundAt'] as const;

const COMPATIBILITY_FIELDS = [
  'deploymentName',
  'buildId',
  'artifactDigest',
  'manifestDigest',
  'workflowRevision',
  'activityContractHash',
] as const;

/** The first field of `value` that is not the expected primitive, or `undefined` when all are. */
function firstBadField(
  value: Fields,
  strings: readonly string[],
  numbers: readonly string[] = [],
): string | undefined {
  const badString = strings.find((field) => typeof value[field] !== 'string');
  if (badString !== undefined) return badString;
  return numbers.find(
    (field) => typeof value[field] !== 'number' || !Number.isFinite(value[field]),
  );
}

function bindingProblem(value: unknown, where: string): string | undefined {
  if (!isRecord(value)) return `${where} is not an object`;
  const bad = firstBadField(value, BINDING_STRING_FIELDS, BINDING_NUMBER_FIELDS);
  if (bad !== undefined) return `${where}.${bad} is missing or has the wrong type`;
  const contracts = value['activityContracts'];
  if (!isRecord(contracts) || Object.values(contracts).some((entry) => typeof entry !== 'string')) {
    return `${where}.activityContracts is not a map of strings`;
  }
  return undefined;
}

function policyProblem(value: unknown): string | undefined {
  if (!isRecord(value)) return 'workerVersioningPolicy is not an object';
  const history = value['maxBindingHistory'];
  if (history !== undefined && typeof history !== 'number') {
    return 'workerVersioningPolicy.maxBindingHistory is not a number';
  }
  const mode = value['mode'];
  if (mode === undefined || mode === 'pinned') return undefined;
  if (mode !== 'auto-upgrade') {
    return `workerVersioningPolicy.mode ${typeof mode === 'string' ? `"${mode}"` : `of type ${typeof mode}`} is unknown`;
  }
  const compatibility = value['compatibility'];
  if (!isRecord(compatibility)) return 'workerVersioningPolicy.compatibility is not an object';
  const bad = firstBadField(compatibility, COMPATIBILITY_FIELDS);
  return bad === undefined
    ? undefined
    : `workerVersioningPolicy.compatibility.${bad} is missing or has the wrong type`;
}

function recordProblem(value: unknown): string | undefined {
  if (!isRecord(value)) return 'workerBinding is not an object';
  const current = bindingProblem(value['current'], 'workerBinding.current');
  if (current !== undefined) return current;
  const history = value['history'];
  if (!Array.isArray(history)) return 'workerBinding.history is not an array';
  for (const [index, entry] of history.entries()) {
    const problem = bindingProblem(entry, `workerBinding.history[${index}]`);
    if (problem !== undefined) return problem;
  }
  return undefined;
}

/** Type guards over the problem finders above: a value is the shape exactly when no problem is found. */
function isWorkerVersioningPolicy(value: unknown): value is WorkerVersioningPolicy {
  return policyProblem(value) === undefined;
}

function isWorkerBindingRecord(value: unknown): value is WorkerBindingRecordLike {
  return recordProblem(value) === undefined;
}

/** Reads the worker-versioning fields off a `weft.workflows.get` result. */
export function readWorkflowWorkerState(workflow: unknown): WorkerBindingReading {
  if (!isRecord(workflow)) return { kind: 'malformed', reason: 'the workflow is not an object' };
  const policy = workflow['workerVersioningPolicy'];
  const record = workflow['workerBinding'];
  if (policy === undefined && record === undefined) return { kind: 'absent' };
  if (policy === undefined) {
    return { kind: 'malformed', reason: 'workerBinding is present without workerVersioningPolicy' };
  }
  if (record === undefined) {
    return { kind: 'malformed', reason: 'workerVersioningPolicy is present without workerBinding' };
  }
  if (!isWorkerVersioningPolicy(policy)) {
    return { kind: 'malformed', reason: policyProblem(policy) ?? 'unreadable policy' };
  }
  if (!isWorkerBindingRecord(record)) {
    return { kind: 'malformed', reason: recordProblem(record) ?? 'unreadable binding' };
  }
  return { kind: 'bound', policy, record };
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/** Why the run's binding may or may not change, in terms of its own policy and binding. */
export function explainWorkerBinding(reading: Extract<WorkerBindingReading, { kind: 'bound' }>) {
  const { policy, record } = reading;
  const current = record.current;
  const where = `build ${current.buildId} of deployment ${current.deploymentName}`;
  if (policy.mode !== 'auto-upgrade') {
    return `Pinned: this run is bound to ${where}. Weft never moves a pinned run to another build while it runs, and the binding history is kept for the record.`;
  }
  const target = policy.compatibility;
  const earlier = record.history.length;
  const movement =
    earlier === 0
      ? 'It has not moved yet.'
      : `It has moved before: the history holds ${plural(earlier, 'earlier binding')}.`;
  return (
    `Auto-upgrade: this run is bound to ${where}. After a durably committed checkpoint, and before the run acquires its realm, ` +
    `Weft may move it to a routed build that exactly matches the policy's compatibility requirement ` +
    `(build ${target.buildId} of deployment ${target.deploymentName}, workflow revision ${target.workflowRevision}). ` +
    movement
  );
}

/** Whether a workflow's worker binding can be overridden now, and the reason when it cannot. */
export type OverrideEligibility =
  { readonly eligible: true } | { readonly eligible: false; readonly reason: string };

const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  'completed',
  'failed',
  'cancelled',
  'timed-out',
]);

/**
 * Whether a start override can be previewed for this run: the same rule the
 * preview operation enforces (a terminal run with an auto-upgrade policy and a
 * durable binding). The server stays authoritative; this only decides whether
 * the action is worth offering and what to tell the operator when it is not.
 */
export function overrideEligibility(
  reading: WorkerBindingReading,
  status: string,
): OverrideEligibility {
  if (reading.kind === 'malformed') {
    return {
      eligible: false,
      reason: 'The worker version could not be read, so no override can be offered.',
    };
  }
  if (reading.kind === 'absent') {
    return {
      eligible: false,
      reason:
        'This run has no worker version (it predates worker versioning), so there is nothing to override.',
    };
  }
  if (reading.policy.mode !== 'auto-upgrade') {
    return {
      eligible: false,
      reason:
        'This run is pinned to its build, so its worker version cannot be overridden. Only an auto-upgrade run can move to a newly routed build.',
    };
  }
  if (!TERMINAL_STATUSES.has(status)) {
    return {
      eligible: false,
      reason:
        'A worker override applies to a restart, and only a terminal run can be restarted. This run is still live.',
    };
  }
  return { eligible: true };
}
