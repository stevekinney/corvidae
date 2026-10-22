import type { AnyToolbox, ToolRequestContext, ToolResultCache } from '../index';
import type { IdempotencyResolutionReceipt, LegacyIdempotencyResolutionReceipt } from './types';
import { withToolboxIdempotency } from './with-toolbox-idempotency';

// The README resolves an unknown-outcome attempt by re-executing through the
// wrapped toolbox with a typed receipt. The wrapper reads both receipts at
// runtime, so `execute` must accept both on the toolbox's public options.
declare const toolbox: AnyToolbox;
declare const cache: ToolResultCache;
declare const requestContext: ToolRequestContext;
declare const receipt: IdempotencyResolutionReceipt;
declare const legacyReceipt: LegacyIdempotencyResolutionReceipt;

const idempotentToolbox = withToolboxIdempotency(toolbox, { cache, tenantId: 'tenant' });
const call = { id: 'provider-call-1', name: 'charge-card', arguments: { cents: 2500 } };

void idempotentToolbox.execute(call, {
  idempotencyKey: 'tool-call-1',
  resolutionReceipt: receipt,
  requestContext,
});
void idempotentToolbox.execute(call, {
  idempotencyKey: 'tool-call-1',
  legacyResolutionReceipt: legacyReceipt,
  requestContext,
});
