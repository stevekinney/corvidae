import { principalFromStdioLocal } from '@lostgradient/backchannel';
import { inProcessCatalogTransport, type CatalogTransport } from '@lostgradient/backchannel/client';
import type { Engine } from '../core/engine.ts';
import { createLiveOperationRegistry } from '../server/rest-bindings.ts';

/** Bind the embedded catalog client to Weft's engine and trusted local principal. */
export function weftInProcessCatalogTransport(
  engine: Engine,
  restOperationNames: ReadonlySet<string> = new Set(),
): CatalogTransport {
  return inProcessCatalogTransport({
    registry: createLiveOperationRegistry(),
    principal: principalFromStdioLocal(),
    host: engine,
    restOperationNames,
  });
}
