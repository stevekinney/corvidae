import type { CatalogSnapshot } from '@lostgradient/backchannel';
import {
  createOperationRegistry,
  snapshotOperationCatalog,
  type RegistrableOperation,
} from '@lostgradient/backchannel/internals';
import type { z } from 'zod';

import {
  BUREAU_HANDLER_OPERATIONS,
  composeBureauOperations,
  type BureauHandlerHost,
} from './create-bureau-handler.ts';

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
export function createBureauCatalogSnapshot(
  contributions: readonly RegistrableOperation<BureauHandlerHost>[] = [],
  effects: readonly z.ZodObject[] = [],
): CatalogSnapshot {
  return snapshotOperationCatalog({
    operations: createOperationRegistry<BureauHandlerHost>(
      contributions.length === 0 && effects.length === 0
        ? BUREAU_HANDLER_OPERATIONS
        : composeBureauOperations(contributions, effects),
    ).list(),
    restBindings: [],
  });
}
