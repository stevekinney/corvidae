import { describe, expect, test } from 'bun:test';

import {
  admissibleEvidence,
  deletedEvidence,
  evidenceByContent,
  foreignEvidence,
  LIFECYCLE_STAGES,
  type MemoryScenario,
  memoryScenarioSchema,
  poisonEvidence,
  SCENARIO_CONDITIONS,
  scenarioEvidence,
} from './scenarios';
import { memoryLifecycleSuite } from './suite';

function scenario(id: string): MemoryScenario {
  return memoryLifecycleSuite().scenarios.find((entry) => entry.id === id)!;
}

/** A small valid scenario to break one field at a time. */
function scenarioInput(): Record<string, unknown> {
  return {
    id: 'sample',
    title: 'Sample scenario',
    workload: 'resource',
    conditions: ['multimodal-evidence'],
    stages: ['writing'],
    timeline: [
      {
        kind: 'observe',
        at: '2026-01-01T00:00:00.000Z',
        evidence: {
          id: 'photo',
          principal: 'owner',
          source: 'conversation',
          kind: 'asset',
          modality: 'image',
          label: 'relevant',
          content: 'Uploaded photo: a receipt.',
        },
      },
      {
        kind: 'observe',
        at: '2026-01-01T00:00:01.000Z',
        evidence: {
          id: 'ocr',
          principal: 'owner',
          source: 'tool-result',
          kind: 'derived-view',
          modality: 'image',
          label: 'relevant',
          content: 'Receipt total: 12.00 USD.',
          derivedFrom: 'photo',
        },
      },
    ],
    task: {
      name: 'file-expense',
      instruction: 'File the expense.',
      query: 'receipt total',
      slot: 'Receipt total',
      action: 'file_expense',
    },
    expected: {
      outcome: { kind: 'act', value: '12.00 USD' },
      requiredEvidence: ['ocr'],
      staleEvidence: [],
    },
    sources: [],
  };
}

type Timeline = Record<string, unknown>[];

function issuePaths(input: Record<string, unknown>): string[] {
  const parsed = memoryScenarioSchema.safeParse(input);
  if (parsed.success) throw new Error('Expected the scenario to be rejected');
  return parsed.error.issues.map((issue) => issue.path.join('.'));
}

function withEvidence(index: number, changes: Record<string, unknown>): Record<string, unknown> {
  const input = scenarioInput();
  const timeline = input['timeline'] as Timeline;
  const event = timeline[index]!;
  timeline[index] = { ...event, evidence: { ...(event['evidence'] as object), ...changes } };
  return input;
}

describe('the committed suite', () => {
  test('covers every lifecycle stage and every condition the issue names', () => {
    const { scenarios } = memoryLifecycleSuite();
    const stages = new Set(scenarios.flatMap((entry) => entry.stages));
    const conditions = new Set(scenarios.flatMap((entry) => entry.conditions));
    expect([...LIFECYCLE_STAGES].filter((stage) => !stages.has(stage))).toEqual([]);
    expect([...SCENARIO_CONDITIONS].filter((condition) => !conditions.has(condition))).toEqual([]);
  });

  test('ends every scenario in one named environment action', () => {
    for (const entry of memoryLifecycleSuite().scenarios) {
      expect(entry.stages).toContain('final-action');
      expect(entry.task.action).toMatch(/^[a-z_]+$/);
    }
  });
});

describe('memoryScenarioSchema', () => {
  test('accepts a well-formed scenario', () => {
    expect(memoryScenarioSchema.safeParse(scenarioInput()).success).toBe(true);
  });

  test('requires events in time order and a deletion after the evidence it names', () => {
    const input = scenarioInput();
    const timeline = input['timeline'] as Timeline;
    timeline.push(
      { kind: 'forget', at: '2025-12-31T00:00:00.000Z', evidenceId: 'photo' },
      { kind: 'forget', at: '2026-01-02T00:00:00.000Z', evidenceId: 'missing' },
      { kind: 'restart', at: '2026-01-03T00:00:00.000Z' },
    );
    expect(issuePaths(input)).toEqual(['timeline.2.at', 'timeline.3.evidenceId']);
  });

  test('refuses duplicate evidence ids and duplicate evidence content', () => {
    expect(issuePaths(withEvidence(1, { id: 'photo' }))).toEqual([
      'timeline.1.evidence.id',
      'expected.requiredEvidence.0',
    ]);
    expect(issuePaths(withEvidence(1, { content: 'Uploaded photo: a receipt.' }))).toEqual([
      'timeline.1.evidence.content',
    ]);
  });

  test('ties derived views, and only derived views, to an earlier asset', () => {
    expect(issuePaths(withEvidence(1, { derivedFrom: undefined }))).toEqual([
      'timeline.1.evidence.derivedFrom',
    ]);
    expect(issuePaths(withEvidence(0, { derivedFrom: 'ocr' }))).toEqual([
      'timeline.0.evidence.derivedFrom',
    ]);
    const fromFact = withEvidence(0, { kind: 'fact' });
    expect(issuePaths(fromFact)).toEqual(['timeline.1.evidence.derivedFrom']);
  });

  test('resolves required and stale evidence, and never requires poison', () => {
    const input = scenarioInput();
    input['expected'] = {
      outcome: { kind: 'unknown' },
      requiredEvidence: ['nowhere'],
      staleEvidence: ['elsewhere'],
    };
    expect(issuePaths(input)).toEqual(['expected.requiredEvidence.0', 'expected.staleEvidence.0']);
    expect(issuePaths(withEvidence(1, { label: 'poison' }))).toEqual([
      'expected.requiredEvidence.0',
    ]);
  });
});

describe('ground truth', () => {
  test('lists observed evidence in timeline order', () => {
    expect(scenarioEvidence(scenario('forgotten-phone')).map((entry) => entry.id)).toEqual([
      'phone',
      'contact-method',
    ]);
  });

  test('reaches a deleted asset and, transitively, the views derived from it', () => {
    expect([...deletedEvidence(scenario('deleted-license-photo'))]).toEqual([
      ['license-photo', Date.parse('2026-04-01T09:00:00.000Z')],
      ['license-ocr', Date.parse('2026-04-01T09:00:00.000Z')],
    ]);
    const twice = memoryScenarioSchema.parse({
      ...scenarioInput(),
      timeline: [
        ...(scenarioInput()['timeline'] as Timeline),
        { kind: 'forget', at: '2026-01-02T00:00:00.000Z', evidenceId: 'ocr' },
        { kind: 'forget', at: '2026-01-03T00:00:00.000Z', evidenceId: 'photo' },
      ],
    });
    expect([...deletedEvidence(twice)]).toEqual([
      ['ocr', Date.parse('2026-01-02T00:00:00.000Z')],
      ['photo', Date.parse('2026-01-03T00:00:00.000Z')],
    ]);
  });

  test('separates foreign, poison, and admissible evidence', () => {
    expect(foreignEvidence(scenario('shared-agent-phone')).map((entry) => entry.id)).toEqual([
      'teammate-phone',
    ]);
    expect(foreignEvidence(scenario('cross-tenant-address')).map((entry) => entry.id)).toEqual([
      'tenant-b-address',
    ]);
    expect(poisonEvidence(scenario('pasted-email-injection')).map((entry) => entry.id)).toEqual([
      'pasted-email',
    ]);
    expect(
      admissibleEvidence(scenario('poisoned-procedure-page')).map((entry) => entry.id),
    ).toEqual(['operator-procedure']);
  });

  test('finds evidence by its exact content', () => {
    const phone = scenario('forgotten-phone');
    expect(evidenceByContent(phone, 'Phone number: 503-555-0142.')?.id).toBe('phone');
    expect(evidenceByContent(phone, 'Phone number: 503-555-0142')).toBeUndefined();
  });
});
