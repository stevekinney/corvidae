import { describe, expect, test } from 'bun:test';

import { isProcessAlive, processTableEnvironment } from './process-identity.ts';

/** A pid no process holds: above any pid a supported host assigns. */
const unusedPid = 99_999_999;

describe('isProcessAlive', () => {
  test('is true for this process and false for a pid nothing holds', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(unusedPid)).toBe(false);
  });
});

describe('processTableEnvironment', () => {
  test('runs `ps` in the C locale and without the caller’s time zone', () => {
    const environment = processTableEnvironment();
    expect(environment['LC_ALL']).toBe('C');
    expect(Object.hasOwn(environment, 'TZ')).toBe(false);
  });
});
