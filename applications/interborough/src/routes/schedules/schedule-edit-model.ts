/**
 * What the page that edits a schedule decides outside the page (`/schedules/:id/edit`; COR-2018,
 * rows 74r, 74t, 75p, 75q): the form it opens on, which is the form that makes a schedule filled in
 * from the schedule, and the request a change becomes. No DOM, so each rule is tested on its own.
 *
 * The Bureau and the engine write a schedule's cadence, name (its description) and overlap policy,
 * and for the engine its catch-up choice. A chat's agent, message and whether it continues one chat
 * are written by the Bureau as well, so the page edits them and sends each one that changed. The
 * workflow of a schedule the engine writes is fixed here, so the page shows it and does not send it.
 * Each request names only what changed, through the same draft classes the page used before the
 * form was shared, so a cadence the builder rounds (`30s`) is not rounded by an edit of the name.
 */
import type { ScheduleSpec, ScheduleSummary, ScheduleUpdateOptions } from '@lostgradient/weft';

import type { AgentScheduleUpdate } from '../../lib/bureau-schedules.ts';
import { AGENT_RUN_TYPE } from '../../lib/schedule-kinds.ts';
import { AgentScheduleFormState } from './agent-schedule-form-state.svelte.ts';
import { cadenceOf, cadenceToScheduleValue } from './cadence.ts';
import { newChatId, workflowLabel, type NewScheduleDraft } from './new-schedule-model.ts';
import { ScheduleFormState } from './schedule-form-state.svelte.ts';

/** What the page edits: the schedule as it was read, and what the Bureau says of it. */
export type EditTarget = {
  readonly schedule: ScheduleSummary;
  /** `agent-run` for a Bureau schedule that runs a chat, `code` for one the engine writes. */
  readonly kind: 'agent-run' | 'code';
  /** The agent a chat runs, or `null` when the Bureau does not say. */
  readonly agentName: string | null;
  /** The start of the message a chat sends, or `null` when the Bureau does not say. */
  readonly message: string | null;
  /** Whether every run of a chat continues one chat, which the Bureau says without naming the chat. */
  readonly continuesChat?: boolean;
};

/**
 * Whether the message the Bureau showed is only the start of the message: it serves at most 500
 * characters and ends a cut message in `…`. Saving what the field holds would replace the whole
 * message with the start, so the page leaves such a message as it is.
 */
export function messageIsCut(message: string | null): boolean {
  return message !== null && message.endsWith('…') && Array.from(message).length >= PREVIEW_LENGTH;
}

/** How many characters the Bureau's preview of a message holds at most. */
const PREVIEW_LENGTH = 500;

/** What the schedule is called: its description, or its workflow's words when it has none. */
export function editNameOf(
  schedule: Pick<ScheduleSummary, 'description' | 'workflowType'>,
): string {
  const description = schedule.description?.trim() ?? '';
  return description === '' ? workflowLabel(schedule.workflowType) : description;
}

/** The form the page opens on: every field as the schedule has it. */
export function editDraftOf(target: EditTarget): NewScheduleDraft {
  const { schedule } = target;
  return {
    workflowType: target.kind === 'agent-run' ? AGENT_RUN_TYPE : schedule.workflowType,
    agentName: target.agentName ?? '',
    message: target.message ?? '',
    continueChat: target.kind === 'agent-run' && target.continuesChat === true,
    name: editNameOf(schedule),
    cadence: cadenceToScheduleValue(schedule),
    overlap: schedule.overlap,
    catchUp: target.kind === 'code' && schedule.backfill,
  };
}

/** Whether the person changed the cadence the schedule was opened with. */
export function cadenceChanged(draft: NewScheduleDraft, opened: NewScheduleDraft): boolean {
  return JSON.stringify(draft.cadence) !== JSON.stringify(opened.cadence);
}

/** The description to send: the schedule's own until the name is changed from the one it was shown by. */
function descriptionOf(target: EditTarget, draft: NewScheduleDraft): string {
  const shown = editNameOf(target.schedule);
  return draft.name.trim() === shown ? (target.schedule.description ?? '') : draft.name.trim();
}

/** What `bureau.schedules.update` is sent for a chat the person edited. */
export function agentUpdateOf(
  target: EditTarget,
  draft: NewScheduleDraft,
  opened: NewScheduleDraft,
): AgentScheduleUpdate {
  const { schedule } = target;
  const state = new AgentScheduleFormState({
    cadence: cadenceToScheduleValue(schedule),
    originalCadence: cadenceOf(schedule),
    description: schedule.description ?? '',
    overlap: schedule.overlap === 'allow' ? 'allow' : 'skip',
    revision: schedule.revision,
  });
  if (cadenceChanged(draft, opened)) state.setCadence(draft.cadence);
  state.description = descriptionOf(target, draft);
  state.overlap = draft.overlap === 'allow' ? 'allow' : 'skip';
  // A chat that continues cannot start another run beside itself, so the Bureau refuses `allow` for it.
  if (draft.continueChat) state.overlap = 'skip';
  const agentName = draft.agentName.trim();
  return {
    ...state.toUpdate(),
    ...(agentName !== opened.agentName.trim() ? { agentName } : {}),
    ...(draft.message !== opened.message ? { input: draft.message } : {}),
    ...(draft.continueChat !== opened.continueChat
      ? { sessionId: draft.continueChat ? newChatId() : null }
      : {}),
  };
}

/** What the engine is sent for a schedule it writes: the cadence, and the options that changed. */
export type EngineUpdate = {
  readonly spec: ScheduleSpec;
  readonly options: ScheduleUpdateOptions | undefined;
};

/** What `weft.schedules.update` is sent for a schedule the person edited. */
export function engineUpdateOf(
  target: EditTarget,
  draft: NewScheduleDraft,
  opened: NewScheduleDraft,
): EngineUpdate {
  const { schedule } = target;
  const state = new ScheduleFormState({
    workflowType: schedule.workflowType,
    ...(schedule.description !== undefined ? { description: schedule.description } : {}),
    cadence: cadenceToScheduleValue(schedule),
    originalCadence: cadenceOf(schedule),
    overlap: schedule.overlap,
    jitterText: schedule.jitterMs !== undefined ? `${schedule.jitterMs}ms` : '',
    backfill: schedule.backfill,
    revisionPolicy: schedule.revisionPolicy,
  });
  if (cadenceChanged(draft, opened)) state.setCadence(draft.cadence);
  state.description = descriptionOf(target, draft);
  state.overlap = draft.overlap;
  state.backfill = draft.catchUp;
  return { spec: state.cadenceSpec, options: state.toUpdateOptions() };
}

/** Whether saving would change the cadence or the zone while runs are skipped, which ends the skips the new cadence does not keep. */
export function endsSkippedRun(
  target: EditTarget,
  draft: NewScheduleDraft,
  opened: NewScheduleDraft,
): boolean {
  return (target.schedule.skippedOccurrences?.length ?? 0) > 0 && cadenceChanged(draft, opened);
}
