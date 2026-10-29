/**
 * The TypeSafe decision model for Operative — `@lostgradient/operative-typesafe`.
 *
 * {@link typesafeJev} builds a `DecisionModel` backed by TypeSafe's Jev that serves `boolean`,
 * `choice`, and `scale` requests and reports the probability of its answer.
 *
 * @module operative-typesafe
 */

export { typesafeJev } from './decisions/typesafe-jev';
export type { TypesafeJevOptions } from './decisions/typesafe-jev';
