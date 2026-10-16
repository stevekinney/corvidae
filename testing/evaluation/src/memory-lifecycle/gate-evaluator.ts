import type { GateEvaluatorDefinition } from '../release-gate';
import { memoryLifecycleEvaluator } from './memory-evaluator';

/**
 * The evaluator module behind `gates/memory-lifecycle.json`: the proposed
 * lifecycle architecture, scored in the deterministic lane. It builds a fresh
 * definition for every gate run.
 */
export default (): GateEvaluatorDefinition =>
  memoryLifecycleEvaluator({ baseline: 'lifecycle', lane: 'deterministic' });
