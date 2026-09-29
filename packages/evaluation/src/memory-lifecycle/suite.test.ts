import { describe, expect, test } from 'bun:test';

import { EvaluatorConfigurationError } from '../configuration';
import { parseEvaluationDataset } from '../datasets';
import { readTaskPrompt, renderTaskPrompt } from './prompt';
import {
  expectedAnswer,
  memoryLifecycleSuite,
  parseMemoryScenarioSuite,
  scenarioDigest,
  suiteDigest,
  toMemoryLifecycleDataset,
} from './suite';
import committedSuite from './suite.json';

function configurationError(work: () => unknown): EvaluatorConfigurationError {
  try {
    work();
  } catch (error) {
    expect(error).toBeInstanceOf(EvaluatorConfigurationError);
    return error as EvaluatorConfigurationError;
  }
  throw new Error('Expected a configuration error');
}

describe('parseMemoryScenarioSuite', () => {
  test('parses the committed, versioned suite', () => {
    const suite = memoryLifecycleSuite();
    expect(suite.id).toBe('memory-lifecycle');
    expect(suite.version).toBe('memory-lifecycle-2026-09');
    expect(suite.scenarios).toHaveLength(14);
  });

  test('refuses duplicate scenario ids with the path of the second', () => {
    const input = structuredClone(committedSuite);
    input.scenarios.push(structuredClone(input.scenarios[0]!));
    const error = configurationError(() => parseMemoryScenarioSuite(input));
    expect(error.issues.map((issue) => issue.path.join('.'))).toEqual(['scenarios.14.id']);
  });

  test('refuses two scenarios with the same task prompt', () => {
    const input = structuredClone(committedSuite);
    const copy = structuredClone(input.scenarios[0]!);
    copy.id = 'ship-after-moves-copy';
    input.scenarios.push(copy);
    const error = configurationError(() => parseMemoryScenarioSuite(input));
    expect(error.issues).toEqual([
      {
        path: ['scenarios', 14, 'task'],
        message: 'Scenario "ship-after-moves-copy" has the same task prompt as "ship-after-moves"',
      },
    ]);
  });
});

describe('digests', () => {
  test('move with any edit to a scenario and never with key order', async () => {
    const suite = memoryLifecycleSuite();
    const digest = await suiteDigest(suite);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(await suiteDigest(memoryLifecycleSuite())).toBe(digest);
    const edited = memoryLifecycleSuite();
    edited.scenarios[0]!.title = 'Edited';
    expect(await suiteDigest(edited)).not.toBe(digest);
    expect(await scenarioDigest(edited.scenarios[0]!)).not.toBe(
      await scenarioDigest(suite.scenarios[0]!),
    );
  });
});

describe('toMemoryLifecycleDataset', () => {
  test('turns every scenario into one held-out case whose input is its task prompt', () => {
    const suite = memoryLifecycleSuite();
    const dataset = parseEvaluationDataset(toMemoryLifecycleDataset(suite));
    expect(dataset.cases).toHaveLength(suite.scenarios.length);
    expect(dataset.cases.every((entry) => entry.visibility === 'held-out')).toBe(true);
    const [first] = dataset.cases;
    expect(first).toEqual({
      id: 'ship-after-moves',
      input: renderTaskPrompt(suite.scenarios[0]!.task),
      expected: '17 Cedar Lane, Olympia',
      visibility: 'held-out',
    });
    expect(expectedAnswer(suite.scenarios[2]!)).toBe('unknown');
  });
});

describe('task prompts', () => {
  test('carry the action, slot, and lookup, and nothing that answers the task', () => {
    const [scenario] = memoryLifecycleSuite().scenarios;
    const prompt = renderTaskPrompt(scenario!.task);
    expect(readTaskPrompt(prompt)).toEqual({
      action: 'ship_order',
      slot: 'Shipping address',
      query: 'shipping address',
    });
    expect(prompt).not.toContain(expectedAnswer(scenario!));
  });

  test('reads nothing from a prompt that is not a task prompt', () => {
    expect(readTaskPrompt('What is the capital of France?')).toBeUndefined();
  });
});
