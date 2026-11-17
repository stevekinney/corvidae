import { describe, expect, test } from 'bun:test';

import { documentProblemOf, issuePathOf, lineOfIssue } from './workflow-issue-line.ts';

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
  test('reads both forms of an issue path', () => {
    expect(issuePathOf('steps[1].duration')).toEqual(['steps', 1, 'duration']);
    expect(issuePathOf('$.trigger.kind')).toEqual(['trigger', 'kind']);
    expect(issuePathOf(['definition', 'steps', 0, 'input'])).toEqual(['steps', 0, 'input']);
  });

  test('names the line of the key the path ends on', () => {
    expect(lineOfIssue(TEXT, ['steps', 1, 'duration'])).toBe(9);
    expect(lineOfIssue(TEXT, ['steps', 0, 'input', 'message'])).toBe(6);
    expect(lineOfIssue(TEXT, ['trigger'])).toBe(3);
    expect(lineOfIssue(TEXT, ['steps', 1])).toBe(7);
  });

  test('a path that goes further than the text names the last part it holds', () => {
    expect(lineOfIssue(TEXT, ['steps', 1, 'signal'])).toBe(7);
  });

  test('an issue about the whole document, or a key it lacks, names no line, so the write says it', () => {
    expect(lineOfIssue(TEXT, ['outputSchema'])).toBeUndefined();
    expect(lineOfIssue(TEXT, issuePathOf(''))).toBeUndefined();
    expect(
      documentProblemOf(TEXT, [{ path: '', message: 'the description is too long' }]),
    ).toBeUndefined();
    expect(
      documentProblemOf(TEXT, [{ path: 'steps[1].duration', message: 'pick a duration' }]),
    ).toEqual({ line: 9, message: 'Pick a duration.' });
  });

  test('text with no object at its root names no line', () => {
    expect(lineOfIssue('[1, 2]', ['steps'])).toBeUndefined();
  });
});
