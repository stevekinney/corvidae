/**
 * Operative's decision-model contract suite — `@lostgradient/operative/decision-testing`.
 *
 * Every {@link DecisionModel} has to honor the same shared behavior: each kind it declares is
 * answered with a value of that kind's type, the provider and model are named, a reported
 * probability is a probability, and reported usage is made of non-negative integers.
 * {@link runDecisionModelContract} registers one `bun:test` suite that checks all of it against a
 * single model, so a package that ships a decision model runs the suite against itself instead of
 * copying the cases. {@link decisionContractFailure} asks the same of one case and returns the
 * failure as a message, for a caller that reports problems rather than registering tests, such as
 * a plugin's conformance suite. {@link runDecisionBatchContract} does the same for several questions about one
 * context, answered through `decideBatch`. {@link decisionScenarios} and
 * {@link decisionBatchScenarios} are the requests and batches, with their expected answers, that a
 * recorded-fixture suite replays.
 *
 * Suite registration is deliberately outside the package root, so a runtime consumer never loads
 * `bun:test`.
 *
 * @module operative/decision-testing
 */

export {
  decisionContractFailure,
  runDecisionBatchContract,
  runDecisionModelContract,
  type DecisionBatchContractCase,
  type DecisionContractCase,
} from './testing/decision-model-contract.test-support.ts';
export {
  decisionBatchScenarios,
  decisionScenarios,
  type DecisionBatchScenario,
  type DecisionBatchScenarioQuestion,
  type DecisionScenario,
} from './testing/decision-scenarios.ts';
