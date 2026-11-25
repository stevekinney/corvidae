/**
 * The guardrails that fired in a run, read back from the audit trail for `bureau.tasks.explain`
 * (COR-2532).
 *
 * A guardrail that halts a run (`run.tripwire`) or acts on a step and lets the run go on
 * (`run.guardrail`) is written to the trail under the id of the run it fired in. A workflow
 * instance runs its agent steps as tasks of their own, so a guardrail that fired in one of them is
 * on the trail under that task's id, and is read as the instance's.
 *
 * A verdict is read field by field: the guardrail's name, what it did and the step. The text it
 * flagged and its `detail` are never read, so they cannot reach an answer.
 *
 * @module run-failure-verdicts
 */

import type { AuditRecord, AuditTrail } from './audit-trail.ts';
import { RUN_VERDICT_OUTCOMES, type RunVerdict } from './run-failure-explanation.ts';
import type { TaskRegistry } from './task-registry.ts';

/** How many trail records one read asks for. */
const TRAIL_PAGE_LIMIT = 500;

/** How many subordinate tasks one read asks the registry for. */
const SUBORDINATE_PAGE_LIMIT = 100;

/** The longest guardrail name an answer carries, in characters. */
const NAME_LIMIT = 256;

const VERDICT_TYPES: ReadonlySet<string> = new Set(['run.guardrail', 'run.tripwire']);

/** What {@link readRunVerdicts} reads. */
export interface RunVerdictSources {
  /** The Bureau's audit trail, or `undefined` for a Bureau that keeps none. */
  readonly trail: Pick<AuditTrail, 'query'> | undefined;
  /** The task registry, which names the tasks a workflow instance's steps ran as. */
  readonly tasks: Pick<TaskRegistry, 'enumerate'>;
}

function detailOf(record: AuditRecord): Readonly<Record<string, unknown>> {
  return typeof record.detail === 'object' && record.detail !== null
    ? (record.detail as Readonly<Record<string, unknown>>)
    : {};
}

/** The verdict a trail record is, or `undefined` for one that is not well formed. */
function verdictOf(record: AuditRecord): RunVerdict | undefined {
  const detail = detailOf(record);
  const name = detail['guardrailName'];
  if (typeof name !== 'string' || name.length === 0) return undefined;
  const step = detail['step'];
  const placed = typeof step === 'number' && Number.isSafeInteger(step) && step >= 0 ? step : null;
  if (record.type === 'run.tripwire') {
    return { name: name.slice(0, NAME_LIMIT), kind: 'tripwire', outcome: 'tripwire', step: placed };
  }
  const outcome = RUN_VERDICT_OUTCOMES.find(
    (candidate) => candidate !== 'tripwire' && candidate === detail['action'],
  );
  if (outcome === undefined) return undefined;
  return { name: name.slice(0, NAME_LIMIT), kind: 'guardrail', outcome, step: placed };
}

/** Every guardrail record the trail holds for `runId`, oldest first. */
async function recordsOf(trail: Pick<AuditTrail, 'query'>, runId: string): Promise<AuditRecord[]> {
  const records: AuditRecord[] = [];
  let after: { readonly timestampMs: number; readonly sequence: number } | undefined;
  for (;;) {
    const page = await trail.query({
      runId,
      filter: (record) => VERDICT_TYPES.has(record.type),
      limit: TRAIL_PAGE_LIMIT,
      ...(after === undefined ? {} : { after }),
    });
    records.push(...page);
    const last = page.at(-1);
    if (page.length < TRAIL_PAGE_LIMIT || last === undefined) return records;
    after = { timestampMs: last.timestampMs, sequence: last.sequence ?? -1 };
  }
}

/** The ids of the tasks a workflow instance's steps ran as, in id order. */
async function stepRunIds(
  tasks: Pick<TaskRegistry, 'enumerate'>,
  instanceId: string,
): Promise<string[]> {
  const ids: string[] = [];
  for (let offset = 0; ; offset += SUBORDINATE_PAGE_LIMIT) {
    const page = await tasks.enumerate({
      parentRunId: instanceId,
      limit: SUBORDINATE_PAGE_LIMIT,
      offset,
    });
    ids.push(...page.tasks.map((task) => task.id));
    if (page.nextOffset === null || page.tasks.length === 0) return ids.toSorted();
  }
}

/**
 * The guardrails that fired in the run `runId`: its own, oldest first, then for a workflow
 * instance each step's, step runs in id order. Empty for a Bureau that keeps no audit trail.
 */
export async function readRunVerdicts(
  sources: RunVerdictSources,
  runId: string,
  kind: 'agent' | 'workflow',
): Promise<readonly RunVerdict[]> {
  if (sources.trail === undefined) return [];
  const ids = [runId, ...(kind === 'workflow' ? await stepRunIds(sources.tasks, runId) : [])];
  const verdicts: RunVerdict[] = [];
  for (const id of ids) {
    for (const record of await recordsOf(sources.trail, id)) {
      const verdict = verdictOf(record);
      if (verdict !== undefined) verdicts.push(verdict);
    }
  }
  return verdicts;
}
