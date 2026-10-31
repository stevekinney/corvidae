/**
 * What the run setup page (`/workflows/:workflow/run`) decides outside the page: whether a
 * workflow can be run from it, the schema its input form is drawn from, the Bureau's or the
 * engine's refusal of an input turned into the field problems the form shows, and the one-line
 * summary of what the primary action will do.
 */
import type { ScheduleValue } from '@lostgradient/cinder';
import { HttpClientError } from '@lostgradient/weft';

import { WORKFLOW_COPY } from '../../app/copy.ts';
import { isEngineType, type WorkflowResolution } from '../../lib/workflow-catalog.ts';
import { describeCronExpression, describeIntervalMs } from '../schedules/cadence.ts';
import { schemaOf } from './workflow-presentation.ts';

/** Where a refused input goes: the field its path names, or the form itself when the path is empty. */
export type InputIssue = {
  readonly path: readonly (string | number)[];
  readonly message: string;
};

/** What a run is started from: a file the Bureau holds, or a type that code registered. */
export type RunSetupTarget =
  | {
      readonly status: 'ready';
      readonly kind: 'file' | 'code';
      /** The JSON Schema the input is described by, or `undefined` when the workflow declares none. */
      readonly schema: unknown;
    }
  | { readonly status: 'engine' | 'invalid' | 'paused' };

/**
 * Whether the workflow can be run from the page. The types the Bureau registers to run itself are
 * never started by a person, and a file that is invalid or paused starts nothing.
 */
export function runSetupTarget(type: string, resolution: WorkflowResolution): RunSetupTarget {
  if (isEngineType(type)) return { status: 'engine' };
  if (resolution.kind === 'code') {
    return {
      status: 'ready',
      kind: 'code',
      schema: schemaOf(undefined, resolution.definition, 'inputSchema'),
    };
  }
  const { file } = resolution;
  if (file.state !== 'ready') return { status: 'invalid' };
  if (file.paused) return { status: 'paused' };
  return {
    status: 'ready',
    kind: 'file',
    schema: schemaOf(file.inputSchema, resolution.definition, 'inputSchema'),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The schema a form can be drawn from: an object schema with fields. Anything else (no schema, an
 * array or a scalar input, an object that names no field) is entered as JSON.
 */
export function formSchemaOf(schema: unknown): Record<string, unknown> | undefined {
  if (!isRecord(schema) || schema['type'] !== 'object') return undefined;
  const properties = schema['properties'];
  return isRecord(properties) && Object.keys(properties).length > 0 ? schema : undefined;
}

/**
 * The field problems in a refusal of the input: an `InvalidParams` fault that lists its issues,
 * which both services answer. The Bureau roots every path at the `input` it was sent, so a path
 * that starts there is relative to the input from then on; `[]` is the input as a whole. `null`
 * when the error is not such a refusal.
 */
export function inputIssuesOf(error: unknown): readonly InputIssue[] | null {
  if (!(error instanceof HttpClientError)) return null;
  const data = error.data;
  // JSON-RPC carries the code in the envelope's data, and a REST body in the error itself.
  const invalid = data?.['weftCode'] === 'InvalidParams' || error.faultCode === 'InvalidParams';
  if (!invalid || data === undefined || !Array.isArray(data['issues'])) return null;
  const issues: InputIssue[] = [];
  for (const issue of data['issues'] as unknown[]) {
    if (!isRecord(issue) || typeof issue['message'] !== 'string') continue;
    const raw = Array.isArray(issue['path']) ? (issue['path'] as unknown[]) : [];
    const path = raw.filter(
      (segment): segment is string | number =>
        typeof segment === 'string' || typeof segment === 'number',
    );
    issues.push({ path: path[0] === 'input' ? path.slice(1) : path, message: issue['message'] });
  }
  return issues.length === 0 ? null : issues;
}

const INTERVAL_UNIT_MS = { minutes: 60_000, hours: 3_600_000 } as const;

/** A schedule value in words: a time of day or days, or an interval. */
export function cadenceWords(value: ScheduleValue): string {
  if ('cron' in value) return describeCronExpression(value.cron);
  return describeIntervalMs(value.every.count * INTERVAL_UNIT_MS[value.every.unit]);
}

/** The one line the footer shows: what the primary action does with the choices made so far. */
export function summaryOf(type: string, when: 'now' | 'schedule', schedule: ScheduleValue): string {
  if (when === 'now') return WORKFLOW_COPY.runSetup.summaryNow(type);
  const zone = 'cron' in schedule ? schedule.timeZone : undefined;
  return WORKFLOW_COPY.runSetup.summarySchedule(type, cadenceWords(schedule), zone);
}
