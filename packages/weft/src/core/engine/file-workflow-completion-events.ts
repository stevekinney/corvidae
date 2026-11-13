/**
 * The completion half of a file workflow's lifecycle history: the `activity-completed`,
 * `signal-received` and `step-completed` events a settled timeline entry makes durable. A step at
 * the top level, a branch of `ctx.all`, and a branch of a keyed `ctx.raceKeyed` (alone, or nested in
 * a branch of `ctx.all`) all record the events a plain top-level step would.
 */

export type FileWorkflowEvent = Readonly<{ type: string; payload: Record<string, unknown> }>;

/** The `stepAddress` field of an event, absent when the address is the step's own index. */
export function addressPayload(address: string, step: number): Record<string, unknown> {
  return address === String(step) ? {} : { stepAddress: address };
}

type StepKind = 'activity' | 'await-signal' | 'sleep';

function stepCompleted(
  step: number,
  addressFields: Record<string, unknown>,
  kind: StepKind,
): FileWorkflowEvent {
  return { type: 'file-workflow:step-completed', payload: { step, ...addressFields, kind } };
}

/**
 * A signal wait's completion: `signal-received` and `step-completed`, or `step-completed` alone
 * for a wait that lost a race to its timeout, which received no signal.
 */
function waitCompletionEvents(
  step: number,
  addressFields: Record<string, unknown>,
  signal: string,
  received: boolean,
): FileWorkflowEvent[] {
  return [
    ...(received
      ? [{ type: 'file-workflow:signal-received', payload: { step, ...addressFields, signal } }]
      : []),
    stepCompleted(step, addressFields, 'await-signal'),
  ];
}

type SettledStep = {
  operationType: string;
  operationLabel: string;
  stepIndex?: number;
  documentStep?: number;
  documentStepAddress?: string;
  status: string;
};

function activityCompletionEvents(
  step: number,
  addressFields: Record<string, unknown>,
  handler: string,
): FileWorkflowEvent[] {
  return [
    { type: 'file-workflow:activity-completed', payload: { step, ...addressFields, handler } },
    stepCompleted(step, addressFields, 'activity'),
  ];
}

/** The document step index and the `stepAddress` field a settled step's events carry. */
function stepIdentity(pending: SettledStep): [number, Record<string, unknown>] {
  const step = pending.documentStep ?? pending.stepIndex ?? 0;
  return [step, addressPayload(String(pending.documentStepAddress ?? step), step)];
}

function completionEvents(pending: SettledStep | undefined): FileWorkflowEvent[] {
  if (pending?.status !== 'completed') return [];
  if (pending.documentStep === undefined && pending.operationType !== 'activity') return [];
  const [step, addressFields] = stepIdentity(pending);
  switch (pending.operationType) {
    case 'activity':
      return activityCompletionEvents(step, addressFields, pending.operationLabel);
    case 'wait-signal':
      return waitCompletionEvents(step, addressFields, pending.operationLabel, true);
    case 'sleep':
      return [stepCompleted(step, addressFields, 'sleep')];
    default:
      return [];
  }
}

type BranchDetail = Omit<SettledStep, 'status'> & {
  outcome: string;
  /** A keyed race that ran as a branch of `ctx.all` carries its own branches. */
  branches?: readonly BranchDetail[];
};

/** A document wait that lost its race lost to its timeout: it completes with no signal received. */
function lostWaitEvents(branch: BranchDetail): FileWorkflowEvent[] {
  const step = branch.documentStep;
  if (branch.operationType !== 'wait-signal' || step === undefined) return [];
  const addressFields = addressPayload(String(branch.documentStepAddress ?? step), step);
  return waitCompletionEvents(step, addressFields, branch.operationLabel, false);
}

/**
 * What a settled coordinator's branches complete. A fulfilled or winning step branch completes as
 * the same step would at the top level; a race inside a branch reports through its own branches.
 */
function branchCompletionEvents(
  branches: readonly BranchDetail[],
  inRace: boolean,
): FileWorkflowEvent[] {
  return branches.flatMap((branch) => {
    if (branch.operationType === 'race') {
      return branch.outcome === 'fulfilled'
        ? branchCompletionEvents(branch.branches ?? [], true)
        : [];
    }
    if (inRace && branch.outcome === 'lost') return lostWaitEvents(branch);
    if (branch.outcome !== 'fulfilled' && branch.outcome !== 'won') return [];
    return completionEvents({ ...branch, status: 'completed' });
  });
}

/**
 * The completion events a pending timeline entry makes durable, on the checkpoint path and the
 * terminal path alike: a settled step's own, or a settled `ctx.all` or `ctx.race`'s branches'.
 */
export function pendingCompletionEvents(
  pending: (SettledStep & { branches?: readonly BranchDetail[] }) | undefined,
): FileWorkflowEvent[] {
  if (pending === undefined) return [];
  if (pending.operationType === 'parallel' || pending.operationType === 'race') {
    return pending.status === 'completed'
      ? branchCompletionEvents(pending.branches ?? [], pending.operationType === 'race')
      : [];
  }
  return completionEvents(pending);
}
