/**
 * Trust-boundary validation for the worker conformance operations
 * (`weft.conformance.targets` and `weft.conformance.report`, COR-160).
 *
 * A conformance report is about a _target_: a worker command the server
 * operator registered at startup. The server runs that command in a private
 * sandbox server and reports each named check, so a report says whether a
 * worker implementation honors the protocol, not what any connected fleet
 * worker is doing right now. The dashboard never supplies a command.
 *
 * @module
 */
import type { HttpClient } from '@lostgradient/weft';

type Operations = HttpClient['operations'];

export type ConformanceTargetsOutput = Awaited<ReturnType<Operations['weft.conformance.targets']>>;
export type ConformanceTarget = ConformanceTargetsOutput['targets'][number];
export type ConformanceReport = Awaited<ReturnType<Operations['weft.conformance.report']>>;
export type ConformanceCheck = ConformanceReport['checks'][number];

export class MalformedConformanceError extends Error {
  constructor(what: 'targets' | 'report') {
    super(`Weft returned a malformed conformance ${what} response.`);
    this.name = 'MalformedConformanceError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 8.64e15;
}

function isTarget(value: unknown): value is ConformanceTarget {
  return (
    isRecord(value) && typeof value['name'] === 'string' && isPositiveInteger(value['timeoutMs'])
  );
}

function isTargets(value: unknown): value is ConformanceTargetsOutput {
  return isRecord(value) && Array.isArray(value['targets']) && value['targets'].every(isTarget);
}

function isCheck(value: unknown): value is ConformanceCheck {
  return (
    isRecord(value) &&
    typeof value['name'] === 'string' &&
    typeof value['ok'] === 'boolean' &&
    typeof value['message'] === 'string'
  );
}

function isReport(value: unknown): value is ConformanceReport {
  return (
    isRecord(value) &&
    typeof value['target'] === 'string' &&
    isTimestamp(value['startedAt']) &&
    isTimestamp(value['completedAt']) &&
    typeof value['ok'] === 'boolean' &&
    isPositiveInteger(value['protocolVersion']) &&
    Array.isArray(value['supportedProtocolVersions']) &&
    value['supportedProtocolVersions'].every(isPositiveInteger) &&
    Array.isArray(value['checks']) &&
    value['checks'].every(isCheck)
  );
}

export function parseConformanceTargets(value: unknown): ConformanceTargetsOutput {
  if (!isTargets(value)) throw new MalformedConformanceError('targets');
  return value;
}

export function parseConformanceReport(value: unknown): ConformanceReport {
  if (!isReport(value)) throw new MalformedConformanceError('report');
  return value;
}

export interface ConformanceSummary {
  readonly label: string;
  readonly variant: 'success' | 'danger';
  readonly passed: number;
  readonly failed: number;
}

/** The overall verdict in words, with counts that must agree with the checks listed. */
export function summarizeConformance(report: ConformanceReport): ConformanceSummary {
  const passed = report.checks.filter((check) => check.ok).length;
  const failed = report.checks.length - passed;
  return {
    label: report.ok ? 'Conformant' : 'Not conformant',
    variant: report.ok ? 'success' : 'danger',
    passed,
    failed,
  };
}
