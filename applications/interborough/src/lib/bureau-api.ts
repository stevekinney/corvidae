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
} from './generated/bureau-operation-client.generated.ts';

/** The client every Bureau call in the browser goes through: one method per operation name. */
export const bureauClient = createBureauClient({ baseUrl: '' });

/** What the Bureau operation `Name` takes. */
export type BureauInput<Name extends CatalogOperationName> = CatalogOperationTypes[Name]['input'];

/** What the Bureau operation `Name` answers. */
export type BureauOutput<Name extends CatalogOperationName> = CatalogOperationTypes[Name]['output'];
