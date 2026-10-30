/** A unit a millisecond field can be edited in. */
export type DurationUnit = {
  value: string;
  label: string;
  /** Milliseconds in one of this unit. */
  milliseconds: number;
};

/** The units offered next to a duration field, smallest first. */
export const DURATION_UNITS: readonly DurationUnit[] = [
  { value: 'ms', label: 'ms', milliseconds: 1 },
  { value: 's', label: 's', milliseconds: 1000 },
  { value: 'min', label: 'min', milliseconds: 60_000 },
  { value: 'h', label: 'h', milliseconds: 3_600_000 },
];

const MILLISECONDS: DurationUnit = { value: 'ms', label: 'ms', milliseconds: 1 };

/** Picks the unit to show a value in: the largest that divides it evenly, else milliseconds. */
export function durationUnitFor(value: number | undefined): string {
  if (value === undefined || value === 0 || !Number.isFinite(value)) return MILLISECONDS.value;
  const divisor = [...DURATION_UNITS]
    .reverse()
    .find((unit) => Number.isInteger(value / unit.milliseconds));
  return (divisor ?? MILLISECONDS).value;
}

function millisecondsPer(unitValue: string): number {
  return DURATION_UNITS.find((unit) => unit.value === unitValue)?.milliseconds ?? 1;
}

/** Converts stored milliseconds into the number shown in `unitValue`. */
export function fromMilliseconds(milliseconds: number, unitValue: string): number {
  return milliseconds / millisecondsPer(unitValue);
}

/** Converts a number typed in `unitValue` into milliseconds, whole when the schema asks for it. */
export function toMilliseconds(shown: number, unitValue: string, integer: boolean): number {
  const milliseconds = shown * millisecondsPer(unitValue);
  return integer ? Math.round(milliseconds) : Math.round(milliseconds * 1e6) / 1e6;
}
