import { describe, expect, test } from 'bun:test';

import { lineOfOffset, locateJsonProblem } from './json-editor-problem.ts';

describe('locateJsonProblem', () => {
  test.each(['', '   \n ', '{}', '[1, 2, 3]', '{"a": {"b": [true, null, -1.5e3]}}', '"text"', '0'])(
    'reports nothing for %j',
    (source) => {
      expect(locateJsonProblem(source)).toBeUndefined();
    },
  );

  test('anchors a missing comma at the end of the line before the token the parser stops at (rows 57x, 65h)', () => {
    const source = '{\n  "branch": "main"\n  "since": "2026-10-23"\n}';
    const problem = locateJsonProblem(source);
    expect(problem?.kind).toBe('comma');
    // The parser stops at the opening quote of "since" on line 3; the mark sits on line 2.
    expect(lineOfOffset(source, problem?.parserPosition ?? 0)).toBe(3);
    expect(problem?.line).toBe(2);
    expect(source.charAt(problem?.position ?? -1)).toBe('"');
    expect(source.slice((problem?.position ?? 0) - 4, (problem?.position ?? 0) + 1)).toBe('main"');
    expect(problem?.summary).toBe('expected a comma');
    expect(problem?.detail).toBe('Missing comma at the end of this line.');
  });

  test('anchors a missing comma after a value that is followed by a blank line', () => {
    const source = '{\n  "a": 1\n\n\n  "b": 2\n}';
    expect(locateJsonProblem(source)?.line).toBe(2);
  });

  test('keeps a missing comma on its own line when the next token shares the line', () => {
    const problem = locateJsonProblem('{\n  "a": 1 "b": 2\n}');
    expect(problem?.line).toBe(2);
    expect(problem?.detail).toBe('Missing comma after this value.');
  });

  test('finds a missing comma between array elements', () => {
    const problem = locateJsonProblem('[\n  1\n  2\n]');
    expect(problem?.kind).toBe('comma');
    expect(problem?.line).toBe(2);
  });

  test('finds a missing colon', () => {
    const problem = locateJsonProblem('{\n  "a"\n  1\n}');
    expect(problem?.kind).toBe('colon');
    expect(problem?.line).toBe(2);
    expect(problem?.detail).toBe('Missing colon after this property name.');
  });

  test.each([
    ['{"a": 1,}', 'trailing-comma'],
    ['[1, 2,]', 'trailing-comma'],
    ['{a: 1}', 'name'],
    ["{'a': 1}", 'name'],
    ['{"a": }', 'value'],
    ['[1, , 2]', 'value'],
    ['{"a": 1', 'end'],
    ['[1, 2', 'end'],
    ['{"a": "open}', 'string'],
    ['{"a": 01}', 'number'],
    ['{"a": 1.}', 'number'],
    ['{"a": tru}', 'token'],
    ['{"a": "\\q"}', 'token'],
    ['{} {}', 'extra'],
  ] as const)('classifies %j as %s', (source, kind) => {
    expect(locateJsonProblem(source)?.kind).toBe(kind);
  });

  test('puts the mark on the line of the offending token for a stray character', () => {
    const problem = locateJsonProblem('{\n  "a": 1,\n  "b": }\n}');
    expect(problem?.kind).toBe('value');
    expect(problem?.line).toBe(3);
  });

  test('anchors a trailing comma on the comma itself', () => {
    const source = '{\n  "a": 1,\n}';
    const problem = locateJsonProblem(source);
    expect(problem?.line).toBe(2);
    expect(source.charAt(problem?.position ?? -1)).toBe(',');
  });

  test('anchors an unexpected end on the last token', () => {
    expect(locateJsonProblem('{\n  "a": [\n    1,\n    2')?.line).toBe(4);
  });

  test('names the unexpected character', () => {
    const problem = locateJsonProblem('{"a": @}');
    expect(problem?.summary).toBe('unexpected @');
    expect(problem?.detail).toBe('Unexpected @ here.');
  });

  test('never depends on the engine message: the line comes from the scanner', () => {
    // JavaScriptCore throws no position, so a scanner that read it would anchor at the end of the
    // source (line 4) instead of line 2.
    expect(locateJsonProblem('{\n  "a": 1\n  "b": 2\n}')?.line).toBe(2);
  });

  test('every problem it reports is a source JSON.parse rejects', () => {
    for (const source of ['{"a":', '[', '{"a" 1}', 'nul', '{"a": 1}}', '"abc', '-', '[1 2]']) {
      expect(() => JSON.parse(source)).toThrow();
      const problem = locateJsonProblem(source);
      expect(problem).toBeDefined();
      expect(problem?.line).toBeGreaterThanOrEqual(1);
    }
  });
});

describe('lineOfOffset', () => {
  test('counts lines from one and clamps past the end', () => {
    expect(lineOfOffset('a\nb\nc', 0)).toBe(1);
    expect(lineOfOffset('a\nb\nc', 2)).toBe(2);
    expect(lineOfOffset('a\nb\nc', 4)).toBe(3);
    expect(lineOfOffset('a\nb\nc', 99)).toBe(3);
  });
});
