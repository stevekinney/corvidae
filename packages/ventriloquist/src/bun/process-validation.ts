import {
  MAXIMUM_TERMINAL_DIMENSION,
  MINIMUM_TERMINAL_DIMENSION,
} from '../protocol/protocol-constants.ts';
import type { TerminalDimensions } from '../session/session-types.ts';
import type { ProcessProfile } from './process-types.ts';

/**
 * Copy what a caller handed over, so that what is validated is what later runs. Validation happens
 * at construction and the spawn at a deferred start, and a caller that mutates its own objects in
 * between must not turn a validated command into another one. The copy is taken first and the copy
 * is what gets validated. A value of the wrong shape is passed through untouched for the validator
 * to refuse.
 */
export function snapshotProfile(profile: ProcessProfile): ProcessProfile {
  return {
    executable: profile.executable,
    argumentList: Array.isArray(profile.argumentList)
      ? [...profile.argumentList]
      : profile.argumentList,
    workingDirectory: profile.workingDirectory,
    environment:
      typeof profile.environment === 'object' && profile.environment !== null
        ? { ...profile.environment }
        : profile.environment,
  };
}

/** Copy the dimensions for the same reason as `snapshotProfile`. */
export function snapshotDimensions(dimensions: TerminalDimensions): TerminalDimensions {
  return typeof dimensions === 'object' && dimensions !== null
    ? { columns: dimensions.columns, rows: dimensions.rows }
    : dimensions;
}

const NUL = '\u0000';

function assertText(label: string, value: unknown): asserts value is string {
  if (typeof value !== 'string') throw new TypeError(`${label} must be a string`);
  if (value.includes(NUL)) throw new TypeError(`${label} must not contain a NUL character`);
}

/**
 * Reject a profile that is not an explicit, well-formed description of one process. The profile is
 * the host's decision, so this checks shape and never rewrites: a relative working directory, an
 * empty executable, an environment name containing `=` and a NUL anywhere are refused rather than
 * repaired, and the executable is never split, expanded or looked up through a shell.
 */
export function validateProcessProfile(profile: ProcessProfile): void {
  assertText('executable', profile.executable);
  if (profile.executable.length === 0) throw new TypeError('executable must not be empty');
  if (!Array.isArray(profile.argumentList)) throw new TypeError('argumentList must be an array');
  profile.argumentList.forEach((argument: unknown, index) => {
    assertText(`argumentList[${index}]`, argument);
  });
  assertText('workingDirectory', profile.workingDirectory);
  if (!profile.workingDirectory.startsWith('/')) {
    throw new TypeError('workingDirectory must be an absolute path');
  }
  for (const [name, value] of Object.entries(profile.environment)) {
    assertText(`environment name ${JSON.stringify(name)}`, name);
    if (name.length === 0 || name.includes('=')) {
      throw new TypeError(
        `environment name ${JSON.stringify(name)} must be non-empty and free of =`,
      );
    }
    assertText(`environment value of ${name}`, value);
  }
}

/** Reject geometry a PTY cannot start from: whole columns and rows inside the protocol's limits. */
export function validateDimensions(dimensions: TerminalDimensions): void {
  for (const [label, value] of [
    ['columns', dimensions.columns],
    ['rows', dimensions.rows],
  ] as const) {
    if (
      !Number.isInteger(value) ||
      value < MINIMUM_TERMINAL_DIMENSION ||
      value > MAXIMUM_TERMINAL_DIMENSION
    ) {
      throw new RangeError(
        `${label} must be an integer from ${MINIMUM_TERMINAL_DIMENSION} to ${MAXIMUM_TERMINAL_DIMENSION}`,
      );
    }
  }
}

/** Reject a setting outside its documented whole-number range. */
export function validateWholeNumber(
  label: string,
  value: number,
  minimum: number,
  maximum: number,
): void {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${label} must be a whole number from ${minimum} to ${maximum}`);
  }
}
