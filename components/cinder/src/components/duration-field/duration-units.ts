/** A unit a millisecond field can be edited in. */
export type DurationUnit = {
  /** The value the unit select reports, such as `s`. */
  value: string;
  /** The short label shown in the unit select, such as `s`. */
  label: string;
  /** Milliseconds in one of this unit. */
  milliseconds: number;
  /** The word shown beside the number when the unit is fixed, such as `seconds`. Defaults to `label`. */
  name?: string;
};

/** The units offered next to a duration field, smallest first. */
export const DURATION_UNITS: readonly DurationUnit[] = [
  { value: 'ms', label: 'ms', milliseconds: 1, name: 'milliseconds' },
  { value: 's', label: 's', milliseconds: 1000, name: 'seconds' },
  { value: 'min', label: 'min', milliseconds: 60_000, name: 'minutes' },
  { value: 'h', label: 'h', milliseconds: 3_600_000, name: 'hours' },
];

const MILLISECONDS: DurationUnit = DURATION_UNITS[0]!;

/**
 * Picks the unit to show a value in: the largest of `units` that divides it evenly, else the
 * smallest. `units` must be ordered smallest first.
 */
export function durationUnitFor(
  value: number | null | undefined,
  units: readonly DurationUnit[] = DURATION_UNITS,
): string {
  const smallest = units[0] ?? MILLISECONDS;
  if (value === undefined || value === null || value === 0 || !Number.isFinite(value)) {
    return smallest.value;
  }
  const divisor = [...units].reverse().find((unit) => Number.isInteger(value / unit.milliseconds));
  return (divisor ?? smallest).value;
}

function millisecondsPer(unitValue: string, units: readonly DurationUnit[]): number {
  return units.find((unit) => unit.value === unitValue)?.milliseconds ?? 1;
}

/** Converts stored milliseconds into the number shown in `unitValue`. */
export function fromMilliseconds(
  milliseconds: number,
  unitValue: string,
  units: readonly DurationUnit[] = DURATION_UNITS,
): number {
  return milliseconds / millisecondsPer(unitValue, units);
}

/** Converts a number typed in `unitValue` into milliseconds, whole when the schema asks for it. */
export function toMilliseconds(
  shown: number,
  unitValue: string,
  integer: boolean,
  units: readonly DurationUnit[] = DURATION_UNITS,
): number {
  const milliseconds = shown * millisecondsPer(unitValue, units);
  return integer ? Math.round(milliseconds) : Math.round(milliseconds * 1e6) / 1e6;
}
