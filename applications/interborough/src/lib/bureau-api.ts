/**
 * The one typed client for the Bureau's operations, generated from the operations its handler
 * serves (`./generated/`, written by `bun run generate:bureau-client`). Its calls go to the host's
 * composed `/jsonrpc` endpoint through `./bureau-transport.ts`, which asks the write guard first
 * and answers a fault as an `HttpClientError`; its subscriptions open under
 * `/bureau/v1/subscriptions`. A transform or default the server's schema lacks is a named function
 * in the file that needs it, applied to the typed result.
 */
import {
  type CatalogOperationName,
  type CatalogOperationTypes,
  createBureauClient,
  type SubscriptionOperationName,
} from './generated/bureau-operation-client.generated.ts';
import type { SubscriptionOperationTypes } from './generated/subscription-operations.generated.ts';

/** The client every Bureau call in the browser goes through: one method per operation name. */
export const bureauClient = createBureauClient({ baseUrl: '' });

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

/** What the Bureau operation `Name` answers. */
export type BureauOutput<Name extends CatalogOperationName> = CatalogOperationTypes[Name]['output'];
