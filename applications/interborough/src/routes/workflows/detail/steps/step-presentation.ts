/**
 * How one timeline step reads on the page: its name in words, its status in a word and a dot, and
 * the input and output the engine kept for it. The engine keeps a summary of each, as text, and
 * this module only lays it out; it never rebuilds a value the engine did not record.
 */
import type { StatusDotStatus } from '@lostgradient/cinder';
import type { WorkflowTimelineEntry, WorkflowTimelineStatus } from '@lostgradient/weft';

import { compensatedActivityName, timelineEntryLabel } from '../timeline/timeline-mapping.ts';

/** A step's status as a word and the dot beside it. */
export interface StepStatus {
  readonly label: string;
  readonly dot: StatusDotStatus;
}

const STEP_STATUS: Readonly<Record<WorkflowTimelineStatus, StepStatus>> = {
  running: { label: 'Running', dot: 'pending' },
  completed: { label: 'Succeeded', dot: 'success' },
  failed: { label: 'Failed', dot: 'danger' },
  cancelled: { label: 'Cancelled', dot: 'neutral' },
  'timed-out': { label: 'Timed out', dot: 'danger' },
};

/** The word and dot for a step's status. */
export function stepStatus(status: WorkflowTimelineStatus): StepStatus {
  return STEP_STATUS[status];
}

/**
 * A name written in code, said as words: `chargeCard` is "Charge card", `send_receipt` is "Send
 * receipt". A name that is already a phrase is left as it is.
 */
export function humanizeStepName(name: string): string {
  if (/\s/.test(name)) return name;
  const words = name
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim();
  if (words === '') return name;
  return words.charAt(0).toUpperCase() + words.slice(1).toLowerCase();
}

/** What a step is called and what it is named in code. */
export interface StepName {
  /** The name in words, for the row and the detail's heading. */
  readonly readable: string;
  /** The name in code, shown beside it, or `undefined` when it is the same text. */
  readonly raw: string | undefined;
}

/** A step's readable name, with its raw name when the two differ. */
export function stepName(entry: WorkflowTimelineEntry): StepName {
  const raw = entry.operationLabel;
  const structural = timelineEntryLabel(entry);
  // A saga's undo of an earlier step is named for what it undoes.
  const compensated = compensatedActivityName(entry);
  const readable =
    compensated !== null
      ? `Undo ${humanizeStepName(compensated).toLowerCase()}`
      : entry.operationType === 'activity'
        ? humanizeStepName(raw)
        : structural;
  return { readable, raw: raw === readable ? undefined : raw };
}

/**
 * A summary the engine kept, laid out for reading: a JSON value is indented, and anything else
 * (an error message, a value cut short) is shown as it was kept.
 */
export function prettySummary(summary: string): string {
  try {
    const parsed: unknown = JSON.parse(summary);
    return typeof parsed === 'object' && parsed !== null
      ? JSON.stringify(parsed, null, 2)
      : summary;
  } catch {
    return summary;
  }
}
