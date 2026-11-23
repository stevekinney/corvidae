import { createProbeClientWithTransport } from '../../__fixtures__/probe-client/portable-operation-client.generated.ts';
import type { CatalogTransport } from '../index.ts';

export function connectBridge(bridge: CatalogTransport) {
  return createProbeClientWithTransport(bridge);
}
