import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';

import casesData from '../src/fixtures/chat-stress.json';
import {
  STRESS_CASE_COUNT,
  STRESS_SCENARIO_NAMES,
  findStressCase,
  parseStressCases,
  stressCaseProblems,
  type StressCase,
} from '../src/fixtures/chat-stress/stress-cases.ts';

const cases = parseStressCases(casesData);

function sample(overrides: Partial<StressCase> = {}): StressCase {
  return {
    id: 1,
    slug: 'sample',
    title: 'A sample.',
    provenance: 'derived',
    source: 'A test.',
    rows: ['C1'],
    scenario: 'idle',
    params: {},
    steps: [],
    variants: [],
    focusSweep: false,
    ...overrides,
  };
}

describe('the committed Chat stress cases', () => {
  it('holds exactly the 80 cases the board requires, numbered 1 to 80', () => {
    expect(cases).toHaveLength(STRESS_CASE_COUNT);
    expect(cases.map((stressCase) => stressCase.id)).toEqual(
      Array.from({ length: STRESS_CASE_COUNT }, (_, index) => index + 1),
    );
  });

  it('names a scenario the fixture can build for every case', () => {
    for (const stressCase of cases) {
      expect(STRESS_SCENARIO_NAMES).toContain(stressCase.scenario);
    }
  });

  it('gives every case a source and at least one design row', () => {
    for (const stressCase of cases) {
      expect(stressCase.source.length).toBeGreaterThan(0);
      expect(stressCase.rows.length).toBeGreaterThan(0);
    }
  });

  it('marks the cases the board issues name, with the sentence that names them', () => {
    const named = [
      9, 10, 11, 14, 15, 17, 19, 21, 23, 24, 25, 31, 32, 33, 34, 44, 45, 50, 51, 52, 59, 63, 68, 69,
      71, 72, 73, 79,
    ];
    for (const id of named) {
      expect(findStressCase(cases, id)?.provenance).toBe('issue-named');
    }
  });

  it('carries the fixed variants the board requires, and only those', () => {
    const variants = cases.flatMap((stressCase) =>
      stressCase.variants.map((variant) => `${stressCase.id}-${variant.name}`),
    );
    expect(variants.toSorted()).toEqual(
      [
        '33-expanded',
        '59-collapsed',
        '68-option2',
        '68-something-else',
        '69-question-2-of-3',
        '71-live',
        '71-folded',
        '72-scrolled',
      ].toSorted(),
    );
  });

  it('asks for a focus sweep on case 73 alone', () => {
    expect(
      cases.filter((stressCase) => stressCase.focusSweep).map((stressCase) => stressCase.id),
    ).toEqual([73]);
  });

  it('pairs the composer edge of cases 9 and 10, and of 14 and 15, in both directions', () => {
    expect(findStressCase(cases, 9)?.composerEdgeWith).toBe(10);
    expect(findStressCase(cases, 10)?.composerEdgeWith).toBe(9);
    expect(findStressCase(cases, 14)?.composerEdgeWith).toBe(15);
    expect(findStressCase(cases, 15)?.composerEdgeWith).toBe(14);
  });

  it('reaches the queue, the question and the offline states through steps, never through seeded end states', () => {
    const offline = findStressCase(cases, 79);
    expect(offline?.steps.map((step) => step.action)).toEqual([
      'fill',
      'press',
      'fill',
      'press',
      'hook',
      'expect-text',
      'expect-text',
    ]);
    const progression = findStressCase(cases, 69);
    expect(progression?.variants[0]?.steps.map((step) => step.action)).toEqual([
      'click',
      'click',
      'expect-text',
    ]);
  });

  it('defers the one row this fixture cannot draw, with a reason', () => {
    const deferred = cases.filter((stressCase) => stressCase.deferred !== undefined);
    expect(deferred.map((stressCase) => stressCase.id)).toEqual([55]);
    expect(deferred[0]?.deferred).toContain('A5');
  });

  it('keeps the middle dot out of every title and source', () => {
    for (const stressCase of cases) {
      expect(`${stressCase.title} ${stressCase.source}`).not.toContain('·');
    }
  });
});

describe('stressCaseProblems', () => {
  it('accepts the committed data', () => {
    expect(stressCaseProblems(casesData)).toEqual([]);
  });

  it('rejects data that is not an array', () => {
    expect(stressCaseProblems({})).toEqual(['the cases must be an array']);
  });

  it('names a missing and a repeated number', () => {
    const repeated = [...casesData.slice(0, 79), sample({ id: 1 })];
    const problems = stressCaseProblems(repeated);
    expect(problems).toContain('case 1 appears twice');
    expect(problems).toContain('case 80 is missing');
  });

  it('rejects a step that names an unknown action', () => {
    const broken = { ...sample(), steps: [{ action: 'wait', milliseconds: 500 }] };
    expect(stressCaseProblems([broken])[0]).toContain('unknown step action "wait"');
  });

  it('rejects a click that names no control', () => {
    const broken = { ...sample(), steps: [{ action: 'click', role: 'button' }] };
    expect(stressCaseProblems([broken]).join('\n')).toContain('click needs a name');
  });

  it('rejects a composer-edge partner that is not a case', () => {
    const problems = stressCaseProblems([sample({ composerEdgeWith: 99 })]);
    expect(problems.join('\n')).toContain('composer-edge partner 99');
  });

  it('rejects a case that repeats a variant name', () => {
    const repeated = sample({
      variants: [
        { name: 'expanded', steps: [] },
        { name: 'expanded', steps: [] },
      ],
    });
    expect(stressCaseProblems([repeated]).join('\n')).toContain('repeats a variant name');
  });

  it('refuses to parse invalid data, naming every problem', () => {
    expect(() => parseStressCases([sample()])).toThrow('Chat stress cases are invalid');
  });
});

describe('the design-review rows', () => {
  const rows = readFileSync(
    new URL('../src/fixtures/chat-stress.rows.txt', import.meta.url),
    'utf8',
  )
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => line.split('|').map((field) => field.trim()));

  it('are written as the design-review skill reads them: row id, board and text', () => {
    for (const fields of rows) {
      expect(fields).toHaveLength(3);
      expect(fields.every((field) => field !== '')).toBe(true);
    }
    const ids = rows.map((fields) => fields[0]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('are the 44 rows the board issues carry text for', () => {
    expect(rows).toHaveLength(44);
  });

  it('are each shown by at least one case, and every row a case names exists', () => {
    const ids = new Set(rows.map((fields) => fields[0]));
    const shown = new Set(cases.flatMap((stressCase) => stressCase.rows));
    for (const id of ids) expect(shown.has(id as string)).toBe(true);
    for (const id of shown) expect(ids.has(id)).toBe(true);
  });
});
