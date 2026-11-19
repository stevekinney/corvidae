/**
 * The one typed client for the Bureau's operations, generated from the operations its handler
 * serves (`./generated/`, written by `bun run generate:bureau-client`). Its calls go to the host's
 * composed `/jsonrpc` endpoint through `./bureau-transport.ts`, which asks the write guard first
 * and answers a fault as an `HttpClientError`; its subscriptions open under
 * `/bureau/v1/subscriptions`. A transform or default the server's schema lacks is a named function
 * in the file that needs it, applied to the typed result.
 */
import type { CatalogCallOptions } from '@lostgradient/backchannel/client';

import {
  type CatalogOperationName,
  type CatalogOperationTypes,
  createBureauClient,
  type SubscriptionOperationName,
} from './generated/bureau-operation-client.generated.ts';
import type { SubscriptionOperationTypes } from './generated/subscription-operations.generated.ts';

/**
 * What a call with `dryRun: true` answers instead of doing the work (COR-2522): the target and what
 * the call would change. An operation that supports a dry run lists it in its answer beside its
 * real one.
 */
type DryRunAnswer = { readonly dryRun: true };

/**
 * What a call answers, by what it was sent: `dryRun: true` the dry run's answer, no `dryRun` (or a
 * `false` one) the operation's own, and a `dryRun` the compiler cannot decide either of them. So
 * the ordinary call keeps the type it always had, though its operation can answer a preview too.
 * (The test is on the key, not on `{ dryRun?: false }`: an input with no `dryRun` has nothing in
 * common with that weak type, so it would not match it.)
 */
type CallAnswer<Output, Input> = Input extends { readonly dryRun: true }
  ? Extract<Output, DryRunAnswer>
  : 'dryRun' extends keyof Input
    ? Input extends { readonly dryRun: false }
      ? Exclude<Output, DryRunAnswer>
      : Output
    : Exclude<Output, DryRunAnswer>;

type GeneratedBureauClient = ReturnType<typeof createBureauClient>;

/** The Bureau client: the generated one, with each call's answer narrowed by its `dryRun`. */
type BureauClient = {
  readonly [Name in keyof GeneratedBureauClient]: Name extends CatalogOperationName
    ? <Input extends CatalogOperationTypes[Name]['input']>(
        input: Input,
        options?: CatalogCallOptions,
      ) => Promise<CallAnswer<CatalogOperationTypes[Name]['output'], Input>>
    : GeneratedBureauClient[Name];
};

/** The client every Bureau call in the browser goes through: one method per operation name. */
// The assertion narrows the answer by the input, which a deferred conditional type cannot be shown
// assignable to: the client is the generated one and the call is the same call.
export const bureauClient = createBureauClient({ baseUrl: '' }) as unknown as BureauClient;

/** What the Bureau operation `Name` takes. */
export type BureauInput<Name extends CatalogOperationName> = CatalogOperationTypes[Name]['input'];

type OptionalKeys<Value> = {
  [Key in keyof Value]-?: object extends Pick<Value, Key> ? Key : never;
}[keyof Value];

/**
 * A wire object whose optional members also read `undefined`, as a value the browser builds or
 * reads back does when a field was left out on purpose. The server's schema leaves a member
 * absent; the browser's own records spell absence either way.
 */
export type WithUndefined<Value> = Value extends unknown
  ? {
      [Key in keyof Value as Key extends OptionalKeys<Value> ? never : Key]: Value[Key];
    } & { [Key in OptionalKeys<Value>]?: Value[Key] | undefined }
  : never;

/** What the Bureau feed `Name` sends, one event at a time. */
export type BureauEvent<Name extends SubscriptionOperationName> =
  SubscriptionOperationTypes[Name]['event'];

/** What the Bureau operation `Name` answers, not counting the answer of its dry run. */
export type BureauOutput<Name extends CatalogOperationName> = Exclude<
  CatalogOperationTypes[Name]['output'],
  DryRunAnswer
>;

/** What the Bureau operation `Name` answers to a call with `dryRun: true`. */
export type BureauDryRunOutput<Name extends CatalogOperationName> = Extract<
  CatalogOperationTypes[Name]['output'],
  DryRunAnswer
>;
