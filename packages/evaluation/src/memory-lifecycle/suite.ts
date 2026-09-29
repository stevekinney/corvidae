/**
 * The committed, versioned memory-lifecycle suite (`suite.json`) and how it
 * becomes an evaluation dataset. Every scenario becomes one held-out case
 * whose input is its task prompt and whose expected answer is the value the
 * action needs (or `unknown`), so the generator projection redacts it like
 * any other expected answer.
 */
import { sha256Hex } from '@lostgradient/cryptography';

import { EvaluatorConfigurationError, toConfigurationIssues } from '../configuration';
import type { EvaluationDataset } from '../datasets';
import { canonicalJson } from '../identity';
import { renderTaskPrompt } from './prompt';
import {
  type MemoryScenario,
  type MemoryScenarioSuite,
  memoryScenarioSuiteSchema,
} from './scenarios';
import committedSuite from './suite.json';

/**
 * Parses a scenario suite, throwing {@link EvaluatorConfigurationError} on any
 * issue. Two scenarios may share a task, but never a task prompt: a trial's
 * subject finds its scenario by the prompt it is run with.
 */
export function parseMemoryScenarioSuite(input: unknown): MemoryScenarioSuite {
  const parsed = memoryScenarioSuiteSchema.safeParse(input);
  if (!parsed.success) throw new EvaluatorConfigurationError(toConfigurationIssues(parsed.error));
  const prompts = new Map<string, string>();
  for (const [index, scenario] of parsed.data.scenarios.entries()) {
    const prompt = renderTaskPrompt(scenario.task);
    const earlier = prompts.get(prompt);
    if (earlier !== undefined) {
      throw new EvaluatorConfigurationError([
        {
          path: ['scenarios', index, 'task'],
          message: `Scenario "${scenario.id}" has the same task prompt as "${earlier}"`,
        },
      ]);
    }
    prompts.set(prompt, scenario.id);
  }
  return parsed.data;
}

/** The committed suite, freshly parsed. */
export function memoryLifecycleSuite(): MemoryScenarioSuite {
  return parseMemoryScenarioSuite(structuredClone(committedSuite));
}

/** The SHA-256 of a suite's canonical JSON: any edit to any scenario moves it. */
export function suiteDigest(suite: MemoryScenarioSuite): Promise<string> {
  return sha256Hex(canonicalJson(suite));
}

/** The SHA-256 of one scenario's canonical JSON. */
export function scenarioDigest(scenario: MemoryScenario): Promise<string> {
  return sha256Hex(canonicalJson(scenario));
}

/** What a scenario's case expects: the value its action needs, or `unknown`. */
export function expectedAnswer(scenario: MemoryScenario): string {
  const { outcome } = scenario.expected;
  return outcome.kind === 'act' ? outcome.value : 'unknown';
}

/** The suite as an evaluation dataset: one held-out case per scenario, in suite order. */
export function toMemoryLifecycleDataset(suite: MemoryScenarioSuite): EvaluationDataset {
  return {
    id: suite.id,
    version: suite.version,
    owner: suite.owner,
    cases: suite.scenarios.map((scenario) => ({
      id: scenario.id,
      input: renderTaskPrompt(scenario.task),
      expected: expectedAnswer(scenario),
      visibility: 'held-out',
    })),
  };
}
