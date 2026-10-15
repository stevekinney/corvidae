import { describe, expect, test } from 'bun:test';

import type { ProcessProfile } from './process-types.ts';
import {
  validateDimensions,
  validateProcessProfile,
  validateWholeNumber,
} from './process-validation.ts';

const valid: ProcessProfile = {
  executable: '/bin/sh',
  argumentList: ['-c', 'true'],
  workingDirectory: '/tmp',
  environment: { PATH: '/usr/bin', EMPTY: '' },
};

function profileWith(overrides: Partial<Record<keyof ProcessProfile, unknown>>): ProcessProfile {
  return { ...valid, ...overrides } as ProcessProfile;
}

describe('validateProcessProfile', () => {
  test('accepts an explicit profile, including an empty argument list and environment', () => {
    expect(() => validateProcessProfile(valid)).not.toThrow();
    expect(() =>
      validateProcessProfile({ ...valid, argumentList: [], environment: {} }),
    ).not.toThrow();
  });

  test.each([
    ['an empty executable', { executable: '' }],
    ['a non-string executable', { executable: 7 }],
    ['an executable with a NUL', { executable: 'sh\u0000' }],
    ['a non-array argument list', { argumentList: '-c true' }],
    ['a non-string argument', { argumentList: ['-c', 1] }],
    ['an argument with a NUL', { argumentList: ['a\u0000b'] }],
    ['a relative working directory', { workingDirectory: 'tmp' }],
    ['an empty working directory', { workingDirectory: '' }],
    ['a working directory with a NUL', { workingDirectory: '/tmp\u0000' }],
    ['a non-string working directory', { workingDirectory: undefined }],
    ['an empty environment name', { environment: { '': 'x' } }],
    ['an environment name containing =', { environment: { 'A=B': 'x' } }],
    ['an environment name with a NUL', { environment: { 'A\u0000': 'x' } }],
    ['a non-string environment value', { environment: { A: 1 } }],
    ['an environment value with a NUL', { environment: { A: 'x\u0000' } }],
  ])('refuses %s', (_label, overrides) => {
    expect(() => validateProcessProfile(profileWith(overrides))).toThrow(TypeError);
  });
});

describe('validateDimensions', () => {
  test('accepts whole columns and rows inside the protocol limits', () => {
    expect(() => validateDimensions({ columns: 1, rows: 65_535 })).not.toThrow();
  });

  test.each([
    [0, 24],
    [80, 0],
    [65_536, 24],
    [80, 65_536],
    [80.5, 24],
    [80, Number.NaN],
    [-1, 24],
  ])('refuses %j columns by %j rows', (columns, rows) => {
    expect(() => validateDimensions({ columns, rows })).toThrow(RangeError);
  });
});

describe('validateWholeNumber', () => {
  test('names the setting and its range when the value falls outside it', () => {
    expect(() => validateWholeNumber('setting', 5, 1, 10)).not.toThrow();
    for (const value of [0, 11, 2.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => validateWholeNumber('setting', value, 1, 10)).toThrow(
        'setting must be a whole number from 1 to 10',
      );
    }
  });
});
