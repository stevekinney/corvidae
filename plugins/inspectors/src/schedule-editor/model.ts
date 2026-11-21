/**
 * What the schedule editor reads of the Bureau's answers (COR-2545), and the words it puts on them.
 * Plain code with its own tests: the page script in `app.ts` makes the calls and the component in
 * `schedule-editor.svelte` draws the result. What a schedule form sends, and which field a fault
 * belongs to, is the shared module `@lostgradient/interborough-plugin/schedule-form`, which the
 * application's own schedule page imports too.
 */
import {
  scheduleFaultFieldErrors,
  scheduleSpecText,
  type ScheduleFieldErrors,
  type ScheduleFormSource,
} from '@lostgradient/interborough-plugin/schedule-form';

/** A schedule as `bureau.schedules.get` and `list` view it: the parts the form reads, and a few it shows. */
export type ScheduleView = ScheduleFormSource & {
  /** The next fire, ISO 8601, or `null` for a schedule that starts none. */
  readonly nextFireAt: string | null;
};

/** One choice of an agent or a workflow in a picker. */
export type PickerOption = { readonly value: string; readonly label: string };

/** What the Bureau answers a `pause`, `resume` or `update` with. */
export type ScheduleReceipt = {
  readonly id: string;
  readonly status: 'active' | 'paused' | 'cancelled';
  readonly revision: number;
};

/** A record, which a guard narrows a value to before it reads a field. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStatus(value: unknown): value is ScheduleReceipt['status'] {
  return value === 'active' || value === 'paused' || value === 'cancelled';
}

/** Whether `value` is a schedule view with what the form reads of it. */
export function isScheduleView(value: unknown): value is ScheduleView {
  if (!isRecord(value)) return false;
  const target = value['target'];
  const targetShaped =
    isRecord(target) &&
    ((target['kind'] === 'agent' && typeof target['agentName'] === 'string') ||
      (target['kind'] === 'workflow' && typeof target['workflowType'] === 'string'));
  return (
    typeof value['id'] === 'string' &&
    typeof value['revision'] === 'number' &&
    isStatus(value['status']) &&
    (value['description'] === null || typeof value['description'] === 'string') &&
    (value['cronExpression'] === null || typeof value['cronExpression'] === 'string') &&
    (value['intervalMs'] === null || typeof value['intervalMs'] === 'number') &&
    typeof value['timeZone'] === 'string' &&
    (value['nextFireAt'] === null || typeof value['nextFireAt'] === 'string') &&
    targetShaped
  );
}

/** Whether `value` is the answer of `bureau.schedules.list`. */
export function isScheduleList(
  value: unknown,
): value is { readonly schedules: ScheduleView[]; readonly nextOffset: number | null } {
  return (
    isRecord(value) &&
    Array.isArray(value['schedules']) &&
    (value['schedules'] as unknown[]).every(isScheduleView)
  );
}

/** Whether `value` is the receipt of a pause, a resume or an update. */
export function isReceipt(value: unknown): value is ScheduleReceipt {
  return (
    isRecord(value) &&
    typeof value['id'] === 'string' &&
    isStatus(value['status']) &&
    typeof value['revision'] === 'number'
  );
}

/** The agents `bureau.agents.list` answers, as picker options, in the order the Bureau lists them. */
export function agentOptionsOf(value: unknown): PickerOption[] | undefined {
  if (!isRecord(value) || !Array.isArray(value['agents'])) return undefined;
  const options: PickerOption[] = [];
  for (const agent of value['agents'] as unknown[]) {
    if (!isRecord(agent) || typeof agent['name'] !== 'string') return undefined;
    // A hidden agent is left out of a picker, as a chat leaves it out; a schedule can still name it.
    if (agent['visibility'] === 'hidden') continue;
    const displayName = agent['displayName'];
    options.push({
      value: agent['name'],
      label:
        typeof displayName === 'string' && displayName !== '' && displayName !== agent['name']
          ? `${displayName} (${agent['name']})`
          : agent['name'],
    });
  }
  return options;
}

/**
 * The workflows `bureau.workflows.list` answers that a schedule can start, as picker options: a
 * code workflow a plugin contributed, and a workflow file that is ready and not paused, which are
 * the targets the Bureau accepts for a schedule.
 */
export function workflowOptionsOf(value: unknown): PickerOption[] | undefined {
  if (!isRecord(value) || !Array.isArray(value['workflows'])) return undefined;
  const options: PickerOption[] = [];
  for (const workflow of value['workflows'] as unknown[]) {
    if (!isRecord(workflow) || typeof workflow['id'] !== 'string') return undefined;
    const startable =
      workflow['kind'] === 'code' || (workflow['state'] === 'ready' && workflow['paused'] !== true);
    if (!startable) continue;
    const title = workflow['title'];
    options.push({
      value: workflow['id'],
      label:
        typeof title === 'string' && title !== '' && title !== workflow['id']
          ? `${title} (${workflow['id']})`
          : workflow['id'],
    });
  }
  return options;
}

/**
 * `options` with the schedule's current target among them, which a list the caller may not see all
 * of (a hidden agent, a workflow that is paused now) could leave out: a picker that dropped the
 * current choice would save a different one.
 */
export function withCurrent(
  options: readonly PickerOption[],
  current: string,
): readonly PickerOption[] {
  return current === '' || options.some((option) => option.value === current)
    ? options
    : [{ value: current, label: current }, ...options];
}

/** What a person reads of a schedule in the list: its name and what it runs when. */
export function scheduleLabel(schedule: ScheduleView): string {
  const name = schedule.description?.trim();
  const target =
    schedule.target.kind === 'agent' ? schedule.target.agentName : schedule.target.workflowType;
  const state = schedule.status === 'active' ? '' : ` (${schedule.status})`;
  return `${name === undefined || name === '' ? target : name}, ${scheduleSpecText(schedule)}${state}`;
}

/** What a failed call says: the Bureau's message, the fields it names, and the revision a stale write found. */
export type CallFault = {
  readonly message: string;
  readonly fields: ScheduleFieldErrors;
  /** Set when the schedule changed since it was read: the revision it is at now. */
  readonly currentRevision: number | undefined;
};

/**
 * The fault a failed tool result carries. The host hands a panel a fault as an error result whose
 * text is the Bureau's message and whose structured content is the fault's data, which names the
 * argument each issue is about.
 */
export function faultOfResult(result: {
  readonly content?: unknown;
  readonly structuredContent?: unknown;
}): CallFault {
  const blocks: unknown[] = Array.isArray(result.content) ? (result.content as unknown[]) : [];
  const text = blocks
    .map((block) => (isRecord(block) && typeof block['text'] === 'string' ? block['text'] : ''))
    .find((candidate) => candidate !== '');
  const data = result.structuredContent;
  const current = isRecord(data) ? data['currentRevision'] : undefined;
  return {
    message: text ?? 'The request failed.',
    fields: scheduleFaultFieldErrors(data),
    currentRevision: typeof current === 'number' ? current : undefined,
  };
}
