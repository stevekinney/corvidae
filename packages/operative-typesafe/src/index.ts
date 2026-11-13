/**
 * The TypeSafe provider for Operative — `@lostgradient/operative-typesafe`.
 *
 * {@link typesafeProvider} is a decision-only provider definition whose `decide` builds TypeSafe's
 * Jev, which serves `boolean`, `choice`, and `scale` requests and reports the probability of its
 * answer. {@link typesafeRows} is its one catalog row, `typesafe/jev`.
 *
 * @module operative-typesafe
 */

export { TYPESAFE_JEV_MODEL, typesafeProvider, typesafeRows } from './provider';
export type { TypesafeProviderConfiguration } from './provider';
