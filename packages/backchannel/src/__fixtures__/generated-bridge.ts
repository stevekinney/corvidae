import { createProbeClientWithTransport } from './probe-client/portable-operation-client.generated.ts';
import type { CatalogTransport } from '../client/index.ts';

export function connectBridge(bridge: CatalogTransport) {
  return createProbeClientWithTransport(bridge);
}
