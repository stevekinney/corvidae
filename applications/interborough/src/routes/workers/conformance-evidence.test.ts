import { describe, expect, test } from 'bun:test';

import {
  MalformedConformanceError,
  parseConformanceReport,
  parseConformanceTargets,
  summarizeConformance,
} from './conformance-evidence.ts';

const NOW = 1_700_000_000_000;

const REPORT = {
  target: 'bun-worker',
  startedAt: NOW,
  completedAt: NOW + 4_000,
  ok: false,
  protocolVersion: 8,
  supportedProtocolVersions: [8],
  checks: [
    { name: 'register', ok: true, message: 'registered' },
    { name: 'heartbeat', ok: false, message: 'no heartbeat within 5s' },
  ],
};

describe('conformance parsing', () => {
  test('accepts targets and reports as the server shapes them', () => {
    expect(
      parseConformanceTargets({ targets: [{ name: 'bun-worker', timeoutMs: 5_000 }] }).targets,
    ).toHaveLength(1);
    expect(parseConformanceTargets({ targets: [] }).targets).toEqual([]);
    expect(parseConformanceReport(REPORT).checks).toHaveLength(2);
  });

  test.each([
    ['a non-object', null],
    ['no targets list', {}],
    ['a target with no name', { targets: [{ timeoutMs: 5_000 }] }],
    ['a target with a non-positive timeout', { targets: [{ name: 'a', timeoutMs: 0 }] }],
  ])('rejects targets with %s', (_name, value) => {
    expect(() => parseConformanceTargets(value)).toThrow(MalformedConformanceError);
  });

  test.each([
    ['a missing verdict', { ...REPORT, ok: undefined }],
    ['an unrepresentable instant', { ...REPORT, completedAt: 1e20 }],
    ['a check with no message', { ...REPORT, checks: [{ name: 'register', ok: true }] }],
    ['a non-integer protocol version', { ...REPORT, protocolVersion: 8.5 }],
    ['unsupported versions that are not numbers', { ...REPORT, supportedProtocolVersions: ['8'] }],
  ])('rejects a report with %s', (_name, value) => {
    expect(() => parseConformanceReport(value)).toThrow(MalformedConformanceError);
  });
});

describe('summarizeConformance', () => {
  test('names the verdict and counts agree with the checks', () => {
    expect(summarizeConformance(parseConformanceReport(REPORT))).toEqual({
      label: 'Not conformant',
      variant: 'danger',
      passed: 1,
      failed: 1,
    });
    expect(
      summarizeConformance(
        parseConformanceReport({ ...REPORT, ok: true, checks: [REPORT.checks[0]] }),
      ),
    ).toEqual({ label: 'Conformant', variant: 'success', passed: 1, failed: 0 });
  });
});
