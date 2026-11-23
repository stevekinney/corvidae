/**
 * The state of a form that makes or changes a schedule (COR-2545), with no framework: the draft a
 * person edits, what is wrong with it, the arguments `bureau.schedules.create` and
 * `bureau.schedules.update` take, the calls a save becomes, and which field a Bureau fault belongs
 * to. The Interborough application's schedule page and the schedule editor panel both import it, so
 * what a schedule form sends, and where an error shows, is decided in one place.
 *
 * It lives here, in the package both the application and a plugin's panel depend on, and imports
 * nothing, so a panel's bundle takes none of this package's server code
 * (`@lostgradient/interborough-plugin/schedule-form`).
 *
 * @module schedule-form
 */

/** The longest description the Bureau accepts. */
export const SCHEDULE_DESCRIPTION_LIMIT = 2_000;

/** The longest text a fire of an agent's schedule sends, as the Bureau accepts it. */
export const SCHEDULE_INPUT_LIMIT = 100_000;

/** The longest cadence text the Bureau accepts. */
export const SCHEDULE_SPEC_LIMIT = 256;

/** What an overlap policy the forms offer is. */
export type ScheduleOverlapChoice = 'skip' | 'allow';

/** What a schedule runs: a catalog agent or a workflow. */
export type ScheduleTargetKind = 'agent' | 'workflow';

/** The parts of a `bureau.schedules.get` or `list` view a form reads. */
export type ScheduleFormSource = {
  /** The schedule's identifier. */
  readonly id: string;
  /** The revision to pass back as `expectedRevision`. */
  readonly revision: number;
  /** Whether the schedule fires (`active`), is held (`paused`) or has ended (`cancelled`). */
  readonly status: 'active' | 'paused' | 'cancelled';
  /** The text that says what the schedule is for, or `null` when it has none. */
  readonly description: string | null;
  /** Set for a cron schedule, `null` for an interval one. */
  readonly cronExpression: string | null;
  /** Set for an interval schedule, `null` for a cron one. */
  readonly intervalMs: number | null;
  /** The IANA time zone a cron expression is read in. */
  readonly timeZone: string;
  /** What each fire runs: a catalog agent by name, or a workflow by type. */
  readonly target:
    | { readonly kind: 'agent'; readonly agentName: string }
    | { readonly kind: 'workflow'; readonly workflowType: string };
};

/** What a person edits: a schedule's cadence, its target, and whether it is paused. */
export type ScheduleDraft = {
  /** A cron expression, or a duration such as `30s`, `6h`, or `1d`. */
  spec: string;
  /** An IANA time zone; empty to keep the schedule's, or for the Bureau's default on a new one. */
  timeZone: string;
  /** Whether the schedule runs an agent or a workflow. */
  targetKind: ScheduleTargetKind;
  /** The catalog agent's name, or the workflow's identifier (`plugin:name`, or a file's id). */
  target: string;
  /** The text each fire sends an agent; asked for when an agent is a new target. */
  input: string;
  /** The JSON each fire starts a workflow with; empty for none. */
  workflowInput: string;
  /** The text that says what the schedule is for; empty for none. */
  description: string;
  /** Whether a new schedule is held (paused) as soon as it is made. */
  paused: boolean;
};

/** A field of the draft that can show a problem. */
export type ScheduleField =
  'spec' | 'timeZone' | 'target' | 'input' | 'workflowInput' | 'description';

/** What is wrong with the draft, by field; a field with no problem is absent. */
export type ScheduleFieldErrors = Partial<Record<ScheduleField, string>>;

/** A draft that has chosen nothing, to make a new schedule from. */
export function emptyScheduleDraft(timeZone = ''): ScheduleDraft {
  return {
    spec: '',
    timeZone,
    targetKind: 'agent',
    target: '',
    input: '',
    workflowInput: '',
    description: '',
    paused: false,
  };
}

/** The cadence text a schedule's view reads as: its cron expression, or its interval as a duration. */
export function scheduleSpecText(source: ScheduleFormSource): string {
  if (source.cronExpression !== null) return source.cronExpression;
  const interval = source.intervalMs;
  if (interval === null) return '';
  for (const [unit, size] of [
    ['d', 86_400_000],
    ['h', 3_600_000],
    ['m', 60_000],
    ['s', 1_000],
  ] as const) {
    if (interval % size === 0) return `${interval / size}${unit}`;
  }
  return `${interval}ms`;
}

/** The draft that shows `source` as it is: nothing changed yet. */
export function scheduleDraftOf(source: ScheduleFormSource): ScheduleDraft {
  return {
    spec: scheduleSpecText(source),
    timeZone: source.timeZone,
    targetKind: source.target.kind,
    target: source.target.kind === 'agent' ? source.target.agentName : source.target.workflowType,
    // The view carries only the start of the text each fire sends, never the text, so a draft
    // starts with none and a save sends one only for an agent the schedule did not run.
    input: '',
    workflowInput: '',
    description: source.description ?? '',
    paused: source.status === 'paused',
  };
}

/**
 * What is wrong with `draft`, said before the Bureau is asked. `source` is the schedule being
 * changed, or `undefined` for a new one: a changed schedule needs a text only when it is newly
 * pointed at an agent, because a schedule that already runs the agent keeps the text it has.
 */
export function scheduleDraftErrors(
  draft: ScheduleDraft,
  source?: ScheduleFormSource,
): ScheduleFieldErrors {
  const errors: { -readonly [Field in ScheduleField]?: string } = {};
  const spec = draft.spec.trim();
  if (spec === '') errors.spec = 'Say when it runs: a cron expression, or a duration such as 6h.';
  else if (spec.length > SCHEDULE_SPEC_LIMIT) {
    errors.spec = `Use at most ${SCHEDULE_SPEC_LIMIT} characters.`;
  }
  if (draft.target.trim() === '') {
    errors.target = draft.targetKind === 'agent' ? 'Choose an agent.' : 'Choose a workflow.';
  }
  // A schedule that already runs an agent keeps the text it sends, which a view never carries in
  // full, so the text is asked for only when it is new: a new schedule, or a workflow made to run
  // an agent. Given on a change of agent or on the same agent, it replaces the text.
  if (draft.targetKind === 'agent') {
    const asksText = source === undefined || source.target.kind !== 'agent';
    if (asksText && draft.input.trim() === '') {
      errors.input = 'Say what each run sends the agent.';
    } else if (draft.input.length > SCHEDULE_INPUT_LIMIT) {
      errors.input = `Use at most ${SCHEDULE_INPUT_LIMIT} characters.`;
    }
  }
  if (draft.targetKind === 'workflow' && draft.workflowInput.trim() !== '') {
    try {
      JSON.parse(draft.workflowInput);
    } catch {
      errors.workflowInput = 'The input must be valid JSON.';
    }
  }
  if (draft.description.length > SCHEDULE_DESCRIPTION_LIMIT) {
    errors.description = `Use at most ${SCHEDULE_DESCRIPTION_LIMIT} characters.`;
  }
  return errors;
}

/** The workflow input a draft carries as a value: its JSON, or `undefined` when none is given. */
function parsedWorkflowInput(draft: ScheduleDraft): { readonly value: unknown } | undefined {
  const text = draft.workflowInput.trim();
  return text === '' ? undefined : { value: JSON.parse(text) as unknown };
}

/**
 * The arguments `bureau.schedules.create` takes for a draft that has no errors. A cadence, a target
 * and, for an agent, the text it is sent; the zone and the description only when given. A paused
 * draft is made active and paused by the save that follows ({@link scheduleSavePlan}), because the
 * Bureau makes every schedule active.
 */
export function scheduleCreateArguments(draft: ScheduleDraft): Record<string, unknown> {
  const description = draft.description.trim();
  const timeZone = draft.timeZone.trim();
  const workflowInput = draft.targetKind === 'workflow' ? parsedWorkflowInput(draft) : undefined;
  return {
    spec: draft.spec.trim(),
    ...(draft.targetKind === 'agent'
      ? { agentName: draft.target.trim(), input: draft.input }
      : {
          workflowType: draft.target.trim(),
          ...(workflowInput === undefined ? {} : { workflowInput: workflowInput.value }),
        }),
    ...(description === '' ? {} : { description }),
    ...(timeZone === '' ? {} : { timeZone }),
  };
}

/** The values a form changes of a schedule, which `bureau.schedules.update` is sent only where they differ. */
export type ScheduleUpdateSnapshot = {
  /** The cadence as the form shows it: a cron expression or a duration such as `6h`. */
  readonly spec: string;
  /** The zone of a cron schedule; `undefined` for an interval, which has none to change. */
  readonly timeZone: string | undefined;
  /** The description as the form holds it, before it is trimmed; empty for none. */
  readonly description: string;
  /** The overlap policy, for a form that edits it. */
  readonly overlap?: ScheduleOverlapChoice | undefined;
};

/** What an update is sent beside the schedule it names. */
export type ScheduleUpdateFields = {
  /** The cadence, always sent: the Bureau replaces it wholesale. */
  readonly spec: string;
  /** The new zone, present only when it differs from the schedule's. */
  readonly timeZone?: string;
  /** The new description, trimmed, present only when it differs. */
  readonly description?: string;
  /** The new overlap policy, present only when the form edits it and it differs. */
  readonly overlap?: ScheduleOverlapChoice;
};

/**
 * What `bureau.schedules.update` is sent: the cadence, which the Bureau replaces wholesale, and the
 * zone, the description and the overlap policy only when they differ from `initial`, so an edit
 * never resends what the person did not touch. The Bureau keeps a zone an update leaves out.
 */
export function scheduleUpdateFields(
  initial: ScheduleUpdateSnapshot,
  current: ScheduleUpdateSnapshot,
): ScheduleUpdateFields {
  const description = current.description.trim();
  return {
    spec: current.spec,
    ...(current.timeZone !== undefined && current.timeZone !== initial.timeZone
      ? { timeZone: current.timeZone }
      : {}),
    ...(description !== initial.description.trim() ? { description } : {}),
    ...(current.overlap !== undefined && current.overlap !== initial.overlap
      ? { overlap: current.overlap }
      : {}),
  };
}

/**
 * The arguments of an update that change what each run starts, and none when the draft runs what
 * the schedule runs and names no new text or input. The Bureau refuses a workflow's arguments with
 * an agent's, so an agent target names `agentName` and `input`, and a workflow target `workflowType`
 * and `workflowInput`, never both.
 */
function scheduleTargetFields(
  draft: ScheduleDraft,
  source: ScheduleFormSource,
): Record<string, unknown> {
  const name = draft.target.trim();
  const sameTarget =
    source.target.kind === draft.targetKind &&
    (source.target.kind === 'agent' ? source.target.agentName : source.target.workflowType) ===
      name;
  if (draft.targetKind === 'agent') {
    const text = draft.input.trim() === '' ? {} : { input: draft.input };
    return sameTarget ? text : { agentName: name, ...text };
  }
  const workflowInput = parsedWorkflowInput(draft);
  const given = workflowInput === undefined ? {} : { workflowInput: workflowInput.value };
  return sameTarget ? given : { workflowType: name, ...given };
}

/** A call a save makes, in the order it makes them. */
export type ScheduleSaveCall =
  | {
      readonly tool: 'bureau.schedules.create';
      readonly arguments: Record<string, unknown>;
    }
  | {
      readonly tool: 'bureau.schedules.update';
      readonly arguments: Record<string, unknown>;
    }
  | {
      readonly tool: 'bureau.schedules.pause' | 'bureau.schedules.resume';
      /** The revision to fence the call by, taken from the receipt of the call before it when there is one. */
      readonly arguments: Record<string, unknown>;
    };

/**
 * The calls saving `draft` makes: for a new schedule one `create` (then a `pause`, because the
 * Bureau makes every schedule active), and for a changed one an `update` when the cadence, the
 * zone, the description or the target changed, then a `pause` or `resume` when the paused state
 * did. The update goes first and the pause is fenced by the revision the update answers, which the
 * caller fills in as it makes the calls (`scheduleId` and `expectedRevision` are set there).
 *
 * The cadence is always resent as the schedule has it when only the target changed, because the
 * update replaces it wholesale. A schedule that runs an agent keeps its text unless the agent
 * changed, and a different workflow starts with the input the draft names or none.
 */
export function scheduleSavePlan(
  draft: ScheduleDraft,
  source?: ScheduleFormSource,
): readonly ScheduleSaveCall[] {
  if (source === undefined) {
    const calls: ScheduleSaveCall[] = [
      { tool: 'bureau.schedules.create', arguments: scheduleCreateArguments(draft) },
    ];
    if (draft.paused) calls.push({ tool: 'bureau.schedules.pause', arguments: {} });
    return calls;
  }
  const calls: ScheduleSaveCall[] = [];
  const initial: ScheduleUpdateSnapshot = {
    spec: scheduleSpecText(source),
    timeZone: source.timeZone,
    description: source.description ?? '',
  };
  const fields = scheduleUpdateFields(initial, {
    spec: draft.spec.trim(),
    timeZone: draft.timeZone.trim() === '' ? source.timeZone : draft.timeZone.trim(),
    description: draft.description,
  });
  const targetFields = scheduleTargetFields(draft, source);
  const changed =
    fields.spec !== initial.spec ||
    fields.timeZone !== undefined ||
    fields.description !== undefined ||
    Object.keys(targetFields).length > 0;
  if (changed) {
    calls.push({
      tool: 'bureau.schedules.update',
      arguments: { ...fields, ...targetFields },
    });
  }
  if (draft.paused !== (source.status === 'paused')) {
    calls.push({
      tool: draft.paused ? 'bureau.schedules.pause' : 'bureau.schedules.resume',
      arguments: {},
    });
  }
  return calls;
}

/** The Bureau argument each form field is sent as, so a fault names the field that caused it. */
const FIELD_OF_ARGUMENT: ReadonlyMap<string, ScheduleField> = new Map<string, ScheduleField>([
  ['spec', 'spec'],
  ['timeZone', 'timeZone'],
  ['agentName', 'target'],
  ['workflowType', 'target'],
  ['input', 'input'],
  ['workflowInput', 'workflowInput'],
  ['description', 'description'],
]);

/**
 * The field each issue of a Bureau fault belongs to. A fault carries `{ issues: [{ path, message }] }`
 * in its `data` (the host hands a panel that as `structuredContent`), and the first segment of an
 * issue's path is the argument that caused it. An issue about an argument no field shows, or a fault
 * that carries none, shows on no field: the caller shows its message as a whole.
 */
export function scheduleFaultFieldErrors(data: unknown): ScheduleFieldErrors {
  if (typeof data !== 'object' || data === null) return {};
  const issues: unknown = Reflect.get(data, 'issues');
  if (!Array.isArray(issues)) return {};
  const errors: { -readonly [Field in ScheduleField]?: string } = {};
  for (const issue of issues as unknown[]) {
    if (typeof issue !== 'object' || issue === null) continue;
    const path: unknown = Reflect.get(issue, 'path');
    const message: unknown = Reflect.get(issue, 'message');
    const head: unknown = Array.isArray(path) ? (path as unknown[])[0] : undefined;
    if (typeof head !== 'string' || typeof message !== 'string') continue;
    const field = FIELD_OF_ARGUMENT.get(head);
    if (field !== undefined && errors[field] === undefined) errors[field] = message;
  }
  return errors;
}
