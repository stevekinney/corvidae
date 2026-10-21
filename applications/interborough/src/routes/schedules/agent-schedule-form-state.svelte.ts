/**
 * Draft state for the drawer that creates and edits a schedule that runs an agent
 * (`bureau.schedules.create` and `bureau.schedules.update`). A plain rune-backed class, so
 * validation and the payloads are testable without a DOM, as `ScheduleFormState` is.
 *
 * Creating takes an agent, a cadence, a description, the text each fire sends, an optional session,
 * and an overlap policy of `skip` or `allow`, which are the Bureau's own. Editing changes only the
 * cadence, the description, and the overlap policy, which is all `bureau.schedules.update` takes: a
 * schedule's agent, input, and session are fixed when it is made. An edit names the revision of the
 * schedule it was built from, so a schedule that changed since is refused instead of overwritten.
 */
import type { ScheduleValue } from '@lostgradient/cinder';

import { SCHEDULE_COPY } from '../../app/copy.ts';
import {
  bureauSpecOf,
  type AgentScheduleInput,
  type AgentScheduleUpdate,
} from '../../lib/bureau-schedules.ts';
import {
  cadenceToWireSpec,
  describeCadence,
  isSubMinuteInterval,
  scheduleValueToWireSpec,
  type ScheduleCadence,
} from './cadence.ts';

/** The longest input, and description, the Bureau accepts. */
const MAX_INPUT_LENGTH = 100_000;
const MAX_DESCRIPTION_LENGTH = 2_000;

export type AgentOverlap = 'skip' | 'allow';

export type AgentScheduleFormInit = {
  readonly mode: 'create' | 'edit';
  readonly agentName?: string;
  readonly cadence?: ScheduleValue;
  /** The cadence an edit was built from, exactly as stored. Kept and resent unless the operator changes it, so a value the builder rounds, such as `30s`, is not rounded by an unrelated edit. */
  readonly originalCadence?: ScheduleCadence;
  readonly description?: string;
  readonly overlap?: AgentOverlap;
  /** The revision of the schedule an edit was built from. */
  readonly revision?: number;
};

export type AgentScheduleFormErrors = {
  readonly agentName?: string;
  readonly description?: string;
  readonly input?: string;
  readonly session?: string;
};

const DEFAULT_CADENCE: ScheduleValue = { mode: 'interval', every: 1, unit: 'hours' };

export class AgentScheduleFormState {
  readonly mode: 'create' | 'edit';
  agentName = $state('');
  cadence = $state<ScheduleValue>(DEFAULT_CADENCE);
  description = $state('');
  input = $state('');
  sessionId = $state('');
  overlap = $state<AgentOverlap>('skip');
  /** Whether the operator changed the cadence. Until then an edit sends `originalCadence`, not the builder's value. */
  cadenceChanged = $state(false);

  /** The cadence an edit was built from, exactly as stored; `undefined` for a new schedule. */
  readonly originalCadence: ScheduleCadence | undefined;
  /** The revision the schedule was at when this draft was made. `undefined` for a new schedule. */
  readonly revision: number | undefined;
  private readonly initialSpec: string;
  private readonly initialDescription: string;
  private readonly initialOverlap: AgentOverlap;

  constructor(init: AgentScheduleFormInit) {
    this.mode = init.mode;
    this.agentName = init.agentName ?? this.agentName;
    this.cadence = init.cadence ?? this.cadence;
    this.description = init.description ?? this.description;
    this.overlap = init.overlap ?? this.overlap;
    this.revision = init.revision;
    this.originalCadence = init.originalCadence;
    this.initialSpec = this.spec;
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

  /** What the edit drawer shows in place of the builder, for a cadence the builder cannot show exactly, until the operator asks to change it. */
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
    const errors: { agentName?: string; description?: string; input?: string; session?: string } =
      {};
    // The description is the one field an edit has to check: the Bureau refuses one that is too long.
    if (this.description.length > MAX_DESCRIPTION_LENGTH) {
      errors.description = SCHEDULE_COPY.form.descriptionTooLong(MAX_DESCRIPTION_LENGTH);
    }
    if (this.mode === 'edit') return errors;
    if (this.agentName.trim().length === 0) errors.agentName = SCHEDULE_COPY.form.agentRequired;
    if (this.input.trim().length === 0) errors.input = SCHEDULE_COPY.form.inputRequired;
    else if (this.input.length > MAX_INPUT_LENGTH) errors.input = SCHEDULE_COPY.form.inputTooLong;
    // The Bureau refuses this pair, so the form says so before it asks.
    if (this.sessionId.trim().length > 0 && this.overlap === 'allow') {
      errors.session = SCHEDULE_COPY.form.sessionWithAllow;
    }
    return errors;
  }

  get isValid(): boolean {
    return Object.keys(this.errors).length === 0;
  }

  /** Whether the draft differs from what it was made from. */
  get isDirty(): boolean {
    return (
      this.spec !== this.initialSpec ||
      this.description !== this.initialDescription ||
      this.overlap !== this.initialOverlap
    );
  }

  /** What `bureau.schedules.create` is sent. Only valid when `isValid` is. */
  toCreateInput(): AgentScheduleInput {
    const description = this.description.trim();
    const sessionId = this.sessionId.trim();
    return {
      agentName: this.agentName.trim(),
      spec: this.spec,
      input: this.input,
      overlap: this.overlap,
      ...(description.length > 0 ? { description } : {}),
      ...(sessionId.length > 0 ? { sessionId } : {}),
    };
  }

  /**
   * What `bureau.schedules.update` is sent: the cadence, which Weft replaces wholesale, and the
   * description and overlap policy only when they changed, so an edit never resends what the
   * person did not touch.
   */
  toUpdate(): AgentScheduleUpdate {
    const description = this.description.trim();
    return {
      spec: this.spec,
      ...(description !== this.initialDescription.trim() ? { description } : {}),
      ...(this.overlap !== this.initialOverlap ? { overlap: this.overlap } : {}),
    };
  }
}
