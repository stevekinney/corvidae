import type { CatalogTransport } from '@lostgradient/backchannel/client';
import { createReviewsClientWithTransport as createGeneratedClient } from '../generated/portable-operation-client.generated.ts';
import { validatedReviewsTransport } from './validation.ts';

export type { ReviewsOperationTypes } from '../generated/reviews-operations.generated.ts';
export { parseReviewsOpeningSnapshot, validatedReviewsTransport } from './validation.ts';
export type { ReviewsOpeningSnapshot } from './validation.ts';

export function createReviewsClientWithTransport(transport: CatalogTransport) {
  return createGeneratedClient(validatedReviewsTransport(transport));
}
