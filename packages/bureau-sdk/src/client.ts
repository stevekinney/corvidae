import {
  createSubscriptionClient,
  sseSubscriptionTransport,
  type CatalogTransport,
  type JsonRpcHttpConnection,
} from '@lostgradient/backchannel/client';
import {
  SUBSCRIPTION_OPERATION_NAMES,
  type CatalogOperationName,
  type CatalogOperationTypes,
  type SubscriptionOperationName,
} from './bureau-generated/operation-client.generated.ts';
import { createBureauClientWithTransport as createUnaryClient } from './bureau-generated/portable-operation-client.generated.ts';
import type { SubscriptionOperationTypes } from './bureau-generated/subscription-operations.generated.ts';

export { CATALOG_OPERATION_BEHAVIORS } from './bureau-generated/operation-behaviors.generated.ts';
export * from './bureau-generated/operation-client.generated.ts';

/** Bind the Bureau's unary calls to a host transport and its feeds to the supplied connection. */
export function createBureauClientWithTransport(
  transport: CatalogTransport,
  connection: JsonRpcHttpConnection,
) {
  return {
    ...createUnaryClient(transport),
    ...createSubscriptionClient<SubscriptionOperationTypes>(
      SUBSCRIPTION_OPERATION_NAMES,
      sseSubscriptionTransport({ ...connection, routePrefix: '/bureau/v1/subscriptions' }),
    ),
  };
}

type DryRunAnswer = { readonly dryRun: true };
/** What the Bureau operation `Name` takes. */
export type BureauInput<Name extends CatalogOperationName> = CatalogOperationTypes[Name]['input'];
/** What the Bureau operation `Name` answers, excluding a dry-run preview. */
export type BureauOutput<Name extends CatalogOperationName> = Exclude<
  CatalogOperationTypes[Name]['output'],
  DryRunAnswer
>;
/** What the Bureau operation `Name` answers to a call with `dryRun: true`. */
export type BureauDryRunOutput<Name extends CatalogOperationName> = Extract<
  CatalogOperationTypes[Name]['output'],
  DryRunAnswer
>;
/** What the Bureau feed `Name` sends, one event at a time. */
export type BureauEvent<Name extends SubscriptionOperationName> =
  SubscriptionOperationTypes[Name]['event'];
