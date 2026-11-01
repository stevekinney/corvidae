/**
 * Edit schedule form state (Track B, plan §9.3; design `Weft New Surfaces.dc.html` §A2 — layout is
 * binding, see `overlap-policy.ts`'s doc for why its consequence COPY isn't). A schedule is made on
 * `new-schedule.svelte`, which holds its own draft; this is what the edit page changes. A plain
 * rune-backed class (`.svelte.ts`, no component coupling) so validation and payload-building are
 * unit-testable without a DOM, matching `src/app/notifications.svelte.ts`'s /
 * `src/lib/scopes.svelte.ts`'s class store pattern.
 */
import type { ScheduleValue } from '@lostgradient/cinder';

import type {
  ScheduleOverlapPolicy,
  ScheduleRevisionPolicy,
  ScheduleSpec,
  ScheduleUpdateOptions,
} from '@lostgradient/weft';

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

/** Mirrors weft's `Duration` string grammar (`weft/src/core/scheduler/duration.ts` `DURATION_PATTERN`) for inline jitter validation. */
const DURATION_PATTERN =
  /^(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|seconds?|m|minutes?|h|hours?|d|days?)$/i;

export function jitterError(jitterText: string): string | undefined {
  if (jitterText.trim().length === 0) return undefined; // empty is valid — no jitter
  return DURATION_PATTERN.test(jitterText.trim())
    ? undefined
    : 'Use a duration like "30s", "5m", or "1h".';
}

export interface ScheduleFormFieldErrors {
  readonly jitter?: string;
}

export interface ScheduleFormInit {
  /** The schedule's workflow type, which an edit shows and cannot change. */
  readonly workflowType?: string;
  readonly description?: string;
  readonly cadence?: ScheduleValue;
  /** The cadence an edit was built from, exactly as stored. Kept and resent unless the operator changes it, so a value the builder rounds, such as `30s`, is not rounded by an unrelated edit. */
  readonly originalCadence?: ScheduleCadence;
  readonly overlap?: ScheduleOverlapPolicy;
  readonly jitterText?: string;
  readonly backfill?: boolean;
  /** Prefills the edit page from the fetched `ScheduleSummary.revisionPolicy` (WFT-117). Defaults to `'active-at-fire'`. */
  readonly revisionPolicy?: ScheduleRevisionPolicy;
}

function defaultCadence(): ScheduleValue {
  return { every: { unit: 'minutes', count: 15 }, timeZone: browserTimeZone() };
}

/**
 * `value ?? fallback`, extracted to a named helper rather than inlined nine
 * times in the constructor below — each inline `??` counts as its own
 * branch toward that function's cyclomatic complexity (eslint's
 * `complexity` rule), and nine of them plus the constructor's own default
 * parameter pushed it over this repo's ceiling. A sequence of plain
 * function calls carries none of that cost.
 */
function withDefault<T>(value: T | undefined, fallback: T): T {
  return value ?? fallback;
}

/**
 * Draft state for the edit schedule page.
 *
 * `cadence` is set exclusively via Cinder's `ScheduleBuilder` `onchange`,
 * which — per that component's own contract — only ever commits an already-
 * valid value (module doc), so this class does not re-validate it.
 */
export class ScheduleFormState {
  workflowType = $state('');
  description = $state('');
  cadence = $state<ScheduleValue>(defaultCadence());
  overlap = $state<ScheduleOverlapPolicy>('skip');
  jitterText = $state('');
  backfill = $state(false);
  revisionPolicy = $state<ScheduleRevisionPolicy>('active-at-fire');

  /** The cadence the edit was built from, exactly as stored. */
  readonly originalCadence: ScheduleCadence | undefined;
  /** Whether the operator changed the cadence. Until then an edit sends `originalCadence`, not the builder's value. */
  cadenceChanged = $state(false);

  /**
   * The policy this draft started from — captured once at construction, not
   * reactive. `toUpdateRevisionPolicy()` diffs the live `revisionPolicy`
   * against this to decide whether an edit submission needs to send
   * `revisionPolicy` at all. See that method's doc for why sending it
   * unconditionally on every edit would be a correctness bug, not just an
   * inefficiency: `'pinned'` is never a no-op server-side — it always
   * RE-captures the revision active at that moment.
   */
  readonly initialRevisionPolicy: ScheduleRevisionPolicy;

  /** The other editable options as loaded, for the same omit-when-unchanged diff `toUpdateOptions()` applies to every option (COR-15). */
  readonly initialDescription: string;
  readonly initialOverlap: ScheduleOverlapPolicy;
  readonly initialJitterText: string;
  readonly initialBackfill: boolean;
  /** The cadence as loaded, in wire form with its zone, so `isDirty` sees a cadence-only or zone-only edit. */
  readonly initialCadenceSpec: string;
  /** The zone the cadence was loaded in: a cron's own, or `undefined` for an interval or a new schedule. */
  readonly initialTimeZone: string | undefined;

  constructor(init: ScheduleFormInit = {}) {
    this.workflowType = withDefault(init.workflowType, this.workflowType);
    this.description = withDefault(init.description, this.description);
    this.cadence = withDefault(init.cadence, this.cadence);
    this.overlap = withDefault(init.overlap, this.overlap);
    this.jitterText = withDefault(init.jitterText, this.jitterText);
    this.backfill = withDefault(init.backfill, this.backfill);
    this.revisionPolicy = withDefault(init.revisionPolicy, this.revisionPolicy);
    this.originalCadence = init.originalCadence;
    this.initialRevisionPolicy = this.revisionPolicy;
    this.initialDescription = this.description;
    this.initialOverlap = this.overlap;
    this.initialJitterText = this.jitterText.trim();
    this.initialBackfill = this.backfill;
    this.initialTimeZone =
      this.originalCadence === undefined ? undefined : cadenceTimeZone(this.originalCadence);
    this.initialCadenceSpec = this.cadenceKey;
  }

  /** The cadence and its zone as one comparable string. */
  private get cadenceKey(): string {
    return JSON.stringify([this.cadenceSpec, this.cadenceTimeZone]);
  }

  /** The zone the cadence is read in: the stored one, until the operator changes the cadence, and then the builder's; `undefined` for an interval. */
  get cadenceTimeZone(): string | undefined {
    if (!this.cadenceChanged && this.originalCadence !== undefined) {
      return cadenceTimeZone(this.originalCadence);
    }
    return scheduleValueTimeZone(this.cadence);
  }

  /** The cadence in wire form: what the schedule had, until the operator changes it, and then the builder's value. */
  get cadenceSpec(): ScheduleSpec {
    if (!this.cadenceChanged && this.originalCadence !== undefined) {
      const original = cadenceToWireSpec(this.originalCadence);
      if (original !== undefined) return original;
    }
    return scheduleValueToWireSpec(this.cadence);
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

  get errors(): ScheduleFormFieldErrors {
    const jitterIssue = jitterError(this.jitterText) ?? this.clearedJitterError();
    return jitterIssue !== undefined ? { jitter: jitterIssue } : {};
  }

  /** `weft.schedules.update` accepts only a positive `jitter`; there is no way to unset one, so an edit draft that empties a loaded jitter cannot be expressed and is rejected inline instead of being silently dropped. */
  private clearedJitterError(): string | undefined {
    if (this.initialJitterText.length > 0 && this.jitterText.trim().length === 0) {
      return 'Jitter can be changed but not removed once set — enter a new duration.';
    }
    return undefined;
  }

  get isValid(): boolean {
    return Object.keys(this.errors).length === 0;
  }

  /**
   * The `revisionPolicy` an edit submission should send, or `undefined` to
   * omit it entirely (preserving the schedule's current policy AND its
   * captured pin unchanged — `ScheduleUpdateOptions`'s own doc,
   * `@lostgradient/weft`). Only returns a value when the draft's live
   * `revisionPolicy` differs from {@link initialRevisionPolicy}: sending
   * `revisionPolicy: 'pinned'` unconditionally on every unrelated cadence
   * edit would silently RE-capture the pin against whatever happens to be
   * active at that moment — the engine documents `'pinned'` as never a
   * no-op, so an unchanged-but-resent pin is a real correctness bug, not a
   * redundant no-op call.
   */
  toUpdateRevisionPolicy(): ScheduleRevisionPolicy | undefined {
    return this.revisionPolicy === this.initialRevisionPolicy ? undefined : this.revisionPolicy;
  }

  /** Whether any editable field differs from what the draft was constructed with. Lets the edit page keep an operator's unsaved changes when a background refetch delivers newer server data (COR-15). */
  get isDirty(): boolean {
    return (
      this.cadenceKey !== this.initialCadenceSpec ||
      this.description !== this.initialDescription ||
      this.overlap !== this.initialOverlap ||
      this.jitterText.trim() !== this.initialJitterText ||
      this.backfill !== this.initialBackfill ||
      this.revisionPolicy !== this.initialRevisionPolicy
    );
  }

  /**
   * The `weft.schedules.update` options an edit submission should send, or
   * `undefined` when nothing changed. Every option follows
   * `toUpdateRevisionPolicy()`'s omit-when-unchanged rule so an unrelated
   * cadence-only edit never resends a value the operator did not touch.
   * `description` is sent trimmed and may be `''`, which clears it (the
   * engine stores any string). `jitter` cannot be cleared this way — the
   * engine only accepts a positive duration — which is why emptying a loaded
   * jitter is a validation error rather than an omitted key.
   */
  toUpdateOptions(): ScheduleUpdateOptions | undefined {
    const revisionPolicy = this.toUpdateRevisionPolicy();
    const description = this.description.trim();
    const jitter = this.jitterText.trim();
    // Weft keeps a schedule's zone when an update leaves it out, so it is sent only when it changed.
    const timeZone = this.cadenceTimeZone;
    const options: ScheduleUpdateOptions = {
      ...(description !== this.initialDescription.trim() ? { description } : {}),
      ...(this.overlap !== this.initialOverlap ? { overlap: this.overlap } : {}),
      ...(this.backfill !== this.initialBackfill ? { backfill: this.backfill } : {}),
      ...(jitter !== this.initialJitterText && jitter.length > 0 ? { jitter } : {}),
      ...(timeZone !== undefined && timeZone !== this.initialTimeZone ? { timeZone } : {}),
      ...(revisionPolicy !== undefined ? { revisionPolicy } : {}),
    };
    return Object.keys(options).length === 0 ? undefined : options;
  }
}
