/**
 * Draft state for the page that edits a schedule that runs an agent (`bureau.schedules.update`). A
 * plain rune-backed class, so validation and the payload are testable without a DOM, as
 * `ScheduleFormState` is. A schedule is made on `new-schedule.svelte`.
 *
 * An edit changes only the cadence, the description, and the overlap policy, which is all
 * `bureau.schedules.update` takes: a schedule's agent, input, and session are fixed when it is made.
 * An edit names the revision of the schedule it was built from, so a schedule that changed since is
 * refused instead of overwritten.
 */
import type { ScheduleValue } from '@lostgradient/cinder';

import { SCHEDULE_COPY } from '../../app/copy.ts';
import { bureauSpecOf, type AgentScheduleUpdate } from '../../lib/bureau-schedules.ts';
import {
  browserTimeZone,
  cadenceTimeZone,
  cadenceToWireSpec,
  describeCadence,
  isSubMinuteInterval,
  scheduleValueTimeZone,
  scheduleValueToWireSpec,
  type ScheduleCadence,
} from './cadence.ts';

/** The longest description the Bureau accepts. */
const MAX_DESCRIPTION_LENGTH = 2_000;

export type AgentOverlap = 'skip' | 'allow';

export type AgentScheduleFormInit = {
  readonly cadence?: ScheduleValue;
  /** The cadence an edit was built from, exactly as stored. Kept and resent unless the operator changes it, so a value the builder rounds, such as `30s`, is not rounded by an unrelated edit. */
  readonly originalCadence?: ScheduleCadence;
  readonly description?: string;
  readonly overlap?: AgentOverlap;
  /** The revision of the schedule an edit was built from. */
  readonly revision?: number;
};

export type AgentScheduleFormErrors = {
  readonly description?: string;
};

function defaultCadence(): ScheduleValue {
  return { every: { unit: 'hours', count: 1 }, timeZone: browserTimeZone() };
}

export class AgentScheduleFormState {
  cadence = $state<ScheduleValue>(defaultCadence());
  description = $state('');
  overlap = $state<AgentOverlap>('skip');
  /** Whether the operator changed the cadence. Until then an edit sends `originalCadence`, not the builder's value. */
  cadenceChanged = $state(false);

  /** The cadence the edit was built from, exactly as stored. */
  readonly originalCadence: ScheduleCadence | undefined;
  /** The revision the schedule was at when this draft was made. */
  readonly revision: number | undefined;
  private readonly initialSpec: string;
  /** The zone the cadence was loaded in: a cron's own, or `undefined` for an interval or a new schedule. */
  private readonly initialTimeZone: string | undefined;
  private readonly initialDescription: string;
  private readonly initialOverlap: AgentOverlap;

  constructor(init: AgentScheduleFormInit) {
    this.cadence = init.cadence ?? this.cadence;
    this.description = init.description ?? this.description;
    this.overlap = init.overlap ?? this.overlap;
    this.revision = init.revision;
    this.originalCadence = init.originalCadence;
    this.initialSpec = this.spec;
    this.initialTimeZone =
      this.originalCadence === undefined ? undefined : cadenceTimeZone(this.originalCadence);
    this.initialDescription = this.description;
    this.initialOverlap = this.overlap;
  }

  /** The cadence in the text the Bureau takes: what the schedule had, until the operator changes it, and then the builder's value. */
  get spec(): string {
    if (!this.cadenceChanged && this.originalCadence !== undefined) {
      const original = cadenceToWireSpec(this.originalCadence);
      if (original !== undefined) return bureauSpecOf(original);
    }
    return bureauSpecOf(scheduleValueToWireSpec(this.cadence));
  }

  /** The zone the cadence is read in: the stored one, until the operator changes the cadence, and then the builder's; `undefined` for an interval. */
  get timeZone(): string | undefined {
    if (!this.cadenceChanged && this.originalCadence !== undefined) {
      return cadenceTimeZone(this.originalCadence);
    }
    return scheduleValueTimeZone(this.cadence);
  }

  /** What the edit page shows in place of the builder, for a cadence the builder cannot show exactly, until the operator asks to change it. */
  get exactCadenceText(): string | undefined {
    if (this.cadenceChanged || this.originalCadence === undefined) return undefined;
    return isSubMinuteInterval(this.originalCadence)
      ? describeCadence(this.originalCadence)
      : undefined;
  }

  /** Takes the cadence the builder committed. */
  setCadence(next: ScheduleValue): void {
    this.cadence = next;
    this.cadenceChanged = true;
  }

  /** Replaces the kept cadence with the builder's value, which the operator then edits. */
  changeCadence(): void {
    this.cadenceChanged = true;
  }

  get errors(): AgentScheduleFormErrors {
    // The description is the one field an edit has to check: the Bureau refuses one that is too long.
    return this.description.length > MAX_DESCRIPTION_LENGTH
      ? { description: SCHEDULE_COPY.form.descriptionTooLong(MAX_DESCRIPTION_LENGTH) }
      : {};
  }

  get isValid(): boolean {
    return Object.keys(this.errors).length === 0;
  }

  /** Whether the draft differs from what it was made from. */
  get isDirty(): boolean {
    return (
      this.spec !== this.initialSpec ||
      this.timeZone !== this.initialTimeZone ||
      this.description !== this.initialDescription ||
      this.overlap !== this.initialOverlap
    );
  }

  /**
   * What `bureau.schedules.update` is sent: the cadence, which Weft replaces wholesale, and the
   * description, overlap policy, and zone only when they changed, so an edit never resends what
   * the person did not touch. The Bureau keeps a zone an update leaves out.
   */
  toUpdate(): AgentScheduleUpdate {
    const description = this.description.trim();
    const timeZone = this.timeZone;
    return {
      spec: this.spec,
      ...(timeZone !== undefined && timeZone !== this.initialTimeZone ? { timeZone } : {}),
      ...(description !== this.initialDescription.trim() ? { description } : {}),
      ...(this.overlap !== this.initialOverlap ? { overlap: this.overlap } : {}),
    };
  }
}
