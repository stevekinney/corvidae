/**
 * What the page that makes a schedule (`/schedules/new`) decides outside the page: the workflows
 * its picker offers and how they are grouped, what the draft says is wrong, and the two requests a
 * valid draft becomes. No DOM, so each rule is tested on its own.
 *
 * A schedule starts one workflow. The built-in choice is "Chat with an agent", which is the
 * Bureau's `agentRun` and is made through `bureau.schedules.create`, which checks the agent and its
 * owner. Any other choice is a workflow that code defines, which the engine schedules. A workflow
 * file's schedule is the trigger in its file, so those are listed but cannot be chosen, and the
 * types the Bureau runs for itself are not listed at all.
 */
import { humanizeIdentifier, type ComboboxOption, type ScheduleValue } from '@lostgradient/cinder';
import type { ScheduleOverlapPolicy, ScheduleRevisionPolicy } from '@lostgradient/weft';

import { SCHEDULE_COPY, WORKFLOW_COPY } from '../../app/copy.ts';
import { bureauSpecOf, type AgentScheduleInput } from '../../lib/bureau-schedules.ts';
import { AGENT_RUN_TYPE } from '../../lib/schedule-kinds.ts';
import type { CatalogRow } from '../../lib/workflow-catalog.ts';
import { cadenceWords } from '../workflow-definitions/run-setup-model.ts';
import { browserTimeZone, scheduleValueTimeZone, scheduleValueToWireSpec } from './cadence.ts';
import { jitterError } from './schedule-form-state.svelte.ts';
import type { CreateScheduleArgs } from './schedule-queries.ts';

const copy = SCHEDULE_COPY.create;

/** The longest description the Bureau accepts. */
const MAX_DESCRIPTION_LENGTH = 2_000;
/** The longest message the Bureau accepts. */
const MAX_MESSAGE_LENGTH = 100_000;
/** How many of the newest schedules' workflows the Recent group holds. */
const RECENT_LIMIT = 3;

/** Everything the page asks for, for either kind of schedule. */
export type NewScheduleDraft = {
  /** The workflow's type, or {@link AGENT_RUN_TYPE} for the built-in chat; empty before one is chosen. */
  workflowType: string;
  /** The agent a chat runs. */
  agentName: string;
  /** What each fire sends the agent. */
  message: string;
  /** The chat each fire continues; empty starts a new chat each time. */
  chatId: string;
  description: string;
  cadence: ScheduleValue;
  overlap: ScheduleOverlapPolicy;
  backfill: boolean;
  startPaused: boolean;
  jitterText: string;
  revisionPolicy: ScheduleRevisionPolicy;
};

/** A draft that has chosen nothing, in the zone of the browser. */
export function emptyDraft(): NewScheduleDraft {
  return {
    workflowType: '',
    agentName: '',
    message: '',
    chatId: '',
    description: '',
    cadence: { cron: '0 9 * * *', timeZone: browserTimeZone() },
    overlap: 'skip',
    backfill: false,
    startPaused: false,
    jitterText: '',
    revisionPolicy: 'active-at-fire',
  };
}

/** Whether the draft is the built-in chat, which the Bureau makes. */
export function isChatDraft(draft: Pick<NewScheduleDraft, 'workflowType'>): boolean {
  return draft.workflowType === AGENT_RUN_TYPE;
}

/** A workflow type named for a person: its words, not its identifier. */
export function workflowLabel(type: string): string {
  return type === AGENT_RUN_TYPE ? copy.chat.label : humanizeIdentifier(type);
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
 * The picker's options. Built in holds the chat. Every workflow code defines follows, under Recent
 * when a new schedule last started it and under All workflows otherwise. An agent-authored
 * workflow is listed under All workflows, disabled, with the reason beside it. A type the Bureau
 * registers to run itself is never offered.
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
  const code = offered.filter((row) => row.kind === 'code');
  const recents = code.filter((row) => Number.isFinite(rank(row.name)));
  recents.sort((a, b) => rank(a.name) - rank(b.name));
  const inRecent = new Set(recents.map((row) => row.name));
  const others = [
    ...code.filter((row) => !inRecent.has(row.name)),
    ...offered.filter((row) => row.kind === 'agent-authored'),
  ].toSorted((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const row of recents) options.push(optionOf(row, copy.groups.recent));
  for (const row of others) options.push(optionOf(row, copy.groups.all));
  return options;
}

function optionOf(row: CatalogRow, group: string): ComboboxOption {
  const label = workflowLabel(row.name);
  const authored = row.kind === 'agent-authored';
  const description = authored ? copy.inFile : (row.description ?? row.name);
  return {
    value: row.name,
    label,
    description,
    group,
    ...(authored ? { disabled: true } : {}),
  };
}

/** Whether an option matches what was typed: any word of it, ignoring case, in the label, the identifier or the description. */
export function optionMatches(option: ComboboxOption, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === '') return true;
  return [option.label, option.value, option.description ?? ''].some((text) =>
    text.toLowerCase().includes(needle),
  );
}

/** What the draft says is wrong, by field. A field with no problem is absent. */
export type DraftErrors = {
  readonly workflowType?: string;
  readonly agentName?: string;
  readonly message?: string;
  readonly chat?: string;
  readonly description?: string;
  readonly jitter?: string;
};

/** The problems with a draft. The same rules the Bureau and the engine hold the request to, said before it is asked. */
export function draftErrors(draft: NewScheduleDraft): DraftErrors {
  const errors: { -readonly [K in keyof DraftErrors]: DraftErrors[K] } = {};
  if (draft.workflowType === '') errors.workflowType = copy.workflowRequired;
  if (draft.description.length > MAX_DESCRIPTION_LENGTH) {
    errors.description = SCHEDULE_COPY.form.descriptionTooLong(MAX_DESCRIPTION_LENGTH);
  }
  if (isChatDraft(draft)) {
    if (draft.agentName.trim() === '') errors.agentName = SCHEDULE_COPY.form.agentRequired;
    if (draft.message.trim() === '') errors.message = SCHEDULE_COPY.form.inputRequired;
    else if (draft.message.length > MAX_MESSAGE_LENGTH) {
      errors.message = SCHEDULE_COPY.form.inputTooLong;
    }
    // The Bureau refuses this pair, so the page says so before it asks.
    if (draft.chatId !== '' && draft.overlap === 'allow') {
      errors.chat = SCHEDULE_COPY.form.sessionWithAllow;
    }
  } else {
    const jitter = jitterError(draft.jitterText);
    if (jitter !== undefined) errors.jitter = jitter;
  }
  return errors;
}

/** Whether the draft can be sent. */
export function isDraftValid(draft: NewScheduleDraft): boolean {
  return Object.keys(draftErrors(draft)).length === 0;
}

/** What `bureau.schedules.create` is sent for a chat. Only valid for a valid draft. */
export function agentScheduleInput(draft: NewScheduleDraft): AgentScheduleInput {
  const description = draft.description.trim();
  const timeZone = scheduleValueTimeZone(draft.cadence);
  return {
    agentName: draft.agentName.trim(),
    spec: bureauSpecOf(scheduleValueToWireSpec(draft.cadence)),
    input: draft.message,
    // The Bureau's policies are `skip` and `allow`, so any other the radio holds reads as skip.
    overlap: draft.overlap === 'allow' ? 'allow' : 'skip',
    ...(description.length > 0 ? { description } : {}),
    ...(draft.chatId !== '' ? { sessionId: draft.chatId } : {}),
    ...(timeZone !== undefined ? { timeZone } : {}),
  };
}

/** What the engine is sent for a workflow, with the input the form validated. Only valid for a valid draft. */
export function engineScheduleArgs(draft: NewScheduleDraft, input: unknown): CreateScheduleArgs {
  const description = draft.description.trim();
  const jitter = draft.jitterText.trim();
  const timeZone = scheduleValueTimeZone(draft.cadence);
  return {
    workflowType: draft.workflowType,
    input,
    spec: scheduleValueToWireSpec(draft.cadence),
    ...(timeZone !== undefined ? { timeZone } : {}),
    overlap: draft.overlap,
    backfill: draft.backfill,
    revisionPolicy: draft.revisionPolicy,
    ...(description.length > 0 ? { description } : {}),
    ...(jitter.length > 0 ? { jitter } : {}),
  };
}

/** The one line under the form: what the schedule will do, in the zone it will do it. */
export function summaryOf(draft: NewScheduleDraft): string {
  if (draft.workflowType === '') return copy.summaryNothing;
  const cadence = cadenceWords(draft.cadence);
  const zone = 'cron' in draft.cadence ? draft.cadence.timeZone : undefined;
  return isChatDraft(draft)
    ? copy.summaryChat(draft.agentName, cadence, zone)
    : WORKFLOW_COPY.runSetup.summarySchedule(workflowLabel(draft.workflowType), cadence, zone);
}
