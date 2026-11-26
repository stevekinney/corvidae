import { HttpClientError } from '@lostgradient/weft/testing';
import { describe, expect, test } from 'bun:test';

import { documentProblemFor } from './workflow-issue-line.ts';

const TEXT = `{
  "name": "morning-briefing",
  "trigger": { "kind": "manual" },
  "steps": [
    { "kind": "activity", "handler": "agent",
      "input": { "agent": "assistant", "message": "Summarize." } },
    {
      "kind": "sleep",
      "duration": 15
    }
  ]
}
`;

describe('COR-2432: the line a Bureau issue names (row 65z)', () => {
  test.each([
    ['steps[1].duration', 9],
    ['steps[0].input.message', 6],
    ['$.trigger.kind', 3],
    ['steps[1]', 7],
    ['steps[1].signal', 7],
    ['outputSchema', 1],
  ])('marks the deepest field that exists for %s', async (path, line) => {
    const problem = await documentProblemFor(TEXT, async () => ({
      status: 'invalid',
      code: 'invalid-document',
      issues: [{ path, message: 'invalid value' }],
    }));
    expect(problem).toEqual({ line, message: 'Invalid value.' });
  });

  test('reads an array path from an InvalidParams response', async () => {
    const problem = await documentProblemFor(TEXT, async () => {
      throw new HttpClientError(400, 'invalid params', {
        data: {
          weftCode: 'InvalidParams',
          issues: [{ path: ['definition', 'steps', 0, 'input'], message: 'invalid input' }],
        },
      });
    });
    expect(problem).toEqual({ line: 6, message: 'Invalid input.' });
  });

  test('matches a path to a JSON key written with escapes', async () => {
    const escaped = `{
  "st\\u0065ps": [
    { "kind": "sleep", "dur\\u0061tion": 15 }
  ]
}`;
    const problem = await documentProblemFor(escaped, async () => ({
      status: 'invalid',
      code: 'invalid-document',
      issues: [{ path: 'steps[0].duration', message: 'invalid duration' }],
    }));
    expect(problem).toEqual({ line: 3, message: 'Invalid duration.' });
  });

  test('text with no object at its root names no line', async () => {
    const problem = await documentProblemFor('[1, 2]', async () => ({
      status: 'invalid',
      code: 'invalid-document',
      issues: [{ path: 'steps', message: 'invalid steps' }],
    }));
    expect(problem).toBeUndefined();
  });
});
