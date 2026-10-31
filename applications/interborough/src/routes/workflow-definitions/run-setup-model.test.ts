/**
 * The run setup page's decisions outside the page: which workflows can be run from it, which
 * schemas become a form, how a refused input becomes field problems, and the footer's summary.
 */
import { HttpClientError } from '@lostgradient/weft';
import { describe, expect, test } from 'bun:test';

import { WORKFLOW_COPY } from '../../app/copy.ts';
import type { WorkflowResolution } from '../../lib/workflow-catalog.ts';
import { formSchemaOf, inputIssuesOf, runSetupTarget, summaryOf } from './run-setup-model.ts';

const OBJECT_SCHEMA = { type: 'object', properties: { topic: { type: 'string' } } };

function code(inputSchema: unknown): WorkflowResolution {
  return {
    kind: 'code',
    definition: { contract: { inputSchema } } as never,
  };
}

function file(
  overrides: { state?: 'ready' | 'invalid'; paused?: boolean; inputSchema?: unknown },
  definitionSchema?: unknown,
): WorkflowResolution {
  return {
    kind: 'agent-authored',
    file: {
      state: overrides.state ?? 'ready',
      paused: overrides.paused ?? false,
      inputSchema: overrides.inputSchema ?? null,
    } as never,
    definition:
      definitionSchema === undefined
        ? undefined
        : ({ contract: { inputSchema: definitionSchema } } as never),
  };
}

describe('runSetupTarget', () => {
  test('lets a code-defined type run, with the schema its contract registered', () => {
    expect(runSetupTarget('order-processing', code(OBJECT_SCHEMA))).toEqual({
      status: 'ready',
      kind: 'code',
      schema: OBJECT_SCHEMA,
    });
  });

  test('lets a ready file that is not paused run, with the schema it declares', () => {
    expect(runSetupTarget('digest', file({ inputSchema: OBJECT_SCHEMA }))).toEqual({
      status: 'ready',
      kind: 'file',
      schema: OBJECT_SCHEMA,
    });
  });

  test('falls back to the engine’s contract for a file that declares none', () => {
    expect(runSetupTarget('digest', file({}, OBJECT_SCHEMA))).toMatchObject({
      status: 'ready',
      schema: OBJECT_SCHEMA,
    });
  });

  test('never lets a type the Bureau registers for itself run', () => {
    expect(runSetupTarget('agentRun', code(null))).toEqual({ status: 'engine' });
  });

  test('refuses an invalid file and a paused one, each for its own reason', () => {
    expect(runSetupTarget('broken', file({ state: 'invalid' }))).toEqual({ status: 'invalid' });
    expect(runSetupTarget('later', file({ paused: true }))).toEqual({ status: 'paused' });
  });
});

describe('formSchemaOf', () => {
  test('draws a form from an object schema that has fields', () => {
    expect(formSchemaOf(OBJECT_SCHEMA)).toBe(OBJECT_SCHEMA);
  });

  test.each([
    ['no schema', undefined],
    ['null', null],
    ['an object schema with no fields', { type: 'object', properties: {} }],
    ['an object schema that names none', { type: 'object' }],
    ['an array', { type: 'array', items: { type: 'string' } }],
    ['a string', { type: 'string' }],
  ])('enters %s as JSON', (_name, schema) => {
    expect(formSchemaOf(schema)).toBeUndefined();
  });
});

/** A refusal as the Bureau's JSON-RPC answers it: the code is in the envelope's data. */
function refusal(data: Record<string, unknown>): HttpClientError {
  return new HttpClientError(400, 'invalid params', {
    data: { weftCode: 'InvalidParams', ...data },
  });
}

describe('inputIssuesOf', () => {
  test('puts each issue on the field its path names, relative to the input', () => {
    const error = refusal({
      issues: [
        { path: ['input', 'topic'], message: 'Too short.' },
        { path: ['input', 'tags', 1], message: 'Not a string.' },
      ],
    });
    expect(inputIssuesOf(error)).toEqual([
      { path: ['topic'], message: 'Too short.' },
      { path: ['tags', 1], message: 'Not a string.' },
    ]);
  });

  test('reads an issue that is about the input as a whole as the empty path', () => {
    expect(
      inputIssuesOf(refusal({ issues: [{ path: ['input'], message: 'Must be an object.' }] })),
    ).toEqual([{ path: [], message: 'Must be an object.' }]);
  });

  test('keeps a path that is already relative, as the engine answers', () => {
    expect(inputIssuesOf(refusal({ issues: [{ path: ['topic'], message: 'Required.' }] }))).toEqual(
      [{ path: ['topic'], message: 'Required.' }],
    );
  });

  test('reads the engine’s REST refusal, which carries the code on the error itself', () => {
    const error = new HttpClientError(400, 'invalid params', {
      faultCode: 'InvalidParams',
      data: { issues: [{ path: ['topic'], message: 'Required.' }] },
    });
    expect(inputIssuesOf(error)).toEqual([{ path: ['topic'], message: 'Required.' }]);
  });

  test('is null for any other failure', () => {
    expect(inputIssuesOf(new Error('boom'))).toBeNull();
    expect(
      inputIssuesOf(new HttpClientError(404, 'nope', { data: { weftCode: 'NotFound' } })),
    ).toBeNull();
    expect(inputIssuesOf(refusal({}))).toBeNull();
    expect(inputIssuesOf(refusal({ issues: [{ path: ['x'] }, 'text'] }))).toBeNull();
  });
});

describe('summaryOf', () => {
  test('says a run starts now', () => {
    expect(summaryOf('digest', 'now', { cron: '0 9 * * *', timeZone: 'UTC' })).toBe(
      WORKFLOW_COPY.runSetup.summaryNow('digest'),
    );
  });

  test('names the zone of a time of day', () => {
    expect(
      summaryOf('digest', 'schedule', { cron: '0 9 * * *', timeZone: 'America/Los_Angeles' }),
    ).toContain('in America/Los_Angeles');
  });

  test('names no zone for an interval, which counts elapsed time', () => {
    const summary = summaryOf('digest', 'schedule', {
      every: { unit: 'minutes', count: 15 },
      timeZone: 'America/Los_Angeles',
    });
    expect(summary).toBe('Runs digest: Every 15 minutes.');
  });
});
