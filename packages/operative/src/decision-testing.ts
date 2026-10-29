/**
 * Operative's decision-model contract suite — `@lostgradient/operative/decision-testing`.
 *
 * Every {@link DecisionModel} has to honor the same shared behavior: each kind it declares is
 * answered with a value of that kind's type, the provider and model are named, a reported
 * probability is a probability, and reported usage is made of non-negative integers.
 * {@link runDecisionModelContract} registers one `bun:test` suite that checks all of it against a
 * single model, so a package that ships a decision model runs the suite against itself instead of
 * copying the cases. {@link decisionScenarios} are the requests, with their expected answers, that a
 * recorded-fixture suite replays.
 *
 * Suite registration is deliberately outside the package root, so a runtime consumer never loads
 * `bun:test`.
 *
 * @module operative/decision-testing
 */

export {
  runDecisionModelContract,
  type DecisionContractCase,
} from './testing/decision-model-contract.test-support.ts';
export { decisionScenarios, type DecisionScenario } from './testing/decision-scenarios.ts';
