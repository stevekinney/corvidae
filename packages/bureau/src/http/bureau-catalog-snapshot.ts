import type { CatalogSnapshot } from '@lostgradient/backchannel';
import {
  createOperationRegistry,
  snapshotOperationCatalog,
} from '@lostgradient/backchannel/internals';

import { BUREAU_HANDLER_OPERATIONS, type BureauHandlerHost } from './create-bureau-handler.ts';

/**
 * Capture the operations `createBureauHandler` serves as a {@link CatalogSnapshot}: sorted by name,
 * with each operation's input, output and event schemas, so a client can be generated against
 * exactly the surface the handler answers. Its REST routes are not included, because Bureau
 * serves its operations over JSON-RPC and its subscriptions over Server-Sent Events.
 *
 * @example
 * ```ts
 * import { createBureauCatalogSnapshot } from '@lostgradient/bureau';
 *
 * const snapshot = createBureauCatalogSnapshot();
 * console.log(snapshot.operations.some((operation) => operation.name === 'bureau.tasks.list'));
 * ```
 */
export function createBureauCatalogSnapshot(): CatalogSnapshot {
  return snapshotOperationCatalog({
    operations: createOperationRegistry<BureauHandlerHost>(BUREAU_HANDLER_OPERATIONS).list(),
    restBindings: [],
  });
}
