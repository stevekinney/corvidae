/**
 * Where each of the lifecycle architecture's structured components is meant
 * to help (COR-755): the scenario conditions it targets and the criteria it
 * must win on there. The suite run ablates each component over exactly these
 * scenarios, and the report decides its promotion over them.
 */
import type { StructuredComponent } from './baselines/adapter';
import { ACTION_CRITERION } from './memory-evaluator';
import type { MemoryScenario, ScenarioCondition } from './scenarios';

/** Each structured component's target conditions and the criteria it must win on. */
export const COMPONENT_TARGETS: Readonly<
  Record<
    StructuredComponent,
    { readonly conditions: readonly ScenarioCondition[]; readonly measures: readonly string[] }
  >
> = {
  'state-projector': {
    conditions: ['temporal-change', 'contradiction'],
    measures: [ACTION_CRITERION, 'state-maintenance'],
  },
  'procedure-memory': { conditions: ['procedural-reuse'], measures: [ACTION_CRITERION] },
  'resource-derivation': {
    conditions: ['multimodal-evidence'],
    measures: [ACTION_CRITERION, 'deletion'],
  },
};

/** The ids of the scenarios that put `component` under one of its target conditions. */
export function componentScenarioIds(
  component: StructuredComponent,
  scenarios: readonly MemoryScenario[],
): Set<string> {
  const { conditions } = COMPONENT_TARGETS[component];
  return new Set(
    scenarios
      .filter((scenario) => scenario.conditions.some((condition) => conditions.includes(condition)))
      .map((scenario) => scenario.id),
  );
}
