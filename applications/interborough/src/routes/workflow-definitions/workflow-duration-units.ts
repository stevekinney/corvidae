/**
 * What the builder gives Cinder's `DurationField` for a wait's length and its limit. The field
 * counts a duration in milliseconds and the file writes it as a whole number of one unit (`15m`), so
 * these turn the number the field reports into the amount the model writes, and back.
 */
import type { DurationUnit } from '@lostgradient/cinder';

import { WORKFLOW_COPY } from '../../app/copy/workflows.ts';
import { WAIT_UNITS, type WaitUnit } from './workflow-builder-model.ts';

const MILLISECONDS: Readonly<Record<WaitUnit, number>> = {
  seconds: 1000,
  minutes: 60_000,
  hours: 3_600_000,
  days: 86_400_000,
};

/** The units a wait is counted in, smallest first, as the field offers them. */
export const WAIT_DURATION_UNITS: readonly DurationUnit[] = WAIT_UNITS.map((unit) => ({
  value: unit,
  label: WORKFLOW_COPY.builder.units[unit],
  milliseconds: MILLISECONDS[unit],
  name: WORKFLOW_COPY.builder.units[unit],
}));

/** Whether `value` is one of the units the field offers. */
export function isWaitUnit(value: string | undefined): value is WaitUnit {
  return WAIT_UNITS.some((unit) => unit === value);
}

/** The milliseconds `amount` of `unit` is, or `null` while the amount is empty or not a number. */
export function millisecondsOf(amount: string, unit: WaitUnit): number | null {
  if (amount.trim() === '') return null;
  const parsed = Number(amount);
  if (!Number.isFinite(parsed)) return null;
  // The field rounds what it reports the same way, so a value that comes back is the one it sent.
  return Math.round(parsed * MILLISECONDS[unit] * 1e6) / 1e6;
}

/** The amount of `unit` that `milliseconds` is, as the text the file writes; empty for `null`. */
export function amountOf(milliseconds: number | null, unit: WaitUnit): string {
  if (milliseconds === null) return '';
  return String(Math.round((milliseconds / MILLISECONDS[unit]) * 1e9) / 1e9);
}
