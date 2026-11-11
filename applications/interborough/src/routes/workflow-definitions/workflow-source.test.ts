/** Where a workflow file's JSON stops being JSON, and where its parts start, found by reading the text. */
import { describe, expect, test } from 'bun:test';

import { locateJsonProblem, sourceLineId, sourceOutline } from './workflow-source.ts';

const lines = (...rows: string[]): string => rows.join('\n');

describe('locating a JSON problem', () => {
  test('finds nothing in a file that parses', () => {
    expect(
      locateJsonProblem(JSON.stringify({ name: 'a', steps: [1, 2, { b: null }] }, null, 2)),
    ).toBe(null);
  });

  test('marks the line before a missing comma and says where the parser stopped', () => {
    const text = lines('{', '  "name": "order-refund"', '  "steps": []', '}');
    expect(locateJsonProblem(text)).toEqual({ line: 2, stoppedAt: 3, kind: 'comma' });
  });

  test('marks the same line when the missing comma and the next key share it', () => {
    expect(locateJsonProblem('{ "a": 1 "b": 2 }')).toEqual({
      line: 1,
      stoppedAt: 1,
      kind: 'comma',
    });
  });

  test('says a problem that is not a missing comma is something else', () => {
    expect(locateJsonProblem(lines('{', '  "a": 1,', '  "b": ', '}'))?.kind).toBe('other');
    expect(locateJsonProblem(lines('[', '  1,', ']'))?.kind).toBe('other');
    expect(locateJsonProblem(lines('{', '  "a": 1', ']'))?.kind).toBe('other');
  });

  test('marks the last line of a file that ends too early', () => {
    expect(locateJsonProblem(lines('{', '  "a": [1, 2'))).toEqual({
      line: 2,
      stoppedAt: 2,
      kind: 'other',
    });
  });

  test('reads strings, numbers and literals as JSON does', () => {
    expect(
      locateJsonProblem('{"a": "he said \\"hi\\"", "b": -1.5e3, "c": [true, false, null]}'),
    ).toBe(null);
    expect(locateJsonProblem('{"a": 01}')).not.toBeNull();
    expect(locateJsonProblem('{"a": tru}')).not.toBeNull();
    expect(locateJsonProblem('{"a": "unterminated}')).not.toBeNull();
    expect(locateJsonProblem('{"a": 1} extra')?.kind).toBe('other');
  });
});

describe('the outline of a file', () => {
  const text = JSON.stringify(
    {
      name: 'release-notes',
      title: 'Release notes',
      trigger: { kind: 'schedule', spec: '0 11 * * 5' },
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
      steps: [
        { kind: 'activity', handler: 'agent', input: { agent: 'a', message: 'm' } },
        { kind: 'await-signal', signal: 'notes-approved' },
      ],
    },
    null,
    2,
  );

  test('names the parts the file has, with the line each starts on, and the steps under steps', () => {
    const outline = sourceOutline(text, ['Find the last release']);
    expect(outline.map((entry) => entry.label)).toEqual([
      'name',
      'title',
      'trigger',
      'input',
      'output',
      'steps',
    ]);
    expect(outline[0]?.line).toBe(2);
    const steps = outline.at(-1);
    expect(steps?.children.map((child) => child.label)).toEqual([
      '1 Find the last release',
      '2 Step 2',
    ]);
    // Each entry points at a line that is the key or the step's opening brace.
    const rows = text.split('\n');
    for (const entry of outline) expect(rows[entry.line - 1]).toContain(`"`);
    for (const child of steps?.children ?? []) expect(rows[child.line - 1]?.trim()).toBe('{');
  });

  test('has no entry for a part the file lacks, and no outline for a file written on one line', () => {
    const bare = JSON.stringify({ name: 'a', steps: [] }, null, 2);
    expect(sourceOutline(bare, []).map((entry) => entry.label)).toEqual(['name', 'steps']);
    expect(sourceOutline('{"name":"a","steps":[]}', [])).toEqual([]);
  });

  test('gives each line an id the outline can link to', () => {
    expect(sourceLineId(11)).toBe('workflow-source-line-11');
  });
});
