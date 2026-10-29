/**
 * Compile-time half of `typesafe-moved.test.ts`: the TypeSafe types that moved to
 * `@lostgradient/operative-typesafe` are exported by none of Operative's entry points or by the
 * decisions barrel. Each alias below must fail to compile; a type that is exported again turns its
 * `@ts-expect-error` into an unused-directive error, so `tsc` fails.
 *
 * The aliases use `import()` types rather than `import type` declarations, because the formatter
 * removes an import whose binding nothing reads, and with it the assertion.
 */

// prettier-ignore
// @ts-expect-error `TypesafeJevOptions` moved to @lostgradient/operative-typesafe.
export type RootTypesafeJevOptions = import('@lostgradient/operative').TypesafeJevOptions;
// prettier-ignore
// @ts-expect-error `TypesafePeers` moved to @lostgradient/operative-typesafe.
export type RootTypesafePeers = import('@lostgradient/operative').TypesafePeers;
// prettier-ignore
// @ts-expect-error `TypesafePeerLoader` moved to @lostgradient/operative-typesafe.
export type RootTypesafePeerLoader = import('@lostgradient/operative').TypesafePeerLoader;
// prettier-ignore
// @ts-expect-error `TypesafeJevOptions` moved to @lostgradient/operative-typesafe.
export type ProviderKitTypesafeJevOptions = import('@lostgradient/operative/provider-kit').TypesafeJevOptions;
// prettier-ignore
// @ts-expect-error `TypesafePeers` moved to @lostgradient/operative-typesafe.
export type ProviderKitTypesafePeers = import('@lostgradient/operative/provider-kit').TypesafePeers;
// prettier-ignore
// @ts-expect-error `TypesafePeerLoader` moved to @lostgradient/operative-typesafe.
export type ProviderKitTypesafePeerLoader = import('@lostgradient/operative/provider-kit').TypesafePeerLoader;
// prettier-ignore
// @ts-expect-error `TypesafeJevOptions` moved to @lostgradient/operative-typesafe.
export type ProviderTestingTypesafeJevOptions = import('@lostgradient/operative/provider-testing').TypesafeJevOptions;
// prettier-ignore
// @ts-expect-error `TypesafePeers` moved to @lostgradient/operative-typesafe.
export type ProviderTestingTypesafePeers = import('@lostgradient/operative/provider-testing').TypesafePeers;
// prettier-ignore
// @ts-expect-error `TypesafePeerLoader` moved to @lostgradient/operative-typesafe.
export type ProviderTestingTypesafePeerLoader = import('@lostgradient/operative/provider-testing').TypesafePeerLoader;
// prettier-ignore
// @ts-expect-error `TypesafeJevOptions` moved to @lostgradient/operative-typesafe.
export type DecisionTestingTypesafeJevOptions = import('@lostgradient/operative/decision-testing').TypesafeJevOptions;
// prettier-ignore
// @ts-expect-error `TypesafePeers` moved to @lostgradient/operative-typesafe.
export type DecisionTestingTypesafePeers = import('@lostgradient/operative/decision-testing').TypesafePeers;
// prettier-ignore
// @ts-expect-error `TypesafePeerLoader` moved to @lostgradient/operative-typesafe.
export type DecisionTestingTypesafePeerLoader = import('@lostgradient/operative/decision-testing').TypesafePeerLoader;
// prettier-ignore
// @ts-expect-error `TypesafeJevOptions` moved to @lostgradient/operative-typesafe.
export type DecisionsBarrelTypesafeJevOptions = import('../src/decisions/index.ts').TypesafeJevOptions;
// prettier-ignore
// @ts-expect-error `TypesafePeers` moved to @lostgradient/operative-typesafe.
export type DecisionsBarrelTypesafePeers = import('../src/decisions/index.ts').TypesafePeers;
// prettier-ignore
// @ts-expect-error `TypesafePeerLoader` moved to @lostgradient/operative-typesafe.
export type DecisionsBarrelTypesafePeerLoader = import('../src/decisions/index.ts').TypesafePeerLoader;
