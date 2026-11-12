/**
 * What the page that makes a schedule (`/schedules/new`) decides outside the page: the workflows
 * its picker offers and how they are grouped, what the draft says is wrong, the footer line, and
 * the two requests a valid draft becomes. No DOM, so each rule is tested on its own.
 *
 * A schedule starts one workflow. The built-in choice is "Chat with an agent", which is the
 * Bureau's `agentRun` and is made through `bureau.schedules.create`, which checks the agent and its
 * owner. Any other choice is a workflow, whether code defines it or a file does, which the engine
 * schedules. A file the Bureau cannot load is listed but cannot be chosen, and the types the Bureau
 * runs for itself are not listed at all. The schedule's name is the description the services keep.
 */
import { humanizeIdentifier, type ComboboxOption, type ScheduleValue } from '@lostgradient/cinder';
import type { ScheduleOverlapPolicy } from '@lostgradient/weft';

import { SCHEDULE_COPY } from '../../app/copy/schedules.ts';
import { bureauSpecOf, type AgentScheduleInput } from '../../lib/bureau-schedules.ts';
import { AGENT_RUN_TYPE } from '../../lib/schedule-kinds.ts';
import type { CatalogRow, WorkflowResolution } from '../../lib/workflow-catalog.ts';
import { runSetupTarget, type RunSetupTarget } from '../workflow-definitions/run-setup-model.ts';
import { browserTimeZone, scheduleValueTimeZone, scheduleValueToWireSpec } from './cadence.ts';
import type { CreateScheduleArgs } from './schedule-queries.ts';

const copy = SCHEDULE_COPY.create;

/** The longest name the services accept: it is the schedule's description. */
export const MAX_NAME_LENGTH = 2_000;
/** The longest message the Bureau accepts. */
const MAX_MESSAGE_LENGTH = 100_000;
/** How many of the newest schedules' workflows the Recent group holds. */
const RECENT_LIMIT = 3;
/** How long a create may take before the footer says so, in milliseconds. */
export const SLOW_CREATE_MS = 10_000;

/**
 * What happens when a fire is due while a run is going. A new schedule chooses skip or allow, and
 * a schedule that is edited may already hold one of the engine's other two policies, which stays
 * until it is changed.
 */
export type NewScheduleOverlap = ScheduleOverlapPolicy;

/** Everything the page asks for, for either kind of schedule. */
export type NewScheduleDraft = {
  /** The workflow's type, or {@link AGENT_RUN_TYPE} for the built-in chat; empty before one is chosen. */
  workflowType: string;
  /** The agent a chat runs. */
  agentName: string;
  /** What each fire sends the agent. */
  message: string;
  /** Whether every fire adds to one chat, which the schedule makes when it is created. */
  continueChat: boolean;
  /** What the schedule is called in Schedules and on every run it starts. */
  name: string;
  cadence: ScheduleValue;
  overlap: NewScheduleOverlap;
  /** Whether to run the fires missed while the host was down. */
  catchUp: boolean;
};

/** A draft that has chosen nothing, in the zone of the browser. */
export function emptyDraft(): NewScheduleDraft {
  return {
    workflowType: '',
    agentName: '',
    message: '',
    continueChat: false,
    name: '',
    cadence: { cron: '0 9 * * *', timeZone: browserTimeZone() },
    overlap: 'skip',
    catchUp: false,
  };
}

/** Whether the draft is the built-in chat, which the Bureau makes. */
export function isChatDraft(draft: Pick<NewScheduleDraft, 'workflowType'>): boolean {
  return draft.workflowType === AGENT_RUN_TYPE;
}

/**
 * Whether a workflow's declared input schema says it takes no input: a `null` input, or an object
 * that names no field and allows none. A workflow that declares no schema is not that: schemas are
 * optional, and such a workflow may read its `input` all the same.
 */
export function takesNoInput(schema: unknown): boolean {
  if (!isRecord(schema)) return false;
  if (schema['type'] === 'null') return true;
  if (schema['type'] !== 'object' || schema['additionalProperties'] !== false) return false;
  const properties = schema['properties'];
  return properties === undefined || (isRecord(properties) && Object.keys(properties).length === 0);
}

/**
 * The input a workflow whose schema says it takes none is started with: the value that schema
 * accepts, `null` or `{}`, because a fire may be rejected under inbound payload validation when the
 * input is missing.
 */
export function emptyInputOf(schema: unknown): null | Record<string, never> {
  return isRecord(schema) && schema['type'] === 'null' ? null : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A workflow type named for a person: its words, not its identifier. */
export function workflowLabel(type: string): string {
  return type === AGENT_RUN_TYPE
    ? copy.chat.label
    : humanizeIdentifier(type, { casing: 'sentence' });
}

/**
 * What a chosen workflow can be scheduled with. A schedule is the owner's own choice, so a paused
 * file is as schedulable as a running one (pausing a file pauses its own trigger and refuses a
 * manual start, neither of which a schedule of its own is); only a file the Bureau cannot load,
 * or a type that is gone, cannot.
 */
export function scheduleTargetOf(type: string, resolution: WorkflowResolution): RunSetupTarget {
  if (resolution.kind === 'agent-authored' && resolution.file.paused) {
    return runSetupTarget(type, { ...resolution, file: { ...resolution.file, paused: false } });
  }
  return runSetupTarget(type, resolution);
}

/** The type of each of the newest schedules, newest first, once each. */
export function recentTypes(
  schedules: readonly { readonly workflowType: string; readonly createdAt: number }[],
): string[] {
  const types: string[] = [];
  for (const schedule of schedules.toSorted((a, b) => b.createdAt - a.createdAt)) {
    if (!types.includes(schedule.workflowType)) types.push(schedule.workflowType);
  }
  return types;
}

/**
 * The picker's options. Built in holds the chat. Every other workflow follows, under Recent when a
 * new schedule last started it and under All workflows otherwise, each with its description. A
 * file the Bureau cannot load is listed under All workflows, disabled, with the reason in danger
 * text. A type the Bureau registers to run itself is never offered.
 */
export function workflowOptions(
  rows: readonly CatalogRow[],
  recent: readonly string[],
): ComboboxOption[] {
  const options: ComboboxOption[] = [
    {
      value: AGENT_RUN_TYPE,
      label: copy.chat.label,
      description: copy.chat.description,
      group: copy.groups.builtIn,
    },
  ];
  const offered = rows.filter((row) => !row.engine);
  const rank = (name: string): number => {
    const index = recent.indexOf(name);
    return index === -1 || index >= RECENT_LIMIT ? Number.POSITIVE_INFINITY : index;
  };
  const loadable = offered.filter((row) => row.file === null || row.file.state === 'ready');
  const recents = loadable.filter((row) => Number.isFinite(rank(row.name)));
  recents.sort((a, b) => rank(a.name) - rank(b.name));
  const inRecent = new Set(recents.map((row) => row.name));
  const others = [
    ...loadable.filter((row) => !inRecent.has(row.name)),
    ...offered.filter((row) => row.file !== null && row.file.state !== 'ready'),
  ].toSorted((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const row of recents) options.push(optionOf(row, copy.groups.recent));
  for (const row of others) options.push(optionOf(row, copy.groups.all));
  return options;
}

function optionOf(row: CatalogRow, group: string): ComboboxOption {
  const label = row.file?.title ?? workflowLabel(row.name);
  if (row.file !== null && row.file.state !== 'ready') {
    return {
      value: row.name,
      label,
      description: copy.cannotLoad,
      descriptionTone: 'danger',
      group,
      disabled: true,
    };
  }
  return { value: row.name, label, description: row.description ?? row.name, group };
}

/** Whether an option matches what was typed: any word of it, ignoring case, in the label, the identifier or the description. */
export function optionMatches(option: ComboboxOption, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === '') return true;
  return [option.label, option.value, option.description ?? ''].some((text) =>
    text.toLowerCase().includes(needle),
  );
}

/** The name a new schedule starts with: the workflow's, or the agent's for a chat. */
export function defaultNameOf(
  draft: Pick<NewScheduleDraft, 'workflowType' | 'agentName'>,
  workflow: string,
): string {
  if (draft.workflowType === '') return '';
  return isChatDraft(draft) ? draft.agentName : workflow;
}

/** What the draft says is wrong, by field. A field with no problem is absent. */
export type DraftErrors = {
  readonly workflowType?: string;
  readonly agentName?: string;
  readonly message?: string;
  readonly name?: string;
};

/**
 * The problems with a draft, in the order the page asks. The same rules the Bureau and the engine
 * hold the request to, said before it is asked. A message a person has not typed yet is not a
 * problem to show until they press Create, so the page decides when to show these.
 */
export function draftErrors(draft: NewScheduleDraft): DraftErrors {
  const errors: { -readonly [K in keyof DraftErrors]: DraftErrors[K] } = {};
  if (draft.workflowType === '') errors.workflowType = copy.required;
  if (isChatDraft(draft)) {
    if (draft.agentName.trim() === '') errors.agentName = SCHEDULE_COPY.form.agentRequired;
    if (draft.message.trim() === '') errors.message = SCHEDULE_COPY.form.inputRequired;
    else if (draft.message.length > MAX_MESSAGE_LENGTH) {
      errors.message = SCHEDULE_COPY.form.inputTooLong;
    }
  }
  const name = draft.name.trim();
  if (name === '') errors.name = copy.nameRequired;
  else if (name.length > MAX_NAME_LENGTH) errors.name = copy.nameTooLong(MAX_NAME_LENGTH);
  return errors;
}

/** Whether the draft can be sent. */
export function isDraftValid(draft: NewScheduleDraft): boolean {
  return Object.keys(draftErrors(draft)).length === 0;
}

/** Whether the person has started a schedule: anything past the page as it opened, which leaving would lose. */
export function isDraftStarted(draft: NewScheduleDraft, opened: NewScheduleDraft): boolean {
  return JSON.stringify(draft) !== JSON.stringify(opened);
}

/**
 * What `bureau.schedules.create` is sent for a chat. Only valid for a valid draft. A draft that
 * continues one chat asks the Bureau for it rather than naming one, because the Bureau refuses, under
 * a workspace, a chat that its owner does not hold yet.
 */
export function agentScheduleInput(draft: NewScheduleDraft): AgentScheduleInput {
  const timeZone = scheduleValueTimeZone(draft.cadence);
  return {
    agentName: draft.agentName.trim(),
    spec: bureauSpecOf(scheduleValueToWireSpec(draft.cadence)),
    input: draft.message,
    // A chat that is continued cannot also start another run beside itself, which the Bureau refuses.
    overlap: draft.continueChat || draft.overlap !== 'allow' ? 'skip' : 'allow',
    description: draft.name.trim(),
    ...(draft.continueChat ? { continueChat: true as const } : {}),
    ...(timeZone !== undefined ? { timeZone } : {}),
  };
}

/** What the engine is sent for a workflow, with the input the form validated. Only valid for a valid draft. */
export function engineScheduleArgs(draft: NewScheduleDraft, input: unknown): CreateScheduleArgs {
  const timeZone = scheduleValueTimeZone(draft.cadence);
  return {
    workflowType: draft.workflowType,
    input,
    spec: scheduleValueToWireSpec(draft.cadence),
    ...(timeZone !== undefined ? { timeZone } : {}),
    overlap: draft.overlap,
    backfill: draft.catchUp,
    description: draft.name.trim(),
  };
}

/** Whether a schedule already carries this name, ignoring case and the space around it; `except` is the schedule being edited, which may keep its own. */
export function takenNameOf(
  name: string,
  schedules: readonly { readonly id: string; readonly description?: string | null | undefined }[],
  except?: string,
): { readonly id: string; readonly name: string } | undefined {
  const wanted = name.trim().toLowerCase();
  if (wanted === '') return undefined;
  for (const schedule of schedules) {
    if (schedule.id === except) continue;
    const existing = schedule.description?.trim() ?? '';
    if (existing.toLowerCase() === wanted) return { id: schedule.id, name: existing };
  }
  return undefined;
}

/** What the footer's line depends on. */
export type FooterState = {
  readonly draft: NewScheduleDraft;
  /** The chosen workflow's name for a person, when one is chosen. */
  readonly workflow: string;
  /** Whether Create is in flight, and for how long. */
  readonly creating: boolean;
  readonly slow: boolean;
  /** Whether the list of workflows, or the chosen workflow's input fields, are still loading. */
  readonly waitingForWorkflows: boolean;
  readonly waitingForInput: boolean;
  /** Whether the chosen agent needs a model and no provider is connected. */
  readonly blocked: boolean;
  /** The label of the first field showing a problem that Create would stop at, when one does. */
  readonly problemField: string | undefined;
  /** The name of the schedule being edited, when the page edits one: the footer then says what Save does. */
  readonly editing?: string | undefined;
};

/**
 * The muted line left of the buttons. What the page is doing comes first (a create in flight,
 * then the lists it waits for), then what a schedule made now would do: it will not run without a
 * provider, or it starts the chat or the workflow. A field that shows a problem adds what pressing
 * Create does about it.
 */
export function footerLineOf(state: FooterState): string {
  if (state.editing !== undefined) return editFooterLineOf(state, state.editing);
  const line = copy.footer;
  if (state.creating) {
    return state.slow ? `${line.creating} ${line.slow} ${line.cancelStops}` : line.creating;
  }
  if (state.waitingForWorkflows) return line.waitingForWorkflows;
  if (state.waitingForInput) return line.waitingForInput;
  let base: string;
  if (state.draft.workflowType === '') base = line.nothing;
  else if (state.blocked) base = line.blocked;
  else if (isChatDraft(state.draft)) base = line.chat(state.draft.agentName);
  else base = line.workflow(state.workflow);
  return state.problemField === undefined
    ? base
    : `${base} ${line.stillEnabled(state.problemField)}`;
}

/** The footer of the page that edits a schedule: it says what Save does, or what it is doing. */
function editFooterLineOf(state: FooterState, name: string): string {
  const line = SCHEDULE_COPY.edit.footer;
  if (state.creating) {
    return state.slow ? `${line.saving} ${line.slow} ${line.cancelStops}` : line.saving;
  }
  const base = state.blocked ? `${line.saves(name)} ${copy.footer.blocked}` : line.saves(name);
  return state.problemField === undefined
    ? base
    : `${base} ${line.stillEnabled(state.problemField)}`;
}
