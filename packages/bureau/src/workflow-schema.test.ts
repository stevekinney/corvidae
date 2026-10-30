/**
 * COR-1812 — the input and output schemas of a workflow file: how the file format carries them,
 * what they do to a revision's version, the limits they are held to, and how an input is judged.
 */
import { workflowDocumentVersion } from '@lostgradient/weft';
import { describe, expect, it } from 'bun:test';

import { createWorkflowDocumentHost } from './workflow-host';
import {
  parseWorkflowFile,
  serializeWorkflowFile,
  workflowVersionOf,
  type WorkflowFileDefinition,
} from './workflow-file';
import {
  checkWorkflowSchema,
  finishReasonOf,
  inputSchemaIssues,
  workflowInputOf,
  WorkflowInputInvalidError,
} from './workflow-schema';

const host = createWorkflowDocumentHost({
  runAgentStep: async () => ({ content: '', output: null, finishReason: 'stop-condition' }),
});

const INPUT_SCHEMA = {
  type: 'object',
  properties: { city: { type: 'string' } },
  required: ['city'],
} as const;
const OUTPUT_SCHEMA = { type: 'object', required: ['content'] } as const;

function file(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    name: 'digest',
    trigger: { kind: 'signal', name: 'go' },
    steps: [
      { kind: 'activity', handler: 'agent', input: { agent: 'writer', message: 'Write it' } },
    ],
    ...overrides,
  });
}

function readyFile(overrides: Record<string, unknown> = {}) {
  const parsed = parseWorkflowFile('digest', file(overrides), host);
  if (!parsed.ok) throw new Error(parsed.problem.message);
  return parsed.file;
}

function problemOf(overrides: Record<string, unknown>) {
  const parsed = parseWorkflowFile('digest', file(overrides), host);
  if (parsed.ok) throw new Error('expected a problem');
  return parsed.problem;
}

describe('a workflow file with schemas', () => {
  it('keeps the version it had without them, and takes another with either or both', async () => {
    const without = readyFile();
    const versions = new Set([
      workflowVersionOf(without.document),
      workflowVersionOf(readyFile({ inputSchema: INPUT_SCHEMA }).document),
      workflowVersionOf(readyFile({ outputSchema: OUTPUT_SCHEMA }).document),
      workflowVersionOf(
        readyFile({ inputSchema: INPUT_SCHEMA, outputSchema: OUTPUT_SCHEMA }).document,
      ),
    ]);

    expect(versions.size).toBe(4);
    // The version of a file with no schemas is the one the format always produced.
    expect(Object.keys(without.document).toSorted()).toEqual(['name', 'steps', 'trigger']);
    expect(workflowVersionOf(without.document)).toBe(
      await workflowDocumentVersion(without.document),
    );
    expect(without.inputSchema).toBeNull();
    expect(without.outputSchema).toBeNull();
  });

  it('pins the version of a file without schemas', () => {
    expect(workflowVersionOf(readyFile().document)).toBe(
      'sha256:e22eb43d9c1420a496f218df8783f220645e9ba31cceda422b0c78babdd22214',
    );
  });

  it('hands Weft the schemas, so they are part of the revision', () => {
    const parsed = readyFile({ inputSchema: INPUT_SCHEMA, outputSchema: OUTPUT_SCHEMA });

    expect(parsed.document.inputSchema).toEqual(INPUT_SCHEMA);
    expect(parsed.document.outputSchema).toEqual(OUTPUT_SCHEMA);
    expect(parsed.inputSchema).toEqual(INPUT_SCHEMA);
    expect(parsed.outputSchema).toEqual(OUTPUT_SCHEMA);
  });

  it('is written with the schemas after paused and before the trigger, and reads back the same', () => {
    const definition: WorkflowFileDefinition = {
      description: 'Digest.',
      agent: 'writer',
      paused: false,
      inputSchema: { ...INPUT_SCHEMA },
      outputSchema: { ...OUTPUT_SCHEMA },
      trigger: { kind: 'signal', name: 'go' },
      steps: [{ kind: 'activity', handler: 'agent', input: { agent: 'writer', message: 'Hi' } }],
    };

    const text = serializeWorkflowFile('digest', definition);

    expect(Object.keys(JSON.parse(text) as object)).toEqual([
      'name',
      'description',
      'agent',
      'paused',
      'inputSchema',
      'outputSchema',
      'trigger',
      'steps',
    ]);
    const parsed = parseWorkflowFile('digest', text, host);
    expect(parsed.ok && parsed.file.inputSchema).toEqual(INPUT_SCHEMA);
  });

  it('writes a file without schemas exactly as before', () => {
    const text = serializeWorkflowFile('digest', {
      trigger: { kind: 'signal', name: 'go' },
      steps: [],
    });

    expect(Object.keys(JSON.parse(text) as object)).toEqual(['name', 'trigger', 'steps']);
  });

  it('is invalid when a schema is not a JSON object', () => {
    for (const bad of [null, 'string', ['array'], 7]) {
      const problem = problemOf({ inputSchema: bad });
      expect(problem.code).toBe('invalid-document');
      expect(problem.issues?.map((issue) => issue.path)).toEqual(['inputSchema']);
    }
  });

  it('is held to the limits of an answer schema, naming the field in each issue', () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ['an $id', { $id: 'urn:example', type: 'object' }],
      ['a pattern', { type: 'object', properties: { a: { type: 'string', pattern: '^a+$' } } }],
      ['patternProperties', { type: 'object', patternProperties: { '^a': { type: 'string' } } }],
      ['an invalid schema', { type: 'no-such-type' }],
      ['a schema 9 levels deep', nested(9)],
      ['a schema over 32 KiB', { type: 'object', description: 'x'.repeat(33 * 1024) }],
    ];
    for (const [label, schema] of cases) {
      for (const key of ['inputSchema', 'outputSchema'] as const) {
        const problem = problemOf({ [key]: schema });
        expect(problem.code, label).toBe('invalid-document');
        expect(problem.issues?.[0]?.path.startsWith(key), label).toBe(true);
      }
    }
  });

  it('accepts a schema at the depth limit', () => {
    expect(parseWorkflowFile('digest', file({ inputSchema: nested(8) }), host).ok).toBe(true);
  });
});

/** A schema of exactly `depth` levels of nesting. */
function nested(depth: number): Record<string, unknown> {
  let schema: Record<string, unknown> = { type: 'string' };
  for (let level = 1; level < depth; level += 1) {
    schema = { type: 'array', items: schema };
  }
  return schema;
}

describe('the input a schema describes', () => {
  it('is the input of a manual start, the payload of a signal, and null for a schedule fire', () => {
    expect(workflowInputOf({ kind: 'manual', input: { a: 1 } })).toEqual({ a: 1 });
    expect(workflowInputOf({ kind: 'manual' })).toBeNull();
    expect(workflowInputOf({ kind: 'signal', name: 'go', payload: 'p' })).toBe('p');
    expect(workflowInputOf({ kind: 'signal', name: 'go' })).toBeNull();
    expect(workflowInputOf({ kind: 'schedule', scheduleId: 's' })).toBeNull();
  });

  it('is a raw start’s input as it is', () => {
    expect(workflowInputOf({ city: 'Oslo' })).toEqual({ city: 'Oslo' });
    expect(workflowInputOf('text')).toBe('text');
    expect(workflowInputOf(undefined)).toBeNull();
    expect(workflowInputOf(null)).toBeNull();
  });
});

describe('judging an input', () => {
  it('returns every field issue with its path', () => {
    const issues = inputSchemaIssues(
      {
        type: 'object',
        properties: { city: { type: 'string' }, days: { type: 'integer' } },
        required: ['city', 'days'],
      },
      { days: 'three' },
    );

    expect(issues.map((issue) => issue.path)).toEqual([['city'], ['days']]);
    expect(issues[0]?.message).toBe('"city" is required');
  });

  it('is empty for an input that satisfies the schema, and judges a missing input as null', () => {
    expect(inputSchemaIssues(INPUT_SCHEMA, { city: 'Oslo' })).toEqual([]);
    expect(inputSchemaIssues({ type: 'null' }, undefined)).toEqual([]);
    expect(inputSchemaIssues(INPUT_SCHEMA, undefined)[0]?.message).toContain('The input');
  });

  it('is what the interpreter’s host asks, for the input and for the output', () => {
    expect(checkWorkflowSchema('input', INPUT_SCHEMA, { kind: 'manual', input: {} })).toEqual([
      { path: 'city', message: '"city" is required' },
    ]);
    expect(
      checkWorkflowSchema('output', { type: 'string' }, 7).map((issue) => issue.message),
    ).toEqual(['The output must be string']);
  });

  it('names the workflow in the error a refused start throws', () => {
    const error = new WorkflowInputInvalidError('digest', [{ path: ['city'], message: 'bad' }]);

    expect(error.code).toBe('input-invalid');
    expect(error.workflow).toBe('digest');
    expect(error.message).toContain('"digest"');
  });
});

describe('the finish reason of a failed run', () => {
  it('is read from the start of its error', () => {
    expect(finishReasonOf('input-invalid: city: "city" is required')).toBe('input-invalid');
    expect(finishReasonOf('output-invalid: The output must be string')).toBe('output-invalid');
    expect(finishReasonOf('the agent step failed')).toBeNull();
    expect(finishReasonOf('a step said output-invalid: later')).toBeNull();
    expect(finishReasonOf(undefined)).toBeNull();
  });
});
